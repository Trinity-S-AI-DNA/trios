/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE BATCH CHOOSER (gHashTag/t27#9021): the cards it reads, a Boundary's
 * edits, when two edits meet, and one round's picks against held files.
 */

import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EDIT_LINES,
  EDIT_WHOLE,
} from '../../src/api/services/queen-actors-card.gen'
import {
  chooseBatch,
  dispatchBatchEnabled,
  type Edit,
  editsMeet,
  editsOf,
  itemSpan,
  planBatch,
  readAnswer,
  regionsEnabled,
  roundChooser,
} from '../../src/api/services/queen-batch-choose'
import { GC_EDIT_DERIVED } from '../../src/api/services/queen-golden-chain-card.gen'
import { DEFAULT_SPECS_ROOT } from '../../src/inngest/spec-catalog'

const sha = (file: string) =>
  createHash('sha256')
    .update(readFileSync(join(DEFAULT_SPECS_ROOT, file)))
    .digest('hex')

describe('the vendored cards are the ones PIN names', () => {
  it('control, golden_chain, derived_data and issue_shape match', () => {
    const pin = readFileSync(join(DEFAULT_SPECS_ROOT, 'PIN'), 'utf8')
    for (const f of [
      'queen/control.t27',
      'queen/control.wasm',
      'queen/golden_chain.t27',
      'queen/golden_chain.wasm',
      'ci/derived_data.t27',
      'ci/derived_data.wasm',
      'policy/issue_shape.t27',
      'policy/issue_shape.wasm',
    ])
      expect(pin).toContain(`${f} sha256 ${sha(f)}`)
  })
})

const SRC = [
  'fn alpha() {', //  1
  '    let s = "}";', //  2
  '}', //  3
  '', //  4
  'fn beta(x: u8) {', //  5
  '    if x > 0 { gamma(); }', //  6
  '}', //  7
  'fn gamma() {}', //  8
  '',
].join('\n')
const base = async (path: string) =>
  path === 'bootstrap/src/compiler.rs' ? SRC : null
const body = (...lines: string[]) =>
  ['## Requirements', '', '## Boundary', '', ...lines, ''].join('\n')

const REGIONS = body(
  '- bootstrap/src/compiler.rs :: fn alpha',
  '- `bootstrap/src/compiler.rs` :: gamma',
  '- bootstrap/src/compiler.rs :: fn nowhere',
  '- specs/queen/holds.t27',
)

describe('a Boundary, as edits', () => {
  it('regions on: a named item is its lines at the base; anything else is the whole file', async () => {
    expect(itemSpan(SRC, 'beta')).toEqual([5, 8])
    const edits = await editsOf(REGIONS, base, false, true)
    expect(edits).toEqual([
      {
        path: 'bootstrap/src/compiler.rs',
        kind: EDIT_LINES,
        lo: 1,
        hi: 4,
        item: 'alpha',
      },
      {
        path: 'bootstrap/src/compiler.rs',
        kind: EDIT_LINES,
        lo: 8,
        hi: 9,
        item: 'gamma',
      },
      { path: 'bootstrap/src/compiler.rs', kind: EDIT_WHOLE, lo: 0, hi: 0 },
      { path: 'specs/queen/holds.t27', kind: EDIT_WHOLE, lo: 0, hi: 0 },
    ])
  })
  it('regions off (the default): every line is its whole file, and no base is read', async () => {
    expect(regionsEnabled({})).toBe(false)
    expect(regionsEnabled({ TRIOS_QUEEN_REGIONS: 'on' })).toBe(true)
    let reads = 0
    const counted = async (path: string) => {
      reads += 1
      return base(path)
    }
    expect(await editsOf(REGIONS, counted, false, false)).toEqual([
      whole('bootstrap/src/compiler.rs'),
      whole('bootstrap/src/compiler.rs'),
      whole('bootstrap/src/compiler.rs'),
      whole('specs/queen/holds.t27'),
    ])
    expect(reads).toBe(0)
  })
  it('a derived record is GC_EDIT_DERIVED only with the flag', async () => {
    const b = body(
      '- .trinity/seals/queen_QueenHolds.json',
      '- bootstrap/stage0/FROZEN_HASH',
    )
    for (const regions of [false, true]) {
      expect(
        (await editsOf(b, base, true, regions)).map((e) => e.kind),
      ).toEqual([GC_EDIT_DERIVED, GC_EDIT_DERIVED])
      expect(
        (await editsOf(b, base, false, regions)).map((e) => e.kind),
      ).toEqual([EDIT_WHOLE, EDIT_WHOLE])
    }
  })
})

const whole = (path: string): Edit => ({ path, kind: EDIT_WHOLE, lo: 0, hi: 0 })
const lines = (path: string, lo: number, hi: number): Edit => ({
  path,
  kind: EDIT_LINES,
  lo,
  hi,
})
const derived = (path: string): Edit => ({
  path,
  kind: GC_EDIT_DERIVED,
  lo: 0,
  hi: 0,
})
const RS = 'bootstrap/src/compiler.rs'

describe('when two edits meet (held_part, then gc_pair)', () => {
  it('apart paths never meet; a whole file meets every edit of it', () => {
    expect(editsMeet(whole('a/b.rs'), whole('a/c.rs'))).toBe(false)
    expect(editsMeet(whole(RS), lines(RS, 1, 4))).toBe(true)
    expect(editsMeet(whole('bootstrap/src/'), lines(RS, 1, 4))).toBe(true)
  })
  it('regions of one file meet only when their lines do (touching meets)', () => {
    expect(editsMeet(lines(RS, 1, 4), lines(RS, 5, 8))).toBe(false)
    expect(editsMeet(lines(RS, 1, 4), lines(RS, 4, 8))).toBe(true)
    expect(editsMeet(lines(RS, 1, 9), lines(RS, 5, 8))).toBe(true)
  })
  it('two writes of a derived record do not meet; a source over it does', () => {
    expect(
      editsMeet(derived('.trinity/seals/'), derived('.trinity/seals/A.json')),
    ).toBe(false)
    expect(editsMeet(whole('.trinity'), derived('.trinity/seals/A.json'))).toBe(
      true,
    )
  })
})

describe('one round, against what queend said', () => {
  const answer = {
    chosen: null,
    skipped: [
      '#10: bootstrap/src/compiler.rs held by gHashTag/t27#1',
      '#11: bootstrap/src/compiler.rs held by gHashTag/t27#1',
      '#12: bootstrap/src/compiler.rs held by gHashTag/t27#1',
      '#13: specs/x.t27 held by gHashTag/trios#5, gHashTag/t27#2',
      '#14: the work already landed (accepted) - the issue is open and nobody closed it',
    ],
  }
  it('reads holders as tasks, and eligibility from `not first`', () => {
    const r = readAnswer({
      chosen: 20,
      skipped: [...answer.skipped, '#21: not first'],
    })
    expect([...r.eligible]).toEqual([20, 21])
    expect(r.held.get(13)).toEqual(['gHashTag/trios#5', 'gHashTag/t27#2'])
  })
  it('frees an edit the holder does not meet, queues one it does, and never lets a later edit overtake', () => {
    const edits = new Map<number, Edit[]>([
      [10, [lines(RS, 10, 12)]], // apart from the holder and from #11: freed
      [11, [lines(RS, 2, 5)]], // meets the holder's lines 1-3: queued
      [12, [lines(RS, 5, 7), lines(RS, 20, 30)]], // apart from the holder, meets #11 ahead: queued too
      [13, [whole('specs/x.t27')]],
    ])
    const batch = chooseBatch({
      candidates: [10, 11, 12, 13, 14],
      reading: readAnswer(answer),
      edits,
      holderEdits: (slug) =>
        slug === 'gHashTag/t27#1' ? [lines(RS, 1, 4)] : [whole('specs/x.t27')],
      quota: 5,
    })
    expect(batch.picks).toEqual([10])
    expect(batch.relaxed).toEqual([10, 12])
    expect(batch.skipped).toContain(
      '#11: bootstrap/src/compiler.rs held by gHashTag/t27#1',
    )
    expect(batch.skipped).toContain(
      '#12: bootstrap/src/compiler.rs, bootstrap/src/compiler.rs held by #11',
    )
    expect(batch.skipped.some((l) => l.startsWith('#14: the work'))).toBe(true)
  })
  it('an edit waits only in the queue of the file it met, so its other files shut nobody out', () => {
    const reading = readAnswer({
      chosen: null,
      skipped: [
        '#50: bootstrap/t27c.py held by gHashTag/t27#4',
        '#51: not first',
        '#52: not first',
      ],
    })
    const batch = chooseBatch({
      candidates: [50, 51, 52],
      reading,
      edits: new Map<number, Edit[]>([
        [50, [whole('bootstrap/t27c.py'), whole(RS)]], // waits on t27c.py
        [51, [lines(RS, 5, 8)]], // not behind #50: #50 waits for t27c.py, not compiler.rs
        [52, [whole('bootstrap/t27c.py')]], // behind #50 on t27c.py
      ]),
      holderEdits: () => [whole('bootstrap/t27c.py')],
      quota: 10,
    })
    expect(batch.picks).toEqual([51])
    expect(batch.skipped).toContain('#52: bootstrap/t27c.py held by #50')
  })
  it('two picks of one batch never meet, and the quota bounds the batch', () => {
    const reading = readAnswer({
      chosen: 30,
      skipped: ['#31: not first', '#32: not first', '#33: not first'],
    })
    const edits = new Map<number, Edit[]>([
      [30, [lines(RS, 1, 4)]],
      [31, [lines(RS, 3, 6)]], // meets pick #30
      [32, [lines(RS, 10, 20)]],
      [33, [whole('specs/y.t27')]],
    ])
    const one = chooseBatch({
      candidates: [30, 31, 32, 33],
      reading,
      edits,
      holderEdits: () => [],
      quota: 10,
    })
    expect(one.picks).toEqual([30, 32, 33])
    expect(one.skipped).toContain('#31: bootstrap/src/compiler.rs held by #30')
    const two = chooseBatch({
      candidates: [30, 31, 32, 33],
      reading,
      edits,
      holderEdits: () => [],
      quota: 2,
    })
    expect(two.picks).toEqual([30, 32])
    expect(two.skipped).toContain('#33: not first')
  })
})

describe('the round seam', () => {
  const first = {
    allowed: false,
    chosen: null,
    refusal: 'nothing to choose',
    skipped: ['#40: specs/z.t27 held by gHashTag/t27#3'],
  }
  const ctx = {
    candidates: [40],
    bodies: { '40': body('- .trinity/seals/Z.json') },
    board: [
      {
        issue: { owner: 'gHashTag', repo: 't27', number: 3 },
        state: 'queued',
        ownedPaths: ['.trinity/seals/'],
      },
    ],
    repo: 'gHashTag/t27',
    readBase: base,
  }
  it('off by default: queend answers, and queend is asked again', async () => {
    expect(dispatchBatchEnabled({})).toBe(false)
    let asked = 0
    const plan = await roundChooser(first, {
      ...ctx,
      env: {},
      ask: async () => {
        asked += 1
        return first
      },
    })
    expect(plan.decision).toBe(first)
    await plan.next([])
    expect(asked).toBe(1)
  })
  it('on, with derived records free: a held seal directory frees a seal edit', async () => {
    const env = {
      TRIOS_QUEEN_DISPATCH_BATCH: 'on',
      TRIOS_QUEEN_DERIVED_FREE: 'on',
      TRIOS_QUEEN_MAX_WORKERS: '70',
    }
    const plan = await roundChooser(first, {
      ...ctx,
      env,
      ask: async () => first,
    })
    expect(plan.first.chosen).toBe(40)
    expect(plan.first.chosenPaths).toEqual(['.trinity/seals/Z.json'])
    expect((await plan.next([])).allowed).toBe(false)
    // without the derived flag the same seal edit stays held
    const held = await roundChooser(first, {
      ...ctx,
      env: { ...env, TRIOS_QUEEN_DERIVED_FREE: '' },
      ask: async () => first,
    })
    expect(held.first.allowed).toBe(false)
  })
  it('TRIOS_QUEEN_REGIONS: a region apart from the holder runs only with the flag on', async () => {
    const held = {
      allowed: false,
      chosen: null,
      refusal: 'nothing to choose',
      skipped: ['#41: bootstrap/src/compiler.rs held by gHashTag/t27#4'],
    }
    const regionCtx = {
      candidates: [41],
      bodies: {
        '41': body('- bootstrap/src/compiler.rs :: fn gamma'),
        '4': body('- bootstrap/src/compiler.rs :: fn alpha'),
      },
      board: [
        {
          issue: { owner: 'gHashTag', repo: 't27', number: 4 },
          state: 'running',
          ownedPaths: [RS],
        },
      ],
      repo: 'gHashTag/t27',
      readBase: base,
      ask: async () => held,
    }
    const env = { TRIOS_QUEEN_DISPATCH_BATCH: 'on' }
    const on = await roundChooser(held, {
      ...regionCtx,
      env: { ...env, TRIOS_QUEEN_REGIONS: 'on' },
    })
    expect(on.first.chosen).toBe(41)
    // off: both lines are the whole file, so #41 stays behind #4 as before regions
    const off = await roundChooser(held, { ...regionCtx, env })
    expect(off.first.allowed).toBe(false)
    expect(off.decision.skipped).toContain(
      '#41: bootstrap/src/compiler.rs held by gHashTag/t27#4',
    )
  })
  it('a refusal without sentences (capacity, money) stands', async () => {
    const full = {
      allowed: false,
      refusal: '70 workers already running (limit 70)',
    }
    const plan = await roundChooser(full, {
      ...ctx,
      env: { TRIOS_QUEEN_DISPATCH_BATCH: 'on' },
      ask: async () => full,
    })
    expect(plan.first).toBe(full)
  })
  it('planBatch leaves no lane when the board fills the cap', async () => {
    const b = await planBatch({
      candidates: [40],
      answer: { chosen: 40, skipped: [] },
      bodies: { '40': body('- specs/z.t27') },
      board: [{ state: 'running' }, { state: 'queued' }],
      repo: 'gHashTag/t27',
      cap: 2,
      derivedFree: false,
      regions: false,
      readBase: base,
    })
    expect(b.picks).toEqual([])
  })
})
