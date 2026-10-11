/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The spec-constant reader, held against its contract
 * (gHashTag/trios#1677): the three exports of t27-consts.ts -
 * decodeBytes, constsOf and loadCompiler - pinned as they behave
 * today, so the next change to that file has something to fail
 * against.
 *
 * decodeBytes: a string whose chars are all <= 0xff is re-decoded as
 * UTF-8 (so a byte pair becomes one char), anything wider passes
 * through untouched, and invalid UTF-8 falls back to the original.
 * constsOf: lifts ConstDecl nodes from a hand-shaped AST, typing each
 * value from the literal, and refuses a duplicate name. loadCompiler:
 * instantiates the vendored t27_compiler.wasm (same bytes the site
 * serves, specs/PIN) and its analyze() reports the constants, the
 * typecheck verdict and the dropped tokens of a source.
 *
 * No network, no database, no container: the only file read is the
 * vendored wasm inside this repository, and the module under test
 * imports nothing.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  constsOf,
  decodeBytes,
  loadCompiler,
} from '../../src/inngest/t27-consts'

describe('t27-consts', () => {
  describe('decodeBytes', () => {
    it('re-decodes a pure-ASCII string as the same text', () => {
      expect(decodeBytes('pub const ID : str = "x";')).toBe(
        'pub const ID : str = "x";',
      )
    })

    it('joins a byte pair stored as two chars into one UTF-8 character', () => {
      // 0xC3 0xA9 is the UTF-8 encoding of e-acute; the wasm hands
      // strings back byte-per-char.
      expect(decodeBytes('\u00C3\u00A9')).toBe('\u00E9')
    })

    it('keeps text that already has a char above 0xff byte-for-char', () => {
      const wide = 'a\u0100b' // a + LATIN CAPITAL LETTER A WITH MACRON + b
      expect(decodeBytes(wide)).toBe(wide)
    })

    it('falls back to the original when the bytes are not valid UTF-8', () => {
      // A lone 0xE9 has no continuation byte: the fatal decoder
      // refuses, and the caller sees the original char.
      expect(decodeBytes('\u00E9')).toBe('\u00E9')
    })
  })

  describe('constsOf', () => {
    it('lifts every ConstDecl with its typed literal value and pub flag', () => {
      const ast = {
        kind: 'Module',
        children: [
          {
            kind: 'ConstDecl',
            name: 'KIND',
            type: 'str',
            pub: true,
            children: [{ kind: 'ExprLiteral', value: '"cron"' }],
          },
          {
            kind: 'ConstDecl',
            name: 'COUNT',
            type: 'int',
            pub: false,
            children: [{ kind: 'ExprLiteral', value: '3' }],
          },
          { kind: 'OtherDecl', name: 'ignored' },
        ],
      }
      expect(constsOf(ast)).toEqual({
        KIND: { type: 'str', value: 'cron', pub: true },
        COUNT: { type: 'int', value: 3, pub: false },
      })
    })

    it('reads booleans and arrays the way the literals spell them', () => {
      const of = (raw: string) =>
        constsOf({
          kind: 'Module',
          children: [
            {
              kind: 'ConstDecl',
              name: 'V',
              type: 'x',
              pub: true,
              children: [{ kind: 'ExprLiteral', value: raw }],
            },
          ],
        }).V.value
      expect(of('true')).toBe(true)
      expect(of('false')).toBe(false)
      expect(of('-7')).toBe(-7)
      expect(of('[1, 2]')).toEqual([1, 2])
      expect(of('["a", "b"]')).toEqual(['a', 'b'])
    })

    it('refuses a duplicate constant name', () => {
      const decl = {
        kind: 'ConstDecl',
        name: 'ID',
        type: 'str',
        pub: true,
        children: [{ kind: 'ExprLiteral', value: '"a"' }],
      }
      expect(() =>
        constsOf({ kind: 'Module', children: [decl, { ...decl }] }),
      ).toThrow('duplicate constant ID')
    })

    it('refuses an expression kind it does not know', () => {
      expect(() =>
        constsOf({
          kind: 'Module',
          children: [
            {
              kind: 'ConstDecl',
              name: 'X',
              type: 'int',
              pub: true,
              children: [{ kind: 'ExprMystery' }],
            },
          ],
        }),
      ).toThrow('unsupported expression kind ExprMystery')
    })
  })

  describe('loadCompiler', () => {
    it(
      'analyzes a card with the real vendored compiler: consts, typecheck verdict, no discarded tokens',
      async () => {
        const wasm = readFileSync(
          resolve(import.meta.dir, '../../../../specs/t27_compiler.wasm'),
        )
        const analyze = await loadCompiler(new Uint8Array(wasm))
        const a = analyze(
          'module zz;\npub const KIND : str = "cron";\npub const ID : str = "x/y";\n',
        )
        expect(a.typecheckOk).toBe(true)
        expect(a.errors).toBe(0)
        expect(a.discarded).toBe(0)
        expect(a.consts.KIND).toEqual({
          type: 'str',
          value: 'cron',
          pub: true,
        })
        expect(a.consts.ID.value).toBe('x/y')
      },
      20_000,
    )

    it(
      'counts tokens the compiler drops instead of hiding them',
      async () => {
        const wasm = readFileSync(
          resolve(import.meta.dir, '../../../../specs/t27_compiler.wasm'),
        )
        const analyze = await loadCompiler(new Uint8Array(wasm))
        // Measured on this exact wasm: a stray token line is dropped
        // and counted, the rest of the card is still analyzed.
        const a = analyze(
          'module zz;\npub const ID : str = "a";\n$$$\n',
        )
        expect(a.typecheckOk).toBe(true)
        expect(a.discarded).toBe(3)
        expect(a.consts.ID.value).toBe('a')
      },
      20_000,
    )

    it(
      'drops a valueless declaration silently: no constant, verdict still ok',
      async () => {
        const wasm = readFileSync(
          resolve(import.meta.dir, '../../../../specs/t27_compiler.wasm'),
        )
        const analyze = await loadCompiler(new Uint8Array(wasm))
        // Measured on this exact wasm (the leniency the scheduler's
        // schema has to refuse on its own): `= ;` yields no constant
        // and no discarded count, and the typecheck still says ok.
        const a = analyze(
          'module zz;\npub const KIND : str = "cron";\npub const ID : str = ;\n',
        )
        expect(a.typecheckOk).toBe(true)
        expect(a.discarded).toBe(0)
        expect(a.consts.KIND.value).toBe('cron')
        expect(a.consts.ID).toBeUndefined()
      },
      20_000,
    )
  })
})
