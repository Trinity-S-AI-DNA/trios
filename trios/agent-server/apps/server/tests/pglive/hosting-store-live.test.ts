/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE HOSTING STORE AGAINST A REAL POSTGRESQL (gHashTag/trios#1761, slice 1b).
 * Slice 1 (#1760) shipped createPgHostingStore without ever running it on a
 * live database; every test used the memory twin. Here two Queen instances,
 * each with its own pool as two processes would have, share one scratch
 * database:
 *   - the boot migration: nothing with TRIOS_HOSTING off; with it on, run
 *     twice, over slice 1's tables with a row in them, and raced by a second
 *     Queen's first use;
 *   - a lease race: six hosts ask both Queens at once for a job of two
 *     replicas, and exactly two leases go out, to two hosts;
 *   - receipt idempotency: one receipt posted four times at once, to both
 *     Queens, is taken once and credited once;
 *   - a lapsed lease is placed again through the other Queen;
 *   - the epoch closes once while both Queens close it at the same time.
 *
 * WHY IT SKIPS WITHOUT A URL. This file creates and drops databases, so it
 * runs only where TRIOS_PG_TEST_URL names a server built for that (a
 * throwaway cluster, or CI's service container), never against DATABASE_URL.
 * The skip is printed. The other pglive files default to 127.0.0.1:5432
 * instead; this one was asked to skip cleanly (trios#1761).
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { Pool } from 'pg'
import { createHostingRoute } from '../../src/api/routes/hosting'
import {
  createHostAgent,
  type LeasedJob,
  type RunShard,
} from '../../src/api/services/hosting-agent'
import {
  createHostingFeed,
  type FeedSource,
} from '../../src/api/services/hosting-feed'
import {
  createHostingQueen,
  type HostingEconomics,
  type HostingQueen,
} from '../../src/api/services/hosting-queen'
import {
  createPgHostingStore,
  migrateHostingStore,
} from '../../src/api/services/hosting-store'
import {
  generateHostKey,
  keyIdOf,
  normalizeShard,
} from '../../src/api/services/hosting-wire'
import {
  FEED_DEBOUNCE_SECONDS,
  REFERENCE_SOURCES,
  T27B_SOURCES,
} from '../../src/api/services/queen-hosting-feed-card.gen'
import {
  ISO_JOBDIR,
  NODE_TTL_SECONDS,
  TIER_OWNER,
  TIER_PUBLIC,
} from '../../src/api/services/queen-hosting-host-card.gen'
import { JOB_RUN_BOUND_SECONDS } from '../../src/api/services/queen-hosting-placement-card.gen'
import {
  EPOCH_ORIGIN_UNIX,
  EPOCH_SECONDS,
} from '../../src/api/services/queen-hosting-statement-card.gen'
import { runPgMigrations } from '../../src/lib/db/pg-migrate'
import { createQueenPool, queenSchema } from '../../src/lib/db/queen-pool'
import { VirtualClock } from '../api/queen-virtual-clock'

// Each test is a few hundred round trips to a real server: on a loaded host
// (load average 39 when this was measured) bun's 5 s default cut them short.
setDefaultTimeout(120_000)

const URL_KEY = 'TRIOS_PG_TEST_URL'
const adminUrl = process.env[URL_KEY]
if (!adminUrl)
  console.log(
    `hosting-store-live: SKIPPED, ${URL_KEY} is unset (no live PostgreSQL named)`,
  )

const QUEEN = 'http://queen.test'
const SPEC = 'specs/demo/shard.t27'
const INPUT = createHash('sha256').update('module DemoShard;\n').digest('hex')
const MODEL = createHash('sha256').update('t27c as built').digest('hex')

const HOSTING_TABLES = [
  // slice 2a (gHashTag/trios#1867): the feed's receipts and their parts
  'hosting_feed_parts',
  'hosting_feeds',
  'hosting_hosts',
  'hosting_jobs',
  'hosting_leases',
  'hosting_ledger',
  'hosting_statements',
]

/** Slice 1's tables exactly as #1760 created them: the state production may hold. */
const SLICE1_SQL = `
CREATE TABLE IF NOT EXISTS hosting_hosts (
  id text PRIMARY KEY, public_key text NOT NULL, tier smallint NOT NULL,
  tier_claim smallint NOT NULL, slots integer NOT NULL, platform text NOT NULL,
  origin text NOT NULL, incarnation bigint NOT NULL, beat_at bigint NOT NULL,
  strikes integer NOT NULL DEFAULT 0, registered_at bigint NOT NULL);
CREATE TABLE IF NOT EXISTS hosting_jobs (
  id text PRIMARY KEY, state text NOT NULL, created_at bigint NOT NULL, body jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS hosting_leases (
  id text PRIMARY KEY, job_id text NOT NULL, host_id text NOT NULL, state text NOT NULL,
  body jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS hosting_ledger (
  seq bigserial PRIMARY KEY, host_id text NOT NULL, job_id text NOT NULL,
  kind smallint NOT NULL, mtri bigint NOT NULL, at bigint NOT NULL,
  UNIQUE (host_id, job_id, kind));
`

const report = (spec: string) =>
  [
    `--- test report: ${spec} ---`,
    '  pass  a_first',
    '  FAIL  a_second',
    '',
    '  tests       2',
    '  pass        1',
    '  FAIL        1',
    '  invariants  1   proved -- comptime, so compiling IS the check',
    '',
    '  runtime asserts executed, per test (#6509; a pass with 0 is vacuous, T730):',
    '       3  a_first',
    '       2  a_second',
    '  vacuous passes  0 of 2  (passed with 0 runtime asserts executed)',
    '',
  ].join('\n')

const honest: RunShard = async (j: LeasedJob) => ({
  result: normalizeShard(j.spec, {
    started: true,
    timedOut: false,
    exitCode: 0,
    stdout: report(j.spec),
    stderr: '',
  }),
  modelHash: MODEL,
  zig: '0.16.0',
})

const jobOf = (i: number) => ({
  commit: i.toString(16).padStart(40, '0'),
  spec: SPEC,
  input_hash: INPUT,
  files: [{ path: SPEC, sha256: INPUT }],
  holds_secret: false,
  holds_personal: false,
})

async function scratchDatabase(): Promise<{
  url: string
  drop: () => Promise<void>
}> {
  const name = `hosting_live_${randomBytes(6).toString('hex')}`
  const admin = new Pool({ connectionString: adminUrl, max: 1 })
  await admin.query(`CREATE DATABASE ${name}`)
  const url = new URL(adminUrl as string)
  url.pathname = `/${name}`
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

async function withSchema(url: string) {
  const p = new Pool({ connectionString: url, max: 1 })
  await p.query(`CREATE SCHEMA IF NOT EXISTS ${queenSchema()}`)
  await p.end()
}

async function tablesIn(url: string): Promise<string[]> {
  const p = new Pool({ connectionString: url, max: 1 })
  try {
    const r = await p.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'hosting%' ORDER BY 1",
      [queenSchema()],
    )
    return r.rows.map((x) => x.table_name)
  } finally {
    await p.end()
  }
}

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = Object.fromEntries(
    Object.keys(vars).map((k) => [k, process.env[k]]),
  )
  for (const [k, v] of Object.entries(vars))
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
  }
}

/** Two Queens, each with its own pool, on one database and one clock. */
async function twoQueens(url: string, econ: Partial<HostingEconomics>) {
  const clock = new VirtualClock()
  await clock.runUntil(EPOCH_ORIGIN_UNIX * 1000 + 60_000)
  const owner = generateHostKey()
  const allowlist = new Map([[keyIdOf(owner.publicHex), TIER_OWNER]])
  const pools = [
    createQueenPool(url, { max: 4 }),
    createQueenPool(url, { max: 4 }),
  ]
  const queens = pools.map((pool) =>
    createHostingQueen({
      store: createPgHostingStore(pool),
      now: clock.now,
      allowlist,
      economics: econ,
    }),
  ) as [HostingQueen, HostingQueen]
  const apps = queens.map((q) =>
    new Hono().route(
      '/hosting',
      createHostingRoute({ enabled: () => true, queen: () => q }),
    ),
  )
  let n = 0
  const agent = (privatePem: string, via: () => number, tier = TIER_PUBLIC) => {
    const ip = `198.${18 + (n % 200)}.${n++ % 250}.7`
    return createHostAgent({
      queenUrl: QUEEN,
      fetch: async (u, init) =>
        (apps[via()] as Hono).request(u.slice(QUEEN.length), {
          ...init,
          headers: {
            ...(init.headers as Record<string, string>),
            'x-forwarded-for': ip,
          },
        }),
      privatePem,
      tierClaim: tier,
      slots: 2,
      platform: 'darwin-arm64',
      isolation: ISO_JOBDIR,
      runShard: honest,
      clock,
    })
  }
  const mac = agent(owner.privatePem, () => 0, TIER_OWNER)
  await mac.register()
  const end = () => Promise.all(pools.map((p) => p.end()))
  return { clock, queens, apps, agent, mac, pools, end }
}

/** A database of its own for one test, with the hosting tables migrated. */
async function ownDatabase() {
  const fresh = await scratchDatabase()
  await withSchema(fresh.url)
  const p = createQueenPool(fresh.url, { max: 1 })
  await migrateHostingStore(p)
  await p.end()
  return fresh
}

const sql = async (url: string, text: string, args: unknown[] = []) => {
  const p = createQueenPool(url, { max: 1 })
  try {
    return (await p.query(text, args)).rows
  } finally {
    await p.end()
  }
}

describe.skipIf(!adminUrl)('the hosting store on a live PostgreSQL', () => {
  let db: { url: string; drop: () => Promise<void> }
  beforeAll(async () => {
    db = await scratchDatabase()
  })
  afterAll(async () => {
    await db?.drop()
  })

  it('off means off: the boot migration builds no hosting table', async () => {
    await withEnv(
      {
        DATABASE_URL: db.url,
        RAILWAY_SSOT_URL: undefined,
        TRIOS_HOSTING: undefined,
      },
      () => runPgMigrations(),
    )
    // the Queen's own tables are there, so the migration did run
    expect(
      (
        await sql(
          db.url,
          "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'queen_job'",
          [queenSchema()],
        )
      )[0],
    ).toEqual({ n: 1 })
    expect(await tablesIn(db.url)).toEqual([])
  })

  it('migrates at boot over slice 1 tables with rows in them, twice, and keeps the rows', async () => {
    await sql(db.url, SLICE1_SQL)
    await sql(
      db.url,
      "INSERT INTO hosting_ledger (host_id, job_id, kind, mtri, at) VALUES ('abcdef0123456789', 'j_old', 0, 1, 1)",
    )
    for (let i = 0; i < 2; i++)
      await withEnv(
        {
          DATABASE_URL: db.url,
          RAILWAY_SSOT_URL: undefined,
          TRIOS_HOSTING: 'on',
        },
        () => runPgMigrations(),
      )
    expect(await tablesIn(db.url)).toEqual(HOSTING_TABLES)
    const cols = await sql(
      db.url,
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name IN ('hosting_hosts','hosting_ledger') AND column_name IN ('agreed','fee_kind','epoch','receipt','source') ORDER BY 1, 2",
      [queenSchema()],
    )
    expect(cols).toEqual([
      { table_name: 'hosting_hosts', column_name: 'agreed' },
      { table_name: 'hosting_ledger', column_name: 'epoch' },
      { table_name: 'hosting_ledger', column_name: 'fee_kind' },
      { table_name: 'hosting_ledger', column_name: 'receipt' },
      { table_name: 'hosting_ledger', column_name: 'source' },
    ])
    expect(
      await sql(
        db.url,
        'SELECT job_id, mtri, fee_kind, epoch, receipt, source FROM hosting_ledger',
      ),
    ).toEqual([
      {
        job_id: 'j_old',
        mtri: '1',
        fee_kind: 0,
        epoch: '0',
        receipt: null,
        source: 'hosting',
      },
    ])
    await sql(db.url, 'DELETE FROM hosting_ledger')
  })

  it('a second Queen racing the first one on a fresh database: both migrate, neither fails', async () => {
    const fresh = await scratchDatabase()
    try {
      await withSchema(fresh.url)
      const pools = [0, 1, 2, 3].map(() =>
        createQueenPool(fresh.url, { max: 2 }),
      )
      await Promise.all(pools.map((p) => migrateHostingStore(p)))
      // and the stores' own first use, at once, on top
      await Promise.all(
        pools.map((p) => createPgHostingStore(p).tx((s) => s.hosts())),
      )
      await Promise.all(pools.map((p) => p.end()))
      expect(await tablesIn(fresh.url)).toEqual(HOSTING_TABLES)
    } finally {
      await fresh.drop()
    }
  })

  it('leases one job of two replicas to exactly two hosts while six ask both Queens at once', async () => {
    const own = await ownDatabase()
    const w = await twoQueens(own.url, { sybil: false })
    try {
      await w.mac.submitJob(jobOf(1))
      const hosts = [0, 1, 2, 3, 4, 5].map((i) =>
        w.agent(generateHostKey().privatePem, () => i % 2),
      )
      for (const h of hosts) await h.register()
      const leases = await Promise.all(hosts.map((h) => h.leaseOnce()))
      const got = leases.filter((l) => l !== null)
      expect(got).toHaveLength(2)
      const rows = await sql(
        own.url,
        "SELECT host_id FROM hosting_leases WHERE body->>'jobId' = (SELECT id FROM hosting_jobs WHERE body->>'commit' = $1)",
        [jobOf(1).commit],
      )
      expect(rows).toHaveLength(2)
      expect(new Set(rows.map((r) => r.host_id)).size).toBe(2)
      const job = await sql(
        own.url,
        "SELECT (body->>'leasesIssued')::int AS issued FROM hosting_jobs WHERE body->>'commit' = $1",
        [jobOf(1).commit],
      )
      expect(job).toEqual([{ issued: 2 }])
    } finally {
      await w.end()
      await own.drop()
    }
  })

  it('takes one receipt once when it is posted four times at once to both Queens', async () => {
    const own = await ownDatabase()
    const w = await twoQueens(own.url, { sybil: false })
    try {
      await w.mac.submitJob(jobOf(2))
      const a = w.agent(generateHostKey().privatePem, () => 0)
      const b = w.agent(generateHostKey().privatePem, () => 1)
      await a.register()
      await b.register()
      const la = await a.leaseOnce()
      const lb = await b.leaseOnce()
      expect(la?.job.commit).toBe(jobOf(2).commit)
      const receipt = a.receiptOf(
        la as NonNullable<typeof la>,
        await honest(la?.job as LeasedJob, new AbortController().signal),
      )
      const post = (i: number) =>
        (w.apps[i] as Hono)
          .request('/hosting/receipts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(receipt),
          })
          .then((r) => r.json() as Promise<{ code: string }>)
      const answers = await Promise.all([post(0), post(1), post(0), post(1)])
      const codes = answers.map((x) => x.code).sort()
      expect(codes).toEqual(['duplicate', 'duplicate', 'duplicate', 'ok'])
      expect(await b.work(lb as NonNullable<typeof lb>)).toMatchObject({
        job: { verdict: 'agreed' },
      })
      const credits = await sql(
        own.url,
        'SELECT host_id, count(*)::int AS n FROM hosting_ledger WHERE job_id = $1 AND kind = 0 GROUP BY 1 ORDER BY 1',
        [la?.job.id],
      )
      expect(credits.map((r) => r.n)).toEqual([1, 1])
    } finally {
      await w.end()
      await own.drop()
    }
  })

  it('places a lapsed lease again, through the other Queen', async () => {
    const own = await ownDatabase()
    const w = await twoQueens(own.url, { sybil: false })
    try {
      await w.mac.submitJob(jobOf(3))
      const silent = w.agent(generateHostKey().privatePem, () => 0)
      const other = w.agent(generateHostKey().privatePem, () => 1)
      const third = w.agent(generateHostKey().privatePem, () => 1)
      for (const h of [silent, other, third]) await h.register()
      const l1 = await silent.leaseOnce()
      const l2 = await other.leaseOnce()
      expect(l1?.job.commit).toBe(jobOf(3).commit)
      expect(await third.leaseOnce()).toBeNull()
      // the silent host stops beating; the others keep beating
      const step = (NODE_TTL_SECONDS + JOB_RUN_BOUND_SECONDS + 5) * 1000
      const until = w.clock.now() + step
      while (w.clock.now() < until) {
        await w.clock.runUntil(w.clock.now() + 5_000)
        await other.beat()
        await third.beat()
        await w.mac.beat()
      }
      const l3 = await third.leaseOnce()
      expect(l3?.job.id).toBe(l1?.job.id)
      const lapsed = await sql(
        own.url,
        'SELECT state FROM hosting_leases WHERE id = $1',
        [l1?.lease],
      )
      expect(lapsed).toEqual([{ state: 'lapsed' }])
      await other.work(l2 as NonNullable<typeof l2>)
      expect(await third.work(l3 as NonNullable<typeof l3>)).toMatchObject({
        job: { verdict: 'agreed' },
      })
    } finally {
      await w.end()
      await own.drop()
    }
  })

  it('with the sybil rules on: a wrong canary is slashed and struck once, through both Queens', async () => {
    const own = await ownDatabase()
    const w = await twoQueens(own.url, { sybil: true, canaryDraw: () => 0 })
    try {
      const wrong: RunShard = async (j) => ({
        ...(await honest(j, new AbortController().signal)),
        result: normalizeShard(j.spec, {
          started: true,
          timedOut: false,
          exitCode: 0,
          stdout: report(j.spec).replace('FAIL  a_second', 'pass  a_second'),
          stderr: '',
        }),
      })
      const truth = (
        await honest({ spec: SPEC } as LeasedJob, new AbortController().signal)
      ).result.outputHash
      await w.mac.submitJob({ ...jobOf(20), known_output_hash: truth })
      const liar = createHostAgent({
        queenUrl: QUEEN,
        fetch: async (u, init) =>
          (w.apps[1] as Hono).request(u.slice(QUEEN.length), {
            ...init,
            headers: {
              ...(init.headers as Record<string, string>),
              'x-forwarded-for': '192.0.2.66',
            },
          }),
        privatePem: generateHostKey().privatePem,
        tierClaim: TIER_PUBLIC,
        slots: 1,
        platform: 'darwin-arm64',
        isolation: ISO_JOBDIR,
        runShard: wrong,
        clock: w.clock,
      })
      const good = w.agent(generateHostKey().privatePem, () => 0)
      await liar.register()
      await good.register()
      const l = await liar.leaseOnce()
      expect(l?.job.commit).toBe(jobOf(20).commit)
      expect(JSON.stringify(l)).not.toContain(truth)
      expect(await liar.work(l as NonNullable<typeof l>)).toMatchObject({
        job: { verdict: 'tiebreak' },
      })
      const g = await good.leaseOnce()
      expect(await good.work(g as NonNullable<typeof g>)).toMatchObject({
        job: { verdict: 'agreed' },
      })
      const rows = await sql(
        own.url,
        'SELECT kind, fee_kind, count(*)::int AS n FROM hosting_ledger WHERE host_id = $1 GROUP BY 1, 2 ORDER BY 1',
        [liar.id],
      )
      // one strike (kind 1) and one slash (kind 2, ENTRY_SLASH 9), never two
      expect(rows).toEqual([
        { kind: 1, fee_kind: 0, n: 1 },
        { kind: 2, fee_kind: 9, n: 1 },
      ])
      const hosts = await sql(
        own.url,
        'SELECT id, strikes, agreed FROM hosting_hosts WHERE id = ANY($1) ORDER BY strikes',
        [[liar.id, good.id]],
      )
      expect(hosts).toEqual([
        { id: good.id, strikes: 0, agreed: 1 },
        { id: liar.id, strikes: 1, agreed: 0 },
      ])
    } finally {
      await w.end()
      await own.drop()
    }
  })

  it('closes an epoch once while both Queens close it at the same time', async () => {
    const fresh = await scratchDatabase()
    const key = generateHostKey()
    try {
      await withSchema(fresh.url)
      const w = await twoQueens(fresh.url, {
        sybil: false,
        ledgerKeyPem: key.privatePem,
      })
      try {
        const a = w.agent(generateHostKey().privatePem, () => 0)
        const b = w.agent(generateHostKey().privatePem, () => 1)
        await a.register()
        await b.register()
        for (let i = 10; i < 13; i++) {
          await w.mac.submitJob(jobOf(i))
          const la = await a.leaseOnce()
          const lb = await b.leaseOnce()
          await a.work(la as NonNullable<typeof la>)
          await b.work(lb as NonNullable<typeof lb>)
        }
        await w.clock.runUntil((EPOCH_ORIGIN_UNIX + EPOCH_SECONDS) * 1000 + 5)
        const answers = await Promise.all([
          w.queens[0].epochs(),
          w.queens[1].epochs(),
          w.queens[0].epochs(),
          w.queens[1].epochs(),
        ])
        const rows = await sql(
          fresh.url,
          'SELECT epoch, root FROM hosting_statements ORDER BY epoch',
        )
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ epoch: '0' })
        for (const x of answers) {
          expect(x.epochs).toHaveLength(1)
          expect(x.epochs[0]).toMatchObject({
            root: rows[0]?.root,
            credit_mtri: 6,
            leaves: 2,
          })
          expect(x.epochs[0]?.signature).toBe(answers[0]?.epochs[0]?.signature)
        }
      } finally {
        await w.end()
      }
    } finally {
      await fresh.drop()
    }
  })
  it('the feed over the live store: two Queens feed one head once, and its receipt reads back from the parts', async () => {
    const fresh = await scratchDatabase()
    try {
      await withSchema(fresh.url)
      const w = await twoQueens(fresh.url, { sybil: false })
      try {
        // t27 at P0 (the pin) and H1, where specs/a/base.t27 changed: base
        // and mid (which imports it) are sharded, single is carried
        const P0 = '1'.repeat(40)
        const H1 = '2'.repeat(40)
        const files = (base: string): Record<string, string> => ({
          'specs/a/base.t27': base,
          'specs/a/mid.t27': 'use a::base;\n',
          'specs/b/single.t27': 'module B;\n',
        })
        const toolchain = Object.fromEntries(
          [...new Set([...REFERENCE_SOURCES, ...T27B_SOURCES])].map((p) => [
            p,
            createHash('sha1').update(p).digest('hex'),
          ]),
        )
        const trees: Record<string, Record<string, string>> = {}
        const blobs = new Map<string, string>()
        for (const [sha, base] of [
          [P0, 'module A;\n'],
          [H1, 'module A;\nconst X = 1;\n'],
        ] as const) {
          const tree: Record<string, string> = { ...toolchain }
          for (const [p, text] of Object.entries(files(base))) {
            const id = createHash('sha1').update(text).digest('hex')
            blobs.set(id, text)
            tree[p] = id
          }
          // two of t27b's sources are specs: give them bytes
          for (const p of T27B_SOURCES.filter((x) => x.startsWith('specs/'))) {
            blobs.set(toolchain[p] as string, `module ${p.length};\n`)
          }
          trees[sha] = tree
        }
        const row = (file: string) => ({
          file,
          reference: 'pass',
          reference_detail: '',
          t27b: 'pass',
          tests: 1,
          invariants: 0,
          asserts: 1,
          blockers: [],
          detail: '',
          test_verdicts: { t: true },
          reference_tests: { t: true },
          reference_disagree: [],
          retried_after_timeout: true,
        })
        const source: FeedSource = {
          head: async () => ({ sha: H1, etag: null }),
          tree: async (c) =>
            trees[c] ? new Map(Object.entries(trees[c])) : null,
          file: async (c, p) =>
            new TextEncoder().encode(blobs.get(trees[c]?.[p] as string) ?? ''),
          labRun: async (c) =>
            c === P0
              ? {
                  results: Object.keys(trees[P0] as object)
                    .filter((p) => p.startsWith('specs/'))
                    .map(row),
                }
              : null,
          labUrl: (c) => `https://lab.test/runs/${c}.json`,
        }
        const feeds = w.pools.map((pool, i) =>
          createHostingFeed({
            store: createPgHostingStore(pool),
            queen: w.queens[i] as HostingQueen,
            source,
            now: w.clock.now,
            pin: P0,
          }),
        )
        await Promise.all(feeds.map((f) => f.tick()))
        await w.clock.runUntil(w.clock.now() + FEED_DEBOUNCE_SECONDS * 1000)
        await Promise.all(feeds.map((f) => f.tick()))
        const rows = await sql(
          fresh.url,
          `SELECT id, (body->>'seq')::int AS seq FROM ${queenSchema()}.hosting_feeds ORDER BY id`,
        )
        expect(rows).toEqual([
          { id: H1, seq: 1 },
          { id: `lab:${P0}`, seq: 0 },
        ])
        // 2 specs x 2 halves sharded, once, whichever Queen claimed the head
        const jobs = await sql(
          fresh.url,
          `SELECT count(*)::int AS n FROM ${queenSchema()}.hosting_jobs`,
        )
        expect(jobs[0]?.n).toBe(4)
        // the lab's 5 rows share two distinct parts (one per half), stored once
        const parts = await sql(
          fresh.url,
          `SELECT count(*)::int AS n FROM ${queenSchema()}.hosting_feed_parts`,
        )
        expect(parts[0]?.n).toBe(2)
        const status = await feeds[1]?.status()
        expect(status?.feeds.map((f) => [f.id, f.state, f.specs])).toEqual([
          [H1, 'open', 5],
          [`lab:${P0}`, 'complete', 5],
        ])
        const receipt = await feeds[0]?.receipt(H1)
        const single = receipt?.rows.find(
          (r) => r.file === 'specs/b/single.t27',
        )
        expect(single).toMatchObject({ reference: 'pass', t27b: 'pass' })
        // the lab's load key is never carried
        expect(single).not.toHaveProperty('retried_after_timeout')
        expect(receipt?.unsettled.map((u) => u.file).sort()).toEqual([
          'specs/a/base.t27',
          'specs/a/mid.t27',
        ])
      } finally {
        await w.end()
      }
    } finally {
      await fresh.drop()
    }
  })
})
