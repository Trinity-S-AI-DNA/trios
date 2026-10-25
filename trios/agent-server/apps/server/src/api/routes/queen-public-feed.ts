/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The Queen's recent actor events as the t27f live page reads them
 * (gHashTag/t27#12146): format "t27f-queen-feed-v1", one JSON object, CORS
 * open to any origin, answerable unauthenticated. The page at
 * t27.ai/t27f/live polls this on a seconds cycle instead of the GitHub API,
 * which is anonymous-rate-limited at 60/h and minutes stale.
 *
 * This route adds no reading of its own. Every row comes from the same
 * projection /queen/public-actors serves (queen-actor-events.ts: pids, kinds,
 * counts, depths, times and task references - never a message, never a card's
 * arguments, FR-004 of specs/t27f/work_graph.t27); here it is only re-shaped
 * into the three fields the replay engine draws: kind, tick and the task/spec
 * labels. `tick` is the event's seq minus one - the t27f tick grid numbers
 * events from zero (specs/t27f/work_graph_fixture.t27), and seq does too once
 * the first row is seq 1. `spec` is the actor's own name when the row carries
 * one (the actors are named by the specs they work on); it is null when the
 * row names none, and no payload is read to invent one.
 *
 * SEED, honestly marked. With TRIOS_QUEEN_ACTOR_EVENTS off (the default) or
 * the bus still empty, the answer is the card's stand-in trace of the network
 * MVP (actor_events.t27 REPLAY_*, the same 24 columns the t27f fixture's
 * first events pin) with "seed": true. The page can show its shape before
 * the runtime publishes; the day the bus carries one event the seed is gone
 * and "seed" is false, with nothing deployed in between.
 */

import { Hono } from 'hono'
import type { Pool } from 'pg'
import { createQueenPool } from '../../lib/db/queen-pool'
import { logger } from '../../lib/logger'
import {
  type ActorRowSource,
  actorEventsOn,
  publicActorsPage,
  replayRows,
  replaySource,
} from '../services/queen-actor-events'
import { pidOf } from '../services/queen-actors'
import {
  cursorRead,
  logBounds,
  pageSize,
  readAfter,
  tokenOk,
} from '../services/queen-events'
import { ACTOR_STREAM } from '../services/queen-events.gen'

let pool: Pool | null = null

/** The most recent events this route will ever answer with. */
export const T27F_FEED_MAX = 200

/** The kinds the t27f replay engine draws, as it spells them. */
const T27F_KINDS = new Set([
  'spawn',
  'restart',
  'exit',
  'down',
  'deliver',
  'delivers',
])

const count = (v: string | undefined): number | null => {
  if (v === undefined || !/^\d{1,15}$/.test(v.trim())) return null
  return Number(v.trim())
}

const cards = { cursorRead, pageSize, tokenOk }
const noStore = { 'Cache-Control': 'no-store' }

/** The log's actors stream as a source of rows. */
export const busSource = (p: Pool): ActorRowSource => ({
  bounds: () => logBounds(p, ACTOR_STREAM),
  after: (after, limit) => readAfter(p, ACTOR_STREAM, after, limit),
})

/** One public actor event as the t27f live page replays it. */
export function t27fEvent(e: {
  seq: number
  name: string
  at: string
  task_ref: { number?: number } | null
  actor?: unknown
}): {
  seq: number
  kind: string
  tick: number
  task: number | null
  spec: string | null
  ts: string
} {
  // "actor.spawn" -> "spawn": the page's kinds are the bare word.
  const name = String(e.name ?? '').replace(/^actor\./, '')
  const seq = Number(e.seq) || 0
  const spec = typeof e.actor === 'string' ? e.actor.slice(0, 120) : null
  return {
    seq,
    kind: T27F_KINDS.has(name) ? name : 'deliver',
    tick: Math.max(0, seq - 1),
    task:
      e.task_ref && typeof e.task_ref.number === 'number'
        ? e.task_ref.number
        : null,
    spec,
    ts: String(e.at ?? ''),
  }
}

export interface QueenPublicFeedDeps {
  env?: NodeJS.ProcessEnv
  /** The bus, for a test; the Queen's pool otherwise. */
  source?: () => ActorRowSource
}

export function createQueenPublicFeedRoute(deps: QueenPublicFeedDeps = {}) {
  return new Hono().get('/', async (c) => {
    const env = deps.env ?? process.env
    const since = count(c.req.query('since'))
    const limit = count(c.req.query('limit')) ?? 0
    try {
      let source: ActorRowSource | undefined
      let seed = true
      if (actorEventsOn(env)) {
        let bus = deps.source?.()
        if (!bus) {
          const url = env.DATABASE_URL
          if (!url) return c.json({ error: 'No database configured' }, 503)
          pool ??= createQueenPool(url)
          bus = busSource(pool)
        }
        // An empty bus at boot answers the seed, not an empty page: the page
        // would show a dead fleet until the first real event, and the shape
        // is the point of the endpoint until the runtime publishes.
        const bounds = await bus.bounds()
        if (bounds.newest > 0) {
          source = bus
          seed = false
        }
      }
      if (!source) source = replaySource(replayRows(pidOf))
      const page = await publicActorsPage(
        source,
        since,
        limit,
        cards,
        seed ? 'replay' : 'bus',
      )
      return c.json(
        {
          format: 't27f-queen-feed-v1',
          seed,
          on: page.on,
          cursor: page.cursor,
          resync: page.resync,
          // publicActorsPage is bounded by the card's page size; the slice
          // keeps the at-most-200 contract true even if that bound regresses.
          events: page.events.slice(0, T27F_FEED_MAX).map(t27fEvent),
        },
        200,
        noStore,
      )
    } catch (error) {
      logger.warn('Queen public feed could not be read', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'The queen feed is unavailable' }, 503)
    }
  })
}
