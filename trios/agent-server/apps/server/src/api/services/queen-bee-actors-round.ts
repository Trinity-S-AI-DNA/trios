/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE ROUND HANDS ITS ISSUES TO THE BEE ACTORS (MVP, gHashTag/trios#1712 item
 * 7). Only with TRIOS_QUEEN_DISPATCH=actors; unset, nothing here runs and the
 * round dispatches as before.
 *
 * The round still reads the issues and builds the board. At its dispatch step
 * it calls `handRoundToBeeActors` instead of looping over queend, and every
 * candidate gets a `ready`. From there the issue actors (queen-bee-actors.ts)
 * do the work:
 *   - admission asks queend about one issue against the round's board plus
 *     every bee started since;
 *   - the start is dispatchBee, as the round calls it;
 *   - a bee's end is the end of its dispatch row (finished_at), read when the
 *     bus says a task ended or a lease expired, and at every round;
 *   - a cancel is cancelTask (control.t27 section 3), which ends the row and
 *     bumps the fence, so the old bee writes nothing more.
 *
 * THE HOLDER IS THE ACTOR (keyed_guard.t27 section 1, trios#1729 item 7).
 * dispatchBee claims for the issue actor: this process's name and boot, then
 * its pid. A claim lands again only for that very holder, so a second
 * incarnation of an issue's actor, or a second dispatcher under one name, no
 * longer "renews" a claim whose bee still runs. The round renews and releases
 * the actors' leases with its own (renewRunningLeases, releaseTaskLease).
 */

import type { Pool } from 'pg'
import { logger } from '../../lib/logger'
import { type Clock, realClock } from './queen-actors'
import {
  type BeeDispatcher,
  type BeeEnd,
  startBeeDispatcher,
} from './queen-bee-actors'
import { addControlEventReader, cancelTask } from './queen-control'
import { EV_LEASE_EXPIRED, EV_TASK_ENDED } from './queen-control.gen'
import { DISPATCH_OUTCOME_LABELS, type DispatchOutcome } from './queen-dispatch'
import {
  EF_CANCEL,
  EF_NONE,
  EF_PROVIDER,
  HB_NEVER,
} from './queen-dispatch-exit-card.gen'
import { LANES_MEASURED } from './queen-keyed-card.gen'
import { queenActorHolderPrefix } from './queen-lease'

/** TRIOS_QUEEN_DISPATCH=actors: the bee actors start the bees. */
export function dispatchByActors(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.TRIOS_QUEEN_DISPATCH ?? '').trim().toLowerCase() === 'actors'
}

export interface RoundHandoff {
  /** The round's candidates, in queend's order. */
  candidates: number[]
  /** queend's word on one issue against `tasks`: the issue's paths, or null. */
  choose: (issue: number, tasks: unknown[]) => Promise<string[] | null>
  /** The board the round read. */
  board: unknown[]
  /** The board task for a bee started since the round read it. */
  boardTask: (issue: number, paths: string[], out: DispatchOutcome) => unknown
  /** dispatchBee, as the round calls it, claiming for `holder`. */
  dispatch: (
    issue: number,
    paths: string[],
    holder?: string,
  ) => Promise<DispatchOutcome>
}

/**
 * What a finished dispatch row says, as dispatch_exit.t27 reads an end. Only
 * observations: the decision is the card's (exit_reason, restart_decision).
 * `outcome` null: the row now belongs to another dispatch of the issue.
 */
export function beeEndOfRow(outcome: string | null): BeeEnd {
  const o = outcome ?? ''
  const provider = [
    DISPATCH_OUTCOME_LABELS.providerQuotaExhausted,
    DISPATCH_OUTCOME_LABELS.providerOverloaded,
  ].some((p) => o.startsWith(p))
  const reaped = outcome === null || o.startsWith('reaped')
  return {
    completion: o === DISPATCH_OUTCOME_LABELS.finished,
    errorFrame: provider
      ? EF_PROVIDER
      : o === 'cancelled'
        ? EF_CANCEL
        : EF_NONE,
    // the row keeps no HTTP status
    http: 0,
    heartbeatAge: reaped ? HB_NEVER : 0,
    leaseHeld: !reaped,
  }
}

interface Production {
  dispatcher: BeeDispatcher
  round: RoundHandoff | null
  since: unknown[]
  settle: () => Promise<void>
  /** Stop the issue actors and stop reading the bus. */
  stop: () => void
}
let production: Production | null = null
// the clock the next dispatcher runs on: the real one, unless a test said so
let clockOfNext: Clock = realClock

/**
 * FOR TESTS ONLY. Stop the process's dispatcher, so the next round starts a
 * fresh one on `clock`. Production never calls this: its one dispatcher runs
 * on the real clock for the life of the process.
 */
export function restartBeeActorsOn(clock: Clock = realClock): void {
  production?.stop()
  production = null
  clockOfNext = clock
}

function start(pool: Pool, clock: Clock): Production {
  const pending = new Map<
    number,
    { conversationId: string; resolve: (e: BeeEnd) => void }
  >()
  const paths = new Map<number, string[]>()
  const p: Production = {
    round: null,
    since: [],
    settle: async () => {
      if (pending.size === 0) return
      const { rows } = await pool.query(
        `SELECT issue, conversation_id, outcome, finished_at
           FROM queen_dispatch WHERE issue = ANY($1::int[])`,
        [[...pending.keys()]],
      )
      for (const row of rows) {
        const wait = pending.get(Number(row.issue))
        if (!wait) continue
        const mine = String(row.conversation_id ?? '') === wait.conversationId
        if (mine && row.finished_at == null) continue
        pending.delete(Number(row.issue))
        wait.resolve(beeEndOfRow(mine ? (row.outcome ?? '') : null))
      }
    },
    dispatcher: startBeeDispatcher(
      {
        lanes: () =>
          Number(process.env.TRIOS_QUEEN_ACTOR_LANES) || LANES_MEASURED,
        admit: async (issue) => {
          const round = p.round
          if (!round) return false
          const got = await round.choose(issue, [...round.board, ...p.since])
          if (!got) return false
          paths.set(issue, got)
          return true
        },
        holderPrefix: queenActorHolderPrefix(),
        start: async (issue, holder) => {
          const round = p.round
          if (!round) return { claim: true, work: null }
          const owned = paths.get(issue) ?? []
          const out = await round.dispatch(issue, owned, holder)
          if (!out.started)
            return {
              claim: !out.detail.startsWith('task lease held'),
              work: null,
            }
          p.since.push(round.boardTask(issue, owned, out))
          const ended = new Promise<BeeEnd>((resolve) =>
            pending.set(issue, {
              conversationId: out.conversationId ?? '',
              resolve,
            }),
          )
          return {
            claim: true,
            work: {
              ended,
              cancel: () =>
                void cancelTask(
                  pool,
                  issue,
                  'bee actors',
                  'its turn passed the bound',
                )
                  .then(() => p.settle())
                  .catch((error) =>
                    logger.warn('Bee actors could not cancel a bee', {
                      issue,
                      error:
                        error instanceof Error ? error.message : String(error),
                    }),
                  ),
            },
          }
        },
      },
      clock,
    ),
    stop: () => {
      unread()
      p.dispatcher.stop()
    },
  }
  const unread = addControlEventReader((event) => {
    if (event.kind === EV_TASK_ENDED || event.kind === EV_LEASE_EXPIRED)
      void p.settle().catch(() => {})
  })
  logger.info(
    'Queen bee dispatch starting as keyed actors (TRIOS_QUEEN_DISPATCH=actors)',
  )
  return p
}

/** The round's dispatch step, when the actors dispatch. */
export function handRoundToBeeActors(pool: Pool, round: RoundHandoff): void {
  if (!production) production = start(pool, clockOfNext)
  production.round = round
  // the round's board already holds every bee started before it read
  production.since = []
  void production.settle().catch(() => {})
  for (const issue of round.candidates) production.dispatcher.ready(issue)
}
