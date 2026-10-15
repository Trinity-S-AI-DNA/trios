/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Executes the vectors of gHashTag/t27 specs/queen/worktree_keep.t27 against
 * the REAL wasm (t27c gen-rust + the thin export shim, see
 * scripts/build/worktree-keep-card.ts). Each case below is the card's own
 * statement of its rule, written out; the wasm is the only implementation.
 * Also pins that the card imports nothing and exports every function the host
 * module calls.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadCardWasm } from '../../src/api/services/queen-card-wasm'
import {
  bootReleases,
  CODE_MAX_LEN,
  claimsAgainAtOnce,
  codeReportable,
  EK_ABORT,
  EK_OTHER,
  EK_TIMEOUT,
  RV_RETHROW,
  RV_RETRY,
  reapVerdict,
  retryVerdict,
  SHAPE_MAX_COUNT,
  SHAPE_MAX_SEQUENCE,
  ST_NO,
  ST_UNKNOWN,
  ST_YES,
  shapeCount,
  WORKTREE_KEEP_CARD,
  WT_KEEP,
  WT_RELEASE,
  worktreeVerdict,
} from '../../src/api/services/queen-worktree-keep'
import { DEFAULT_SPECS_ROOT } from '../../src/inngest/spec-catalog'

const STATES = [ST_NO, ST_YES, ST_UNKNOWN]

/** Every combination of `n` states, in order. */
const grid = (n: number): number[][] =>
  n === 0
    ? [[]]
    : grid(n - 1).flatMap((rest) => STATES.map((state) => [...rest, state]))

describe('worktree_keep card, executed', () => {
  it('imports nothing and exports what the host calls', () => {
    const module = new WebAssembly.Module(
      readFileSync(join(DEFAULT_SPECS_ROOT, WORKTREE_KEEP_CARD)),
    )
    expect(WebAssembly.Module.imports(module)).toEqual([])
    const names = WebAssembly.Module.exports(module).map((e) => e.name)
    for (const fn of [
      'worktree_verdict',
      'boot_releases',
      'retry_verdict',
      'claims_again_at_once',
      'reap_verdict',
      'shape_count',
      'code_reportable',
    ])
      expect(names).toContain(fn)
  })

  it('worktree_verdict: all 243 state combinations, release only on full proof', () => {
    const wanted = [ST_YES, ST_NO, ST_NO, ST_NO, ST_YES]
    let released = 0
    for (const [a = 0, b = 0, c = 0, d = 0, e = 0] of grid(5)) {
      const proven = [a, b, c, d, e].join() === wanted.join()
      expect(worktreeVerdict(a, b, c, d, e)).toBe(proven ? WT_RELEASE : WT_KEEP)
      if (proven) released++
    }
    expect(released).toBe(1)
    // a value outside the card's states is read as unknown, not as proof
    expect(worktreeVerdict(1, 256, 0, 0, 1)).toBe(WT_KEEP)
    expect(worktreeVerdict(1, 0, 0, 4294967295, 1)).toBe(WT_KEEP)
  })

  it('boot never releases, whatever the count', () => {
    for (const n of [0, 1, 41, 130, 4294967295])
      expect(bootReleases(n)).toBe(false)
  })

  it('reap_verdict: release only when not running, clean with ignored, published, read', () => {
    const wanted = [ST_NO, ST_NO, ST_NO, ST_YES]
    for (const [run = 0, dirty = 0, unpushed = 0, read = 0] of grid(4)) {
      const proven = [run, dirty, unpushed, read].join() === wanted.join()
      expect(reapVerdict(run, dirty, unpushed, read)).toBe(
        proven ? WT_RELEASE : WT_KEEP,
      )
    }
  })

  it('retry_verdict: the table of the card', () => {
    // [callerAborted, kind, delivered, attempt, max] -> verdict
    const vectors: Array<[boolean, number, number, number, number, number]> = [
      [false, EK_TIMEOUT, 0, 1, 7, RV_RETRY],
      [false, EK_OTHER, 0, 6, 7, RV_RETRY],
      [true, EK_TIMEOUT, 0, 1, 7, RV_RETHROW],
      [true, EK_ABORT, 0, 1, 7, RV_RETHROW],
      [false, EK_ABORT, 0, 1, 7, RV_RETHROW],
      [false, EK_TIMEOUT, 1, 1, 7, RV_RETHROW],
      [false, EK_OTHER, 4096, 1, 7, RV_RETHROW],
      [false, EK_TIMEOUT, 0, 7, 7, RV_RETHROW],
      [false, EK_TIMEOUT, 0, 8, 7, RV_RETHROW],
      [false, 255, 0, 1, 7, RV_RETRY],
    ]
    for (const [aborted, kind, delivered, attempt, max, want] of vectors)
      expect(retryVerdict(aborted, kind, delivered, attempt, max)).toBe(want)
  })

  it('claims_again_at_once follows started', () => {
    expect(claimsAgainAtOnce(true)).toBe(true)
    expect(claimsAgainAtOnce(false)).toBe(false)
  })

  it('shape bounds and the reportable code', () => {
    expect(SHAPE_MAX_SEQUENCE).toBe(200)
    expect(SHAPE_MAX_COUNT).toBe(100000)
    expect(CODE_MAX_LEN).toBe(12)
    expect(shapeCount(0)).toBe(0)
    expect(shapeCount(100000)).toBe(100000)
    expect(shapeCount(100001)).toBe(100000)
    expect(shapeCount(4294967295)).toBe(100000)
    expect(codeReportable(4, true)).toBe(true)
    expect(codeReportable(12, true)).toBe(true)
    expect(codeReportable(13, true)).toBe(false)
    expect(codeReportable(0, true)).toBe(false)
    expect(codeReportable(4, false)).toBe(false)
  })

  it('executes every vector of worktree_keep_vectors.json on the wasm', () => {
    const file = JSON.parse(
      readFileSync(
        join(DEFAULT_SPECS_ROOT, 'queen/worktree_keep_vectors.json'),
        'utf8',
      ),
    ) as {
      test_vectors: Array<{
        name: string
        fn: string
        input: number[]
        expected: number
      }>
    }
    expect(file.test_vectors.length).toBeGreaterThan(40)
    const card = loadCardWasm(WORKTREE_KEEP_CARD)
    for (const vector of file.test_vectors) {
      const got = card.call(vector.fn, ...vector.input) >>> 0
      expect({ name: vector.name, got }).toEqual({
        name: vector.name,
        got: vector.expected,
      })
    }
  })

  it('benchmark: one million verdicts stay cheap (informational bound)', () => {
    const start = performance.now()
    let sink = 0
    for (let i = 0; i < 1_000_000; i++)
      sink += worktreeVerdict(1, 0, 0, 0, i & 1)
    const ms = performance.now() - start
    expect(sink).toBe(500_000)
    // generous: the card is a few comparisons; this only catches a pathology
    expect(ms).toBeLessThan(20_000)
  })
})
