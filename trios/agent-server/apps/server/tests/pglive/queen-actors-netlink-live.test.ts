/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE NODE LINK, MADE SAFE (gHashTag/t27 specs/queen/netlink.t27, trios#1712
 * lane 6), against a real PostgreSQL. Each defect the code reading found is
 * reproduced first; the memory-net half is tests/api/queen-actors-netlink.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import { Pool } from 'pg'
import {
  createActorSystem,
  type Pid,
} from '../../src/api/services/queen-actors'
import { NODE_TTL_SECONDS } from '../../src/api/services/queen-actors-card.gen'
import {
  createPgLink,
  FENCE_SQL,
  type PgLink,
} from '../../src/api/services/queen-actors-pg'
import { loadCardWasm } from '../../src/api/services/queen-card-wasm'
import { runPgMigrations } from '../../src/lib/db/pg-migrate'
import { createQueenPool, queenSchema } from '../../src/lib/db/queen-pool'

const OFFLINE_KEY = 'TRIOS_PG_MIGRATE_GATE'
const URL_KEY = 'TRIOS_PG_TEST_URL'

function offlineRequested(): boolean {
  return (process.env[OFFLINE_KEY] ?? '').toLowerCase() === 'offline'
}

function adminUrl(): string {
  return (
    process.env[URL_KEY] ??
    `postgres://${userInfo().username}@127.0.0.1:5432/postgres`
  )
}

async function scratchDatabase(): Promise<{
  url: string
  drop: () => Promise<void>
} | null> {
  const name = `queen_netlink_${randomBytes(6).toString('hex')}`
  const admin = new Pool({ connectionString: adminUrl(), max: 1 })
  try {
    await admin.query(`CREATE DATABASE ${name}`)
  } catch (error) {
    await admin.end().catch(() => undefined)
    if (offlineRequested()) return null
    throw error
  }
  const url = new URL(adminUrl())
  url.pathname = `/${name}`
  const fresh = new Pool({ connectionString: url.toString(), max: 1 })
  try {
    await fresh.query(`CREATE SCHEMA IF NOT EXISTS ${queenSchema()}`)
  } finally {
    await fresh.end().catch(() => undefined)
  }
  return {
    url: url.toString(),
    drop: async () => {
      await admin
        .query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
        .catch(() => undefined)
      await admin.end().catch(() => undefined)
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (cond: () => boolean, ms: number) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await sleep(50)
}

/**
 * A pool whose statements can be made to fail as a dropped connection does:
 * `after` runs the statement on the server and then loses its answer, `before`
 * loses the statement itself.
 */
function faulty(
  pool: Pool,
  fault: (sql: string, rows: number) => 'after' | 'before' | null,
) {
  const query = pool.query.bind(pool) as (
    sql: unknown,
    params?: unknown,
  ) => Promise<{ rowCount: number | null; rows: unknown[] }>
  ;(pool as unknown as { query: unknown }).query = async (
    sql: unknown,
    params?: unknown,
  ) => {
    const text =
      typeof sql === 'string' ? sql : String((sql as { text?: string }).text)
    if (fault(text, -1) === 'before')
      throw new Error('connection lost before the statement (injected)')
    const result = await query(sql, params)
    if (fault(text, result.rows?.length ?? 0) === 'after')
      throw new Error('connection lost after the server ran it (injected)')
    return result
  }
  return pool
}

describe('PgLink over PostgreSQL: the defects, reproduced', () => {
  let scratch: { url: string; drop: () => Promise<void> } | null = null
  const pools: Pool[] = []
  const links: PgLink[] = []
  const previousUrl = process.env.DATABASE_URL

  beforeEach(async () => {
    scratch = await scratchDatabase()
    if (!scratch) return
    process.env.DATABASE_URL = scratch.url
    await runPgMigrations()
  })

  afterEach(async () => {
    for (const l of links.splice(0)) await l.stop().catch(() => undefined)
    for (const p of pools.splice(0)) await p.end().catch(() => undefined)
    await scratch?.drop()
    scratch = null
    if (previousUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousUrl
  })

  const node = async (n: number, wrap?: (pool: Pool) => Pool) => {
    const base = createQueenPool((scratch as { url: string }).url)
    pools.push(base)
    const pool = wrap ? wrap(base) : base
    const link = await createPgLink(pool, n, { pollMs: 200 })
    links.push(link)
    return { pool, link, sys: createActorSystem(undefined, { node: n, link }) }
  }
  const rowsFor = async (n: number) => {
    const p = createQueenPool((scratch as { url: string }).url)
    try {
      const r = await p.query(
        'SELECT count(*)::int AS c FROM queen_actor_mail WHERE node = $1',
        [n],
      )
      return Number((r.rows[0] as { c: number }).c)
    } finally {
      await p.end()
    }
  }

  it('a read whose answer is lost loses no mail and handles none twice', async () => {
    if (!scratch) return
    // A read of node 2's mailbox: the delete-and-return of the old link, or
    // the plain read of the new one (not the expiry's count by group).
    const isRead = (sql: string) =>
      sql.includes('FROM queen_actor_mail') &&
      !sql.includes('GROUP BY') &&
      /^\s*(WITH m AS|SELECT)/.test(sql)
    // An acknowledgement: only the new link has one.
    const isAck = (sql: string) =>
      sql.includes('DELETE FROM queen_actor_mail') && sql.includes('ANY(')
    let lost = 0
    let ackLost = 0
    // the first three reads that find rows lose their answer after the
    // server ran them; then the first acknowledgement is lost before it runs
    const a = await node(1)
    const b = await node(2, (pool) =>
      faulty(pool, (sql, rows) => {
        if (rows === -1) return isAck(sql) && ackLost++ < 1 ? 'before' : null
        return isRead(sql) && rows > 0 && lost++ < 3 ? 'after' : null
      }),
    )
    await until(() => a.link.up(2) && b.link.up(1), 12_000)
    const got: number[] = []
    const far = b.sys.spawn<number>({
      name: 'far',
      receive: (n) => void got.push(n),
    })
    for (let i = 0; i < 20; i++) a.sys.send(far, i)
    await until(() => got.length >= 20, 15_000)
    await sleep(1500)
    expect(lost).toBeGreaterThanOrEqual(3)
    // no message lost, none handled twice
    expect([...got].sort((x, y) => x - y)).toEqual(
      Array.from({ length: 20 }, (_, i) => i),
    )
    // the lost acknowledgement was read again, and caught as a duplicate
    expect(ackLost).toBeGreaterThanOrEqual(1)
    expect(b.link.stats.duplicates).toBeGreaterThan(0)
    expect(await rowsFor(2)).toBe(0)
  }, 60_000)

  it('the fence in the SQL agrees with write_admitted at its edges', async () => {
    if (!scratch) return
    const p = createQueenPool((scratch as { url: string }).url)
    pools.push(p)
    const netlink = loadCardWasm('queen/netlink.wasm')
    await p.query(
      `INSERT INTO queen_actor_node (node, host, heartbeat_at, incarnation)
         VALUES (9, 'test', clock_timestamp(), 4)`,
    )
    let checked = 0
    for (const leaseInc of [3, 4, 5])
      for (const writerInc of [0, 4])
        for (const age of [0, 14.7, 19.7, 20.3, 45]) {
          await p.query(
            `UPDATE queen_actor_node SET incarnation = $1,
                    heartbeat_at = clock_timestamp() - make_interval(secs => $2)
              WHERE node = 9`,
            [leaseInc, age],
          )
          const r = await p.query(FENCE_SQL, [9, writerInc, NODE_TTL_SECONDS])
          const store = (r.rows[0] as { admitted: number }).admitted === 1
          const rule =
            netlink.call64(
              'write_admitted',
              BigInt(leaseInc),
              BigInt(writerInc),
              Math.floor(age),
            ) !== 0
          expect({ leaseInc, writerInc, age, store }).toEqual({
            leaseInc,
            writerInc,
            age,
            store: rule,
          })
          checked++
        }
    expect(checked).toBe(30)
  }, 60_000)

  it('a restarted node neither reuses a pid nor hands its last incarnation mail to the new one', async () => {
    if (!scratch) return
    const a = await node(1)
    const b1 = await node(2)
    await until(() => a.link.up(2) && b1.link.up(1), 12_000)
    const old = b1.sys.spawn<unknown>({ name: 'x', receive: () => {} })
    // the process ends without a word; its lease is still young
    await b1.link.stop()
    for (let i = 0; i < 3; i++) a.sys.send(old, i)
    await sleep(500)
    const b2 = await node(2)
    const got: unknown[] = []
    const fresh = b2.sys.spawn<unknown>({
      name: 'x',
      receive: (m) => void got.push(m),
    })
    await sleep(2000)
    expect(fresh).not.toBe(old)
    expect(got).toEqual([])
    expect(await rowsFor(2)).toBe(0)
  }, 60_000)

  it('a node its peers see down stops its actors, sends nothing, and does not come back', async () => {
    if (!scratch) return
    const a = await node(1)
    const b = await node(2)
    await until(() => a.link.up(2) && b.link.up(1), 12_000)
    const fromB: number[] = []
    const sink = a.sys.spawn<number>({
      name: 'sink',
      receive: (n) => void fromB.push(n),
    })
    let n = 0
    const ticker = b.sys.spawn<number>({
      name: 'ticker',
      receive: (_m, self) => {
        b.sys.send(sink, n++, self)
      },
    })
    const tick = setInterval(() => b.sys.send(ticker, 0), 250)
    // node 2 can still write mail, but it cannot renew: its lease row is held
    const holder = new Pool({
      connectionString: (scratch as { url: string }).url,
      max: 1,
    })
    const c = await holder.connect()
    try {
      await c.query(`SET search_path TO ${queenSchema()}`)
      await c.query('BEGIN')
      await c.query('SELECT 1 FROM queen_actor_node WHERE node = 2 FOR UPDATE')
      await until(() => !a.link.up(2), (NODE_TTL_SECONDS + 10) * 1000)
      expect(a.link.up(2)).toBe(false)
      await sleep(1000)
      const atDown = fromB.length
      await sleep(3000)
      // nothing from a node seen down, and its actors are stopped
      expect(fromB.length).toBe(atDown)
      expect(b.sys.alive(ticker)).toBe(false)
    } finally {
      await c.query('ROLLBACK').catch(() => undefined)
      c.release()
      await holder.end()
      clearInterval(tick)
    }
    // its lease is free again; that incarnation stays down all the same
    await sleep(7000)
    expect(a.link.up(2)).toBe(false)
  }, 90_000)

  it('a newer start on the same node id fences the old one, and its writes are refused', async () => {
    if (!scratch) return
    const a = await node(1)
    const b1 = await node(2)
    await until(() => a.link.up(2) && b1.link.up(1), 12_000)
    const got: number[] = []
    const sink = a.sys.spawn<number>({
      name: 'sink',
      receive: (n) => void got.push(n),
    })
    const worker = b1.sys.spawn<number>({ name: 'w', receive: () => {} })
    // a deploy: the new build starts on the same node id while the old drains
    const b2 = await node(2)
    expect(b2.link.incarnation).toBe(b1.link.incarnation + 1)
    // The old one's next write is refused by the store, and it fences at once.
    // WHICH WRITE COMES FIRST IS A RACE, so neither is asserted: its beat
    // thread renews on its own clock, and when that renewal lands between the
    // new start and this send, the node has fenced before it sends and the
    // send is a dead letter here, not a lost send (3 of 6 full runs in
    // gHashTag/trios#1734; #1729 item 8). What holds either way is asserted:
    // the store admits no write of the old incarnation, the send went
    // nowhere, and the node fenced.
    const dropped = () => b1.link.stats.lostSends + b1.sys.stats.deadLetters
    const droppedBefore = dropped()
    b1.sys.send(sink, 1)
    await until(() => b1.sys.fenced(), 7000)
    expect(b1.sys.fenced()).toBe(true)
    expect(b1.sys.alive(worker)).toBe(false)
    expect(dropped()).toBeGreaterThan(droppedBefore)
    const admitted = await b1.pool.query(FENCE_SQL, [
      2,
      b1.link.incarnation,
      NODE_TTL_SECONDS,
    ])
    expect((admitted.rows[0] as { admitted: number }).admitted).toBe(0)
    await sleep(1500)
    expect(got).toEqual([])
    // the new one is the node now
    b2.sys.send(sink, 2)
    await until(() => got.length === 1, 7000)
    expect(got).toEqual([2])
    expect(b2.sys.fenced()).toBe(false)
  }, 60_000)

  it('mail to a node that died is expired, not kept for ever', async () => {
    if (!scratch) return
    const a = await node(1)
    const b = await node(2)
    await until(() => a.link.up(2) && b.link.up(1), 12_000)
    const x = b.sys.spawn<number>({ name: 'x', receive: () => {} })
    await b.link.stop()
    for (let i = 0; i < 5; i++) a.sys.send(x, i)
    await sleep(1000)
    expect(await rowsFor(2)).toBe(5)
    await until(() => !a.link.up(2), (NODE_TTL_SECONDS + 15) * 1000)
    await sleep(6000)
    expect(await rowsFor(2)).toBe(0)
  }, 90_000)

  it('a stopped node handles and acknowledges no mail, even from a read that was on its way when it stopped', async () => {
    if (!scratch) return
    // trios#1810: the read of the poll that was running when stop() was
    // called reached the store after the sends below, handled them on the
    // stopped node and acknowledged them; the store then held 0 rows, not 5.
    // Here that read is held until the sends are in, so it happens every run.
    const isRead = (sql: string) =>
      sql.includes('FROM queen_actor_mail') && /^\s*SELECT id, to_inc/.test(sql)
    let hold = false
    let held = 0
    let release: () => void = () => undefined
    const released = new Promise<void>((r) => {
      release = r
    })
    const a = await node(1)
    const b = await node(2, (pool) => {
      const query = pool.query.bind(pool) as (
        sql: unknown,
        params?: unknown,
      ) => Promise<unknown>
      ;(pool as unknown as { query: unknown }).query = async (
        sql: unknown,
        params?: unknown,
      ) => {
        const text =
          typeof sql === 'string'
            ? sql
            : String((sql as { text?: string }).text)
        if (hold && isRead(text)) {
          held++
          await released
        }
        return query(sql, params)
      }
      return pool
    })
    await until(() => a.link.up(2) && b.link.up(1), 12_000)
    const got: number[] = []
    const x = b.sys.spawn<number>({
      name: 'x',
      receive: (n) => void got.push(n),
    })
    hold = true
    await until(() => held > 0, 5000)
    expect(held).toBeGreaterThan(0)
    const stopping = b.link.stop()
    for (let i = 0; i < 5; i++) a.sys.send(x, i)
    await until(() => a.link.stats.sent >= 5, 5000)
    expect(a.link.stats.sent).toBe(5)
    release()
    await stopping
    await sleep(1500)
    expect(got).toEqual([])
    expect(b.link.stats.delivered).toBe(0)
    expect(await rowsFor(2)).toBe(5)
  }, 60_000)

  it('a turn that holds the loop for 25 s does not make its node look dead', async () => {
    if (!scratch) return
    const a = await node(1)
    const downs: number[] = []
    a.link.onNodeDown((n) => void downs.push(n))
    const child = Bun.spawn(
      [
        'bun',
        'run',
        new URL('./fixtures/queen-node-proc.ts', import.meta.url).pathname,
      ],
      {
        env: {
          ...process.env,
          QUEEN_NODE_URL: (scratch as { url: string }).url,
          QUEEN_NODE: '2',
        },
        stdout: 'pipe',
        stderr: 'inherit',
      },
    )
    try {
      const reader = child.stdout.getReader()
      let text = ''
      while (!text.includes('\n')) {
        const { value, done } = await reader.read()
        if (done) break
        text += new TextDecoder().decode(value)
      }
      const ready = JSON.parse(text.split('\n')[0]) as { spin: string }
      await until(() => a.link.up(2), 12_000)
      a.sys.send(BigInt(ready.spin) as Pid, 25_000)
      await sleep(25_000 + 8000)
      expect(downs).toEqual([])
      expect(a.link.up(2)).toBe(true)
    } finally {
      child.kill(9)
      await child.exited
    }
  }, 90_000)
})
