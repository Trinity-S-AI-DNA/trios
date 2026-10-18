/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE REVIEWER, ON ITS OWN CLOCK (gHashTag/t27 specs/queen/reviewer.t27,
 * t27#7840).
 *
 * WHY. Measured 2026-10-08: bees finished 47 tasks an hour and the Queen
 * reviewed 23. The sweep ran inside the round, before it handed out work: at
 * most 3 reviews, one after another, in at most 45 s - about one review a
 * round - while finished work queued up and held its files.
 *
 * WHAT DECIDES. The card, as generated wasm: review_slots (how many rows a
 * pass starts), visit_first (the order: never-visited, then longest ago) and
 * round_reviews (the round stands aside while this runs). This file runs the
 * passes: only while this process holds the Queen's lease, one row per sweep,
 * never one row twice at once, each sweep on a lane no bee and no sibling
 * holds. The steps that write to the checkout (a runner's branch imported, a
 * worktree added or removed) run one at a time; everything else - criterion
 * commands, the witness, the model calls - runs side by side.
 */

import type { Pool } from 'pg'
import { logger } from '../../lib/logger'
import { importRunnerBranch } from '../routes/queen-export'
import { flag, loadCardWasm, u32 } from './queen-card-wasm'
import { defaultExec, type Exec, measureCriteria } from './queen-criteria-run'
import { queenHolderName } from './queen-lease'
import type { LaneGate } from './queen-review-lanes'
import type { ReviewDeps } from './queen-reviewer'
import {
  REVIEW_ROW_SECONDS,
  REVIEWER_EVERY_SECONDS,
} from './queen-reviewer-card.gen'
import { asStep } from './queen-turn-stop'

export const REVIEWER_CARD = 'queen/reviewer.wasm'

const card = () => loadCardWasm(REVIEWER_CARD)
export const reviewSlots = (inFlight: number, waiting: number): number =>
  card().call('review_slots', u32(inFlight), u32(waiting))
/** The same rule against a bound the host computed (reviewer_concurrency). */
export const reviewSlotsWithin = (
  bound: number,
  inFlight: number,
  waiting: number,
): number =>
  card().call('review_slots_within', u32(bound), u32(inFlight), u32(waiting))
export const visitFirst = (
  a: number | undefined,
  b: number | undefined,
  now: number,
): boolean =>
  card().call(
    'visit_first',
    flag(a === undefined),
    u32(a === undefined ? 0 : (now - a) / 1000),
    flag(b === undefined),
    u32(b === undefined ? 0 : (now - b) / 1000),
  ) !== 0
export const roundReviews = (reviewerRunning: boolean): boolean =>
  card().call('round_reviews', flag(reviewerRunning)) !== 0
export const dueAgain = (waits: number, sinceVisitMs: number): boolean =>
  card().call('due_again', u32(waits), u32(sinceVisitMs / 1000)) !== 0

/**
 * A RUNNER ROW WITH NO BUNDLE, PAST THE GRACE, IS AN EMPTY ATTEMPT
 * (no_bundle_is_empty, gHashTag/t27#9069). Measured 07:10-09:43Z on
 * 2026-10-11: 425 of 480 reviewer visits answered `wait` because the diff of
 * queen-N could not be read. A runner stores a bundle only for a bee that
 * committed something, so a bee that committed nothing left no branch here
 * and its row waited for the six-hour frozen-wait valve with its issue
 * claimed; a container bee that commits nothing is `empty` at once. The card
 * waits NO_BUNDLE_GRACE_MINUTES first, because the bundle is stored after the
 * turn ends (15 arrived late in that window, the latest 58 s after the first
 * visit).
 */
export const noBundleIsEmpty = (
  onRunner: boolean,
  bundleStored: boolean,
  minutesSinceFinished: number,
): boolean =>
  card().call(
    'no_bundle_is_empty',
    flag(onRunner),
    flag(bundleStored),
    u32(minutesSinceFinished),
  ) !== 0

/** TRIOS_QUEEN_NO_BUNDLE_EMPTY=on: the review asks `noBundleIsEmpty`. Off by default. */
export const noBundleEmptyEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => (env.TRIOS_QUEEN_NO_BUNDLE_EMPTY ?? '').trim() === 'on'

let running = false

/**
 * What the reviewer judged since the round last asked, so the round's report
 * still says what was accepted, sent back and escalated.
 */
export interface Judged {
  acted: string[]
  strays: Array<{ issue: number; paths: string[] }>
  tally: unknown[]
}
let judged: Judged = { acted: [], strays: [], tally: [] }

/** Hand the round what the reviewer judged since it last asked, and start over. */
export function drainReviewerRound<T extends Judged>(): T {
  const out = judged
  judged = { acted: [], strays: [], tally: [] }
  return out as T
}

/** Whether this process runs the reviewer; the round asks before it sweeps. */
export function reviewerRunning(): boolean {
  return running
}

/** One-at-a-time, for the steps that write to the shared checkout. */
export function serialized<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  let chain: Promise<unknown> = Promise.resolve()
  return (...args: A) => {
    const run = chain.then(() => fn(...args))
    chain = run.catch(() => undefined)
    return run
  }
}

export interface ReviewerDeps {
  /** Whether this process holds the Queen's lease now. */
  holdsLease: () => Promise<boolean>
  /** The issues waiting for a review, in the sweep's own order. */
  waiting: () => Promise<number[]>
  /**
   * One sweep over one issue; lanes held by siblings are passed in. `signal`
   * stops it (turn_stop.t27): the actor reviewer passes its turn's. `lanes`
   * is its gate into the lane queue (review_lanes.t27), actors only.
   */
  reviewOne: (
    issue: number,
    reservedKeys: () => number[],
    onLane: (keyIndex: number | undefined) => void,
    signal?: AbortSignal,
    lanes?: LaneGate,
  ) => Promise<Judged>
  now?: () => number
}

/**
 * The reviewer's state and one pass. Exported apart from the timer so a test
 * can drive passes and watch what it starts.
 */
export function createReviewer(deps: ReviewerDeps) {
  const inFlight = new Set<number>()
  const lanes = new Map<number, number>()
  const lastVisited = new Map<number, number>()
  const now = deps.now ?? Date.now

  const pass = async (): Promise<number[]> => {
    if (!(await deps.holdsLease())) return []
    const waiting = (await deps.waiting()).filter((n) => !inFlight.has(n))
    if (waiting.length === 0) return []
    const at = now()
    // visit_first as a comparator; the sort is stable, so ties keep the
    // sweep's own order (the longest-waiting row first)
    const ordered = [...waiting].sort((a, b) => {
      if (visitFirst(lastVisited.get(a), lastVisited.get(b), at)) return -1
      if (visitFirst(lastVisited.get(b), lastVisited.get(a), at)) return 1
      return 0
    })
    const take = ordered.slice(0, reviewSlots(inFlight.size, ordered.length))
    for (const issue of take) {
      inFlight.add(issue)
      lastVisited.set(issue, at)
      void deps
        .reviewOne(
          issue,
          () => [...lanes.values()],
          (keyIndex) => {
            if (typeof keyIndex === 'number') lanes.set(issue, keyIndex)
          },
        )
        .then(recordJudged)
        .catch((error) =>
          logger.warn('Queen reviewer could not review a row', {
            issue,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(() => {
          inFlight.delete(issue)
          lanes.delete(issue)
        })
    }
    if (lastVisited.size > 10_000) lastVisited.clear()
    return take
  }
  return { pass, inFlight }
}

/** What one review needs from this process, shared by the loop and the actors. */
export type ReviewFn = (
  pool: Pool,
  overrides: Partial<ReviewDeps>,
  scope: {
    issues: number[]
    reservedKeys: () => number[]
    onLane: (lane: { keyIndex?: number }) => void
    deadlineMs: number
    /** Stops the sweep at its next await, before it writes anything. */
    signal?: AbortSignal
    /** With no lane free at the model call, wait here (review_lanes.t27). */
    lanes?: LaneGate
  },
) => Promise<Judged>

/**
 * A row that keeps answering `wait` is visited less and less (reviewer.t27
 * revisit_after_seconds, due_again). Both runtimes go through this, so the
 * loop and the actors see the same rows. The counts live in memory: a restart
 * forgets them, and the cost of that is one early visit per row.
 */
export function withWaitBackoff(
  deps: ReviewerDeps,
  now: () => number = Date.now,
): ReviewerDeps {
  const waits = new Map<number, { n: number; at: number }>()
  return {
    ...deps,
    waiting: async () => {
      const at = now()
      return (await deps.waiting()).filter((issue) => {
        const w = waits.get(issue)
        return !w || dueAgain(w.n, at - w.at)
      })
    },
    reviewOne: async (issue, reservedKeys, onLane, signal, lanes) => {
      const round = await deps.reviewOne(
        issue,
        reservedKeys,
        onLane,
        signal,
        lanes,
      )
      if (round.acted.includes(`#${issue}:wait`))
        waits.set(issue, { n: (waits.get(issue)?.n ?? 0) + 1, at: now() })
      else waits.delete(issue)
      if (waits.size > 10_000) waits.clear()
      return round
    },
  }
}

/**
 * Only the git commands that change the shared checkout's worktree list run
 * one at a time. A measurement cuts its own worktree in its own temporary
 * directory, and its criterion commands run there, side by side with every
 * other review's. Before this, the whole measurement waited in one queue,
 * commands included, with a budget of up to 5 minutes each.
 */
const worktreeLock = serialized(<T>(fn: () => Promise<T>) => fn())
// A worktree command writes the checkout's shared worktree list: a stopped
// review lets one under way finish (turn_stop.t27 step_on_abort).
const worktreeSerialExec: Exec = (request) =>
  request.argv[0] === 'git' && request.argv.includes('worktree')
    ? (asStep({ writesShared: true }, () =>
        worktreeLock(() => defaultExec(request)),
      ) as ReturnType<Exec>)
    : defaultExec(request)

export function reviewerDeps(
  pool: Pool,
  leaseName: string,
  review: ReviewFn,
  waiting: (pool: Pool) => Promise<number[]>,
): ReviewerDeps {
  const overrides: Partial<ReviewDeps> = {
    reviewsPerRound: () => 1,
    measurementsPerRound: () => 1,
    measureCriteria: async (issue, headSha, criteria, baseSha) => {
      const t0 = Date.now()
      const measured = await measureCriteria(issue, headSha, criteria, {
        baseSha,
        exec: worktreeSerialExec,
      })
      logger.info('Queen reviewer measured', {
        issue,
        ms: Date.now() - t0,
        ok: measured.ok,
      })
      return measured
    },
    // brings a branch into the shared checkout: a write other reviews share
    importRunnerBranch: serialized((issue: number) =>
      asStep({ writesShared: true }, () => importRunnerBranch(pool, issue)),
    ),
  }
  return withWaitBackoff({
    holdsLease: async () => {
      const r = await pool.query(
        `SELECT 1 FROM queen_lease
          WHERE name = $1 AND holder = $2 AND expires_at > now()`,
        [leaseName, queenHolderName()],
      )
      return (r.rowCount ?? r.rows.length) > 0
    },
    waiting: () => waiting(pool),
    reviewOne: async (issue, reservedKeys, onLane, signal, lanes) => {
      const t0 = Date.now()
      const round = await review(pool, overrides, {
        issues: [issue],
        reservedKeys,
        onLane: (lane) => onLane(lane.keyIndex),
        deadlineMs: REVIEW_ROW_SECONDS * 1000,
        signal,
        lanes,
      })
      // one line per row, for the throughput arithmetic of t27#7851
      logger.info('Queen reviewer row', {
        issue,
        ms: Date.now() - t0,
        verdicts: round.acted,
      })
      return round
    },
  })
}

/** The actor reviewer reports here, so the round's report reads the same. */
export function recordJudged(round: Judged): void {
  judged.acted.push(...round.acted)
  judged.strays.push(...round.strays)
  judged.tally.push(...round.tally)
}

/** Set while some reviewer runs in this process; the round stands aside. */
export function setReviewerRunning(on: boolean): void {
  running = on
}

/**
 * Start the reviewer in this process. The round's sweep stands aside from the
 * first pass on (round_reviews). Off with TRIOS_QUEEN_REVIEWER=off, which
 * hands reviewing back to the round as before.
 */
export function startReviewer(
  pool: Pool,
  leaseName: string,
  review: ReviewFn,
  waiting: (pool: Pool) => Promise<number[]>,
): (() => void) | null {
  if ((process.env.TRIOS_QUEEN_REVIEWER ?? 'on').toLowerCase() === 'off')
    return null
  const reviewer = createReviewer(
    reviewerDeps(pool, leaseName, review, waiting),
  )
  running = true
  logger.info('Queen reviewer starting', {
    everySeconds: REVIEWER_EVERY_SECONDS,
  })
  const timer = setInterval(() => {
    reviewer.pass().catch((error) =>
      logger.warn('Queen reviewer pass failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }, REVIEWER_EVERY_SECONDS * 1000)
  return () => {
    clearInterval(timer)
    running = false
  }
}
