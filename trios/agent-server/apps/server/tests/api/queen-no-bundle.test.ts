/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A RUNNER BEE THAT COMMITTED NOTHING (gHashTag/t27#9069; reviewer.t27
 * no_bundle_is_empty; TRIOS_QUEEN_NO_BUNDLE_EMPTY, off by default).
 *
 * The card as the wasm runs it, then the review sweep on one runner row
 * whose diff cannot be read: with the flag off it is today's `wait`, byte for
 * byte; with it on, a row inside the grace still waits, one past it is
 * `empty` exactly as a container bee that committed nothing, and a bundle
 * that arrives 40 s late is judged on its branch. The database is a
 * recording fake and git is injected, as in queen-review-unjudged.test.ts;
 * no case here reaches queend.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { runnerBundleFacts } from '../../src/api/routes/queen-export'
import { loadCardWasm } from '../../src/api/services/queen-card-wasm'
import {
  noBundleEmptyEnabled,
  noBundleIsEmpty,
  REVIEWER_CARD,
} from '../../src/api/services/queen-review-loop'
import type { ReviewDeps } from '../../src/api/services/queen-reviewer'
import { NO_BUNDLE_GRACE_MINUTES } from '../../src/api/services/queen-reviewer-card.gen'
import { reviewFinishedDispatches } from '../../src/api/services/queen-tick'

const ISSUE = 9069
const CONVERSATION = '00000000-0000-0000-0000-000000009069'
const FLAG = 'TRIOS_QUEEN_NO_BUNDLE_EMPTY'

describe('the reviewer card exports every fn, no_bundle_is_empty included', () => {
  it('answers for each export', () => {
    const card = loadCardWasm(REVIEWER_CARD)
    for (const fn of [
      'reviewer_concurrency',
      'slots_needed',
      'keeps_up',
      'review_slots_within',
      'review_slots',
      'visit_first',
      'round_reviews',
      'revisit_after_seconds',
      'due_again',
      'no_bundle_is_empty',
    ])
      expect(() => card.call(fn, 0, 0, 0, 0, 0)).not.toThrow()
  })
})

describe('no_bundle_is_empty, as the wasm runs it', () => {
  it('a runner row with no bundle is empty once the grace has passed', () => {
    expect(NO_BUNDLE_GRACE_MINUTES).toBe(10)
    expect(noBundleIsEmpty(true, false, NO_BUNDLE_GRACE_MINUTES)).toBe(true)
    expect(noBundleIsEmpty(true, false, 360)).toBe(true)
    expect(noBundleIsEmpty(true, false, 0xffff_ffff)).toBe(true)
  })
  it('inside the grace it waits', () => {
    expect(noBundleIsEmpty(true, false, 0)).toBe(false)
    expect(noBundleIsEmpty(true, false, NO_BUNDLE_GRACE_MINUTES - 1)).toBe(
      false,
    )
  })
  it('a container row and a stored bundle are never decided here', () => {
    expect(noBundleIsEmpty(false, false, 360)).toBe(false)
    expect(noBundleIsEmpty(true, true, 360)).toBe(false)
  })
})

describe('TRIOS_QUEEN_NO_BUNDLE_EMPTY', () => {
  it('is off unless it says on', () => {
    expect(noBundleEmptyEnabled({})).toBe(false)
    expect(noBundleEmptyEnabled({ [FLAG]: '' })).toBe(false)
    expect(noBundleEmptyEnabled({ [FLAG]: 'off' })).toBe(false)
    expect(noBundleEmptyEnabled({ [FLAG]: '1' })).toBe(false)
    expect(noBundleEmptyEnabled({ [FLAG]: ' on ' })).toBe(true)
  })
})

describe('runnerBundleFacts reads one row for the attempt being judged', () => {
  const at = Date.parse('2026-10-11T08:00:00Z')
  const poolAnswering = (rows: unknown[]) => {
    const asked: Array<{ sql: string; params: unknown[] }> = []
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        asked.push({ sql, params })
        return { rows }
      },
    } as unknown as Pick<Pool, 'query'>
    return { pool, asked }
  }
  it('whole minutes since the finish, and whether a bundle is stored', async () => {
    const { pool, asked } = poolAnswering([
      { finished_at: new Date(at), stored: false },
    ])
    expect(
      await runnerBundleFacts(pool, ISSUE, CONVERSATION, at + 10 * 60_000 - 1),
    ).toEqual({ stored: false, minutesSinceFinished: 9 })
    expect(asked[0].params).toEqual([ISSUE, CONVERSATION])
    expect(asked[0].sql).toContain('FROM queen_bundle')
  })
  it('an answer that is not a plain false is a stored bundle', async () => {
    const { pool } = poolAnswering([{ finished_at: new Date(at), stored: 't' }])
    expect((await runnerBundleFacts(pool, ISSUE, null, at))?.stored).toBe(true)
  })
  it('no finished row for the attempt, or no readable clock, decides nothing', async () => {
    expect(
      await runnerBundleFacts(poolAnswering([]).pool, ISSUE, null, at),
    ).toBeNull()
    expect(
      await runnerBundleFacts(
        poolAnswering([{ finished_at: 'never', stored: false }]).pool,
        ISSUE,
        null,
        at,
      ),
    ).toBeNull()
  })
})

interface Row {
  issue: number
  conversation_id: string
  criteria: string[]
  criteria_source: string
  send_backs: number
  free_attempts: number
  owned_paths: string[]
  said: string
  claimed_by: string | null
}

const runnerRow = (over: Partial<Row> = {}): Row => ({
  issue: ISSUE,
  conversation_id: CONVERSATION,
  criteria: [],
  criteria_source: 'stated',
  send_backs: 0,
  free_attempts: 0,
  owned_paths: ['specs/queen/reviewer.t27'],
  said: '',
  claimed_by: 'runner-a',
  ...over,
})

/** Postgres, answering the shapes the review asks for and recording them. */
function reviewPool(rows: Row[]) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql: String(sql), params })
      if (String(sql).includes('FROM queen_dispatch d'))
        return { rowCount: rows.length, rows }
      return { rowCount: 0, rows: [] }
    },
  } as unknown as Pool
  return { pool, queries }
}

/** The UPDATE that records a verdict. */
const verdictOf = (queries: Array<{ sql: string; params: unknown[] }>) =>
  queries.find(
    (q) =>
      q.sql.includes('UPDATE queen_dispatch') &&
      q.sql.includes('review_state ='),
  )

const DIFF_FAILED =
  "fatal: ambiguous argument 'origin/master...queen-9069': unknown revision"

/**
 * A runner's bee seen at `minutes` after its turn ended. `bundle` says
 * whether the runner has stored it by then; the git and the facts follow.
 */
function runnerAt(
  minutes: number,
  bundle: boolean,
  asked: { facts: number; witness: string[][] } = { facts: 0, witness: [] },
): Partial<ReviewDeps> {
  return {
    importRunnerBranch: async () => ({ ok: true, imported: bundle }),
    committedFilesResult: async () =>
      bundle
        ? { ok: true, files: ['specs/queen/reviewer.t27'] }
        : { ok: false, error: DIFF_FAILED },
    runnerBundleFacts: async () => {
      asked.facts += 1
      return { stored: bundle, minutesSinceFinished: minutes }
    },
    branchHeadSha: async () => 'a'.repeat(40),
    mergeBaseSha: async () => null,
    worktreeDirtCount: async () => null,
    witness: async (_issue, files) => {
      asked.witness.push(files)
      return { kind: 'witnessed', t27c: 't27c', specs: [] }
    },
    laneCandidates: () => [],
  }
}

describe('the review of a runner row whose diff cannot be read', () => {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const key of [FLAG, 'TRIOS_QUEEND_PATH', 'WORKSPACE_DIR']) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    // no queend and no workspace: nothing here reaches a real policy or git
    process.env.TRIOS_QUEEND_PATH = join(tmpdir(), 'queen-no-bundle-no-queend')
    process.env.WORKSPACE_DIR = join(tmpdir(), 'queen-no-bundle-no-such')
  })
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  const TODAY_NOTE =
    `The diff of queen-${ISSUE} could not be read (${DIFF_FAILED}), ` +
    'so nothing was judged this round and nothing was counted.'

  it('flag off: today, byte for byte - a wait, and the facts are never asked', async () => {
    const asked = { facts: 0, witness: [] as string[][] }
    const off = reviewPool([runnerRow()])
    const reviewedOff = await reviewFinishedDispatches(
      off.pool,
      runnerAt(360, false, asked),
    )
    // the same sweep with no fact source at all: what the code did before
    const before = reviewPool([runnerRow()])
    const reviewedBefore = await reviewFinishedDispatches(before.pool, {
      ...runnerAt(360, false),
      runnerBundleFacts: undefined,
    })
    expect(asked.facts).toBe(0)
    expect(reviewedOff.acted).toEqual([`#${ISSUE}:wait`])
    expect(reviewedOff).toEqual(reviewedBefore)
    expect(off.queries).toEqual(before.queries)
    const verdict = verdictOf(off.queries)
    expect(verdict?.params[1]).toBe('wait')
    expect(verdict?.params[2]).toBe(TODAY_NOTE)
    expect(verdict?.params[4]).toBe(false)
    expect(verdict?.params[5]).toBe(0)
  })

  it('flag set to anything but on is off', async () => {
    process.env[FLAG] = 'yes'
    const asked = { facts: 0, witness: [] as string[][] }
    const { pool, queries } = reviewPool([runnerRow()])
    const reviewed = await reviewFinishedDispatches(
      pool,
      runnerAt(360, false, asked),
    )
    expect(asked.facts).toBe(0)
    expect(reviewed.acted).toEqual([`#${ISSUE}:wait`])
    expect(verdictOf(queries)?.params[2]).toBe(TODAY_NOTE)
  })

  it('flag on, inside the grace: it still waits, with the same note', async () => {
    process.env[FLAG] = 'on'
    const asked = { facts: 0, witness: [] as string[][] }
    const { pool, queries } = reviewPool([runnerRow()])
    const reviewed = await reviewFinishedDispatches(
      pool,
      runnerAt(NO_BUNDLE_GRACE_MINUTES - 1, false, asked),
    )
    expect(asked.facts).toBe(1)
    expect(reviewed.acted).toEqual([`#${ISSUE}:wait`])
    expect(verdictOf(queries)?.params[2]).toBe(TODAY_NOTE)
  })

  it('flag on, past the grace: empty, exactly as a container bee that committed nothing', async () => {
    process.env[FLAG] = 'on'
    const { pool, queries } = reviewPool([runnerRow({ free_attempts: 1 })])
    const reviewed = await reviewFinishedDispatches(
      pool,
      runnerAt(NO_BUNDLE_GRACE_MINUTES, false),
    )
    expect(reviewed.acted).toEqual([`#${ISSUE}:empty`])
    // the container bee's twin: a diff that read and held no commit
    const container = reviewPool([
      runnerRow({ free_attempts: 1, claimed_by: null }),
    ])
    const containerReviewed = await reviewFinishedDispatches(container.pool, {
      ...runnerAt(0, false),
      committedFilesResult: async () => ({ ok: true, files: [] }),
    })
    expect(containerReviewed.acted).toEqual([`#${ISSUE}:empty`])
    const runner = verdictOf(queries)
    const twin = verdictOf(container.queries)
    // state, counters, head and conversation are the container's
    expect(runner?.params[1]).toBe('empty')
    for (const n of [0, 1, 3, 4, 5, 6, 7, 8, 9])
      expect(runner?.params[n]).toEqual(twin?.params[n])
    // free_attempts counted once, as for the container bee
    expect(runner?.params[5]).toBe(2)
    // the note says what was seen, after the container's sentence
    expect(String(runner?.params[2])).toStartWith(String(twin?.params[2]))
    expect(String(runner?.params[2])).toContain(
      `stored no bundle of queen-${ISSUE} within ${NO_BUNDLE_GRACE_MINUTES} minutes`,
    )
  })

  it('flag on, past the grace, a container row: its failed diff still decides nothing', async () => {
    process.env[FLAG] = 'on'
    const { pool, queries } = reviewPool([runnerRow({ claimed_by: null })])
    const reviewed = await reviewFinishedDispatches(pool, runnerAt(360, false))
    expect(reviewed.acted).toEqual([`#${ISSUE}:wait`])
    expect(verdictOf(queries)?.params[2]).toBe(TODAY_NOTE)
  })

  it('flag on, past the grace, a bundle stored that would not import: still a wait', async () => {
    process.env[FLAG] = 'on'
    const { pool } = reviewPool([runnerRow()])
    const reviewed = await reviewFinishedDispatches(pool, {
      ...runnerAt(360, false),
      importRunnerBranch: async () => ({ ok: false, error: 'fetch failed' }),
      runnerBundleFacts: async () => ({
        stored: true,
        minutesSinceFinished: 360,
      }),
    })
    expect(reviewed.acted).toEqual([`#${ISSUE}:wait`])
  })

  it('flag on, the attempt is no longer the finished row: decides nothing', async () => {
    process.env[FLAG] = 'on'
    const { pool } = reviewPool([runnerRow()])
    const reviewed = await reviewFinishedDispatches(pool, {
      ...runnerAt(360, false),
      runnerBundleFacts: async () => null,
    })
    expect(reviewed.acted).toEqual([`#${ISSUE}:wait`])
  })

  it('flag on, a bundle 40 s late: waits at the first visit, then is judged on its branch', async () => {
    process.env[FLAG] = 'on'
    // the first visit, at the turn's end: no bundle yet
    const first = { facts: 0, witness: [] as string[][] }
    const one = reviewPool([runnerRow()])
    const visitOne = await reviewFinishedDispatches(
      one.pool,
      runnerAt(0, false, first),
    )
    expect(visitOne.acted).toEqual([`#${ISSUE}:wait`])
    expect(verdictOf(one.queries)?.params[2]).toBe(TODAY_NOTE)
    // 40 s later the runner has stored it: the branch is read, never empty
    const second = { facts: 0, witness: [] as string[][] }
    const two = reviewPool([runnerRow()])
    const visitTwo = await reviewFinishedDispatches(
      two.pool,
      runnerAt(0, true, second),
    )
    expect(visitTwo.acted).not.toContain(`#${ISSUE}:empty`)
    expect(second.facts).toBe(0)
    expect(second.witness).toEqual([['specs/queen/reviewer.t27']])
    expect(String(verdictOf(two.queries)?.params[2])).not.toContain(
      'could not be read',
    )
  })
})
