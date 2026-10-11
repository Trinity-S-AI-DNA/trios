/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Where the self-hosting rows live (gHashTag/trios#1756): hosts, jobs, leases,
 * the off-chain ledger and, since slice 1b (trios#1761), the signed epoch
 * statements. State only; it decides nothing.
 *
 * Two stores, one interface. The Queen runs on Postgres (the `pg` pool every
 * Queen route uses, tables created in code on first use, like the waits and
 * the jobs). Tests run on the memory store. Every Queen operation runs inside
 * one `tx`: on Postgres a transaction holding a transaction-scoped advisory
 * lock, so two Queen processes (a deploy's old and new one) never place the
 * same replica twice; in memory a queue, for the same reason.
 */

import type { Pool, PoolClient } from 'pg'

export interface HostRow {
  /** The key id: KEY_ID_HEX_LEN hex characters of SHA-256(public key). */
  id: string
  publicKey: string
  tier: number
  tierClaim: number
  slots: number
  platform: string
  /** host.t27 ISO_*: the isolation the host measured and signed into its registration. */
  isolation: number
  /** A hash of the network prefix the host registered from, never the address. */
  origin: string
  incarnation: number
  beatAt: number
  strikes: number
  registeredAt: number
  /** Votes on the agreeing side so far: sybil.t27's probation counter. */
  agreed: number
}

export interface JobFile {
  path: string
  sha256: string
}

export interface JobResult {
  outputHash: string
  /** The agreed normalized output: what a lab row is assembled from (hosting-wire assembleRow). */
  output?: string
  word: string
  tests: number
  ops: number
  hosts: string[]
}

export interface JobRow {
  id: string
  kind: 'shard'
  /** row.t27 HALF_*: which half of the lab's row this job is. */
  half: number
  commit: string
  spec: string
  inputHash: string
  files: JobFile[]
  modelHash: string | null
  workloadClass: number
  holdsSecret: boolean
  holdsPersonal: boolean
  wanted: number
  leasesIssued: number
  /**
   * A known answer (sybil.t27): the output hash a lab row or an anchored
   * quorum already agreed. Never shown to a host: it is not in the job's id
   * nor in its payload.
   */
  knownHash?: string | null
  state: 'open' | 'agreed' | 'unresolved'
  verdict: number
  createdAt: number
  closedAt: number | null
  result: JobResult | null
}

export interface LeaseRow {
  id: string
  jobId: string
  hostId: string
  incarnation: number
  nonce: string
  leasedAt: number
  /** out: running; reported: a receipt is in; lapsed: placed again; closed: the job ended first. */
  state: 'out' | 'reported' | 'lapsed' | 'closed'
  code: number | null
  vote: boolean
  outputHash: string | null
  /** The first receipt for this lease, exactly as it came. */
  receipt: Record<string, unknown> | null
  receivedAt: number | null
  /** 1 for the job's first receipt, 2 for its second, ... (slice 1b). */
  arrival?: number
}

export interface LedgerRow {
  seq: number
  hostId: string
  jobId: string
  /** credit.t27 LE_CREDIT, LE_STRIKE or LE_SLASH. */
  kind: number
  mtri: number
  at: number
  /** statement.t27: the payment kind of a credit, ENTRY_SLASH for a slash, 0 for a strike. */
  feeKind: number
  /** statement.t27 epoch_of(at). */
  epoch: number
  /** The receipt (lease) behind the row, when there is one. */
  receipt: string | null
  /**
   * Who judged the work: 'hosting' for a shard's lease, or the source a
   * recordWork call names (a t27b lab receipt is 'lab'). The statement's leaf
   * does not carry it: a leaf is (key, kind, amount, receipt ids) whatever
   * the source, so every source folds into one root.
   */
  source?: string
}

/** One closed epoch (statement.t27): the signed text, and the leaves under its root. */
export interface StatementRow {
  epoch: number
  /** The signed text, exactly: STATEMENT_DOMAIN, then name=value per STATEMENT_FIELDS. */
  message: string
  signature: string
  root: string
  /** The leaves' fields in leaf order, so a proof can be served without recomputing them. */
  leaves: Array<{
    epoch: number
    host: string
    kind: string
    mtri: number
    receipts: string[]
  }>
  closedAt: number
}

/**
 * One half of one spec in a feed (gHashTag/t27 specs/hosting/feed.t27,
 * slice 2a): why it was sharded or carried, its job, and its row keys once it
 * has them. A part is content-addressed (hosting_feed_parts): most halves are
 * carried unchanged from feed to feed, so a feed holds ids, not rows.
 */
export interface FeedHalf {
  /** feed.t27 SHARD_*. */
  reason: number
  /** The shard job, when the half is sharded. */
  job: string | null
  /** The half's row keys (feed.t27 *_PART_KEYS), carried or agreed. */
  part: string | null
  /** An audited half: the part it carried, to set the hosts' answer against. */
  carried?: string | null
  /** Where the part was made: feed.t27 SOURCE_*, the commit it ran, and its job. */
  from: { source: number; commit: string; job?: string } | null
  /** feed.t27 HS_*. */
  state: number
  /** feed.t27 AU_* (AU_NONE unless audited). */
  audit: number
}

export interface FeedSpec {
  file: string
  /** The spec's `use` closure at the commit: SHA-256 of `path blob` lines, sorted. */
  input: string
  halves: [FeedHalf, FeedHalf]
}

/** One fed commit, or the genesis receipt a toolchain's chain starts from. */
export interface FeedRow {
  /** The commit, or `lab:<pin>` for a chain's genesis. */
  id: string
  commit: string
  /** The feed's round in its toolchain's chain (feed.t27 audit_pick). */
  seq: number
  /** The t27 commit the hosts' t27c and t27b were built from (toolchain.t27 T27_COMMIT). */
  pin: string
  /** feed.t27 FEED_*. */
  state: number
  startedAt: number
  closedAt: number | null
  /** The receipt this feed carried from. */
  base: string | null
  /** This commit's toolchain against the pin, per half (feed.t27 TC_*): comparability with the lab. */
  toolchain: [number, number]
  /** Halves whose carrying a poisoned audit in the base voided (feed.t27 voids_next). */
  voided: [boolean, boolean]
  specs: FeedSpec[]
}

/** A feed without its specs: what a listing shows. */
export type FeedSummary = Omit<FeedRow, 'specs'> & { specCount: number }

export interface HostingTx {
  host(id: string): Promise<HostRow | null>
  hosts(): Promise<HostRow[]>
  putHost(row: HostRow): Promise<void>
  job(id: string): Promise<JobRow | null>
  jobs(): Promise<JobRow[]>
  openJobs(): Promise<JobRow[]>
  putJob(row: JobRow): Promise<void>
  lease(id: string): Promise<LeaseRow | null>
  leasesOf(jobId: string): Promise<LeaseRow[]>
  outLeasesOfHost(hostId: string): Promise<LeaseRow[]>
  putLease(row: LeaseRow): Promise<void>
  ledgerHas(hostId: string, jobId: string, kind: number): Promise<boolean>
  addLedger(row: Omit<LedgerRow, 'seq'>): Promise<void>
  ledger(): Promise<LedgerRow[]>
  ledgerOfEpoch(epoch: number): Promise<LedgerRow[]>
  /** The epoch of the first ledger row, or null when there is none. */
  firstLedgerEpoch(): Promise<number | null>
  statement(epoch: number): Promise<StatementRow | null>
  lastStatement(): Promise<StatementRow | null>
  statements(): Promise<StatementRow[]>
  /** Write a statement once; false when that epoch already has one. */
  putStatement(row: StatementRow): Promise<boolean>
  /** The jobs of these ids that exist (feed.t27: a feed reads its own jobs only). */
  jobsByIds(ids: string[]): Promise<JobRow[]>
  feed(id: string): Promise<FeedRow | null>
  /** Every feed, newest first (a chain's genesis after the feed it was made for), without its specs. */
  feeds(): Promise<FeedSummary[]>
  putFeed(row: FeedRow): Promise<void>
  /** The feed parts of these ids that exist. */
  parts(ids: string[]): Promise<Map<string, Record<string, unknown>>>
  /** Write content-addressed parts; an id already there is kept. */
  putParts(parts: Map<string, Record<string, unknown>>): Promise<void>
}

export interface HostingStore {
  tx<T>(fn: (s: HostingTx) => Promise<T>): Promise<T>
}

const clone = <T>(row: T): T => structuredClone(row)

/** The memory store: Maps, and a queue so one operation runs at a time. */
export function createMemoryHostingStore(): HostingStore {
  const hosts = new Map<string, HostRow>()
  const jobs = new Map<string, JobRow>()
  const leases = new Map<string, LeaseRow>()
  const ledger: LedgerRow[] = []
  const statements = new Map<number, StatementRow>()
  const feeds = new Map<string, FeedRow>()
  const parts = new Map<string, Record<string, unknown>>()
  let tail: Promise<unknown> = Promise.resolve()
  const s: HostingTx = {
    host: async (id) =>
      hosts.has(id) ? clone(hosts.get(id) as HostRow) : null,
    hosts: async () => [...hosts.values()].map(clone),
    putHost: async (row) => {
      hosts.set(row.id, clone(row))
    },
    job: async (id) => (jobs.has(id) ? clone(jobs.get(id) as JobRow) : null),
    jobs: async () => [...jobs.values()].map(clone),
    openJobs: async () =>
      [...jobs.values()].filter((j) => j.state === 'open').map(clone),
    putJob: async (row) => {
      jobs.set(row.id, clone(row))
    },
    lease: async (id) =>
      leases.has(id) ? clone(leases.get(id) as LeaseRow) : null,
    leasesOf: async (jobId) =>
      [...leases.values()].filter((l) => l.jobId === jobId).map(clone),
    outLeasesOfHost: async (hostId) =>
      [...leases.values()]
        .filter((l) => l.hostId === hostId && l.state === 'out')
        .map(clone),
    putLease: async (row) => {
      leases.set(row.id, clone(row))
    },
    ledgerHas: async (hostId, jobId, kind) =>
      ledger.some(
        (r) => r.hostId === hostId && r.jobId === jobId && r.kind === kind,
      ),
    addLedger: async (row) => {
      ledger.push({ source: 'hosting', ...row, seq: ledger.length + 1 })
    },
    ledger: async () => ledger.map(clone),
    ledgerOfEpoch: async (epoch) =>
      ledger.filter((r) => r.epoch === epoch).map(clone),
    firstLedgerEpoch: async () =>
      ledger.length === 0 ? null : Math.min(...ledger.map((r) => r.epoch)),
    statement: async (epoch) =>
      statements.has(epoch)
        ? clone(statements.get(epoch) as StatementRow)
        : null,
    lastStatement: async () => {
      const last = Math.max(-1, ...statements.keys())
      return last < 0 ? null : clone(statements.get(last) as StatementRow)
    },
    statements: async () =>
      [...statements.values()].sort((a, b) => a.epoch - b.epoch).map(clone),
    putStatement: async (row) => {
      if (statements.has(row.epoch)) return false
      statements.set(row.epoch, clone(row))
      return true
    },
    jobsByIds: async (ids) =>
      ids.flatMap((id) =>
        jobs.has(id) ? [clone(jobs.get(id) as JobRow)] : [],
      ),
    feed: async (id) =>
      feeds.has(id) ? clone(feeds.get(id) as FeedRow) : null,
    feeds: async () =>
      [...feeds.values()]
        .sort((a, b) => b.startedAt - a.startedAt || b.seq - a.seq)
        .map(({ specs, ...rest }) => ({
          ...clone(rest),
          specCount: specs.length,
        })),
    putFeed: async (row) => {
      feeds.set(row.id, clone(row))
    },
    parts: async (ids) =>
      new Map(
        ids.flatMap((id) =>
          parts.has(id)
            ? [[id, clone(parts.get(id) as Record<string, unknown>)] as const]
            : [],
        ),
      ),
    putParts: async (more) => {
      for (const [id, part] of more)
        if (!parts.has(id)) parts.set(id, clone(part))
    },
  }
  return {
    tx<T>(fn: (s: HostingTx) => Promise<T>): Promise<T> {
      const run = tail.then(() => fn(s))
      tail = run.catch(() => undefined)
      return run
    },
  }
}

// --- Postgres -----------------------------------------------------------------

export const HOSTING_SQL = [
  'CREATE TABLE IF NOT EXISTS hosting_hosts (',
  '  id text PRIMARY KEY,',
  '  public_key text NOT NULL,',
  '  tier smallint NOT NULL,',
  '  tier_claim smallint NOT NULL,',
  '  slots integer NOT NULL,',
  '  platform text NOT NULL,',
  '  origin text NOT NULL,',
  '  incarnation bigint NOT NULL,',
  '  beat_at bigint NOT NULL,',
  '  strikes integer NOT NULL DEFAULT 0,',
  '  registered_at bigint NOT NULL',
  ');',
  'ALTER TABLE hosting_hosts ADD COLUMN IF NOT EXISTS isolation smallint NOT NULL DEFAULT 0;',
  'ALTER TABLE hosting_hosts ADD COLUMN IF NOT EXISTS agreed integer NOT NULL DEFAULT 0;',
  'CREATE TABLE IF NOT EXISTS hosting_jobs (',
  '  id text PRIMARY KEY,',
  '  state text NOT NULL,',
  '  created_at bigint NOT NULL,',
  '  body jsonb NOT NULL',
  ');',
  'CREATE INDEX IF NOT EXISTS hosting_jobs_state ON hosting_jobs (state, created_at);',
  'CREATE TABLE IF NOT EXISTS hosting_leases (',
  '  id text PRIMARY KEY,',
  '  job_id text NOT NULL,',
  '  host_id text NOT NULL,',
  '  state text NOT NULL,',
  '  body jsonb NOT NULL',
  ');',
  'CREATE INDEX IF NOT EXISTS hosting_leases_job ON hosting_leases (job_id);',
  'CREATE INDEX IF NOT EXISTS hosting_leases_host ON hosting_leases (host_id, state);',
  'CREATE TABLE IF NOT EXISTS hosting_ledger (',
  '  seq bigserial PRIMARY KEY,',
  '  host_id text NOT NULL,',
  '  job_id text NOT NULL,',
  '  kind smallint NOT NULL,',
  '  mtri bigint NOT NULL,',
  '  at bigint NOT NULL,',
  '  UNIQUE (host_id, job_id, kind)',
  ');',
  'ALTER TABLE hosting_ledger ADD COLUMN IF NOT EXISTS fee_kind smallint NOT NULL DEFAULT 0;',
  'ALTER TABLE hosting_ledger ADD COLUMN IF NOT EXISTS epoch bigint NOT NULL DEFAULT 0;',
  'ALTER TABLE hosting_ledger ADD COLUMN IF NOT EXISTS receipt text;',
  "ALTER TABLE hosting_ledger ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'hosting';",
  'CREATE INDEX IF NOT EXISTS hosting_ledger_epoch ON hosting_ledger (epoch);',
  'CREATE TABLE IF NOT EXISTS hosting_statements (',
  '  epoch bigint PRIMARY KEY,',
  '  root text NOT NULL,',
  '  closed_at bigint NOT NULL,',
  '  body jsonb NOT NULL',
  ');',
  'CREATE TABLE IF NOT EXISTS hosting_feeds (',
  '  id text PRIMARY KEY,',
  '  started_at bigint NOT NULL,',
  '  body jsonb NOT NULL',
  ');',
  'CREATE TABLE IF NOT EXISTS hosting_feed_parts (',
  '  id text PRIMARY KEY,',
  '  body jsonb NOT NULL',
  ');',
].join('\n')

/** pg_advisory_xact_lock key: 'host' as four ASCII bytes. */
const HOSTING_LOCK = 0x686f7374
/**
 * WHY A SECOND LOCK FOR THE SCHEMA: two Queen processes starting together
 * both run CREATE TABLE IF NOT EXISTS, and Postgres can refuse the loser with
 * a unique violation on pg_type. The DDL runs under its own advisory lock.
 */
const HOSTING_DDL_LOCK = 0x68646466

type HostSqlRow = {
  id: string
  public_key: string
  tier: number
  tier_claim: number
  slots: number
  platform: string
  isolation: number | null
  origin: string
  incarnation: string
  beat_at: string
  strikes: number
  registered_at: string
  agreed: number
}

const hostOf = (r: HostSqlRow): HostRow => ({
  id: r.id,
  publicKey: r.public_key,
  tier: Number(r.tier),
  tierClaim: Number(r.tier_claim),
  slots: Number(r.slots),
  platform: r.platform,
  isolation: Number(r.isolation ?? 0),
  origin: r.origin,
  incarnation: Number(r.incarnation),
  beatAt: Number(r.beat_at),
  strikes: Number(r.strikes),
  registeredAt: Number(r.registered_at),
  agreed: Number(r.agreed ?? 0),
})

function pgTx(c: PoolClient): HostingTx {
  const bodies = async <T>(sql: string, args: unknown[]): Promise<T[]> =>
    (await c.query<{ body: T }>(sql, args)).rows.map((r) => r.body)
  return {
    host: async (id) => {
      const r = await c.query<HostSqlRow>(
        'SELECT * FROM hosting_hosts WHERE id = $1',
        [id],
      )
      return r.rows[0] ? hostOf(r.rows[0]) : null
    },
    hosts: async () =>
      (
        await c.query<HostSqlRow>('SELECT * FROM hosting_hosts ORDER BY id')
      ).rows.map(hostOf),
    putHost: async (h) => {
      await c.query(
        'INSERT INTO hosting_hosts (id, public_key, tier, tier_claim, slots, platform, origin, incarnation, beat_at, strikes, registered_at, isolation, agreed) ' +
          'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ' +
          'ON CONFLICT (id) DO UPDATE SET public_key = $2, tier = $3, tier_claim = $4, slots = $5, platform = $6, ' +
          'origin = $7, incarnation = $8, beat_at = $9, strikes = $10, registered_at = $11, isolation = $12, agreed = $13',
        [
          h.id,
          h.publicKey,
          h.tier,
          h.tierClaim,
          h.slots,
          h.platform,
          h.origin,
          h.incarnation,
          h.beatAt,
          h.strikes,
          h.registeredAt,
          h.isolation,
          h.agreed ?? 0,
        ],
      )
    },
    job: async (id) =>
      (
        await bodies<JobRow>('SELECT body FROM hosting_jobs WHERE id = $1', [
          id,
        ])
      )[0] ?? null,
    jobs: () =>
      bodies<JobRow>(
        'SELECT body FROM hosting_jobs ORDER BY created_at, id',
        [],
      ),
    openJobs: () =>
      bodies<JobRow>(
        "SELECT body FROM hosting_jobs WHERE state = 'open' ORDER BY created_at, id",
        [],
      ),
    putJob: async (j) => {
      await c.query(
        'INSERT INTO hosting_jobs (id, state, created_at, body) VALUES ($1, $2, $3, $4) ' +
          'ON CONFLICT (id) DO UPDATE SET state = $2, body = $4',
        [j.id, j.state, j.createdAt, JSON.stringify(j)],
      )
    },
    lease: async (id) =>
      (
        await bodies<LeaseRow>(
          'SELECT body FROM hosting_leases WHERE id = $1',
          [id],
        )
      )[0] ?? null,
    leasesOf: (jobId) =>
      bodies<LeaseRow>(
        'SELECT body FROM hosting_leases WHERE job_id = $1 ORDER BY id',
        [jobId],
      ),
    outLeasesOfHost: (hostId) =>
      bodies<LeaseRow>(
        "SELECT body FROM hosting_leases WHERE host_id = $1 AND state = 'out' ORDER BY id",
        [hostId],
      ),
    putLease: async (l) => {
      await c.query(
        'INSERT INTO hosting_leases (id, job_id, host_id, state, body) VALUES ($1, $2, $3, $4, $5) ' +
          'ON CONFLICT (id) DO UPDATE SET state = $4, body = $5',
        [l.id, l.jobId, l.hostId, l.state, JSON.stringify(l)],
      )
    },
    ledgerHas: async (hostId, jobId, kind) =>
      (
        await c.query(
          'SELECT 1 FROM hosting_ledger WHERE host_id = $1 AND job_id = $2 AND kind = $3',
          [hostId, jobId, kind],
        )
      ).rows.length > 0,
    addLedger: async (r) => {
      await c.query(
        'INSERT INTO hosting_ledger (host_id, job_id, kind, mtri, at, fee_kind, epoch, receipt, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [
          r.hostId,
          r.jobId,
          r.kind,
          r.mtri,
          r.at,
          r.feeKind,
          r.epoch,
          r.receipt,
          r.source ?? 'hosting',
        ],
      )
    },
    ledger: async () =>
      (
        await c.query<LedgerSqlRow>('SELECT * FROM hosting_ledger ORDER BY seq')
      ).rows.map(ledgerOf),
    ledgerOfEpoch: async (epoch) =>
      (
        await c.query<LedgerSqlRow>(
          'SELECT * FROM hosting_ledger WHERE epoch = $1 ORDER BY seq',
          [epoch],
        )
      ).rows.map(ledgerOf),
    firstLedgerEpoch: async () => {
      const r = await c.query<{ first: string | null }>(
        'SELECT min(epoch) AS first FROM hosting_ledger',
      )
      const first = r.rows[0]?.first
      return first === null || first === undefined ? null : Number(first)
    },
    statement: async (epoch) =>
      (
        await bodies<StatementRow>(
          'SELECT body FROM hosting_statements WHERE epoch = $1',
          [epoch],
        )
      )[0] ?? null,
    lastStatement: async () =>
      (
        await bodies<StatementRow>(
          'SELECT body FROM hosting_statements ORDER BY epoch DESC LIMIT 1',
          [],
        )
      )[0] ?? null,
    statements: () =>
      bodies<StatementRow>(
        'SELECT body FROM hosting_statements ORDER BY epoch',
        [],
      ),
    putStatement: async (row) =>
      ((
        await c.query(
          'INSERT INTO hosting_statements (epoch, root, closed_at, body) VALUES ($1, $2, $3, $4) ON CONFLICT (epoch) DO NOTHING',
          [row.epoch, row.root, row.closedAt, JSON.stringify(row)],
        )
      ).rowCount ?? 0) > 0,
    jobsByIds: (ids) =>
      ids.length === 0
        ? Promise.resolve([])
        : bodies<JobRow>('SELECT body FROM hosting_jobs WHERE id = ANY($1)', [
            ids,
          ]),
    feed: async (id) =>
      (
        await bodies<FeedRow>('SELECT body FROM hosting_feeds WHERE id = $1', [
          id,
        ])
      )[0] ?? null,
    feeds: async () =>
      (
        await c.query<{ body: FeedSummary }>(
          "SELECT (body - 'specs') || jsonb_build_object('specCount', jsonb_array_length(body->'specs')) AS body " +
            "FROM hosting_feeds ORDER BY started_at DESC, (body->>'seq')::int DESC",
        )
      ).rows.map((r) => r.body),
    putFeed: async (row) => {
      await c.query(
        'INSERT INTO hosting_feeds (id, started_at, body) VALUES ($1, $2, $3) ' +
          'ON CONFLICT (id) DO UPDATE SET body = $3',
        [row.id, row.startedAt, JSON.stringify(row)],
      )
    },
    parts: async (ids) =>
      new Map(
        ids.length === 0
          ? []
          : (
              await c.query<{ id: string; body: Record<string, unknown> }>(
                'SELECT id, body FROM hosting_feed_parts WHERE id = ANY($1)',
                [ids],
              )
            ).rows.map((r) => [r.id, r.body] as const),
      ),
    putParts: async (more) => {
      const ids = [...more.keys()]
      if (ids.length === 0) return
      await c.query(
        'INSERT INTO hosting_feed_parts (id, body) SELECT * FROM unnest($1::text[], $2::jsonb[]) ON CONFLICT (id) DO NOTHING',
        [ids, ids.map((id) => JSON.stringify(more.get(id)))],
      )
    },
  }
}

type LedgerSqlRow = {
  seq: string
  host_id: string
  job_id: string
  kind: number
  mtri: string
  at: string
  fee_kind: number
  epoch: string
  receipt: string | null
  source: string | null
}

const ledgerOf = (r: LedgerSqlRow): LedgerRow => ({
  seq: Number(r.seq),
  hostId: r.host_id,
  jobId: r.job_id,
  kind: Number(r.kind),
  mtri: Number(r.mtri),
  at: Number(r.at),
  feeKind: Number(r.fee_kind ?? 0),
  epoch: Number(r.epoch ?? 0),
  receipt: r.receipt ?? null,
  source: r.source ?? 'hosting',
})

/** TRIOS_HOSTING=on. Off, the Queen builds no hosting table and serves 503. */
export function hostingOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.TRIOS_HOSTING ?? 'off').trim().toLowerCase() === 'on'
}

/**
 * The hosting tables, idempotent: every statement is IF NOT EXISTS, under an
 * advisory lock, so a boot and a second Queen against one database agree.
 * The boot migration (pg-migrate.ts) and the store's first use both run this
 * one function, so the two cannot come to disagree.
 */
export async function migrateHostingStore(pool: Pool): Promise<void> {
  await ensureSchema(pool)
}

async function ensureSchema(pool: Pool): Promise<void> {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    await c.query('SELECT pg_advisory_xact_lock($1)', [HOSTING_DDL_LOCK])
    await c.query(HOSTING_SQL)
    await c.query('COMMIT')
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    c.release()
  }
}

export function createPgHostingStore(pool: Pool): HostingStore {
  let ensured: Promise<unknown> | null = null
  return {
    async tx<T>(fn: (s: HostingTx) => Promise<T>): Promise<T> {
      ensured ??= ensureSchema(pool).catch((err) => {
        ensured = null
        throw err
      })
      await ensured
      const c = await pool.connect()
      try {
        await c.query('BEGIN')
        await c.query('SELECT pg_advisory_xact_lock($1)', [HOSTING_LOCK])
        const out = await fn(pgTx(c))
        await c.query('COMMIT')
        return out
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined)
        throw err
      } finally {
        c.release()
      }
    },
  }
}
