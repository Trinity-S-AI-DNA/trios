/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * WHEN A TASK'S FILES STOP SHUTTING OTHER BEES OUT (gHashTag/t27
 * specs/queen/holds.t27, t27#7838).
 *
 * Measured 2026-10-08 15:24Z: 32 of 70 lanes busy and the round said "nothing
 * to choose". 125 of the 135 blocked issues were shut out only by finished
 * work waiting in review - 105 of them by bootstrap/src/compiler.rs - because
 * a finished task held its files for up to 48 hours while the Queen reviewed
 * 23 tasks an hour against 47 finished.
 *
 * The card's holds_files decides, as generated wasm; this file only says which
 * stage a dispatch row is in. A row that no longer holds is handed to queend
 * with no owned paths, so it still claims its own issue (that is its state)
 * but no longer conflicts with anybody's files.
 *
 * THE ISSUE AS IT STANDS NOW (holds.t27 holds_files_now and held_part,
 * t27#9033). Measured 2026-10-11 10:57Z: 122 candidates were shut out only by
 * bootstrap/src/compiler.rs, held by the bee of #8660 - an issue closed at
 * 10:56:59Z, whose work no review reads and no publisher takes. A row also
 * kept the paths its issue named when it was dispatched, so an epic whose
 * Boundary was removed (#8095) and a narrowed `.trinity/seals/` (#8721) went
 * on shutting out the old set. The round now hands each row what it read of
 * the issue this tick; the card decides what still holds.
 */

import { flag, loadCardWasm, u32 } from './queen-card-wasm'
import {
  CL_FREE,
  CL_LIVE,
  HP_CURRENT,
  HP_STORED,
  HS_AWAITING,
  HS_DONE,
  HS_ESCALATED,
  HS_SEND_BACK,
  HS_WORKING,
} from './queen-holds.gen'
import { OBSOLETE_STATE } from './queen-review-valve.gen'

export const HOLDS_CARD = 'queen/holds.wasm'

export const holdsFiles = (stage: number, minutes: number): boolean =>
  loadCardWasm(HOLDS_CARD).call('holds_files', stage, u32(minutes)) !== 0
export const holdsFilesNow = (
  issue: IssueNow,
  stage: number,
  minutes: number,
): boolean =>
  loadCardWasm(HOLDS_CARD).call(
    'holds_files_now',
    flag(issue.known),
    flag(issue.open),
    flag(issue.boundary.length > 0),
    stage,
    u32(minutes),
  ) !== 0
/** HP_APART, HP_STORED or HP_CURRENT: which of the two paths still holds. */
export const heldPart = (stored: string, current: string): number => {
  const card = loadCardWasm(HOLDS_CARD)
  const [s, c] = card.put(stored, current)
  return card.call('held_part', s.at, s.len, c.at, c.len)
}

/**
 * A CLAIM ON THE ISSUE FOLLOWS THE WORK AS IT STANDS NOW (holds.t27,
 * t27#9111). Measured 2026-10-11: a send-back claims its issue for "the same
 * bee", which never comes back once its turn has ended (a runner deletes the
 * session at turn end), so 8 of 89 claims at 12:55Z waited out an idle hour
 * for nothing; and an accept whose pull request was closed unmerged claims its
 * issue as done for the whole 7-day window (#4374, #6414 at 12:47Z).
 *
 * CL_FREE, CL_LIVE or CL_DONE for a send-back with `sendBacks` counted.
 */
export const sendBackClaim = (sendBacks: number, ceiling: number): number =>
  loadCardWasm(HOLDS_CARD).call('send_back_claim', u32(sendBacks), u32(ceiling))
/** CL_FREE only when the branch's pull requests were read and all closed unmerged. */
export const acceptClaim = (
  read: boolean,
  open: number,
  merged: number,
  closedUnmerged: number,
): number =>
  loadCardWasm(HOLDS_CARD).call(
    'accept_claim',
    flag(read),
    u32(open),
    u32(merged),
    u32(closedUnmerged),
  )
/** The stage a row holds files at once its claim is known: a freed one holds none. */
export const heldStage = (claim: number, stage: number): number =>
  loadCardWasm(HOLDS_CARD).call('held_stage', claim, stage)

/** TRIOS_QUEEN_RELEASE_DEAD_CLAIMS=on: send_back_claim and held_stage decide. Off by default. */
export const releaseDeadClaimsEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => (env.TRIOS_QUEEN_RELEASE_DEAD_CLAIMS ?? '').trim() === 'on'

/** TRIOS_QUEEN_FREE_CLOSED_PR=on: accept_claim decides on the CI take-back's read. Off by default. */
export const freeClosedPrEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => (env.TRIOS_QUEEN_FREE_CLOSED_PR ?? '').trim() === 'on'

/**
 * The claim a row's state puts on its issue, in the card's words: the states
 * QueenDelegationPolicy.claimOnIssue reads as free are `failed` and
 * `cancelled`; live and done both keep the row's stage for its files.
 */
export function claimOfState(state: string): number {
  return state === 'failed' || state === 'cancelled' ? CL_FREE : CL_LIVE
}

/**
 * What the round read of a dispatch's issue this tick. `known` only when it
 * read the whole open list; `boundary` is the issue's Boundary as written now.
 */
export interface IssueNow {
  known: boolean
  open: boolean
  boundary: string[]
}

/** Nothing read: the stage alone decides, as before t27#9033. */
export const ISSUE_UNREAD: IssueNow = { known: false, open: true, boundary: [] }

/** The verdicts that end a task: an accepted, failed or closed one holds nothing. */
const DECIDED = new Set([
  'accept',
  'failed',
  'cancelled',
  OBSOLETE_STATE,
  'stale-contract',
])

/** A dispatch row's stage, for its files. */
export function holdStage(finished: boolean, reviewState: unknown): number {
  if (!finished) return HS_WORKING
  const verdict = String(reviewState ?? '')
  if (verdict === 'sendBack') return HS_SEND_BACK
  if (verdict === 'escalate') return HS_ESCALATED
  if (DECIDED.has(verdict)) return HS_DONE
  return HS_AWAITING
}

/**
 * The paths a dispatch row still holds against other bees: all of them while
 * the card says it holds, none after. `finishedAt` is the clock - written once
 * when the bee stops - never the verdict's time, which a wait re-writes every
 * round. With its issue read this tick, a stored path holds only where the
 * current Boundary still names it (held_part); a path the Boundary added holds
 * nothing. With `claim` given (TRIOS_QUEEN_RELEASE_DEAD_CLAIMS), a row whose
 * claim is free holds no files (held_stage): its next attempt is its own
 * issue's, and a hold against it shut that issue out by its own row.
 */
export function heldPaths(
  row: { finished_at?: unknown; review_state?: unknown; owned_paths?: unknown },
  now: number = Date.now(),
  issue: IssueNow = ISSUE_UNREAD,
  claim?: number,
): string[] {
  const owned = Array.isArray(row.owned_paths)
    ? (row.owned_paths as unknown[]).filter(
        (p): p is string => typeof p === 'string',
      )
    : []
  const finished = row.finished_at != null
  const minutes = finished
    ? Math.max(
        0,
        (now - new Date(row.finished_at as string | Date).getTime()) / 60_000,
      )
    : 0
  const stage = holdStage(finished, row.review_state)
  if (
    !holdsFilesNow(
      issue,
      claim === undefined ? stage : heldStage(claim, stage),
      minutes,
    )
  )
    return []
  if (!issue.known) return owned
  const held: string[] = []
  for (const stored of owned)
    for (const current of issue.boundary) {
      const part = heldPart(stored, current)
      const path =
        part === HP_STORED ? stored : part === HP_CURRENT ? current : null
      if (path !== null && !held.includes(path)) held.push(path)
    }
  return held
}
