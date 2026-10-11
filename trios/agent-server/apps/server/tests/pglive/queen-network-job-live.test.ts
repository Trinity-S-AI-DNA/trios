/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A NETWORK JOB THE QUEEN RUNS, against PostgreSQL (gHashTag/t27
 * specs/jobs/network_job.t27 and specs/network/job_rules.t27).
 *
 * The receipts are the labs' REAL signed corpus receipts of t27 master
 * ddb84c5f5 (keys a05db80f53c317f6 and fed03daa6459a7fa), trimmed of their
 * leaves, and every judgment is job_rules.wasm's: Ed25519 over the rebuilt
 * bytes, the vote count, the quorum, settle(). GitHub, the labs' HTTP and the
 * ssh write are a fake; the database is real, because "one challenge per
 * job", "one credit per commit" and "PENDING, then FINAL" are properties of
 * the rows. Same harness as the other pg-live suites.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { createQueenPublicNetCreditsRoute } from '../../src/api/routes/queen-public-net-credits'
import { createHostingQueen } from '../../src/api/services/hosting-queen'
import { createPgHostingStore } from '../../src/api/services/hosting-store'
import {
  advanceJobs,
  getJob,
  type JobIo,
  loadJobCard,
  startJob,
} from '../../src/api/services/queen-jobs'
import {
  J_DONE,
  J_RUNNING,
  O_FAIL,
  O_NOT_YET,
  O_PASS,
} from '../../src/api/services/queen-jobs-rules'
import {
  creditOf,
  judge,
  type NetworkIo,
  networkExecutors,
  type RecordWork,
} from '../../src/api/services/queen-network-job'
import {
  AUTH_BAD_SIGNATURE,
  AUTH_MISSING_NONE,
  LEVEL_AUTHOR,
  QV_BELOW_QUORUM,
} from '../../src/api/services/queen-network-rules.gen'
import { DEFAULT_SPECS_ROOT } from '../../src/inngest/spec-catalog'
import { runPgMigrations } from '../../src/lib/db/pg-migrate'
import { createQueenPool, queenSchema } from '../../src/lib/db/queen-pool'

const OFFLINE_KEY = 'TRIOS_PG_MIGRATE_GATE'
const URL_KEY = 'TRIOS_PG_TEST_URL'
const offlineRequested = (): boolean =>
  (process.env[OFFLINE_KEY] ?? '').toLowerCase() === 'offline'
const adminUrl = (): string =>
  process.env[URL_KEY] ??
  `postgres://${userInfo().username}@127.0.0.1:5432/postgres`

async function scratchDatabase(): Promise<{
  url: string
  drop: () => Promise<void>
} | null> {
  const name = `queen_netjob_${randomBytes(6).toString('hex')}`
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

const SHA = 'ddb84c5f58994da8afe3d59185f3ef121ae7065f'
const FIX = join(import.meta.dir, '..', '__fixtures__', 'network-job')
const receipt = (lab: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIX, `${lab}.ddb84c5f.receipt.json`), 'utf8'))
const LAB1 = 'https://t27b-lab-production.up.railway.app'
const LAB2 = 'https://t27b-lab-2-production.up.railway.app'

/** GitHub, the two labs' HTTP and the ssh write, as the job sees them. */
class FakeNet implements NetworkIo {
  receipts = new Map<string, Record<string, unknown>>([
    [`${LAB1}/runs/${SHA}.receipt.json`, receipt('t27b-lab')],
    [`${LAB2}/runs/${SHA}.receipt.json`, receipt('t27b-lab-2')],
  ])
  writes: Array<{ host: string; sha: string; challenge: string }> = []
  recordWork?: RecordWork
  queue = new Map<string, string>()
  draws = 0
  host: string | undefined = 'lab-one'

  async get(url: string): Promise<{ status: number; body: unknown }> {
    if (url.endsWith(`/commits/${SHA}`))
      return { status: 200, body: { sha: SHA } }
    const r = this.receipts.get(url)
    return r ? { status: 200, body: r } : { status: 404, body: null }
  }
  async labWrite(host: string, _dir: string, sha: string, challenge: string) {
    this.writes.push({ host, sha, challenge })
    this.queue.set(sha, challenge)
    return { ok: true, read: challenge, detail: 'written' }
  }
  async labRead(_host: string, _dir: string, sha: string) {
    return { ok: true, read: this.queue.get(sha) ?? '', detail: 'read' }
  }
  sshHost(lab: string): string | undefined {
    return lab === 't27b-lab' ? this.host : undefined
  }
  draw(): string {
    this.draws += 1
    return randomBytes(20).toString('hex')
  }
}

const jobIo = (net: FakeNet): JobIo => ({
  get: (url) => net.get(url),
  postRelease: async () => ({ status: 500, body: null }),
  hasReleaseToken: () => false,
  network: net,
})

const pinSha = (file: string) =>
  createHash('sha256')
    .update(readFileSync(join(DEFAULT_SPECS_ROOT, file)))
    .digest('hex')

describe('the vendored network job card is the one PIN names', () => {
  it('the card, the rules, their wasm, the bridge and the keys match', () => {
    const pin = readFileSync(join(DEFAULT_SPECS_ROOT, 'PIN'), 'utf8')
    for (const f of [
      'jobs/network_job.t27',
      'network/job_rules.t27',
      'network/job_rules.wasm',
      'network/job_rules_bridge.zig',
      'keys/a05db80f53c317f6.pub',
      'keys/fed03daa6459a7fa.pub',
    ])
      expect(pin).toContain(`network_job: ${f} sha256 ${pinSha(f)}`)
  })
})

describe("the rules judge the labs' real receipts", () => {
  const read = (
    r1: Record<string, unknown>,
    r2: Record<string, unknown>,
    challenge = '',
  ) => [
    { lab: 't27b-lab', url: 'u1', status: 200, receipt: r1, challenge },
    { lab: 't27b-lab-2', url: 'u2', status: 200, receipt: r2, challenge: '' },
  ]

  it('both authenticate, agree, and are one independent vote', () => {
    const j = judge(SHA, read(receipt('t27b-lab'), receipt('t27b-lab-2')))
    expect(j.labs.map((l) => l.auth)).toEqual([
      AUTH_MISSING_NONE,
      AUTH_MISSING_NONE,
    ])
    expect(j.labs.map((l) => l.level)).toEqual([LEVEL_AUTHOR, LEVEL_AUTHOR])
    expect(j.agree).toBe(true)
    expect(j.keys).toBe(2)
    expect(j.votes).toBe(1)
    expect(j.verdict).toBe(QV_BELOW_QUORUM)
    expect(j.executor?.keyId).toBe('a05db80f53c317f6')
  })

  it('a tampered total fails its signature; a master receipt does not answer a challenge', () => {
    const bad = receipt('t27b-lab-2')
    ;(bad.totals as Record<string, number>).crash = 1
    const j = judge(SHA, read(receipt('t27b-lab'), bad))
    expect(j.labs[1].auth).toBe(AUTH_BAD_SIGNATURE)
    const replay = judge(
      SHA,
      read(receipt('t27b-lab'), receipt('t27b-lab-2'), 'ab'.repeat(20)),
    )
    expect(replay.labs[0].auth).not.toBe(AUTH_MISSING_NONE)
  })
})

describe('a network job the Queen runs, with no session open', () => {
  let scratch: { url: string; drop: () => Promise<void> } | null = null
  let pool: Pool | null = null
  const previousUrl = process.env.DATABASE_URL
  const previousFlag = process.env.TRIOS_QUEEN_NETWORK_JOBS

  beforeEach(async () => {
    process.env.TRIOS_QUEEN_NETWORK_JOBS = 'on'
    scratch = await scratchDatabase()
    if (!scratch) return
    process.env.DATABASE_URL = scratch.url
    await runPgMigrations()
    pool = createQueenPool(scratch.url)
  })

  afterEach(async () => {
    await pool?.end().catch(() => undefined)
    pool = null
    await scratch?.drop()
    scratch = null
    if (previousUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousUrl
    if (previousFlag === undefined) delete process.env.TRIOS_QUEEN_NETWORK_JOBS
    else process.env.TRIOS_QUEEN_NETWORK_JOBS = previousFlag
  })

  it('challenges the lab once, journaled, and waits for a receipt that answers it', async () => {
    if (!pool) return
    const net = new FakeNet()
    const started = await startJob(
      pool,
      'network-job',
      { sha: SHA },
      false,
      'test',
    )
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const t = Date.parse('2026-10-10T21:00:00Z')
    await advanceJobs(pool, jobIo(net), () => t, false)
    const job = await getJob(pool, started.job.id)
    // job-commit and lab-challenge passed; lab-receipts waits: lab 1 serves its master receipt, no nonce
    expect(job?.state).toBe(J_RUNNING)
    expect(job?.step).toBe(2)
    expect(net.writes.length).toBe(1)
    expect(net.writes[0].host).toBe('lab-one')
    const outcomes = (job?.log as Array<{ outcome: number }>).map(
      (e) => e.outcome,
    )
    expect(outcomes).toEqual([O_PASS, O_PASS, O_NOT_YET])
    // the step again after a restart: the journal answers, no second write, no second draw
    const exec = networkExecutors(net)['lab-challenge']
    const card = await loadJobCard('network-job')
    const again = await exec({
      job: job as never,
      card: { repo: card.repo, consts: card.consts },
      pool,
      now: t + 60_000,
    })
    expect(again.outcome).toBe(O_PASS)
    expect(net.writes.length).toBe(1)
    expect(net.draws).toBe(1)
  })

  it('without a request path the step is BLOCKED, and says so', async () => {
    if (!pool) return
    const net = new FakeNet()
    net.host = undefined
    const started = await startJob(
      pool,
      'network-job',
      { sha: SHA },
      false,
      'test',
    )
    if (!started.ok) throw new Error(started.error)
    await advanceJobs(pool, jobIo(net), () => Date.now(), false)
    const job = await getJob(pool, started.job.id)
    expect(job?.step).toBe(1)
    expect(String(job?.note)).toContain('no request path to t27b-lab')
  })

  it('a rehearsal judges the master receipts end to end and writes nothing', async () => {
    if (!pool) return
    const net = new FakeNet()
    const started = await startJob(
      pool,
      'network-job',
      { sha: SHA },
      true,
      'test',
    )
    if (!started.ok) throw new Error(started.error)
    await advanceJobs(pool, jobIo(net), () => Date.now(), false)
    const job = await getJob(pool, started.job.id)
    expect(job?.state).toBe(J_DONE)
    expect(net.writes.length).toBe(0)
    expect(await creditOf(pool, SHA)).toBeNull()
    const quorum = (job?.log as Array<{ what: string; detail: string }>).find(
      (e) => e.what === 'quorum',
    )
    expect(quorum?.detail).toContain(
      'BELOW_QUORUM: 1 independent vote(s) from 2 key(s) of M=3',
    )
  })

  it('credits the commit once, PENDING, then FINAL after the window, and the public route shows it', async () => {
    if (!pool) return
    // the credit's line goes into the hosting ledger (trios#1761) when hosting is on
    const hosting = process.env.TRIOS_HOSTING
    process.env.TRIOS_HOSTING = 'on'
    const net = new FakeNet()
    // the test's own hosting Queen over the scratch database; a process has one (hosting.ts hostingQueen)
    const ledgerQueen = createHostingQueen({
      store: createPgHostingStore(pool),
      now: Date.now,
      allowlist: new Map(),
    })
    net.recordWork = async (_pool, w) => ledgerQueen.recordWork(w)
    const card = await loadJobCard('network-job')
    // both labs read as master runs (no request path): the receipts above are judged unchallenged
    const consts = { ...card.consts, LAB_REQUEST_PATHS: ['none', 'none'] }
    const ex = networkExecutors(net)
    const job = {
      id: 7,
      params: { sha: SHA },
      rehearsal: false,
      subject: SHA,
      checks_at_subject: true,
    }
    const ctx = (now: number) => ({
      job,
      card: { repo: card.repo, consts },
      pool: pool as Pool,
      now,
    })
    const t0 = Date.now()
    for (const what of [
      'lab-challenge',
      'lab-receipts',
      'receipts-verified',
      'quorum',
    ])
      expect((await ex[what](ctx(t0))).outcome).toBe(O_PASS)
    expect(net.writes.length).toBe(0)
    const settled = await ex['settle-credit'](ctx(t0))
    expect(settled.outcome).toBe(O_PASS)
    const row = await creditOf(pool, SHA)
    expect(row?.state).toBe('PENDING')
    expect(Number(row?.mtri)).toBe(1)
    expect(row?.host).toBe('a05db80f53c317f6')
    expect(row?.kind).toBe('executor_fee')
    expect(row?.test).toBe(true)
    expect((row?.quorum as { verdict: string }).verdict).toBe('BELOW_QUORUM')
    expect(row?.ledger?.recorded).toBe(true)
    expect(row?.ledger?.job).toBe(`network-job:${SHA}`)
    const lines = await pool.query(
      `SELECT host_id, job_id, mtri, fee_kind, source, receipt FROM hosting_ledger WHERE job_id = $1`,
      [`network-job:${SHA}`],
    )
    expect(lines.rows.length).toBe(1)
    expect(lines.rows[0].host_id).toBe('a05db80f53c317f6')
    expect(Number(lines.rows[0].mtri)).toBe(1)
    expect(lines.rows[0].source).toBe('lab')
    expect(String(lines.rows[0].receipt)).toContain(LAB1)
    // a replayed settlement pays nothing more, in either place
    const replay = await ex['settle-credit'](ctx(t0))
    expect(replay.detail).toContain('already settled')
    expect(replay.detail).toContain('already recorded')
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM hosting_ledger WHERE job_id = $1',
          [`network-job:${SHA}`],
        )
      ).rows[0].n,
    ).toBe(1)
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM queen_net_credit'))
        .rows[0].n,
    ).toBe(1)
    // the window
    const at = Date.parse(String(row?.settled_at))
    expect((await ex['challenge-window'](ctx(at + 5 * 60_000))).outcome).toBe(
      O_NOT_YET,
    )
    expect((await ex['challenge-window'](ctx(at + 15 * 60_000))).outcome).toBe(
      O_PASS,
    )
    expect((await creditOf(pool, SHA))?.state).toBe('FINAL')
    const res = await createQueenPublicNetCreditsRoute(() => pool).request(
      '/?since=2026-01-01T00:00:00Z',
    )
    const body = (await res.json()) as {
      credits: Array<{ job_sha: string; state: string; mtri: number }>
    }
    expect(body.credits.map((c) => [c.job_sha, c.state, c.mtri])).toEqual([
      [SHA, 'FINAL', 1],
    ])
    if (hosting === undefined) delete process.env.TRIOS_HOSTING
    else process.env.TRIOS_HOSTING = hosting
  })

  it('a tampered receipt fails verification and earns nothing', async () => {
    if (!pool) return
    const net = new FakeNet()
    const bad = receipt('t27b-lab-2')
    ;(bad.totals as Record<string, number>).crash = 1
    net.receipts.set(`${LAB2}/runs/${SHA}.receipt.json`, bad)
    const card = await loadJobCard('network-job')
    const consts = { ...card.consts, LAB_REQUEST_PATHS: ['none', 'none'] }
    const job = {
      id: 8,
      params: { sha: SHA },
      rehearsal: false,
      subject: SHA,
      checks_at_subject: true,
    }
    const r = await networkExecutors(net)['receipts-verified']({
      job,
      card: { repo: card.repo, consts },
      pool,
      now: Date.now(),
    })
    expect(r.outcome).toBe(O_FAIL)
    expect(r.detail).toContain(`auth ${AUTH_BAD_SIGNATURE}`)
  })
})
