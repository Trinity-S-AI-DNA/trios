/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The link between nodes on different machines (actors.t27 section 9,
 * t27#7900): the store is the wire. Made safe before its first caller by
 * specs/queen/netlink.t27 (trios#1712, lane 6).
 *
 * - INCARNATION. A start claims the node's row with the next incarnation
 *   (next_incarnation), in one transaction, and wins over any holder. Every
 *   pid the node hands out carries it, and every row it writes names it.
 * - LEASE. A worker thread with its own connection renews the row every
 *   NODE_HEARTBEAT_SECONDS (queen-actors-pg-beat.ts), so no turn can hold the
 *   lease up, and only while the actors' loop still turns (beat_renews).
 *   Every write is fenced: the store admits it only while the row holds this
 *   incarnation and the lease is up (write_admitted).
 * - FENCE. A node whose write was refused, or whose last confirmed renewal is
 *   SELF_FENCE_SECONDS old (must_fence), stops: its actors, its timers, its
 *   mail. It never takes the lease back; a new start takes a new incarnation.
 * - PEERS. Each heartbeat the loop reads every lease. The card says what
 *   changed (peer_change, peer_up): a lapsed lease or a newer incarnation is
 *   the old incarnation down, for good. The same read expires mail written
 *   for an incarnation that is over (mail_expired).
 * - MAIL. A send is one row plus pg_notify on the node's channel. The node
 *   LISTENs and also polls, the notification being a hint. It reads its rows
 *   in id order without taking them, handles each (mail_action), and only
 *   then acknowledges them. A lost answer costs a second read, and a row read
 *   again is acknowledged without being handled: no row lost, none twice.
 * - Nothing here decides anything. Every decision is the card's. The fences
 *   inside the SQL are the one exception the card cannot reach: a compare-and-
 *   set must run in the statement that writes, and t27c has no SQL backend.
 *   They mirror write_admitted, and a live test holds them to it.
 */

import { hostname } from 'node:os'
import type { Pool, PoolClient } from 'pg'
import { QUEEN_ACTORS_SQL } from '../../lib/db/pg-migrate'
import { logger } from '../../lib/logger'
import type { Mail, NodeLink } from './queen-actors'
import { flag, loadCardWasm, u32 } from './queen-card-wasm'
import {
  MA_DELIVER,
  MA_DUPLICATE,
  MA_EXPIRE,
  MAIL_BATCH_ROWS,
  MAIL_POLL_MS,
  NODE_HEARTBEAT_SECONDS,
  NODE_TTL_SECONDS,
  PC_DOWN,
} from './queen-netlink-card.gen'

const netlink = () => loadCardWasm('queen/netlink.wasm')
const big = (v: unknown) => BigInt(v as string | number | bigint)

/** JSON with bigints (pids) kept exact. */
export const encodeMail = (mail: Mail): string =>
  JSON.stringify(mail, (_k, v) =>
    typeof v === 'bigint' ? { $big: v.toString() } : v,
  )
export const decodeMail = (text: string): Mail =>
  JSON.parse(text, (_k, v) =>
    v &&
    typeof v === 'object' &&
    typeof v.$big === 'string' &&
    Object.keys(v).length === 1
      ? BigInt(v.$big)
      : v,
  ) as Mail

// The slots shared with the beat thread (queen-actors-pg-beat.ts).
export const BEAT_TICK = 0
export const BEAT_RENEWED = 1
export const BEAT_REFUSED = 2

/** Milliseconds on a clock both threads read alike and that never steps back. */
export const monoNow = (): number => performance.timeOrigin + performance.now()

/**
 * The fence every write carries (write_admitted): the row still holds the
 * writer's incarnation, and its lease is up. clock_timestamp, not now(): a
 * statement that waited on a lock is judged when it runs.
 * Parameters: $node, $inc, $ttl at the positions given.
 */
const fenceCte = (node: string, inc: string, ttl: string) =>
  `f AS (SELECT 1 FROM queen_actor_node
          WHERE node = ${node} AND incarnation = ${inc}
            AND heartbeat_at > clock_timestamp() - make_interval(secs => ${ttl}))`

/** The fence alone: 1 row if a write by ($1, $2) would be admitted. */
export const FENCE_SQL = `WITH ${fenceCte('$1', '$2', '$3')} SELECT count(*)::int AS admitted FROM f`

/** The renewal, fenced the same way. */
export const RENEW_SQL = `
UPDATE queen_actor_node SET heartbeat_at = clock_timestamp(), host = $3
 WHERE node = $1 AND incarnation = $2
   AND heartbeat_at > clock_timestamp() - make_interval(secs => $4)
`

const SEND_SQL = `
WITH ${fenceCte('$3', '$4', '$6')},
i AS (INSERT INTO queen_actor_mail (node, to_inc, from_node, from_inc, body)
      SELECT $1, $2, $3, $4, $5 FROM f RETURNING id)
SELECT (SELECT count(*) FROM i)::int AS sent,
       (SELECT pg_notify('queen_actor_mail_' || $1::text, '') FROM i LIMIT 1) AS n
`

const READ_SQL = `
SELECT id, to_inc, body FROM queen_actor_mail
 WHERE node = $1 ORDER BY id LIMIT $2
`

const ACK_SQL = `
WITH ${fenceCte('$1', '$3', '$4')},
d AS (DELETE FROM queen_actor_mail
       WHERE node = $1 AND id = ANY($2::bigint[]) AND EXISTS (SELECT 1 FROM f)
       RETURNING id)
SELECT (SELECT count(*) FROM f)::int AS fence,
       COALESCE((SELECT array_agg(id) FROM d), '{}') AS ids
`

const PEERS_SQL = `
SELECT node, incarnation,
       EXTRACT(EPOCH FROM now() - heartbeat_at)::float8 AS age
  FROM queen_actor_node
`

const MAIL_GROUPS_SQL = `
SELECT m.node, m.to_inc, count(*)::int AS rows,
       n.incarnation AS node_inc,
       EXTRACT(EPOCH FROM now() - n.heartbeat_at)::float8 AS age
  FROM queen_actor_mail m LEFT JOIN queen_actor_node n ON n.node = m.node
 GROUP BY m.node, m.to_inc, n.incarnation, n.heartbeat_at
`

const EXPIRE_SQL = `
WITH ${fenceCte('$3', '$4', '$5')},
d AS (DELETE FROM queen_actor_mail
       WHERE node = $1 AND to_inc = $2 AND EXISTS (SELECT 1 FROM f)
       RETURNING 1)
SELECT (SELECT count(*) FROM f)::int AS fence,
       (SELECT count(*) FROM d)::int AS deleted
`

export interface PgLinkStats {
  /** Rows written. */
  sent: number
  /** Sends the store refused (the fence) or that never reached it. */
  lostSends: number
  /** Rows handed to the runtime. */
  delivered: number
  /** Rows read again after their acknowledgement was lost: not handled. */
  duplicates: number
  /** Rows for an incarnation that is over: never delivered (mail_expired). */
  expired: number
  /** Rows that did not decode, acknowledged and counted. */
  poison: number
  /** Renewals the beat skipped because the actors' loop was not turning. */
  stalledBeats: number
}

export interface PgLink extends NodeLink {
  stop(): Promise<void>
  stats: PgLinkStats
}

/**
 * One read of every lease. Each peer's state moves as the card says
 * (peer_change, peer_up); returns the incarnations that went down.
 */
function judgePeers(
  rows: Array<{ node: number; incarnation: string; age: number }>,
  self: number,
  peers: Map<number, { inc: number; up: boolean }>,
): Array<{ node: number; inc: number }> {
  const down: Array<{ node: number; inc: number }> = []
  for (const r of rows) {
    const n = Number(r.node)
    if (n === self) continue
    const known = peers.get(n) ?? { inc: 0, up: false }
    const now = Number(r.incarnation)
    const a = [BigInt(known.inc), flag(known.up), BigInt(now), u32(r.age)]
    const change = netlink().call64('peer_change', ...a) as number
    peers.set(n, { inc: now, up: netlink().call64('peer_up', ...a) !== 0 })
    if ((change & PC_DOWN) !== 0) down.push({ node: n, inc: known.inc })
  }
  return down
}

/** One row read: its mail if it decodes, and what the card says to do. */
function judgeRow(
  row: { id: string; to_inc: string; body: string },
  inc: number,
  handled: Set<string>,
): { id: string; action: number; mail?: Mail } {
  const id = String(row.id)
  let mail: Mail | undefined
  try {
    mail = decodeMail(row.body)
  } catch {
    mail = undefined
  }
  const action = netlink().call64(
    'mail_action',
    big(row.to_inc),
    BigInt(inc),
    flag(handled.has(id)),
    flag(mail !== undefined),
  ) as number
  return { id, action, mail }
}

/**
 * The start's incarnation: the next after the one the node's row holds, in
 * the transaction that reads it. The row is made first if it is missing, so
 * two starts racing for a new node id are serialised on it too.
 */
async function claim(
  pool: Pool,
  node: number,
  host: string,
  now: () => number,
) {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    await c.query(
      `INSERT INTO queen_actor_node (node, host, heartbeat_at, incarnation)
         VALUES ($1, $2, clock_timestamp(), 0)
       ON CONFLICT (node) DO NOTHING`,
      [node, host],
    )
    const row = await c.query(
      'SELECT incarnation FROM queen_actor_node WHERE node = $1 FOR UPDATE',
      [node],
    )
    const inc = Number(
      netlink().call64(
        'next_incarnation',
        big((row.rows[0] as { incarnation: string }).incarnation),
      ),
    )
    const sentAt = now()
    await c.query(
      `UPDATE queen_actor_node
          SET incarnation = $2, host = $3, heartbeat_at = clock_timestamp()
        WHERE node = $1`,
      [node, inc, host],
    )
    await c.query('COMMIT')
    return { inc, sentAt }
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    c.release()
  }
}

export async function createPgLink(
  pool: Pool,
  node: number,
  options: {
    pollMs?: number
    host?: string
    /** The beat thread's database; the pool's own when not given. */
    url?: string
    /**
     * The monotonic clock, in ms, that the lease's age is read by on this
     * loop: monoNow when unset. A simulation hands in its own, so no other
     * reader of performance.now in the process moves it (queen-actors.ts
     * `micros`). A beat thread keeps the host's.
     */
    now?: () => number
  } = {},
): Promise<PgLink> {
  await pool.query(QUEEN_ACTORS_SQL)
  const host = options.host ?? hostname()
  const now = options.now ?? monoNow
  const { inc, sentAt } = await claim(pool, node, host, now)
  const channel = `queen_actor_mail_${node}`
  const mailHandlers: Array<(m: Mail) => void> = []
  const downHandlers: Array<(n: number, inc: number) => void> = []
  const fenceHandlers: Array<() => void> = []
  // each peer as this node last read it
  const peers = new Map<number, { inc: number; up: boolean }>()
  const stats: PgLinkStats = {
    sent: 0,
    lostSends: 0,
    delivered: 0,
    duplicates: 0,
    expired: 0,
    poison: 0,
    stalledBeats: 0,
  }
  let stopped = false
  let fenced = false

  const slots = new BigInt64Array(new SharedArrayBuffer(8 * 3))
  Atomics.store(slots, BEAT_TICK, BigInt(Math.floor(now())))
  Atomics.store(slots, BEAT_RENEWED, BigInt(Math.floor(sentAt)))

  let heartbeat: ReturnType<typeof setInterval> | undefined
  let poll: ReturnType<typeof setInterval> | undefined
  let beatThread: Worker | undefined
  // settles once the beat thread has loaded every module, or failed to
  let beatLoaded: Promise<void> = Promise.resolve()
  let beatEnded: Promise<void> | undefined
  let listener: PoolClient | null = null

  /**
   * THE BEAT THREAD IS ENDED ONLY ONCE IT HAS LOADED (gHashTag/trios#1813).
   * Bun 1.3.6 and 1.3.11 crash the whole process when a worker is terminated
   * while its modules are still being transpiled: a transpiler job on Bun's
   * thread pool writes into the source map table of the worker that is gone
   * (Segmentation fault at 0xFFFFFFFFFFFFFFF8 in SavedSourceMap.putValue).
   * A node stopped or fenced within milliseconds of its start did exactly
   * that, and the pglive suite died after its tests had passed. So the end
   * waits for the thread's word that it loaded, or for the error or exit
   * that ends a load that failed. No timeout: those three are every way a
   * load ends. Bun 1.4.3 survives the same churn.
   */
  const endBeat = (): Promise<void> => {
    beatEnded ??= beatLoaded.then(() => {
      beatThread?.terminate()
      beatThread = undefined
    })
    return beatEnded
  }

  const halt = async () => {
    if (heartbeat) clearInterval(heartbeat)
    if (poll) clearInterval(poll)
    const beatGone = endBeat()
    if (listener) {
      const l = listener
      listener = null
      await l.query(`UNLISTEN ${channel}`).catch(() => undefined)
      l.release()
    }
    await beatGone
  }

  const fence = (why: string) => {
    if (fenced) return
    fenced = true
    logger.warn('Queen actor node fenced itself', { node, inc, why })
    void halt()
    for (const h of fenceHandlers) h()
  }
  /** must_fence, on what the beat thread shares. */
  const fencedNow = (): boolean => {
    if (fenced) return true
    const refused = Atomics.load(slots, BEAT_REFUSED) !== 0n
    const age = (now() - Number(Atomics.load(slots, BEAT_RENEWED))) / 1000
    if (netlink().call('must_fence', flag(refused), u32(age)) !== 0)
      fence(refused ? 'the store refused a renewal' : `no renewal for ${age} s`)
    return fenced
  }

  // PEERS, and the mail left for incarnations that are over
  const readPeers = async () => {
    const rows = await pool.query(PEERS_SQL)
    // its own row too: held by a newer start, it counts as a refused write
    const own = (
      rows.rows as Array<{ node: number; incarnation: string; age: number }>
    ).find((r) => Number(r.node) === node)
    if (
      own &&
      netlink().call64(
        'write_admitted',
        big(own.incarnation),
        BigInt(inc),
        u32(own.age),
      ) === 0
    ) {
      Atomics.store(slots, BEAT_REFUSED, 1n)
      if (fencedNow()) return
    }
    for (const d of judgePeers(rows.rows, node, peers))
      for (const h of downHandlers) h(d.node, d.inc)
  }
  const expireMail = async () => {
    const groups = await pool.query(MAIL_GROUPS_SQL)
    for (const g of groups.rows as Array<{
      node: number
      to_inc: string
      rows: number
      node_inc: string | null
      age: number | null
    }>) {
      const expired =
        netlink().call64(
          'mail_expired',
          flag(g.node_inc !== null),
          big(g.to_inc),
          big(g.node_inc ?? 0),
          u32(Number(g.age ?? 0)),
        ) !== 0
      if (!expired) continue
      const r = await pool.query(EXPIRE_SQL, [
        g.node,
        g.to_inc,
        node,
        inc,
        NODE_TTL_SECONDS,
      ])
      const out = r.rows[0] as { fence: number; deleted: number }
      if (out.fence === 0) return fence('the store refused an expiry')
      stats.expired += out.deleted
      if (out.deleted > 0)
        logger.warn('Queen actor mail expired: its incarnation is over', {
          node,
          to: g.node,
          toInc: Number(g.to_inc),
          rows: out.deleted,
        })
    }
  }

  // MAIL IN: read, handle, then acknowledge
  const handled = new Set<string>()
  const deliver = (mail: Mail) => {
    for (const h of mailHandlers) {
      try {
        h(mail)
      } catch (error) {
        logger.warn('Queen actor mail handler threw', {
          node,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  // A notification that lands while a drain runs is not dropped: the drain
  // reads again before it ends. Dropped, the row waited for the next poll.
  let draining = false
  let again = false
  const drain = async () => {
    if (stopped || fencedNow()) return
    if (draining) {
      again = true
      return
    }
    draining = true
    try {
      do {
        again = false
        await drainOnce()
      } while (again && !stopped && !fenced)
    } finally {
      draining = false
    }
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one pass over a batch of mail rows, one branch per netlink.t27 mail_action answer; the decisions are the card's
  const drainOnce = async () => {
    try {
      for (;;) {
        const got = await pool.query(READ_SQL, [node, MAIL_BATCH_ROWS])
        const rows = got.rows as Array<{
          id: string
          to_inc: string
          body: string
        }>
        // a complete read lists every row left: an id it no longer lists is
        // gone for good (forget_handled)
        const complete = rows.length < MAIL_BATCH_ROWS
        const listed = new Set(rows.map((r) => String(r.id)))
        for (const id of handled)
          if (
            netlink().call(
              'forget_handled',
              0,
              flag(complete),
              flag(listed.has(id)),
            ) !== 0
          )
            handled.delete(id)
        const ack: string[] = []
        for (const row of rows) {
          if (fencedNow()) return
          const { id, action, mail } = judgeRow(row, inc, handled)
          if (action === MA_DELIVER && mail) {
            handled.add(id)
            stats.delivered++
            deliver(mail)
          } else if (action === MA_DUPLICATE) stats.duplicates++
          else if (action === MA_EXPIRE) stats.expired++
          else {
            stats.poison++
            logger.warn('Queen actor mail did not decode', { node, id })
          }
          ack.push(id)
        }
        if (ack.length > 0) {
          const r = await pool.query(ACK_SQL, [
            node,
            ack,
            inc,
            NODE_TTL_SECONDS,
          ])
          const out = r.rows[0] as { fence: number; ids: unknown[] }
          if (out.fence === 0)
            return fence('the store refused an acknowledgement')
          // a confirmed acknowledgement: those rows cannot come back
          if (netlink().call('forget_handled', 1, 0, 1) !== 0)
            for (const id of out.ids) handled.delete(String(id))
        }
        if (complete) break
      }
    } catch (error) {
      logger.warn('Queen actor node could not read its mail', {
        node,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // MAIL OUT: one sender's rows go in one at a time, so their ids keep its order
  let sending: Promise<unknown> = Promise.resolve()
  const carry = (to: number, mail: Mail, toInc: number) => {
    const body = encodeMail(mail)
    sending = sending
      .then(async () => {
        if (fencedNow()) {
          stats.lostSends++
          return
        }
        const r = await pool.query(SEND_SQL, [
          to,
          toInc,
          node,
          inc,
          body,
          NODE_TTL_SECONDS,
        ])
        if ((r.rows[0] as { sent: number }).sent === 1) stats.sent++
        else {
          stats.lostSends++
          fence('the store refused a send')
        }
      })
      .catch((error) => {
        stats.lostSends++
        logger.warn('Queen actor node could not send mail', {
          node,
          to,
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }

  try {
    listener = await pool.connect()
    listener.on('notification', () => void drain())
    await listener.query(`LISTEN ${channel}`)
  } catch (error) {
    listener?.release()
    listener = null
    logger.warn('Queen actor node listens by polling only', {
      node,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // THE BEAT, on its own thread. Without a database url for it, on this loop
  // with the same fenced renewal, which a held loop can starve.
  const url = options.url ?? pool.options.connectionString
  const renewHere = async () => {
    const sent = now()
    const r = await pool.query(RENEW_SQL, [node, inc, host, NODE_TTL_SECONDS])
    if (r.rowCount === 1)
      Atomics.store(slots, BEAT_RENEWED, BigInt(Math.floor(sent)))
    else Atomics.store(slots, BEAT_REFUSED, 1n)
  }
  if (url) {
    const thread = new Worker(
      new URL('./queen-actors-pg-beat.ts', import.meta.url).href,
    )
    beatThread = thread
    beatLoaded = new Promise<void>((loaded) => {
      thread.addEventListener('message', (event: MessageEvent) => {
        if ((event.data as { loaded?: boolean }).loaded) loaded()
      })
      thread.addEventListener('error', () => loaded())
      thread.addEventListener('close', () => loaded())
    })
    beatThread.onmessage = (event: MessageEvent) => {
      const m = event.data as { refused?: boolean; stalled?: number }
      if (m.stalled !== undefined) stats.stalledBeats++
      if (m.refused) fencedNow()
    }
    // a beat thread that died renews nothing: must_fence stops the node
    beatThread.onerror = (event) =>
      logger.warn('Queen actor node lost its beat thread', {
        node,
        error: event.message,
      })
    beatThread.postMessage({ url, node, inc, host, shared: slots.buffer })
  } else
    logger.warn('Queen actor node renews its lease on the actors loop', {
      node,
    })

  await readPeers()
  heartbeat = setInterval(() => {
    if (fencedNow()) return
    ;(async () => {
      if (!url) await renewHere()
      await readPeers()
      await expireMail()
    })().catch((error) =>
      logger.warn('Queen actor node could not read the leases', {
        node,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }, NODE_HEARTBEAT_SECONDS * 1000)
  // the poll is also the loop's mark that it still turns (beat_renews)
  poll = setInterval(() => {
    Atomics.store(slots, BEAT_TICK, BigInt(Math.floor(now())))
    void drain()
  }, options.pollMs ?? MAIL_POLL_MS)
  void drain()

  return {
    node,
    incarnation: inc,
    up: (n) => !fencedNow() && (peers.get(n)?.up ?? false),
    incarnationOf: (n) => peers.get(n)?.inc ?? 0,
    carry,
    onMail: (h) => {
      mailHandlers.push(h)
    },
    onNodeDown: (h) => {
      downHandlers.push(h)
    },
    fenced: fencedNow,
    onFenced: (h) => {
      fenceHandlers.push(h)
    },
    stats,
    stop: async () => {
      stopped = true
      await halt()
      await sending.catch(() => undefined)
    },
  }
}
