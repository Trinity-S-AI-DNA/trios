/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * PGLINK AT ITS EDGES (gHashTag/t27 specs/queen/netlink.t27,
 * gHashTag/trios#1731), against a real PostgreSQL: a start whose claim
 * fails, a node that renews on its own loop and finds its row taken, a mail
 * handler that throws, a send asked of a fenced node, a node with no LISTEN
 * connection, and a beat thread that dies.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { Pool } from 'pg'
import {
  createActorSystem,
  type Mail,
  type Pid,
} from '../../src/api/services/queen-actors'
import {
  createPgLink,
  FENCE_SQL,
  type PgLink,
} from '../../src/api/services/queen-actors-pg'
import {
  NODE_HEARTBEAT_SECONDS,
  NODE_TTL_SECONDS,
  SELF_FENCE_SECONDS,
} from '../../src/api/services/queen-netlink-card.gen'
import { runPgMigrations } from '../../src/lib/db/pg-migrate'
import { createQueenPool } from '../../src/lib/db/queen-pool'
import { logger } from '../../src/lib/logger'
import { offlineRequested, scratchDatabase } from './queen-waits-world'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (cond: () => boolean, ms: number) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await sleep(50)
}

/**
 * The pool as createPgLink sees it, with some of its answers changed:
 * no url for a beat thread, its connections handed out by `connect`, or a
 * hook run once before the first statement `before.sql` matches, whose
 * answer `before.saw` is then shown.
 */
function seen(
  pool: Pool,
  change: {
    noUrl?: boolean
    connect?: (n: number) => Promise<unknown>
    before?: {
      sql: RegExp
      run: () => Promise<void>
      saw?: (answer: { rows: unknown[] }) => void
    }
  },
): Pool {
  let n = 0
  let hooked = false
  return new Proxy(pool, {
    get(target, key) {
      if (key === 'options' && change.noUrl)
        return { ...target.options, connectionString: undefined }
      if (key === 'connect' && change.connect) {
        const connect = change.connect
        return () => connect(n++)
      }
      if (key === 'query' && change.before) {
        const before = change.before
        return async (sql: string, params?: unknown[]) => {
          if (!hooked && before.sql.test(sql)) {
            hooked = true
            await before.run()
            const answer = await target.query(sql, params)
            before.saw?.(answer)
            return answer
          }
          return target.query(sql, params)
        }
      }
      const v = Reflect.get(target, key)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

describe('PgLink at its edges, against PostgreSQL', () => {
  let scratch: { url: string; drop: () => Promise<void> } | null = null
  const pools: Pool[] = []
  const links: PgLink[] = []
  const restore: Array<() => void> = []
  const previousUrl = process.env.DATABASE_URL

  beforeEach(async () => {
    scratch = await scratchDatabase('queen_pg_edges')
    if (!scratch) return
    process.env.DATABASE_URL = scratch.url
    await runPgMigrations()
  })

  afterEach(async () => {
    for (const l of links.splice(0)) await l.stop().catch(() => undefined)
    for (const p of pools.splice(0)) await p.end().catch(() => undefined)
    for (const r of restore.splice(0)) r()
    await scratch?.drop()
    scratch = null
    if (previousUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousUrl
  })

  const pool = (max = 10): Pool => {
    const p = createQueenPool((scratch as { url: string }).url, { max })
    pools.push(p)
    return p
  }
  const link = async (
    p: Pool,
    n: number,
    options: Parameters<typeof createPgLink>[2] = {},
  ) => {
    const l = await createPgLink(p, n, { pollMs: 200, ...options })
    links.push(l)
    return l
  }
  const warnings = () => {
    const w = spyOn(logger, 'warn').mockImplementation(() => {})
    restore.push(() => w.mockRestore())
    return (msg: string) => w.mock.calls.filter((c) => c[0] === msg)
  }
  /** What another start's claim writes: the node's next incarnation. */
  const takeRow = async (node: number) => {
    await pool().query(
      `UPDATE queen_actor_node
          SET incarnation = incarnation + 1, heartbeat_at = clock_timestamp()
        WHERE node = $1`,
      [node],
    )
  }

  it('a start whose claim the store refuses rolls back and rejects, and leaves its connection clean', async () => {
    if (!scratch) return expect(offlineRequested()).toBe(true)
    const p = pool(1)
    // node is an int column: 2^31 fails the INSERT inside the claim
    await expect(createPgLink(p, 2 ** 31)).rejects.toThrow(/out of range/)
    // one connection: left inside the failed transaction, this would fail
    const r = await p.query('SELECT count(*)::int AS n FROM queen_actor_node')
    expect(r.rows[0].n).toBe(0)
  }, 60_000)

  it('a node that renews on its own loop fences itself at its next read of the leases once a newer start holds its row', async () => {
    if (!scratch) return expect(offlineRequested()).toBe(true)
    const said = warnings()
    const old = await link(seen(pool(), { noUrl: true }), 3)
    let heard = 0
    old.onFenced(() => {
      heard++
    })
    expect(
      said('Queen actor node renews its lease on the actors loop').length,
    ).toBe(1)
    const fresh = await link(pool(), 3)
    expect(fresh.incarnation).toBe(old.incarnation + 1)
    await until(() => old.fenced(), 8000)
    expect(old.fenced()).toBe(true)
    expect(heard).toBe(1)
    expect(fresh.fenced()).toBe(false)
    expect(said('Queen actor node fenced itself')[0][1]).toMatchObject({
      node: 3,
      inc: old.incarnation,
    })
  }, 60_000)

  it('a fenced node writes no mail: a send it is asked for is counted lost', async () => {
    if (!scratch) return expect(offlineRequested()).toBe(true)
    const p = pool()
    const old = await link(seen(p, { noUrl: true }), 4)
    const peer = await link(pool(), 5)
    await link(pool(), 4)
    await until(() => old.fenced(), 8000)
    expect(old.fenced()).toBe(true)
    const lost = old.stats.lostSends
    const mail: Mail = { kind: 'send', to: 1n, msg: 'late' }
    old.carry(5, mail, peer.incarnation)
    await old.stop()
    expect(old.stats.lostSends).toBe(lost + 1)
    const rows = await p.query(
      'SELECT count(*)::int AS n FROM queen_actor_mail',
    )
    expect(rows.rows[0].n).toBe(0)
  }, 60_000)

  it('a mail handler that throws is logged, and the handlers after it still get the mail', async () => {
    if (!scratch) return expect(offlineRequested()).toBe(true)
    const said = warnings()
    const la = await link(pool(), 6)
    const lb = await link(pool(), 7)
    lb.onMail(() => {
      throw new Error('a handler that breaks')
    })
    const a = createActorSystem(undefined, { node: 6, link: la })
    const b = createActorSystem(undefined, { node: 7, link: lb })
    const got: string[] = []
    const sink: Pid = b.spawn<string>({
      name: 'sink',
      receive: (m) => void got.push(m),
    })
    await until(() => la.up(7), 12_000)
    a.send(sink, 'through')
    await until(() => got.length > 0, 10_000)
    expect(got).toEqual(['through'])
    expect(lb.stats.delivered).toBe(1)
    expect(said('Queen actor mail handler threw')[0][1]).toMatchObject({
      node: 7,
      error: 'a handler that breaks',
    })
  }, 60_000)

  it('a node that cannot hold a LISTEN connection says so and still gets its mail by polling', async () => {
    if (!scratch) return expect(offlineRequested()).toBe(true)
    const said = warnings()
    const pb = pool()
    // the claim's connection is given; the LISTEN connection is not
    const lb = await link(
      seen(pb, {
        connect: (n) =>
          n === 0
            ? pb.connect()
            : Promise.reject(new Error('too many clients already')),
      }),
      9,
    )
    expect(
      said('Queen actor node listens by polling only')[0][1],
    ).toMatchObject({ node: 9, error: 'too many clients already' })
    const la = await link(pool(), 8)
    const a = createActorSystem(undefined, { node: 8, link: la })
    const b = createActorSystem(undefined, { node: 9, link: lb })
    const got: string[] = []
    const sink = b.spawn<string>({
      name: 'sink',
      receive: (m) => void got.push(m),
    })
    await until(() => la.up(9), 12_000)
    a.send(sink, 'polled')
    await until(() => got.length > 0, 5000)
    expect(got).toEqual(['polled'])
  }, 60_000)

  it('a beat thread that dies is reported, and with nothing renewing the node fences itself', async () => {
    if (!scratch) return expect(offlineRequested()).toBe(true)
    const said = warnings()
    // a url the thread cannot use kills it at its first line
    const l = await link(pool(), 11, { url: 42 as unknown as string })
    await until(
      () => said('Queen actor node lost its beat thread').length > 0,
      5000,
    )
    expect(said('Queen actor node lost its beat thread')[0][1]).toMatchObject({
      node: 11,
    })
    expect(l.fenced()).toBe(false)
    await until(() => l.fenced(), (SELF_FENCE_SECONDS + 5) * 1000)
    expect(l.fenced()).toBe(true)
    expect(String(said('Queen actor node fenced itself')[0][1]?.why)).toMatch(
      /^no renewal for/,
    )
  }, 60_000)

  // Which refused write of node 13 fences it is a race (gHashTag/trios#1778):
  // its acknowledgement, or a write of the heartbeat its own loop runs every
  // NODE_HEARTBEAT_SECONDS when that lands between the claim and the
  // acknowledgement: the renewal, or the expiry of the very mail being
  // handled, whose incarnation is now over (seen on CI, 56c5df785 and run
  // 38086264626). None is pinned. What holds either way is asserted: the
  // mail was handled, the node fenced once on a refused write, its
  // acknowledgement deleted nothing (the row is still there), and the store
  // admits no write of its incarnation. The second case makes the heartbeat
  // win, so both outcomes run on every run.
  const refusedWrites = [
    'the store refused an acknowledgement',
    'the store refused a renewal',
    'the store refused an expiry',
  ]
  for (const heartbeatFirst of [false, true])
    it(`an acknowledgement the store refuses fences the node at once: the claim of another start took its row while the mail was handled${heartbeatFirst ? ' (its own heartbeat is refused first)' : ''}`, async () => {
      if (!scratch) return expect(offlineRequested()).toBe(true)
      const said = warnings()
      const p = pool()
      const lc = await link(pool(), 14)
      let acked: { fence: number; ids: unknown[] } | undefined
      // node 13's acknowledgement first lets another start's claim take the
      // row: the mail was read and handled, its delete is fenced out. Node 13
      // renews on its own loop, with no beat thread: only that loop's
      // heartbeat can race the acknowledgement.
      const la: PgLink = await link(
        seen(p, {
          noUrl: true,
          before: {
            sql: /id = ANY\(\$2::bigint\[\]\)/,
            run: async () => {
              await takeRow(13)
              if (heartbeatFirst)
                await until(
                  () => la.fenced(),
                  (NODE_HEARTBEAT_SECONDS + 5) * 1000,
                )
            },
            saw: (answer) => {
              acked = answer.rows[0] as { fence: number; ids: unknown[] }
            },
          },
        }),
        13,
      )
      let heard = 0
      la.onFenced(() => {
        heard++
      })
      const a = createActorSystem(undefined, { node: 13, link: la })
      const c = createActorSystem(undefined, { node: 14, link: lc })
      const got: string[] = []
      const sink = a.spawn<string>({
        name: 'sink',
        receive: (m) => void got.push(m),
      })
      await until(() => lc.up(13), 12_000)
      c.send(sink, 'handled, then fenced')
      // node 14 stops once the mail is in the store: left running, it would
      // expire the row of an incarnation that is over before a late
      // acknowledgement could reach it, and hide what that acknowledgement did
      await until(() => lc.stats.sent === 1, 5000)
      await lc.stop()
      await until(() => la.fenced() && acked !== undefined, 20_000)
      expect(got).toEqual(['handled, then fenced'])
      expect(la.fenced()).toBe(true)
      expect(heard).toBe(1)
      const fencedLines = said('Queen actor node fenced itself')
      expect(fencedLines.length).toBe(1)
      expect(fencedLines[0][1]).toMatchObject({
        node: 13,
        inc: la.incarnation,
      })
      const why = String((fencedLines[0][1] as { why?: unknown }).why)
      expect(refusedWrites).toContain(why)
      if (heartbeatFirst)
        expect(why).not.toBe('the store refused an acknowledgement')
      // the old incarnation's acknowledgement was refused and deleted nothing:
      // the mail row it handled is still in the store
      expect(acked).toEqual({ fence: 0, ids: [] })
      const left = await p.query(
        'SELECT count(*)::int AS n FROM queen_actor_mail WHERE node = 13',
      )
      expect(left.rows[0].n).toBe(1)
      const admitted = await p.query(FENCE_SQL, [
        13,
        la.incarnation,
        NODE_TTL_SECONDS,
      ])
      expect((admitted.rows[0] as { admitted: number }).admitted).toBe(0)
    }, 60_000)

  it('a send the store refuses is counted lost and fences the node: the claim of another start took its row just before the send', async () => {
    if (!scratch) return expect(offlineRequested()).toBe(true)
    const said = warnings()
    const p = pool()
    const lb = await link(pool(), 18)
    const la = await link(
      seen(p, {
        noUrl: true,
        before: {
          sql: /INSERT INTO queen_actor_mail/,
          run: () => takeRow(17),
        },
      }),
      17,
    )
    const a = createActorSystem(undefined, { node: 17, link: la })
    const b = createActorSystem(undefined, { node: 18, link: lb })
    const sink = b.spawn<string>({ name: 'sink', receive: () => {} })
    await until(() => la.up(18), 12_000)
    a.send(sink, 'refused at the store')
    await until(() => la.fenced(), 10_000)
    expect(la.stats.lostSends).toBe(1)
    expect(la.stats.sent).toBe(0)
    expect(said('Queen actor node fenced itself')[0][1]).toMatchObject({
      node: 17,
      why: 'the store refused a send',
    })
    const rows = await p.query(
      'SELECT count(*)::int AS n FROM queen_actor_mail',
    )
    expect(rows.rows[0].n).toBe(0)
  }, 60_000)

  it('an expiry the store refuses fences the node: the claim of another start took its row between its read of the leases and the expiry', async () => {
    if (!scratch) return expect(offlineRequested()).toBe(true)
    const said = warnings()
    const p = pool()
    // mail left for node 99, which holds no lease: expired (mail_expired)
    await p.query(
      `INSERT INTO queen_actor_mail (node, to_inc, from_node, from_inc, body)
       VALUES (99, 1, 0, 0, '{}')`,
    )
    // renewing on its own loop, the heartbeat renews, reads the leases and
    // then expires, in that order; the claim lands just before the expiry
    const la = await link(
      seen(p, {
        noUrl: true,
        before: {
          sql: /AND to_inc = \$2 AND EXISTS/,
          run: () => takeRow(15),
        },
      }),
      15,
    )
    await until(() => la.fenced(), 12_000)
    expect(la.fenced()).toBe(true)
    expect(said('Queen actor node fenced itself')[0][1]).toMatchObject({
      node: 15,
      why: 'the store refused an expiry',
    })
    // the fenced expiry deleted nothing
    expect(la.stats.expired).toBe(0)
  }, 60_000)

  it('a node whose UNLISTEN fails at stop still gives its connection back', async () => {
    if (!scratch) return expect(offlineRequested()).toBe(true)
    const p = pool()
    let released = 0
    const asked: string[] = []
    const l = await link(
      seen(p, {
        connect: async (n) => {
          const client = await p.connect()
          if (n === 0) return client
          // the LISTEN connection
          return new Proxy(client, {
            get(target, key) {
              if (key === 'query')
                return async (sql: string) => {
                  asked.push(sql)
                  if (sql.startsWith('UNLISTEN'))
                    throw new Error('the connection is gone')
                  return target.query(sql)
                }
              if (key === 'release')
                return () => {
                  released++
                  target.release()
                }
              const v = Reflect.get(target, key)
              return typeof v === 'function' ? v.bind(target) : v
            },
          })
        },
      }),
      16,
    )
    links.splice(links.indexOf(l), 1)
    await l.stop()
    expect(asked).toEqual([
      'LISTEN queen_actor_mail_16',
      'UNLISTEN queen_actor_mail_16',
    ])
    expect(released).toBe(1)
    expect(p.waitingCount).toBe(0)
  }, 60_000)

  // A beat thread terminated while its modules were still being transpiled
  // crashed Bun 1.3.6 and 1.3.11 outright, after every test of this file had
  // passed (gHashTag/trios#1813). Each start here is stopped at once, inside
  // that window; every terminate must come after the thread said it loaded.
  it('a node stopped as soon as it starts ends its beat thread only once the thread has loaded', async () => {
    if (!scratch) return expect(offlineRequested()).toBe(true)
    const Real = globalThis.Worker
    const ends: boolean[] = []
    class Watched extends Real {
      private loaded = false
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args)
        this.addEventListener('message', (event: MessageEvent) => {
          if ((event.data as { loaded?: boolean }).loaded) this.loaded = true
        })
      }
      override terminate(): void {
        ends.push(this.loaded)
        super.terminate()
      }
    }
    globalThis.Worker = Watched
    restore.push(() => {
      globalThis.Worker = Real
    })
    const p = pool()
    for (let i = 0; i < 20; i++) await (await link(p, 19)).stop()
    expect(ends).toEqual(Array(20).fill(true))
  }, 60_000)
})
