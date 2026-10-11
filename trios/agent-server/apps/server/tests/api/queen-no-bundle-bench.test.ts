/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE BENCHMARK BEFORE THE SWAP, FOR RUNNER BEES THAT LEFT NO BUNDLE
 * (reviewer.t27 no_bundle_is_empty, gHashTag/t27#9069; numbers on
 * t27#7851). The owner's rule: a mechanism replaces another only after both
 * run the same input and the numbers are posted.
 *
 * The input is recorded, not drawn: fixtures/queen-no-bundle-window.json,
 * every reviewer visit of 2026-10-11 07:10-10:31Z whose diff of queen-N
 * could not be read, cut into 56 runner attempts on 51 issues. Each visit is
 * replayed through the real review sweep (`reviewFinishedDispatches`), with
 * git and the database faked to say what that visit saw: no bundle yet, or
 * the bundle that the recorded visit brought in. `before` is the sweep with
 * TRIOS_QUEEN_NO_BUNDLE_EMPTY unset, as production runs it; `after` is the
 * sweep with it on. An attempt ends at its first verdict other than `wait`,
 * or at the visit that read its branch; one that does neither by its last
 * recorded visit is still waiting.
 *
 * What the record cannot say, stated rather than guessed: a row that already
 * waited when the window opened finished at some unknown earlier time, so its
 * clock starts at its first visit here - the latest it can have finished,
 * which can only make `after` judge it later, never sooner. And the replay
 * stops an attempt at its verdict; what the swarm would have done with the
 * freed issue next is not simulated.
 *
 * The table is printed; QUEEN_BENCH_OUT writes it as JSON too. The asserts
 * check that every attempt is accounted for, that no late bundle is ever
 * judged empty, and that `before` is today's wait.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import type { ReviewDeps } from '../../src/api/services/queen-reviewer'
import { NO_BUNDLE_GRACE_MINUTES } from '../../src/api/services/queen-reviewer-card.gen'
import { reviewFinishedDispatches } from '../../src/api/services/queen-tick'
import { logger } from '../../src/lib/logger'

interface Attempt {
  issue: number
  kind: 'before-window' | 'dispatched' | 'redispatched-unlogged'
  t0: string
  visits: number[]
  bundleAt: number | null
}

const window = JSON.parse(
  readFileSync(
    join(import.meta.dir, 'fixtures/queen-no-bundle-window.json'),
    'utf8',
  ),
) as { windowStart: string; windowEnd: string; attempts: Attempt[] }

const FLAG = 'TRIOS_QUEEN_NO_BUNDLE_EMPTY'

type Outcome =
  | { end: 'branch'; atSec: number; sweeps: number }
  | { end: 'empty' | 'escalate'; atSec: number; sweeps: number }
  | { end: 'waiting'; atSec: number; sweeps: number }

/** One recorded visit, through the real sweep. */
async function visit(a: Attempt, n: number, atSec: number): Promise<string> {
  const stored = a.bundleAt !== null && atSec >= a.bundleAt
  const row = {
    issue: a.issue,
    conversation_id: `${a.issue}-${a.t0}`,
    criteria: [],
    criteria_source: 'stated',
    send_backs: 0,
    free_attempts: 0,
    owned_paths: [],
    said: '',
    claimed_by: 'runner',
  }
  const pool = {
    query: async (sql: string) => {
      if (String(sql).includes('FROM queen_dispatch d'))
        return { rowCount: 1, rows: [row] }
      if (String(sql).includes('FROM queen_issues'))
        return { rowCount: 1, rows: [{ n: '1' }] }
      return { rowCount: 0, rows: [] }
    },
  } as unknown as Pool
  const deps: Partial<ReviewDeps> = {
    importRunnerBranch: async () => ({ ok: true, imported: stored }),
    committedFilesResult: async () =>
      stored
        ? { ok: true, files: [`specs/queen/issue-${a.issue}.t27`] }
        : {
            ok: false,
            error: `unknown revision queen-${a.issue} (visit ${n})`,
          },
    runnerBundleFacts: async () => ({
      stored,
      minutesSinceFinished: Math.floor(atSec / 60),
    }),
    branchHeadSha: async () => 'b'.repeat(40),
    mergeBaseSha: async () => null,
    worktreeDirtCount: async () => null,
    witness: async () => ({ kind: 'witnessed', t27c: 't27c', specs: [] }),
    laneCandidates: () => [],
  }
  const round = await reviewFinishedDispatches(pool, deps)
  // the branch was read: from here on the row is judged on it
  if (stored) return 'branch'
  return String(round.acted[0] ?? '').split(':')[1] ?? ''
}

async function replay(a: Attempt): Promise<Outcome> {
  let sweeps = 0
  for (const [n, atSec] of a.visits.entries()) {
    sweeps += 1
    const answer = await visit(a, n, atSec)
    if (answer === 'branch') return { end: 'branch', atSec, sweeps }
    if (answer === 'empty' || answer === 'escalate')
      return { end: answer, atSec, sweeps }
    expect(answer).toBe('wait')
  }
  return { end: 'waiting', atSec: a.visits[a.visits.length - 1], sweeps }
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null
  const s = [...xs].sort((x, y) => x - y)
  return s.length % 2
    ? s[(s.length - 1) / 2]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const minutes = (sec: number | null) =>
  sec === null ? '-' : (sec / 60).toFixed(1)

interface Arm {
  arm: string
  noBundle: number
  judgedEmpty: number
  issuesJudged: number
  stillWaiting: number
  minutesWaitedInRecord: { median: number | null; max: number | null }
  minutesToVerdict: { median: number | null; max: number | null }
  sweepsOnNoBundle: number
  lateBundles: number
  lateReadOnBranch: number
  lateMisjudged: number
  byKind: Record<string, { attempts: number; judged: number }>
}

function summarize(arm: string, out: Array<{ a: Attempt; o: Outcome }>): Arm {
  const none = out.filter(({ a }) => a.bundleAt === null)
  const late = out.filter(({ a }) => a.bundleAt !== null)
  const judged = none.filter(
    ({ o }) => o.end === 'empty' || o.end === 'escalate',
  )
  const byKind: Arm['byKind'] = {}
  for (const { a, o } of none) {
    byKind[a.kind] ??= { attempts: 0, judged: 0 }
    byKind[a.kind].attempts += 1
    if (o.end === 'empty' || o.end === 'escalate') byKind[a.kind].judged += 1
  }
  const at = judged.map(({ o }) => o.atSec)
  const waited = none
    .filter(({ o }) => o.end === 'waiting')
    .map(({ o }) => o.atSec)
  return {
    arm,
    noBundle: none.length,
    judgedEmpty: judged.length,
    issuesJudged: new Set(judged.map(({ a }) => a.issue)).size,
    stillWaiting: waited.length,
    minutesWaitedInRecord: {
      median: median(waited),
      max: waited.length ? Math.max(...waited) : null,
    },
    minutesToVerdict: {
      median: median(at),
      max: at.length ? Math.max(...at) : null,
    },
    sweepsOnNoBundle: none.reduce((n, { o }) => n + o.sweeps, 0),
    lateBundles: late.length,
    lateReadOnBranch: late.filter(({ o }) => o.end === 'branch').length,
    lateMisjudged: late.filter(({ o }) => o.end !== 'branch').length,
    byKind,
  }
}

let level: Parameters<typeof logger.setLevel>[0] = 'info'
beforeAll(() => {
  level = (logger as unknown as { level: typeof level }).level ?? 'info'
  logger.setLevel('error')
})
afterAll(() => logger.setLevel(level))

describe('no_bundle_is_empty on the recorded window, before and after', () => {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const key of [FLAG, 'TRIOS_QUEEND_PATH', 'WORKSPACE_DIR']) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    process.env.TRIOS_QUEEND_PATH = join(
      tmpdir(),
      'queen-no-bundle-bench-no-queend',
    )
    process.env.WORKSPACE_DIR = join(tmpdir(), 'queen-no-bundle-bench-no-such')
  })
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('judges the rows that never got a bundle, and no late bundle', async () => {
    const arms: Arm[] = []
    const outcomes: Record<string, Array<{ a: Attempt; o: Outcome }>> = {}
    for (const [arm, flag] of [
      ['before (flag unset)', undefined],
      ['after (flag on)', 'on'],
    ] as const) {
      if (flag) process.env[FLAG] = flag
      else delete process.env[FLAG]
      const out: Array<{ a: Attempt; o: Outcome }> = []
      for (const a of window.attempts) out.push({ a, o: await replay(a) })
      outcomes[arm] = out
      arms.push(summarize(arm, out))
    }
    const [before, after] = arms

    const rows = [
      ['', before.arm, after.arm],
      [
        'runner attempts with no bundle in the window',
        before.noBundle,
        after.noBundle,
      ],
      ['  judged empty', before.judgedEmpty, after.judgedEmpty],
      [
        '  distinct issues judged empty',
        before.issuesJudged,
        after.issuesJudged,
      ],
      [
        '  still waiting at their last recorded visit',
        before.stillWaiting,
        after.stillWaiting,
      ],
      [
        '  minutes those had waited since their first visit, median / max',
        `${minutes(before.minutesWaitedInRecord.median)} / ${minutes(before.minutesWaitedInRecord.max)}`,
        `${minutes(after.minutesWaitedInRecord.median)} / ${minutes(after.minutesWaitedInRecord.max)}`,
      ],
      [
        '  minutes from first visit to verdict, median / max',
        `${minutes(before.minutesToVerdict.median)} / ${minutes(before.minutesToVerdict.max)}`,
        `${minutes(after.minutesToVerdict.median)} / ${minutes(after.minutesToVerdict.max)}`,
      ],
      [
        '  reviewer visits spent on them',
        before.sweepsOnNoBundle,
        after.sweepsOnNoBundle,
      ],
      ...Object.keys(after.byKind)
        .sort()
        .map((kind) => [
          `  ${kind}: judged / attempts`,
          `${before.byKind[kind]?.judged ?? 0} / ${before.byKind[kind]?.attempts ?? 0}`,
          `${after.byKind[kind].judged} / ${after.byKind[kind].attempts}`,
        ]),
      [
        'runner attempts whose bundle came late',
        before.lateBundles,
        after.lateBundles,
      ],
      [
        '  read on their branch',
        before.lateReadOnBranch,
        after.lateReadOnBranch,
      ],
      ['  misjudged empty', before.lateMisjudged, after.lateMisjudged],
    ]
    console.log(
      `\nno_bundle_is_empty, grace ${NO_BUNDLE_GRACE_MINUTES} min, window ${window.windowStart} - ${window.windowEnd}\n` +
        rows.map((r) => `| ${r.join(' | ')} |`).join('\n'),
    )
    if (process.env.QUEEN_BENCH_OUT)
      writeFileSync(
        process.env.QUEEN_BENCH_OUT,
        JSON.stringify({ arms, outcomes }, null, 2),
      )

    // every attempt is accounted for, in both arms
    expect(before.noBundle + before.lateBundles).toBe(window.attempts.length)
    expect(after.noBundle + after.lateBundles).toBe(window.attempts.length)
    // before: today's wait - nothing judged, every recorded visit spent
    expect(before.judgedEmpty).toBe(0)
    expect(before.sweepsOnNoBundle).toBe(
      window.attempts
        .filter((a) => a.bundleAt === null)
        .reduce((n, a) => n + a.visits.length, 0),
    )
    // no late bundle is ever judged empty, in either arm
    expect(before.lateMisjudged).toBe(0)
    expect(after.lateMisjudged).toBe(0)
    expect(after.lateReadOnBranch).toBe(after.lateBundles)
    // after: judged at the first recorded visit past the grace, and never before it
    for (const { a, o } of outcomes[after.arm]) {
      if (a.bundleAt !== null) continue
      const pastGrace = a.visits.find((s) => s >= NO_BUNDLE_GRACE_MINUTES * 60)
      if (pastGrace === undefined) expect(o.end).toBe('waiting')
      else expect(o).toMatchObject({ end: 'empty', atSec: pastGrace })
    }
  }, 120_000)
})
