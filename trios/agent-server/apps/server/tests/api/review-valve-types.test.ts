/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * queen-review-valve.gen.d.ts is typing glue for the generated .js. This pins
 * it to the generated file: the same export names and the same literal values,
 * so the glue cannot drift from what the generator wrote.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as generated from '../../src/api/services/queen-review-valve.gen.js'

const dir = join(import.meta.dir, '../../src/api/services')
const declarations = readFileSync(
  join(dir, 'queen-review-valve.gen.d.ts'),
  'utf8',
)

describe('queen-review-valve.gen.d.ts', () => {
  it('declares exactly the exports of the generated module, with its values', () => {
    const declared = new Map<string, string>()
    const lines = declarations.matchAll(/^export const (\w+): (.+)$/gm)
    for (const match of lines) {
      declared.set(match[1] ?? '', (match[2] ?? '').trim())
    }
    const actual = Object.keys(generated).sort()
    expect([...declared.keys()].sort()).toEqual(actual)
    for (const [name, type] of declared) {
      if (type.startsWith('readonly ')) continue
      const value = (generated as Record<string, unknown>)[name]
      const literal = typeof value === 'string' ? `'${value}'` : String(value)
      expect({ name, type }).toEqual({ name, type: literal })
    }
  })
})
