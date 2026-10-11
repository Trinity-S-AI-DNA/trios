/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A claim on the issue follows the work as it stands now (gHashTag/t27
 * specs/queen/holds.t27 send_back_claim, accept_claim, held_stage; t27#9111).
 *
 * Measured on the live Queen 2026-10-11:
 * - 12:55Z, 89 open issues claimed. 9 were send-backs "expecting the same bee
 *   back", but a runner deletes the bee's session when its turn ends and
 *   nothing resumes a send-back. 8 of the 9 were under the ceiling.
 * - 12:47Z, 374 issues counted `completed`. 2 had only pull requests closed
 *   unmerged (#4374, #6414), so the work will never land and the issue is never
 *   chosen again. 121 had an open PR, and 213 had none: their accepted heads
 *   wait in an export that has timed out since 10-08.
 *
 * Each rule is behind its own flag, off by default, and off is today exactly.
 */

import { describe, expect, it } from 'bun:test'
import type { Pool } from 'pg'
import {
  type CiDeps,
  type PullRequest,
  takeBackRefusedAcceptances,
} from '../../src/api/services/queen-ci-verdict'
import {
  acceptClaim,
  claimOfState,
  freeClosedPrEnabled,
  heldPaths,
  heldStage,
  releaseDeadClaimsEnabled,
  sendBackClaim,
} from '../../src/api/services/queen-holds'
import {
  CL_DONE,
  CL_FREE,
  CL_LIVE,
  HS_DONE,
  HS_SEND_BACK,
  HS_WORKING,
} from '../../src/api/services/queen-holds.gen'
import {
  SEND_BACK_IDLE_FLOOR_MS,
  stateOfDispatch,
} from '../../src/api/services/queen-tick'

const OFF = { releaseDeadClaims: false }
const ON = { releaseDeadClaims: true }

// test a_send_back_under_the_ceiling_frees_its_issue / a_pull_request_closed_unmerged_frees_its_accept
describe('the card, as the wasm runs it', () => {
  it('send_back_claim: free under the ceiling, live at it', () => {
    expect(sendBackClaim(0, 2)).toBe(CL_FREE)
    expect(sendBackClaim(1, 2)).toBe(CL_FREE)
    expect(sendBackClaim(2, 2)).toBe(CL_LIVE)
    expect(sendBackClaim(0, 0)).toBe(CL_LIVE)
  })

  it('accept_claim: free only when every PR read is closed unmerged', () => {
    expect(acceptClaim(true, 0, 0, 1)).toBe(CL_FREE)
    expect(acceptClaim(true, 1, 0, 0)).toBe(CL_DONE)
    expect(acceptClaim(true, 0, 1, 0)).toBe(CL_DONE)
    expect(acceptClaim(true, 1, 0, 1)).toBe(CL_DONE)
    expect(acceptClaim(true, 0, 0, 0)).toBe(CL_DONE)
    expect(acceptClaim(false, 0, 0, 1)).toBe(CL_DONE)
  })

  it('held_stage: a freed claim holds no files', () => {
    expect(heldStage(CL_FREE, HS_SEND_BACK)).toBe(HS_DONE)
    expect(heldStage(CL_FREE, HS_WORKING)).toBe(HS_DONE)
    expect(heldStage(CL_LIVE, HS_SEND_BACK)).toBe(HS_SEND_BACK)
  })
})

describe('the flags are off unless set to on', () => {
  it('reads only the word on', () => {
    expect(releaseDeadClaimsEnabled({})).toBe(false)
    expect(
      releaseDeadClaimsEnabled({ TRIOS_QUEEN_RELEASE_DEAD_CLAIMS: '1' }),
    ).toBe(false)
    expect(
      releaseDeadClaimsEnabled({ TRIOS_QUEEN_RELEASE_DEAD_CLAIMS: 'on' }),
    ).toBe(true)
    expect(freeClosedPrEnabled({})).toBe(false)
    expect(freeClosedPrEnabled({ TRIOS_QUEEN_FREE_CLOSED_PR: 'yes' })).toBe(
      false,
    )
    expect(freeClosedPrEnabled({ TRIOS_QUEEN_FREE_CLOSED_PR: ' on ' })).toBe(
      true,
    )
  })
})

describe('TRIOS_QUEEN_RELEASE_DEAD_CLAIMS: a send-back nobody comes back to', () => {
  // The 12:55Z claims, as stateOfDispatch reads them.
  const claims = [
    ['running', false, null, 0, 0],
    ['wait', true, 'wait', 0, 5 * 60_000],
    ['empty', true, 'empty', 0, 20 * 60_000],
    ['escalate', true, 'escalate', 0, 50 * 60_000],
    ['sendBack 0', true, 'sendBack', 0, 14 * 60_000],
    ['sendBack 1', true, 'sendBack', 1, 55 * 60_000],
    ['sendBack at the ceiling', true, 'sendBack', 2, 14 * 60_000],
    ['accept', true, 'accept', 0, 0],
  ] as const

  it('off: every state is what it was', () => {
    for (const [, finished, verdict, sendBacks, idleMs] of claims) {
      const off = stateOfDispatch(finished, verdict, {
        idleMs,
        sendBacks,
        ...OFF,
      })
      const unset = stateOfDispatch(finished, verdict, { idleMs, sendBacks })
      expect(off).toBe(unset)
    }
    expect(
      stateOfDispatch(true, 'sendBack', { idleMs: 0, sendBacks: 1, ...OFF }),
    ).toBe('rejected')
    expect(
      stateOfDispatch(true, 'sendBack', {
        idleMs: SEND_BACK_IDLE_FLOOR_MS,
        sendBacks: 1,
        ...OFF,
      }),
    ).toBe('failed')
  })

  it('on: a send-back under the ceiling frees its issue at once', () => {
    expect(
      stateOfDispatch(true, 'sendBack', { idleMs: 0, sendBacks: 0, ...ON }),
    ).toBe('failed')
    expect(
      stateOfDispatch(true, 'sendBack', { idleMs: 0, sendBacks: 1, ...ON }),
    ).toBe('failed')
  })

  it('on: nothing else moves - the ceiling, a bee at work, waits, empties, escalations, accepts', () => {
    for (const [name, finished, verdict, sendBacks, idleMs] of claims) {
      if (name === 'sendBack 0' || name === 'sendBack 1') continue
      expect([
        name,
        stateOfDispatch(finished, verdict, { idleMs, sendBacks, ...ON }),
      ]).toEqual([
        name,
        stateOfDispatch(finished, verdict, { idleMs, sendBacks, ...OFF }),
      ])
    }
  })

  it('reads the environment when the round passes nothing', () => {
    const saved = process.env.TRIOS_QUEEN_RELEASE_DEAD_CLAIMS
    try {
      delete process.env.TRIOS_QUEEN_RELEASE_DEAD_CLAIMS
      expect(stateOfDispatch(true, 'sendBack', { sendBacks: 1 })).toBe(
        'rejected',
      )
      process.env.TRIOS_QUEEN_RELEASE_DEAD_CLAIMS = 'on'
      expect(stateOfDispatch(true, 'sendBack', { sendBacks: 1 })).toBe('failed')
    } finally {
      if (saved === undefined)
        delete process.env.TRIOS_QUEEN_RELEASE_DEAD_CLAIMS
      else process.env.TRIOS_QUEEN_RELEASE_DEAD_CLAIMS = saved
    }
  })

  it('a freed claim holds no files; a live one holds as before', () => {
    const now = Date.parse('2026-10-11T13:00:00Z')
    const sendBack = {
      finished_at: '2026-10-11T12:30:00Z',
      review_state: 'sendBack',
      owned_paths: ['specs/queen/holds.t27'],
    }
    const running = {
      finished_at: null,
      review_state: null,
      owned_paths: ['a.t27'],
    }
    // no claim given (the flag off): exactly as before
    expect(heldPaths(sendBack, now)).toEqual(['specs/queen/holds.t27'])
    // the claim a state puts on its issue
    expect(claimOfState('failed')).toBe(CL_FREE)
    expect(claimOfState('cancelled')).toBe(CL_FREE)
    expect(claimOfState('rejected')).toBe(CL_LIVE)
    expect(claimOfState('running')).toBe(CL_LIVE)
    expect(claimOfState('accepted')).toBe(CL_LIVE)
    expect(heldPaths(sendBack, now, undefined, CL_FREE)).toEqual([])
    expect(heldPaths(sendBack, now, undefined, CL_LIVE)).toEqual([
      'specs/queen/holds.t27',
    ])
    expect(heldPaths(running, now, undefined, CL_LIVE)).toEqual(['a.t27'])
  })
})

/** A pool that answers the SELECT with `rows` and records every statement. */
function fakePool(
  rows: Array<{ issue: number; branch: string; send_backs: number }>,
) {
  const statements: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      statements.push({ sql, params })
      if (/^\s*SELECT/.test(sql)) return { rows, rowCount: rows.length }
      return { rows: [], rowCount: 1 }
    },
  }
  return { pool: pool as unknown as Pool, statements }
}

const pr = (
  number: number,
  state: 'open' | 'closed',
  merged = false,
): PullRequest => ({
  number,
  state,
  merged,
  headSha: `sha${number}`,
})

/** No required check is red, so only the closed-PR rule can write anything. */
function deps(pulls: PullRequest[] | null): CiDeps {
  return {
    requiredChecks: async () => ['validate'],
    pullsForBranch: async () => pulls,
    checkRuns: async () => [],
    jobLog: async () => null,
    changesRequested: async () => null,
  }
}

const freed = (statements: Array<{ sql: string; params: unknown[] }>) =>
  statements.filter((s) => /SET review_state = 'failed'/.test(s.sql))

describe('TRIOS_QUEEN_FREE_CLOSED_PR: an accept whose pull request closed unmerged', () => {
  const row = [{ issue: 4374, branch: 'queen-4374', send_backs: 0 }]

  it('off: a closed-unmerged PR changes nothing (today)', async () => {
    const { pool, statements } = fakePool(row)
    const taken = await takeBackRefusedAcceptances(
      pool,
      deps([pr(4565, 'closed')]),
      8,
      {},
    )
    expect(taken).toEqual([])
    expect(freed(statements)).toEqual([])
  })

  it('on: only closed-unmerged PRs free the issue, with the PR named in the note', async () => {
    const { pool, statements } = fakePool(row)
    const taken = await takeBackRefusedAcceptances(
      pool,
      deps([pr(4565, 'closed'), pr(4400, 'closed')]),
      8,
      { TRIOS_QUEEN_FREE_CLOSED_PR: 'on' },
    )
    expect(taken).toEqual([
      { issue: 4374, pull: 4565, state: 'failed', checks: [] },
    ])
    const writes = freed(statements)
    expect(writes.length).toBe(1)
    expect(writes[0]?.sql).toContain(
      "WHERE issue = $1 AND review_state = 'accept'",
    )
    expect(writes[0]?.params[0]).toBe(4374)
    expect(String(writes[0]?.params[1])).toContain(
      'Pull request #4565 for queen-4374 was closed without merging',
    )
  })

  it('on: an open PR, a merged PR, no PR, or an unread list frees nothing', async () => {
    for (const pulls of [
      [pr(7613, 'open')],
      [pr(4536, 'closed'), pr(7613, 'open')], // #4372 at 12:47Z
      [pr(6853, 'closed', true)], // #5074, merged
      [pr(1, 'closed'), pr(2, 'closed', true)],
      [], // the 213: the accepted head waits in the export
      null, // GitHub could not be read
    ]) {
      const { pool, statements } = fakePool(row)
      const taken = await takeBackRefusedAcceptances(pool, deps(pulls), 8, {
        TRIOS_QUEEN_FREE_CLOSED_PR: 'on',
      })
      expect(taken.filter((t) => t.state === 'failed')).toEqual([])
      expect(freed(statements)).toEqual([])
    }
  })

  it('on: a row a review moved meanwhile is not overwritten', async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = []
    const pool = {
      async query(sql: string, params: unknown[] = []) {
        statements.push({ sql, params })
        if (/^\s*SELECT/.test(sql)) return { rows: row, rowCount: 1 }
        if (/SET review_state = 'failed'/.test(sql))
          return { rows: [], rowCount: 0 }
        return { rows: [], rowCount: 1 }
      },
    } as unknown as Pool
    const taken = await takeBackRefusedAcceptances(
      pool,
      deps([pr(4565, 'closed')]),
      8,
      {
        TRIOS_QUEEN_FREE_CLOSED_PR: 'on',
      },
    )
    expect(taken).toEqual([])
  })

  it('adds no GitHub read: one pullsForBranch per row, flag on or off', async () => {
    for (const env of [{}, { TRIOS_QUEEN_FREE_CLOSED_PR: 'on' }]) {
      let reads = 0
      const counted: CiDeps = {
        ...deps([pr(4565, 'closed')]),
        pullsForBranch: async () => {
          reads += 1
          return [pr(4565, 'closed')]
        },
      }
      const { pool } = fakePool(row)
      await takeBackRefusedAcceptances(pool, counted, 8, env)
      expect(reads).toBe(1)
    }
  })
})
