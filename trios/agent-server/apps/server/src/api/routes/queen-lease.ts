/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The lease, offered to callers that cannot speak Postgres.
 *
 * The container's own tick takes the lease directly. This route exists for the
 * OTHER contender: the Mac app, which has been running the supervision loop all
 * along and has no database connection. Without a way for it to contend, the
 * exclusion would only hold between cloud replicas - which is the easy half, and
 * not the half that has two Queens in it.
 *
 * So the rule is: whoever runs a round takes the lease first, over whichever
 * transport they have. One lease, one name, two kinds of client.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import { createQueenPool } from '../../lib/db/queen-pool'
import { leased, vault, zaiLeaseCall } from '../services/queen-free-lane'
import * as KV from '../services/queen-key-vault-card.gen'
import {
  acquireQueenLease,
  queenLeaseDatabaseUrl,
  queenLeaseStatus,
  releaseQueenLease,
} from '../services/queen-lease'
import { zaiLeaseLanes } from '../services/queen-reviewer'
import { runningKeys, runQueenTickOnce } from '../services/queen-tick'

const LEASE_NAME = 'queen-tick'

/**
 * The pool a round runs on, which outlives the request that asked for the round.
 *
 * Every other handler here finishes its database work before it answers, so a
 * request-scoped pool ended in `finally` is correct for them. `/tick` is not
 * like them: a round's last act is fire-and-forget - `void drain(pool, ...)` in
 * queen-dispatch.ts - a background reader that writes the bee's transcript and
 * its ending on this same pool for the whole multi-minute model turn. `drain`
 * has no client checked out when it starts (its first act is `await
 * reader.read()`), so `pool.end()` does not wait for it and returns at once.
 *
 * Measured: `new Pool(...)`, `await pool.end()`, then a query rejects with
 * "Cannot use a pool after calling end on the pool" (pg-pool 3.14.0). Every
 * later transcript INSERT and the terminal `finishDispatch` UPDATE swallow
 * their rejection, so the route still answered 200 while the bee it started
 * left no transcript row and never got `finished_at` - which the kanban reads
 * as permanently running until the 120-minute stall reaper fires.
 *
 * So the tick pool is created once and never ended, the same lifetime the
 * timer's own pool has in `startQueenTick`. Never ending it is the point: there
 * is no moment at which no round's drain can still be writing.
 */
let tickPool: Pool | undefined

function poolForTick(url: string): Pool {
  if (!tickPool) tickPool = createQueenPool(url)
  return tickPool
}

export function createQueenLeaseRoute() {
  return (
    new Hono()
      .post('/', async (c) => {
        const url = queenLeaseDatabaseUrl()
        if (!url) return c.json({ error: 'No database configured' }, 503)
        const body = await c.req.json().catch(() => null)
        const holder = typeof body?.holder === 'string' ? body.holder : null
        if (!holder) return c.json({ error: 'holder is required' }, 400)
        // Bounded: a caller that asks for a day-long lease and then dies takes the
        // hive down with it until someone edits a database by hand.
        const ttl = Math.min(
          Math.max(Number(body?.ttlSeconds) || 300, 30),
          3600,
        )

        const pool = createQueenPool(url)
        try {
          const grant = await acquireQueenLease(pool, LEASE_NAME, holder, ttl)
          // 200 either way. Losing a lease is a normal outcome of a healthy round,
          // not an error, and a caller that retries on 4xx would fight the winner.
          return c.json(grant)
        } finally {
          await pool.end()
        }
      })
      .delete('/', async (c) => {
        const url = queenLeaseDatabaseUrl()
        if (!url) return c.json({ error: 'No database configured' }, 503)
        const holder = c.req.query('holder')
        if (!holder) return c.json({ error: 'holder is required' }, 400)
        const pool = createQueenPool(url)
        try {
          return c.json({
            released: await releaseQueenLease(pool, LEASE_NAME, holder),
          })
        } finally {
          await pool.end()
        }
      })
      /**
       * Run a round now.
       *
       * The loop already ticks on its own; this is for the two cases a timer
       * cannot serve. An operator who has just fixed something should not have to
       * wait out half an hour to learn whether it worked - and a supervisor that
       * can only be observed on its own schedule is one nobody verifies.
       *
       * `candidates` overrides what GitHub would have offered. Diagnostic, behind
       * the same token as everything else here, and echoed back in the response so
       * a result obtained this way can never be mistaken for one the tick reached
       * by itself.
       */
      .post('/tick', async (c) => {
        const url = queenLeaseDatabaseUrl()
        if (!url) return c.json({ error: 'No database configured' }, 503)
        const body = await c.req.json().catch(() => null)
        const override = Array.isArray(body?.candidates)
          ? body.candidates.filter((n: unknown) => typeof n === 'number')
          : undefined
        const pool = poolForTick(url)
        try {
          const result = await runQueenTickOnce(pool, override)
          return c.json({ ...result, candidatesOverridden: override ?? null })
        } catch (error) {
          return c.json(
            { error: error instanceof Error ? error.message : String(error) },
            500,
          )
        }
      })
      .get('/', async (c) => {
        const url = queenLeaseDatabaseUrl()
        if (!url) return c.json({ error: 'No database configured' }, 503)
        const pool = createQueenPool(url)
        try {
          const status = await queenLeaseStatus(pool, LEASE_NAME)
          const tick = await pool.query(
            'SELECT holder, fence, decided_at, decision FROM queen_tick WHERE name = $1',
            [LEASE_NAME],
          )
          const dispatches = await pool.query(
            `SELECT issue, branch, started, detail, conversation_id,
                  dispatched_at, finished_at, outcome
             FROM queen_dispatch ORDER BY dispatched_at DESC LIMIT 10`,
          )
          return c.json({
            lease: status,
            dispatches: dispatches.rows.map((r) => ({
              issue: r.issue,
              branch: r.branch,
              started: r.started,
              detail: r.detail,
              conversationId: r.conversation_id,
              dispatchedAt: r.dispatched_at,
              // Present even when null. "still running" and "this server does
              // not record endings" look identical when the key is simply
              // missing - which is exactly how a working column read as a
              // broken one for two deploys.
              finishedAt: r.finished_at,
              outcome: r.outcome,
            })),
            lastTick: tick.rowCount
              ? {
                  holder: tick.rows[0].holder,
                  fence: Number(tick.rows[0].fence),
                  decidedAt: tick.rows[0].decided_at,
                  decision: tick.rows[0].decision,
                }
              : null,
          })
        } finally {
          await pool.end()
        }
      })
  )
}

/** What a lease forwards of the caller's request: never its token. */
const ZAI_HEADERS = {
  'content-type': 'application/json',
  'anthropic-version': '2023-06-01',
}
/** The Mac reviewer's z.ai calls, made here so no key leaves the Queen. */
export function createQueenZaiLeaseRoute() {
  return new Hono().all('/*', async (c) => {
    const token = process.env.TRIOS_QUEEN_REVIEW_LEASE_TOKEN ?? ''
    const sha = (s: string) => createHash('sha256').update(s).digest()
    if (token.length < 32) return c.json({ error: 'lease_off' }, 503)
    const given = sha(c.req.header('authorization') ?? '')
    if (!timingSafeEqual(given, sha(`Bearer ${token}`)))
      return c.json({ error: 'forbidden' }, 403)
    const url = queenLeaseDatabaseUrl()
    const taken = url ? await runningKeys(poolForTick(url)) : []
    const lanes = zaiLeaseLanes(taken, leased)
    const total = zaiLeaseLanes([], leased).length + leased.size
    const n = leased.size
    const ask = [KV.LEASE_REVIEW, KV.SRC_STORE, n, lanes.length, total, n, 1]
    const answer = vault('lease_answer', ...ask)
    const path = c.req.url.replace(/^.*?\/zai-lease/, '')
    const body = c.req.method === 'GET' ? undefined : await c.req.arrayBuffer()
    const init = { method: c.req.method, headers: ZAI_HEADERS, body }
    const res =
      answer === KV.LA_GRANT && (await zaiLeaseCall(lanes, path, init))
    if (res) return res
    const refused = answer === KV.LA_REFUSE
    const wait = vault('retry_after_seconds', refused ? answer : KV.LA_WAIT)
    c.header('retry-after', String(wait))
    const error = { type: 'rate_limit_error', message: 'no z.ai lane free' }
    return c.json({ type: 'error', error }, refused ? 403 : 429)
  })
}
