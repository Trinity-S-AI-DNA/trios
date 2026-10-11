/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * WHEN FINISHED WORK LETS GO OF ITS FILES (gHashTag/t27 specs/queen/holds.t27):
 * the card as the wasm runs it, the stage of a dispatch row, and the paths a
 * row still holds against other bees.
 */

import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  heldPart,
  heldPaths,
  holdStage,
  holdsFiles,
  holdsFilesNow,
} from '../../src/api/services/queen-holds'
import {
  AWAITING_HOLD_MINUTES,
  HP_APART,
  HP_CURRENT,
  HP_STORED,
  HS_AWAITING,
  HS_DONE,
  HS_ESCALATED,
  HS_SEND_BACK,
  HS_WORKING,
  SEND_BACK_HOLD_MINUTES,
} from '../../src/api/services/queen-holds.gen'
import { boundariesNow, issueNow } from '../../src/api/services/queen-tick'
import { DEFAULT_SPECS_ROOT } from '../../src/inngest/spec-catalog'

const sha = (file: string) =>
  createHash('sha256')
    .update(readFileSync(join(DEFAULT_SPECS_ROOT, file)))
    .digest('hex')

describe('the vendored holds card is the one PIN names', () => {
  it('holds.t27 and holds.wasm match', () => {
    const pin = readFileSync(join(DEFAULT_SPECS_ROOT, 'PIN'), 'utf8')
    expect(pin).toContain(`queen/holds.t27 sha256 ${sha('queen/holds.t27')}`)
    expect(pin).toContain(`queen/holds.wasm sha256 ${sha('queen/holds.wasm')}`)
  })
})

describe('the card, as the wasm runs it', () => {
  it('a bee at work holds; finished work lets go; a person and a verdict hold nothing', () => {
    expect(holdsFiles(HS_WORKING, 1e9)).toBe(true)
    expect(holdsFiles(HS_AWAITING, AWAITING_HOLD_MINUTES - 1)).toBe(true)
    expect(holdsFiles(HS_AWAITING, AWAITING_HOLD_MINUTES)).toBe(false)
    expect(holdsFiles(HS_SEND_BACK, SEND_BACK_HOLD_MINUTES - 1)).toBe(true)
    expect(holdsFiles(HS_SEND_BACK, SEND_BACK_HOLD_MINUTES)).toBe(false)
    expect(holdsFiles(HS_ESCALATED, 0)).toBe(false)
    expect(holdsFiles(HS_DONE, 0)).toBe(false)
  })
})

describe('a dispatch row, for its files', () => {
  it('reads its stage from whether it finished and its verdict', () => {
    expect(holdStage(false, null)).toBe(HS_WORKING)
    expect(holdStage(false, 'sendBack')).toBe(HS_WORKING)
    expect(holdStage(true, 'sendBack')).toBe(HS_SEND_BACK)
    expect(holdStage(true, 'escalate')).toBe(HS_ESCALATED)
    expect(holdStage(true, 'wait')).toBe(HS_AWAITING)
    expect(holdStage(true, null)).toBe(HS_AWAITING)
    for (const done of [
      'accept',
      'failed',
      'cancelled',
      'obsolete',
      'stale-contract',
    ])
      expect(holdStage(true, done)).toBe(HS_DONE)
  })

  const now = Date.parse('2026-10-08T16:00:00Z')
  const owned = [
    'bootstrap/src/compiler.rs',
    'specs/tri/t27b/bit_cast_plan.t27',
  ]
  it('holds every path while a bee may be writing', () => {
    expect(
      heldPaths(
        { finished_at: null, review_state: null, owned_paths: owned },
        now,
      ),
    ).toEqual(owned)
  })
  it('lets go of finished work after AWAITING_HOLD_MINUTES, by when the bee finished', () => {
    const at = (minutes: number) =>
      new Date(now - minutes * 60_000).toISOString()
    expect(
      heldPaths(
        { finished_at: at(29), review_state: 'wait', owned_paths: owned },
        now,
      ),
    ).toEqual(owned)
    expect(
      heldPaths(
        { finished_at: at(31), review_state: 'wait', owned_paths: owned },
        now,
      ),
    ).toEqual([])
    // measured: #7772 finished 13:31 and still held compiler.rs at 15:24
    expect(
      heldPaths(
        {
          finished_at: '2026-10-08T13:31:00Z',
          review_state: 'wait',
          owned_paths: owned,
        },
        Date.parse('2026-10-08T15:24:00Z'),
      ),
    ).toEqual([])
  })
  it('an escalation holds nothing, at once', () => {
    expect(
      heldPaths(
        {
          finished_at: new Date(now).toISOString(),
          review_state: 'escalate',
          owned_paths: owned,
        },
        now,
      ),
    ).toEqual([])
  })
  it('a send-back holds for SEND_BACK_HOLD_MINUTES', () => {
    const at = (minutes: number) =>
      new Date(now - minutes * 60_000).toISOString()
    expect(
      heldPaths(
        { finished_at: at(90), review_state: 'sendBack', owned_paths: owned },
        now,
      ),
    ).toEqual(owned)
    expect(
      heldPaths(
        { finished_at: at(121), review_state: 'sendBack', owned_paths: owned },
        now,
      ),
    ).toEqual([])
  })
  it('a row with no paths holds none, whatever it is', () => {
    expect(
      heldPaths(
        { finished_at: null, review_state: null, owned_paths: null },
        now,
      ),
    ).toEqual([])
  })
})

describe('a hold follows the issue as it stands now (holds.t27, t27#9033)', () => {
  const now = Date.parse('2026-10-11T10:57:58Z')
  const working = (owned: string[]) => ({
    finished_at: null,
    review_state: null,
    owned_paths: owned,
  })
  // measured: #8660's bee held compiler.rs after its issue closed at 10:56:59Z
  const p8660 = [
    'specs/fpga/die_probe.t27',
    'bootstrap/src/compiler.rs',
    'proofs/lean4/Trinity/IcarusLowerable/Verilog.lean',
  ]

  it('the card: a closed issue and a removed Boundary hold nothing; unread, the stage decides', () => {
    const open = { known: true, open: true, boundary: ['a/b.t27'] }
    const closed = { known: true, open: false, boundary: ['a/b.t27'] }
    const bare = { known: true, open: true, boundary: [] }
    const unread = { known: false, open: false, boundary: [] }
    expect(holdsFilesNow(open, HS_WORKING, 0)).toBe(true)
    expect(holdsFilesNow(closed, HS_WORKING, 0)).toBe(false)
    expect(holdsFilesNow(closed, HS_AWAITING, 0)).toBe(false)
    expect(holdsFilesNow(bare, HS_WORKING, 0)).toBe(false)
    expect(holdsFilesNow(unread, HS_WORKING, 0)).toBe(true)
    expect(holdsFilesNow(unread, HS_AWAITING, AWAITING_HOLD_MINUTES)).toBe(
      false,
    )
    expect(holdsFilesNow(open, HS_AWAITING, AWAITING_HOLD_MINUTES)).toBe(false)
  })

  it('the card: the narrower path holds; apart holds nothing', () => {
    expect(heldPart('.trinity/seals/', '.trinity/seals/Backend.json')).toBe(
      HP_CURRENT,
    )
    expect(heldPart('specs/queen/holds.t27', 'specs/queen')).toBe(HP_STORED)
    expect(heldPart('./specs/x.t27', 'specs/x.t27')).toBe(HP_STORED)
    expect(heldPart('specs/a', 'specs/ab')).toBe(HP_APART)
  })

  it('a closed issue holds nothing, though its bee still runs', () => {
    expect(
      heldPaths(working(p8660), now, {
        known: true,
        open: false,
        boundary: [],
      }),
    ).toEqual([])
  })

  it('an issue whose Boundary was removed holds nothing (#8095)', () => {
    expect(
      heldPaths(working(['bootstrap/t27c.py']), now, {
        known: true,
        open: true,
        boundary: [],
      }),
    ).toEqual([])
  })

  it('a narrowed Boundary holds the narrower paths (#8721)', () => {
    expect(
      heldPaths(working(['.trinity/seals/', 'specs/a/b.t27']), now, {
        known: true,
        open: true,
        boundary: [
          'specs/a/b.t27',
          '.trinity/seals/A.json',
          '.trinity/seals/B.json',
        ],
      }),
    ).toEqual([
      '.trinity/seals/A.json',
      '.trinity/seals/B.json',
      'specs/a/b.t27',
    ])
  })

  it('a widened Boundary holds no more than was stored', () => {
    expect(
      heldPaths(working(['specs/queen/holds.t27']), now, {
        known: true,
        open: true,
        boundary: ['specs/queen', 'bootstrap/src/compiler.rs'],
      }),
    ).toEqual(['specs/queen/holds.t27'])
  })

  it('an unread issue list leaves every stored path held, as before', () => {
    expect(heldPaths(working(p8660), now)).toEqual(p8660)
  })

  it('finished work still lets go on its own clock when its issue is open', () => {
    const at = (minutes: number) =>
      new Date(now - minutes * 60_000).toISOString()
    const issue = { known: true, open: true, boundary: p8660 }
    expect(
      heldPaths(
        { finished_at: at(29), review_state: 'wait', owned_paths: p8660 },
        now,
        issue,
      ),
    ).toEqual(p8660)
    expect(
      heldPaths(
        { finished_at: at(31), review_state: 'wait', owned_paths: p8660 },
        now,
        issue,
      ),
    ).toEqual([])
  })
})

describe('the round reads each issue from the list it already fetched (t27#9033)', () => {
  const open = [
    { number: 8721, body: '## Boundary\n\n- .trinity/seals/A.json\n' },
    { number: 8095, body: 'An epic, no Boundary.' },
  ]
  it('a whole list: open issues with their Boundary as written now, the rest closed', () => {
    const now = boundariesNow(open, true)
    expect(issueNow(now, 8721)).toEqual({
      known: true,
      open: true,
      boundary: ['.trinity/seals/A.json'],
    })
    expect(issueNow(now, 8095)).toEqual({
      known: true,
      open: true,
      boundary: [],
    })
    expect(issueNow(now, '8660')).toEqual({
      known: true,
      open: false,
      boundary: [],
    })
  })
  it('a truncated list says nothing about any issue', () => {
    expect(boundariesNow(open, false)).toBeNull()
    expect(issueNow(null, 8660)).toBeUndefined()
  })
})
