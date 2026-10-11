/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE MERGE SIDE OF A DECLARED REGION (gHashTag/t27#9021, golden_chain.t27
 * section 5, TRIOS_QUEEN_REGIONS): a bee whose diff left its declared region
 * onto live work does not land; one that kept to it, or met nothing, does.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import type { Pool } from 'pg'
import {
  GC_RV_SEND_BACK,
  GC_RV_STANDS,
  GC_RV_WAIT,
} from '../../src/api/services/queen-golden-chain-card.gen'
import {
  checkRegions,
  hunksOf,
  mergeKind,
  noRegionCheck,
  type RegionCheckInput,
  type RegionDeps,
  regionCounts,
  regionDeps,
  regionStep,
} from '../../src/api/services/queen-region-merge'
import type { ReviewDeps } from '../../src/api/services/queen-reviewer'
import { reviewFinishedDispatches } from '../../src/api/services/queen-tick'
import { resolveQueendPath } from '../__helpers__/queend-path'

const RS = 'bootstrap/src/compiler.rs'
// alpha is base lines 1-3, beta 5-7, gamma 8 (item_span: [1,4), [5,8), [8,9))
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
const body = (...lines: string[]) =>
  ['## Requirements', '', '## Boundary', '', ...lines, ''].join('\n')

const BEE = 7001
const HOLDER = 7002
const diff = (...headers: string[]) =>
  [
    `diff --git a/${RS} b/${RS}`,
    `--- a/${RS}`,
    `+++ b/${RS}`,
    ...headers.flatMap((h) => [h, '-old', '+new']),
  ].join('\n')

/** Fake reads; `calls` names every read the check made. */
function fakes(over: Partial<RegionDeps> = {}, theDiff = diff('@@ -6 +6 @@')) {
  const calls: string[] = []
  const bodies: Record<number, string> = {
    [BEE]: body(`- ${RS} :: fn beta`, '- specs/queen/x.t27'),
    [HOLDER]: body(`- ${RS} :: fn alpha`),
  }
  const deps: RegionDeps = {
    enabled: true,
    derivedFree: false,
    issueBody: async (n) => {
      calls.push(`body #${n}`)
      return bodies[n] ?? null
    },
    readAt: async (sha, path) => {
      calls.push(`show ${sha}:${path}`)
      return path === RS ? SRC : null
    },
    diffOf: async (_base, _head, path) => {
      calls.push(`diff ${path}`)
      return path === RS ? theDiff : ''
    },
    liveHolders: async () => {
      calls.push('live')
      return [{ issue: HOLDER, paths: [RS] }]
    },
    readBase: async (path) => (path === RS ? SRC : null),
    ...over,
  }
  return { deps, calls }
}

const accept: RegionCheckInput = {
  issue: BEE,
  accepting: true,
  head: 'h'.repeat(40),
  mergeBase: async () => 'b'.repeat(40),
}

describe('the cards it asks (golden_chain.t27 section 5, vendored)', () => {
  it('one hunk outside widens the file; only an accept is gated; a send-back counts', () => {
    expect(mergeKind(true)).toBe(1) // EDIT_LINES
    expect(mergeKind(false)).toBe(0) // EDIT_WHOLE
    expect(regionStep(GC_RV_STANDS, true, true, 0, true)).toBe(GC_RV_SEND_BACK)
    expect(regionStep(GC_RV_STANDS, true, true, 0, false)).toBe(GC_RV_STANDS)
    expect(regionStep(GC_RV_STANDS, false, true, 0, true)).toBe(GC_RV_STANDS)
    expect(regionStep(GC_RV_STANDS, true, false, 1, false)).toBe(GC_RV_WAIT)
    expect(regionCounts(GC_RV_SEND_BACK)).toBe(true)
    expect(regionCounts(GC_RV_WAIT)).toBe(false)
  })
})

describe("git's hunk headers, as base-side lines", () => {
  it('reads lines, a one-line hunk and an insertion after a line', () => {
    expect(
      hunksOf(
        '@@ -10,3 +10,4 @@ fn x\n@@ -7 +7 @@\n@@ -5,0 +6,2 @@\n@@ -0,0 +1,3 @@\n@@ -2,4 +1,0 @@',
      ),
    ).toEqual([
      { lo: 10, hi: 13 },
      { lo: 7, hi: 8 },
      { lo: 6, hi: 6 }, // inserted after line 5: before line 6
      { lo: 1, hi: 1 }, // inserted at the top of the file
      { lo: 2, hi: 6 }, // a deletion
    ])
    expect(hunksOf('+@@ -1 +1 @@ inside a line\n')).toEqual([])
  })
})

describe('the check, before an accept stands', () => {
  it('flag off: nothing is read and the verdict stands', async () => {
    const { deps, calls } = fakes({ enabled: false })
    const check = await checkRegions(accept, deps)
    expect(check.answer).toBe(GC_RV_STANDS)
    expect(check.note).toBe('')
    expect(calls).toEqual([])
    // and the default reads the flag from the environment, off when unset
    const pool = {
      query: async () => {
        throw new Error('the check must not read the database')
      },
    } as unknown as Pool
    expect(regionDeps(pool, async () => null, {}).enabled).toBe(false)
    expect(
      regionDeps(pool, async () => null, { TRIOS_QUEEN_REGIONS: 'on' }).enabled,
    ).toBe(true)
    expect((await noRegionCheck()).answer).toBe(GC_RV_STANDS)
  })
  it('a verdict that is not an accept reads nothing', async () => {
    const { deps, calls } = fakes()
    const check = await checkRegions({ ...accept, accepting: false }, deps)
    expect(check.answer).toBe(GC_RV_STANDS)
    expect(calls).toEqual([])
  })
  it('a diff inside its region is accepted as before, and no live work is read', async () => {
    const { deps, calls } = fakes({}, diff('@@ -6 +6 @@', '@@ -5,3 +5,4 @@'))
    const check = await checkRegions(accept, deps)
    expect(check.answer).toBe(GC_RV_STANDS)
    expect(check.counts).toBe(false)
    expect(calls).not.toContain('live')
  })
  it('a hunk outside, widened, meeting a live holder: sent back, counted, with the reason', async () => {
    // line 2 is inside alpha, which the live #7002 declares
    const { deps } = fakes({}, diff('@@ -6 +6 @@', '@@ -2 +2 @@'))
    const check = await checkRegions(accept, deps)
    expect(check.answer).toBe(GC_RV_SEND_BACK)
    expect(check.counts).toBe(true)
    expect(check.findings).toHaveLength(1)
    expect(check.findings[0]?.holder).toBe(HOLDER)
    expect(check.note).toContain(RS)
    expect(check.note).toContain('fn beta (base lines 5-7)')
    expect(check.note).toContain('base line 2')
    expect(check.note).toContain(`#${HOLDER}`)
  })
  it('a hunk outside that meets nothing passes', async () => {
    const outside = diff('@@ -2 +2 @@')
    const none = fakes({ liveHolders: async () => [] }, outside)
    expect((await checkRegions(accept, none.deps)).answer).toBe(GC_RV_STANDS)
    // a live holder of another file holds nothing of this one
    const elsewhere = fakes(
      { liveHolders: async () => [{ issue: HOLDER, paths: ['specs/y.t27'] }] },
      outside,
    )
    const check = await checkRegions(accept, elsewhere.deps)
    expect(check.answer).toBe(GC_RV_STANDS)
    expect(elsewhere.calls).not.toContain(`body #${HOLDER}`)
  })
  it('an insertion at a region edge is outside it (the #9062 rule); one inside is not', async () => {
    // after line 7, the closing brace of beta: before line 8, outside [5, 8)
    const after = await checkRegions(
      accept,
      fakes({}, diff('@@ -7,0 +8 @@')).deps,
    )
    expect(after.answer).toBe(GC_RV_SEND_BACK)
    expect(after.note).toContain('an insertion before base line 8')
    // after line 4: before beta's own fn line, outside too
    const before = await checkRegions(
      accept,
      fakes({}, diff('@@ -4,0 +5 @@')).deps,
    )
    expect(before.answer).toBe(GC_RV_SEND_BACK)
    // after line 6: inside the body
    const inside = await checkRegions(
      accept,
      fakes({}, diff('@@ -6,0 +7 @@')).deps,
    )
    expect(inside.answer).toBe(GC_RV_STANDS)
  })
  it('what cannot be read waits, uncounted; nothing unread passes', async () => {
    const noDiff = await checkRegions(
      accept,
      fakes({ diffOf: async () => null }).deps,
    )
    expect(noDiff.answer).toBe(GC_RV_WAIT)
    expect(noDiff.counts).toBe(false)
    expect(noDiff.note).toContain(`the diff of ${RS}`)
    const noBody = await checkRegions(
      accept,
      fakes({ issueBody: async () => null }).deps,
    )
    expect(noBody.answer).toBe(GC_RV_WAIT)
    const noBase = await checkRegions(
      { ...accept, mergeBase: async () => null },
      fakes().deps,
    )
    expect(noBase.answer).toBe(GC_RV_WAIT)
    const noLive = await checkRegions(
      accept,
      fakes({ liveHolders: async () => null }, diff('@@ -2 +2 @@')).deps,
    )
    expect(noLive.answer).toBe(GC_RV_WAIT)
  })
  it('a file the Boundary also names whole has no region to keep', async () => {
    const { deps, calls } = fakes(
      {
        issueBody: async (n) =>
          n === BEE ? body(`- ${RS} :: fn beta`, `- ${RS}`) : null,
      },
      diff('@@ -2 +2 @@'),
    )
    expect((await checkRegions(accept, deps)).answer).toBe(GC_RV_STANDS)
    expect(calls).not.toContain(`diff ${RS}`)
  })
})

/**
 * The review sweep, end to end, with queend deciding accept. queend is the
 * real policy binary; these run where it is built (TRIOS_QUEEND_PATH).
 */
const present = existsSync(resolveQueendPath())

describe('the review sweep (needs queend)', () => {
  const finished = () => ({
    issue: BEE,
    conversation_id: '00000000-0000-0000-0000-000000001b59',
    review_state: null as unknown,
    review_note: null as unknown,
    criteria: ['beta handles zero'],
    criteria_source: 'stated',
    send_backs: 0,
    owned_paths: [RS],
    free_attempts: 0,
    key_index: 1,
    provider: 'zai',
    model: 'glm-5.3',
    reviewer_fingerprint: null,
    reviewer_text: null,
    reviewer_model: null,
    reviewer_provider: null,
    said: '',
  })
  function sweepPool(row: Record<string, unknown>) {
    return {
      query: async (sql: string, params: unknown[] = []) => {
        const text = String(sql)
        if (text.includes('FROM queen_dispatch d')) {
          const open = row.review_state == null || row.review_state === 'wait'
          return { rowCount: open ? 1 : 0, rows: open ? [row] : [] }
        }
        if (text.includes('review_state = $2')) {
          row.review_state = params[1]
          row.review_note = params[2]
          if (params[1] === 'sendBack' && params[4] === true)
            row.send_backs = Number(row.send_backs ?? 0) + 1
        }
        return { rowCount: 0, rows: [] }
      },
    } as unknown as Pool
  }
  const review = (regionCheck?: ReviewDeps['regionCheck']) =>
    ({
      committedFilesResult: async () => ({ ok: true, files: [RS] }),
      branchHeadSha: async () => 'a'.repeat(40),
      mergeBaseSha: async () => 'b'.repeat(40),
      branchPatch: async () =>
        `diff --git a/${RS} b/${RS}\n+    if x >= 0 { gamma(); }`,
      worktreeDirtCount: async () => null,
      witness: async () => ({ kind: 'witnessed', t27c: 'fake', specs: [] }),
      measureCriteria: async () => ({ ok: true, criteria: [] }),
      laneCandidates: () => [
        {
          provider: 'openai-compatible',
          model: 'other-model',
          baseUrl: 'https://n.example.invalid',
          apiKey: 'not-a-real-key',
          keyIndex: 10_000,
          poolNumber: 2,
          laneIndex: 0,
          laneCount: 1,
        },
      ],
      reviewsPerRound: () => 3,
      llm: async () => ({
        ok: true,
        text: `## VERDICT\n- 1. ${RS}:6 the guard now admits zero: met`,
      }),
      ...(regionCheck ? { regionCheck } : {}),
    }) as Partial<ReviewDeps>

  it.if(present)(
    'flag off: the accept stands and the check reads nothing',
    async () => {
      const row = finished()
      const { deps, calls } = fakes({ enabled: false }, diff('@@ -2 +2 @@'))
      await reviewFinishedDispatches(
        sweepPool(row),
        review((input) => checkRegions(input, deps)),
      )
      expect(row.review_state).toBe('accept')
      expect(calls).toEqual([])
    },
  )
  it.if(present)(
    'flag on: an accept that left its region onto live work goes back, counted, with the reason',
    async () => {
      const row = finished()
      const { deps } = fakes({}, diff('@@ -2 +2 @@'))
      await reviewFinishedDispatches(
        sweepPool(row),
        review((input) => checkRegions(input, deps)),
      )
      expect(row.review_state).toBe('sendBack')
      expect(row.send_backs).toBe(1)
      expect(String(row.review_note)).toContain(
        `meets the live edit of #${HOLDER}`,
      )
    },
  )
  it.if(present)('flag on: an accept that kept its region stands', async () => {
    const row = finished()
    const { deps } = fakes({}, diff('@@ -6 +6 @@'))
    await reviewFinishedDispatches(
      sweepPool(row),
      review((input) => checkRegions(input, deps)),
    )
    expect(row.review_state).toBe('accept')
  })
})
