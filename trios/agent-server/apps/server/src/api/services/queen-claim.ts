/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * WHAT A DISPATCH ROW STILL CLAIMS (gHashTag/t27 specs/queen/claim.t27,
 * t27#8765; gHashTag/trios#1767).
 *
 * Every round asks it of every queen_dispatch row, and the board asks it of
 * every card: running, accepted, rejected, awaitingReview, failed or
 * cancelled. The card's claim_of decides, as generated wasm, and it imports
 * the review valve's own escalation_kind and next_step instead of restating
 * them. This file only reads the row into the card's codes and the card's
 * answer back into the word the round, the board and queend use.
 *
 * The rule was hand-written TypeScript in queen-tick.ts until this card. That
 * body is kept verbatim in tests/api/queen-claim-card.test.ts, where the card
 * is proven to answer it word for word over every input the round can pass.
 */

import { logger } from '../../lib/logger'
import { flag, loadCardWasm, u32 } from './queen-card-wasm'
import {
  CL_ACCEPTED,
  CL_AWAITING_REVIEW,
  CL_CANCELLED,
  CL_FAILED,
  CL_REJECTED,
  CL_RUNNING,
  DEFAULT_SEND_BACK_CEILING,
  OBSOLETE_STATE,
  V_ACCEPT,
  V_CANCELLED,
  V_EMPTY,
  V_ESCALATE,
  V_FAILED,
  V_NONE,
  V_OBSOLETE,
  V_OTHER,
  V_SEND_BACK,
  V_STALE_CONTRACT,
  V_WAIT,
} from './queen-claim-card.gen'

export const CLAIM_CARD = 'queen/claim.wasm'

export type DispatchClaim =
  | 'running'
  | 'accepted'
  | 'rejected'
  | 'awaitingReview'
  | 'failed'
  | 'cancelled'

/** What a row carries besides its verdict, as stateOfDispatch has always taken it. */
export interface ClaimLease {
  /** Milliseconds since finished_at, the one clock nothing rewrites. */
  idleMs?: number
  sendBacks?: number
  /** The send-back ceiling; the card's DEFAULT_SEND_BACK_CEILING when absent. */
  ceiling?: number
  /** How many times this issue's ceiling has already been handed back. */
  releases?: number
  /** The escalation's kind is read from these (specs/queen/review_valve.t27). */
  criteria?: number
  freeAttempts?: number
  reviewerMisses?: number
  /**
   * TRIOS_QUEEN_RELEASE_DEAD_CLAIMS (holds.t27 send_back_claim, t27#9111). It
   * is read by stateOfDispatch before the card is asked, never by the card;
   * the environment's reading is used when it is not given.
   */
  releaseDeadClaims?: boolean
}

/**
 * The review_state words the card has a rule for. Recognising a word is text
 * work and stays here; what the word means is the card's. A word this table
 * does not name is V_OTHER, which the card holds with no clock.
 */
const VERDICTS: ReadonlyMap<string, number> = new Map([
  ['', V_NONE],
  ['accept', V_ACCEPT],
  ['sendBack', V_SEND_BACK],
  ['escalate', V_ESCALATE],
  ['wait', V_WAIT],
  ['failed', V_FAILED],
  ['cancelled', V_CANCELLED],
  ['empty', V_EMPTY],
  ['stale-contract', V_STALE_CONTRACT],
  [OBSOLETE_STATE, V_OBSOLETE],
])

/** The card's code for a review_state value; null and undefined are no verdict. */
export function verdictCode(reviewState: unknown): number {
  return VERDICTS.get(String(reviewState ?? '')) ?? V_OTHER
}

const CLAIMS: ReadonlyMap<number, DispatchClaim> = new Map([
  [CL_RUNNING, 'running'],
  [CL_ACCEPTED, 'accepted'],
  [CL_REJECTED, 'rejected'],
  [CL_AWAITING_REVIEW, 'awaitingReview'],
  [CL_FAILED, 'failed'],
  [CL_CANCELLED, 'cancelled'],
])

/** Codes already reported, so a drifted card logs once, not once per row per round. */
const reported = new Set<number>()

/**
 * The word for a claim code. claim.t27 answers only CL_ codes, so any other
 * code means the vendored card drifted from its constants. That is logged as
 * an error and the row is held as awaitingReview, the claim the card gives a
 * verdict it does not know: the issue and its files stay held, so nothing is
 * dispatched twice, and one row cannot fail every round and the board (the
 * round maps every in-flight row through this, with no try per row). A card
 * that cannot load still throws, from loadCardWasm.
 */
export function claimWord(code: number): DispatchClaim {
  const word = CLAIMS.get(code)
  if (word !== undefined) return word
  if (!reported.has(code)) {
    reported.add(code)
    logger.error('The claim card answered a code that is no claim', {
      card: CLAIM_CARD,
      code,
      held: 'awaitingReview',
    })
  }
  return 'awaitingReview'
}

/**
 * Whole minutes since finished_at. Every floor in the card is a whole number
 * of minutes, so `idleMs >= floorMs` holds exactly when this is at least the
 * floor in minutes. An unreadable (NaN) or negative clock reads 0: it keeps
 * the hold, as every comparison against NaN did.
 */
export const idleMinutes = (idleMs: number | undefined): number =>
  u32((idleMs ?? 0) / 60_000)

/** What the row claims, decided by the card's claim_of. */
export function claimOf(
  finished: boolean,
  reviewState: unknown,
  lease: ClaimLease = {},
): DispatchClaim {
  return claimWord(
    loadCardWasm(CLAIM_CARD).call(
      'claim_of',
      flag(finished),
      verdictCode(reviewState),
      idleMinutes(lease.idleMs),
      u32(lease.sendBacks ?? 0),
      u32(lease.ceiling ?? DEFAULT_SEND_BACK_CEILING),
      u32(lease.releases ?? 0),
      flag(lease.criteria != null),
      u32(lease.criteria ?? 0),
      u32(lease.freeAttempts ?? 0),
      u32(lease.reviewerMisses ?? 0),
    ),
  )
}
