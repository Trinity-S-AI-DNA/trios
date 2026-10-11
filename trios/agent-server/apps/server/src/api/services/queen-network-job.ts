/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * ONE NETWORK JOB, DRIVEN BY THE QUEEN (gHashTag/t27 specs/jobs/network_job.t27
 * and specs/network/job_rules.t27): a t27 commit is run by the labs, each lab
 * signs a corpus receipt for it, the receipts are verified and counted, and the
 * work earns one PENDING test credit that turns FINAL after the challenge
 * window. Test credits are not money.
 *
 * WHAT IS DECIDED WHERE. Every judgment is a function of job_rules.wasm,
 * compiled from the spec (`t27c gen` + zig, specs/PIN): whether a receipt's
 * bytes are a corpus message for this commit, whether its Ed25519 signature
 * verifies under the registered key (tri/crypto/ed25519.t27 verify, on the
 * receipt's real bytes), whether its nonce is the challenge, whether two
 * receipts agree, how many independent votes they are (key, then operator),
 * the quorum verdict, what trinet/ledger.t27 settle() pays and when a credit
 * is final. The card names the steps, the labs and the keys. What is written
 * here is I/O: GitHub and the labs over HTTP, one ssh write per challenged
 * lab, the rows, and rebuilding a receipt's signed bytes as
 * corpus_receipt.t27 says (a rebuild that is wrong fails the signature; it
 * cannot pass one).
 *
 * THE LEDGER. A credit is one row of queen_net_credit, keyed by the job's
 * commit, in the shape of gHashTag/t27 specs/hosting/statement.t27's leaf
 * (host key id, kind word, mtri, receipt ids), so the hosting ledger
 * (trios#1761) folds it into an epoch statement. This file writes PENDING and
 * FINAL rows only; it is not a second ledger.
 *
 * THE GAP. A lab's request queue is written over ssh. The deployment names
 * the ssh host of each lab it can reach in TRIOS_NETWORK_JOB_SSH
 * (`t27b-lab=<host>`); without it the challenge step answers BLOCKED, which
 * is what the deployed Queen answers today. A lab whose card path is "none"
 * (t27b-lab-2) is never written: its own master run of the commit is read,
 * judged without a challenge.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { DEFAULT_SPECS_ROOT } from '../../inngest/spec-catalog'
import { hostingQueen } from '../routes/hosting'
import { hostingOn } from './hosting-store'
import { actorEventsOn } from './queen-actor-events'
import { RC_CRASH, RC_NORMAL, TK_JOB } from './queen-actor-events-card.gen'
import { type CardWasm, flag, loadCardWasm } from './queen-card-wasm'
import { appendEvent } from './queen-control'
import {
  afterLook,
  DO_LOOK,
  DO_RUN,
  DO_SKIP,
  EFF_DONE,
  EFF_INTENT,
  EFF_NONE,
  EK_PUSH,
  effectAction,
  runsAfterIntent,
} from './queen-control-rules'
import { ACTOR_STREAM, EV_ACTOR_EXIT, EV_ACTOR_SPAWN } from './queen-events.gen'
import { EXECUTOR_FEE } from './queen-hosting-statement-card.gen'
import {
  E_REFUSE,
  E_REHEARSE,
  effectMayRun,
  O_BLOCKED,
  O_FAIL,
  O_NOT_YET,
  O_PASS,
} from './queen-jobs-rules'
import {
  AUTH_MISSING_NONE,
  AUTH_NO_NONCE,
  AUTH_NONCE_NOT_CHALLENGE,
  CORPUS_DOMAIN,
  CORPUS_SIGNED_FIELDS,
  CS_FINAL,
  CS_NAMES,
  CS_VOID,
  LEVEL_FRESH,
  OUT_CREDITED,
  QV_NAMES,
  TRUSTED_F,
  TRUSTED_M,
  TRUSTED_N,
  V_OK,
} from './queen-network-rules.gen'

export const NETWORK_RULES_CARD = 'network/job_rules.wasm'
export const NETWORK_JOB_CARD = 'network-job'

/**
 * TRIOS_QUEEN_NETWORK_JOBS=on lets a network job start; anything else, the
 * default, refuses the card on every start path, rehearsals included. Off
 * means off: today no deployment has a lab request path (gHashTag/t27#8791),
 * and a published job would hold the card's one slot at a BLOCKED step.
 */
export const networkJobsOn = (env: NodeJS.ProcessEnv = process.env): boolean =>
  (env.TRIOS_QUEEN_NETWORK_JOBS ?? 'off').trim().toLowerCase() === 'on'
export const NETWORK_KEYS_DIR = 'keys'

/** The card's constants this file reads, as the compiler wasm read them. */
export interface NetworkCard {
  repo: string
  consts: Record<string, unknown>
}

const list = (card: NetworkCard, k: string): string[] => {
  const v = card.consts[k]
  if (!Array.isArray(v)) throw new Error(`network-job card: ${k} is missing`)
  return v.map(String)
}
const num = (card: NetworkCard, k: string): number => {
  const v = card.consts[k]
  if (typeof v !== 'number')
    throw new Error(`network-job card: ${k} is missing`)
  return v
}
const text = (card: NetworkCard, k: string): string => {
  const v = card.consts[k]
  if (typeof v !== 'string')
    throw new Error(`network-job card: ${k} is missing`)
  return v
}

// --------------------------------------------------------------- the rules

let rulesCard: CardWasm | undefined
const rules = (): CardWasm => {
  rulesCard ??= loadCardWasm(NETWORK_RULES_CARD)
  return rulesCard
}
const callText = (name: string, texts: string[], ...nums: number[]): number => {
  const r = rules()
  const at = r.put(...texts).flatMap((t) => [t.at, t.len])
  return r.call(name, ...at, ...nums)
}

export const challengeOk = (ch: string): boolean =>
  callText('challenge_ok', [ch]) === 1
export const receiptAuth = (
  msg: string,
  job: string,
  keyId: string,
  keyHex: string,
  sig: string,
  challenge: string,
): number => callText('receipt_auth', [msg, job, keyId, keyHex, sig, challenge])
export const receiptLevel = (
  msg: string,
  job: string,
  keyId: string,
  keyHex: string,
  sig: string,
  challenge: string,
): number =>
  callText('receipt_auth_level', [msg, job, keyId, keyHex, sig, challenge])
export const resultsAgree = (a: string, b: string): boolean =>
  callText('results_agree', [a, b]) === 1
export const keyOperator = (keyId: string): number =>
  callText('key_operator', [keyId])
export const independentVotes = (keys: string): number =>
  callText('independent_votes', [keys])
export const distinctKeys = (keys: string): number =>
  callText('distinct_keys', [keys])
export const jobNonce = (sha: string): number =>
  callText('job_nonce', [sha]) >>> 0
export const quorumVerdict = (votes: number, agree: boolean): number =>
  rules().call('quorum_verdict', votes, flag(agree))
export const settleVerdict = (qv: number): number =>
  rules().call('settle_verdict', qv)
export const settleOutcome = (
  qv: number,
  op: number,
  nonce: number,
  prior: boolean,
): number => rules().call('settle_outcome', qv, op, nonce, flag(prior))
export const settleCreditMtri = (
  qv: number,
  op: number,
  nonce: number,
  prior: boolean,
): number =>
  Number(rules().call64('settle_credit_mtri', qv, op, nonce, flag(prior)))
export const creditState = (
  outcome: number,
  minutes: number,
  challengeOpen: boolean,
): number =>
  rules().call(
    'credit_state',
    outcome,
    Math.max(0, Math.floor(minutes)) >>> 0,
    flag(challengeOpen),
  )

// ------------------------------------------------- the receipt's signed bytes

/** serde_json::to_string of a parsed value: compact, object keys in byte order. */
export function jsonText(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return `[${v.map(jsonText).join(',')}]`
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    const keys = Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jsonText(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/** corpus_receipt.t27's message: CORPUS_DOMAIN, then `name=<JSON text>` per signed field. */
export function receiptMessage(
  receipt: Record<string, unknown>,
  domain: string,
  fields: readonly string[],
): string {
  return `${domain}\n${fields.map((f) => `${f}=${jsonText(receipt[f])}\n`).join('')}`
}

/** The registered public key of a key id (signed_receipt.t27 KEY_DIR, vendored), or ''. */
export function registeredKey(
  keyId: string,
  root: string = DEFAULT_SPECS_ROOT,
): string {
  if (!/^[0-9a-f]{16}$/.test(keyId)) return ''
  try {
    return readFileSync(
      join(root, NETWORK_KEYS_DIR, `${keyId}.pub`),
      'utf8',
    ).trim()
  } catch {
    return ''
  }
}

// ------------------------------------------------------------------ the I/O

export interface NetworkIo {
  /** GET a lab's or GitHub's JSON. */
  get: (
    url: string,
    auth: 'read' | 'none',
  ) => Promise<{ status: number; body: unknown }>
  /** Write `challenge` as LAB_REQUEST_DIR/<sha> on an ssh host; returns what the file then reads. */
  labWrite: (
    host: string,
    dir: string,
    sha: string,
    challenge: string,
  ) => Promise<{ ok: boolean; read: string; detail: string }>
  /** Read back LAB_REQUEST_DIR/<sha> on an ssh host ('' when absent). */
  labRead: (
    host: string,
    dir: string,
    sha: string,
  ) => Promise<{ ok: boolean; read: string; detail: string }>
  /** The ssh host this deployment reaches a lab by, or undefined. */
  sshHost: (lab: string) => string | undefined
  /** A fresh 40-hex challenge. */
  draw: () => string
  /** The hosting ledger's write path; recordLabWork when unset. */
  recordWork?: RecordWork
}

const ssh = (
  host: string,
  script: string,
): Promise<{ code: number; out: string; err: string }> =>
  new Promise((resolve) => {
    const p = spawn(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', host, script],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    const t = setTimeout(() => p.kill('SIGKILL'), 90_000)
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => {
      clearTimeout(t)
      resolve({ code: code ?? -1, out, err })
    })
  })

/** The Railway ssh gateway rotates its host key and rate-limits: try a few times. */
const sshRetrying = async (host: string, script: string) => {
  let last = { code: -1, out: '', err: '' }
  for (let i = 0; i < 4; i += 1) {
    last = await ssh(host, script)
    if (last.code === 0) return last
    if (
      !/HOST IDENTIFICATION|RateLimit|Connection closed|kex_exchange|timed out/i.test(
        last.err,
      )
    )
      return last
    await new Promise((r) => setTimeout(r, 10_000))
  }
  return last
}

export const defaultNetworkIo = (get: NetworkIo['get']): NetworkIo => ({
  get,
  // sha and challenge are 40 lowercase hex digits (job_rules.t27 challenge_ok) before they get here
  async labWrite(host, dir, sha, challenge) {
    const tmp = `${dir}/../.network-job-${sha}`
    const r = await sshRetrying(
      host,
      `umask 022 && mkdir -p ${dir} && printf %s ${challenge} > ${tmp} && mv ${tmp} ${dir}/${sha} && cat ${dir}/${sha}`,
    )
    return {
      ok: r.code === 0,
      read: r.out.trim(),
      detail: r.code === 0 ? 'written' : `ssh exited ${r.code}`,
    }
  },
  async labRead(host, dir, sha) {
    const r = await sshRetrying(host, `cat ${dir}/${sha} 2>/dev/null; true`)
    return {
      ok: r.code === 0,
      read: r.out.trim(),
      detail: r.code === 0 ? 'read' : `ssh exited ${r.code}`,
    }
  },
  sshHost(lab) {
    for (const pair of (process.env.TRIOS_NETWORK_JOB_SSH ?? '').split(',')) {
      const [name, host] = pair.split('=').map((s) => s?.trim())
      if (name === lab && host && /^[A-Za-z0-9._-]+$/.test(host)) return host
    }
    return undefined
  },
  draw: () => randomBytes(20).toString('hex'),
})

// --------------------------------------------------------------- the rows

export const NETWORK_JOB_SQL = `
CREATE TABLE IF NOT EXISTS queen_net_credit (
  job_sha text PRIMARY KEY,
  job_id bigint NOT NULL,
  host text NOT NULL,
  kind text NOT NULL,
  mtri bigint NOT NULL,
  receipts jsonb NOT NULL,
  outcome smallint NOT NULL,
  state text NOT NULL,
  quorum jsonb NOT NULL,
  test boolean NOT NULL,
  settled_at timestamptz NOT NULL DEFAULT now(),
  final_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS queen_net_credit_updated ON queen_net_credit (updated_at);
ALTER TABLE queen_net_credit ADD COLUMN IF NOT EXISTS ledger jsonb;
`

export async function ensureNetworkTables(pool: Pool): Promise<void> {
  await pool.query(NETWORK_JOB_SQL)
}

export interface CreditRow {
  job_sha: string
  job_id: number
  host: string
  kind: string
  mtri: number
  receipts: string[]
  outcome: number
  state: string
  quorum: Record<string, unknown>
  test: boolean
  settled_at: string
  final_at: string | null
  updated_at: string
  /** Where the hosting ledger (hosting-queen.ts recordWork) holds the credit, when it does. */
  ledger: { recorded: boolean; epoch: number; job: string } | null
}

export async function creditOf(
  pool: Pool,
  sha: string,
): Promise<CreditRow | null> {
  const r = await pool.query(
    'SELECT * FROM queen_net_credit WHERE job_sha = $1',
    [sha],
  )
  return (r.rows[0] as CreditRow) ?? null
}

/** The credits changed since `since`, oldest first: the public route's rows. */
export async function creditsSince(
  pool: Pool,
  since: Date,
  limit = 100,
): Promise<CreditRow[]> {
  const r = await pool.query(
    'SELECT * FROM queen_net_credit WHERE updated_at > $1 ORDER BY updated_at, job_sha LIMIT $2',
    [since.toISOString(), limit],
  )
  return r.rows as CreditRow[]
}

async function journal(
  pool: Pool,
  key: string,
): Promise<{
  state: number
  runs: number
  result: Record<string, unknown> | null
}> {
  const r = await pool.query(
    'SELECT state, runs, result FROM queen_effect WHERE key = $1',
    [key],
  )
  const row = r.rows[0]
  if (!row) return { state: EFF_NONE, runs: 0, result: null }
  return {
    state: Number(row.state),
    runs: Number(row.runs),
    result: row.result ?? null,
  }
}

async function journalWrite(
  pool: Pool,
  key: string,
  state: number,
  runs: number,
  result: unknown,
): Promise<void> {
  await pool.query(
    `INSERT INTO queen_effect (key, kind, state, runs, result) VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (key) DO UPDATE SET state = $3, runs = $4, result = $5::jsonb, updated_at = now()`,
    [key, EK_PUSH, state, runs, JSON.stringify(result)],
  )
}

// ------------------------------------------------------- the hosting ledger

/** The credit's line in the hosting ledger (trios#1761): hosting-queen.ts recordWork's argument. */
export interface WorkRecord {
  source: string
  key: string
  job: string
  kind: number
  mtri: number
  receipt: string
}
export type RecordWork = (
  pool: Pool,
  w: WorkRecord,
) => Promise<{ recorded: boolean; epoch: number } | null>

/**
 * The hosting ledger's write path for work that is not a shard, on the
 * process's one hosting Queen (hosting.ts hostingQueen). Off while
 * TRIOS_HOSTING is off: then the credit stays this file's row alone, and the
 * route says so. One row per (key, job, kind): a second call records nothing.
 */
export const recordLabWork: RecordWork = async (_pool, w) => {
  if (!hostingOn()) return null
  const q = hostingQueen()
  return q ? q.recordWork(w) : null
}

/** Record a credited row in the hosting ledger, once, and note where on the row. */
async function recordCredit(
  pool: Pool,
  io: NetworkIo,
  row: CreditRow,
  s: string,
): Promise<CreditRow['ledger']> {
  if (row.outcome !== OUT_CREDITED || Number(row.mtri) <= 0) return null
  const job = `network-job:${s}`
  const r = await (io.recordWork ?? recordLabWork)(pool, {
    source: 'lab',
    key: row.host,
    job,
    kind: EXECUTOR_FEE,
    mtri: Number(row.mtri),
    receipt: String(row.quorum.executor_receipt ?? job),
  })
  if (!r) return null
  const ledger = { recorded: r.recorded, epoch: r.epoch, job }
  await pool.query(
    `UPDATE queen_net_credit SET ledger = COALESCE(ledger, $2::jsonb), updated_at = now() WHERE job_sha = $1`,
    [s, JSON.stringify(ledger)],
  )
  return ledger
}

const ledgerText = (l: CreditRow['ledger']): string =>
  l
    ? `hosting ledger epoch ${l.epoch}${l.recorded ? ', recorded' : ', already recorded'}`
    : 'hosting ledger off (TRIOS_HOSTING), the row alone holds it'

/** The job's one challenge: drawn once, kept in the journal, reused after any restart. */
async function challengeOf(
  pool: Pool,
  card: NetworkCard,
  sha: string,
  io: NetworkIo,
): Promise<string> {
  const key = `${text(card, 'JOURNAL_PREFIX')}${sha}:challenge`
  const kept = await journal(pool, key)
  if (kept.result?.challenge) return String(kept.result.challenge)
  await pool.query(
    `INSERT INTO queen_effect (key, kind, state, runs, result) VALUES ($1, $2, $3, 1, $4::jsonb)
     ON CONFLICT (key) DO NOTHING`,
    [
      key,
      EK_PUSH,
      EFF_DONE,
      JSON.stringify({
        challenge: io.draw(),
        drawn_at: new Date().toISOString(),
      }),
    ],
  )
  const j = await journal(pool, key)
  return String(j.result?.challenge ?? '')
}

// ------------------------------------------------------ judging the receipts

interface LabReceipt {
  lab: string
  url: string
  status: number
  receipt: Record<string, unknown> | null
  challenge: string
}

export interface LabJudgment {
  lab: string
  url: string
  keyId: string
  auth: number
  level: number
  agrees: boolean
  id: string
}

export interface Judgment {
  labs: LabJudgment[]
  agree: boolean
  votes: number
  keys: number
  verdict: number
  executor: LabJudgment | undefined
}

/** The challenge a lab was given: the job's, for a lab with a request path; '' otherwise or in a rehearsal. */
const challengeFor = (
  card: NetworkCard,
  i: number,
  challenge: string,
  rehearsal: boolean,
): string =>
  !rehearsal && list(card, 'LAB_REQUEST_PATHS')[i] !== 'none' ? challenge : ''

async function readReceipts(
  card: NetworkCard,
  sha: string,
  io: NetworkIo,
  challenge: string,
  rehearsal: boolean,
): Promise<LabReceipt[]> {
  const names = list(card, 'LAB_NAMES')
  const urls = list(card, 'LAB_URLS')
  const path = `${text(card, 'RECEIPT_PATH_PREFIX')}${sha}${text(card, 'RECEIPT_PATH_SUFFIX')}`
  return Promise.all(
    names.map(async (lab, i) => {
      const url = `${urls[i]}${path}`
      const r = await io.get(url, 'none')
      const receipt =
        r.status === 200 && r.body && typeof r.body === 'object'
          ? (r.body as Record<string, unknown>)
          : null
      return {
        lab,
        url,
        status: r.status,
        receipt,
        challenge: challengeFor(card, i, challenge, rehearsal),
      }
    }),
  )
}

export function judge(sha: string, read: LabReceipt[]): Judgment {
  const msgs = read.map((r) =>
    r.receipt
      ? receiptMessage(r.receipt, CORPUS_DOMAIN, CORPUS_SIGNED_FIELDS)
      : '',
  )
  // every receipt is compared with the first one that authenticates
  const auths = read.map((r, i) => {
    const keyId = String(r.receipt?.key_id ?? '')
    return receiptAuth(
      msgs[i],
      sha,
      keyId,
      registeredKey(keyId),
      String(r.receipt?.signature ?? ''),
      r.challenge,
    )
  })
  const first = auths.indexOf(AUTH_MISSING_NONE)
  const labs = read.map((r, i): LabJudgment => {
    const keyId = String(r.receipt?.key_id ?? '')
    const sig = String(r.receipt?.signature ?? '')
    const keyHex = registeredKey(keyId)
    const msg = msgs[i]
    return {
      lab: r.lab,
      url: r.url,
      keyId,
      auth: auths[i],
      level: receiptLevel(msg, sha, keyId, keyHex, sig, r.challenge),
      agrees: first >= 0 && msg !== '' && resultsAgree(msg, msgs[first]),
      id: `${r.url}#${sig.slice(0, 16)}`,
    }
  })
  const authed = labs.filter((l) => l.auth === AUTH_MISSING_NONE)
  const agree = authed.length > 0 && authed.every((l) => l.agrees)
  const keyList = authed
    .filter((l) => l.agrees)
    .map((l) => `${l.keyId}\n`)
    .join('')
  const votes = independentVotes(keyList)
  return {
    labs,
    agree,
    votes,
    keys: distinctKeys(keyList),
    verdict: quorumVerdict(votes, agree),
    executor: authed.find((l) => l.agrees),
  }
}

const LEVELS = ['NONE', 'AUTHOR', 'FRESH']
const summary = (j: Judgment): string =>
  j.labs
    .map(
      (l) =>
        `${l.lab} key ${l.keyId || '-'} auth ${l.auth} ${LEVELS[l.level] ?? l.level}${l.agrees ? '' : ' DISAGREES'}`,
    )
    .join('; ')

const quorumText = (j: Judgment): string =>
  `${QV_NAMES[j.verdict] ?? j.verdict}: ${j.votes} independent vote(s) from ${j.keys} key(s) of M=${TRUSTED_M} (N ${TRUSTED_N}, F ${TRUSTED_F})`

// -------------------------------------------------------------- executors

interface Ctx {
  job: {
    id: number
    params: Record<string, string>
    rehearsal: boolean
    subject: string | null
    checks_at_subject: boolean
  }
  card: NetworkCard
  pool: Pool
  now: number
}
type Answer = { outcome: number; detail: string; subject?: string }

/**
 * One lab's request, through the effects journal (control.t27 section 7): a
 * Queen that restarted after the intent looks before she writes again.
 */
async function challengeLab(
  ctx: Ctx,
  io: NetworkIo,
  lab: string,
  host: string,
  dir: string,
  s: string,
  challenge: string,
): Promise<{ ok: boolean; note: string }> {
  const key = `${text(ctx.card, 'JOURNAL_PREFIX')}${s}:lab-challenge:${lab}`
  const entry = await journal(ctx.pool, key)
  let action = effectAction(entry.state, EK_PUSH, entry.runs, 0, 0)
  if (action === DO_LOOK) {
    const back = await io.labRead(host, dir, s)
    action = afterLook(back.ok && back.read === challenge, entry.runs)
    if (action === DO_SKIP)
      await journalWrite(ctx.pool, key, EFF_DONE, entry.runs, {
        ...(entry.result ?? {}),
        found: true,
      })
  }
  if (action === DO_SKIP) {
    const at = (await journal(ctx.pool, key)).result?.at ?? '?'
    return {
      ok: true,
      note: `${lab}: request written at ${String(at)} (journal)`,
    }
  }
  if (action !== DO_RUN)
    return {
      ok: false,
      note: `${lab}: the journal gave up after ${entry.runs} run(s)`,
    }
  const at = new Date(ctx.now).toISOString()
  const runs = runsAfterIntent(entry.runs)
  await journalWrite(ctx.pool, key, EFF_INTENT, runs, { at, host })
  const w = await io.labWrite(host, dir, s, challenge)
  if (!w.ok || w.read !== challenge)
    return { ok: false, note: `${lab}: request not written (${w.detail})` }
  await journalWrite(ctx.pool, key, EFF_DONE, runs, { at, host })
  return {
    ok: true,
    note: `${lab}: request ${dir}/${s.slice(0, 12)} written at ${at}`,
  }
}

export function networkExecutors(io: NetworkIo) {
  const sha = (ctx: Ctx) => ctx.job.params.sha ?? ''
  const executors: Record<string, (ctx: Ctx) => Promise<Answer>> = {
    async 'job-commit'(ctx) {
      const s = sha(ctx)
      if (!challengeOk(s))
        return {
          outcome: O_FAIL,
          detail: `${JSON.stringify(s)} is not a 40-hex commit sha`,
        }
      const r = await io.get(
        `https://api.github.com/repos/${ctx.card.repo}/commits/${s}`,
        'read',
      )
      const got =
        r.body && typeof r.body === 'object'
          ? (r.body as Record<string, unknown>).sha
          : undefined
      if (r.status !== 200 || got !== s)
        return {
          outcome: O_FAIL,
          detail: `${ctx.card.repo} has no commit ${s} (${r.status})`,
        }
      return {
        outcome: O_PASS,
        detail: `${s.slice(0, 12)} is a commit of ${ctx.card.repo}`,
        subject: s,
      }
    },

    async 'lab-challenge'(ctx) {
      const s = sha(ctx)
      const may = effectMayRun(
        ctx.job.rehearsal,
        ctx.job.subject !== null,
        ctx.job.checks_at_subject,
      )
      if (may === E_REFUSE)
        return {
          outcome: O_FAIL,
          detail: 'refused: no checked, pinned subject',
        }
      if (may === E_REHEARSE)
        return {
          outcome: O_PASS,
          detail:
            "rehearsal: no request written; the labs' master runs are read",
        }
      const challenge = await challengeOf(ctx.pool, ctx.card, s, io)
      if (!challengeOk(challenge))
        return {
          outcome: O_FAIL,
          detail: 'the journal holds no well-formed challenge',
        }
      const names = list(ctx.card, 'LAB_NAMES')
      const paths = list(ctx.card, 'LAB_REQUEST_PATHS')
      const dir = text(ctx.card, 'LAB_REQUEST_DIR')
      const notes: string[] = []
      for (let i = 0; i < names.length; i += 1) {
        if (paths[i] === 'none') {
          notes.push(
            `${names[i]}: no request path (GAP), its master run is read`,
          )
          continue
        }
        const host = io.sshHost(names[i])
        if (!host)
          return {
            outcome: O_BLOCKED,
            detail: `blocked: this deployment has no request path to ${names[i]} (TRIOS_NETWORK_JOB_SSH)`,
          }
        const done = await challengeLab(
          ctx,
          io,
          names[i],
          host,
          dir,
          s,
          challenge,
        )
        if (!done.ok) return { outcome: O_FAIL, detail: done.note }
        notes.push(done.note)
      }
      return {
        outcome: O_PASS,
        // never the challenge itself: /queen/public-jobs publishes step details
        detail: `challenge drawn (in the journal); ${notes.join('; ')}`,
      }
    },

    async 'lab-receipts'(ctx) {
      const s = sha(ctx)
      const challenge = ctx.job.rehearsal
        ? ''
        : await challengeOf(ctx.pool, ctx.card, s, io)
      const read = await readReceipts(
        ctx.card,
        s,
        io,
        challenge,
        ctx.job.rehearsal,
      )
      const waiting: string[] = []
      for (const r of read) {
        if (!r.receipt) {
          waiting.push(`${r.lab} (${r.status})`)
          continue
        }
        if (r.challenge === '') continue
        // a receipt from before the request carries no nonce, or another one: not this job's yet
        const keyId = String(r.receipt.key_id ?? '')
        const a = receiptAuth(
          receiptMessage(r.receipt, CORPUS_DOMAIN, CORPUS_SIGNED_FIELDS),
          s,
          keyId,
          registeredKey(keyId),
          String(r.receipt.signature ?? ''),
          r.challenge,
        )
        if (a === AUTH_NO_NONCE || a === AUTH_NONCE_NOT_CHALLENGE)
          waiting.push(`${r.lab} (receipt not yet for this challenge)`)
      }
      if (waiting.length > 0)
        return {
          outcome: O_NOT_YET,
          detail: `waiting for ${waiting.join(', ')}`,
        }
      return {
        outcome: O_PASS,
        detail: `published: ${read.map((r) => r.url).join(' ')}`,
      }
    },

    async 'receipts-verified'(ctx) {
      const s = sha(ctx)
      const challenge = ctx.job.rehearsal
        ? ''
        : await challengeOf(ctx.pool, ctx.card, s, io)
      const j = judge(
        s,
        await readReceipts(ctx.card, s, io, challenge, ctx.job.rehearsal),
      )
      const ok = j.labs.every((l) => l.auth === AUTH_MISSING_NONE) && j.agree
      return {
        outcome: ok ? O_PASS : O_FAIL,
        detail: `${ok ? 'verified' : 'NOT verified'}: ${summary(j)}`,
      }
    },

    async quorum(ctx) {
      const s = sha(ctx)
      const challenge = ctx.job.rehearsal
        ? ''
        : await challengeOf(ctx.pool, ctx.card, s, io)
      const j = judge(
        s,
        await readReceipts(ctx.card, s, io, challenge, ctx.job.rehearsal),
      )
      // the verdicts settle() accepts are the ones that may earn a credit (job_rules.t27 settle_verdict)
      const ok = settleVerdict(j.verdict) === V_OK
      return { outcome: ok ? O_PASS : O_FAIL, detail: quorumText(j) }
    },

    async 'settle-credit'(ctx) {
      const s = sha(ctx)
      const may = effectMayRun(
        ctx.job.rehearsal,
        ctx.job.subject !== null,
        ctx.job.checks_at_subject,
      )
      if (may === E_REFUSE)
        return {
          outcome: O_FAIL,
          detail: 'refused: no checked, pinned subject',
        }
      const challenge = ctx.job.rehearsal
        ? ''
        : await challengeOf(ctx.pool, ctx.card, s, io)
      const j = judge(
        s,
        await readReceipts(ctx.card, s, io, challenge, ctx.job.rehearsal),
      )
      const ex = j.executor
      if (!ex)
        return {
          outcome: O_FAIL,
          detail: 'no authenticated, agreeing receipt to credit',
        }
      const op = keyOperator(ex.keyId)
      const nonce = jobNonce(s)
      await ensureNetworkTables(ctx.pool)
      const before = await creditOf(ctx.pool, s)
      const prior = before !== null
      const outcome = settleOutcome(j.verdict, op, nonce, prior)
      const mtri = settleCreditMtri(j.verdict, op, nonce, prior)
      if (may === E_REHEARSE)
        return {
          outcome: O_PASS,
          detail: `rehearsal: settle() would answer outcome ${outcome}, ${mtri} mtri to ${ex.keyId}; nothing written`,
        }
      if (before) {
        // a Queen that died between the row and the ledger writes the ledger now
        const ledger = await recordCredit(ctx.pool, io, before, s)
        return {
          outcome: O_PASS,
          detail: `already settled (journal): settle() answers outcome ${outcome}, ${mtri} mtri; ${ledgerText(ledger)}`,
        }
      }
      const state = CS_NAMES[creditState(outcome, 0, false)] ?? 'VOID'
      const fresh = j.labs.filter((l) => l.level === LEVEL_FRESH).length
      await ctx.pool.query(
        `INSERT INTO queen_net_credit (job_sha, job_id, host, kind, mtri, receipts, outcome, state, quorum, test)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10) ON CONFLICT (job_sha) DO NOTHING`,
        [
          s,
          ctx.job.id,
          ex.keyId,
          text(ctx.card, 'CREDIT_KIND_WORD'),
          mtri,
          JSON.stringify(
            j.labs
              .filter((l) => l.auth === AUTH_MISSING_NONE)
              .map((l) => l.id)
              .sort(),
          ),
          outcome,
          state,
          JSON.stringify({
            verdict: QV_NAMES[j.verdict],
            votes: j.votes,
            keys: j.keys,
            n: TRUSTED_N,
            f: TRUSTED_F,
            m: TRUSTED_M,
            fresh_receipts: fresh,
            executor_receipt: ex.id,
            operators: 'one operator (gHashTag) holds every registered key',
          }),
          ctx.card.consts.CREDIT_IS_TEST === true,
        ],
      )
      const row = await creditOf(ctx.pool, s)
      const ledger = row ? await recordCredit(ctx.pool, io, row, s) : null
      return {
        outcome: O_PASS,
        detail: `settled: outcome ${outcome}, ${mtri} mtri ${text(ctx.card, 'CREDIT_KIND_WORD')} to ${ex.keyId}, ${state}; ${ledgerText(ledger)}`,
      }
    },

    async 'challenge-window'(ctx) {
      const s = sha(ctx)
      if (ctx.job.rehearsal)
        return { outcome: O_PASS, detail: 'rehearsal: no credit to finalize' }
      await ensureNetworkTables(ctx.pool)
      const row = await creditOf(ctx.pool, s)
      if (!row) return { outcome: O_FAIL, detail: 'no credit row for this job' }
      const minutes = (ctx.now - Date.parse(row.settled_at)) / 60_000
      // no challenge path exists yet, so no challenge is ever open (stated, not hidden)
      const st = creditState(row.outcome, minutes, false)
      if (st === CS_VOID)
        return {
          outcome: O_PASS,
          detail: `outcome ${row.outcome}: nothing to finalize (VOID)`,
        }
      if (st !== CS_FINAL)
        return {
          outcome: O_NOT_YET,
          detail: `PENDING: ${Math.floor(minutes)} of ${num(ctx.card, 'CHALLENGE_WINDOW_MINUTES')} minutes`,
        }
      await ctx.pool.query(
        `UPDATE queen_net_credit SET state = $2, final_at = now(), updated_at = now() WHERE job_sha = $1 AND state <> $2`,
        [s, CS_NAMES[CS_FINAL]],
      )
      return {
        outcome: O_PASS,
        detail: `FINAL: ${row.mtri} mtri ${row.kind} to ${row.host}${row.outcome === OUT_CREDITED ? '' : ' (not credited)'}`,
      }
    },
  }
  return executors
}

// ------------------------------------------------------------- actor events

/**
 * Each step on the actors' stream (actor_events.t27), behind
 * TRIOS_QUEEN_ACTOR_EVENTS: a spawn when it starts, an exit when it answers,
 * naming the job as its task. Only keys ACTOR_PUBLIC_KEYS lists.
 */
export async function stepEvent(
  pool: Pool,
  start: boolean,
  repo: string,
  jobId: number,
  what: string,
  outcome: number,
  at: number,
): Promise<void> {
  if (!actorEventsOn()) return
  const base = {
    actor: `network-job/${what}`,
    task_kind: TK_JOB,
    task_repo: repo,
    task_id: String(jobId),
    at_ms: at,
  }
  await appendEvent(
    pool,
    ACTOR_STREAM,
    start ? EV_ACTOR_SPAWN : EV_ACTOR_EXIT,
    start
      ? base
      : { ...base, reason_class: outcome === O_FAIL ? RC_CRASH : RC_NORMAL },
  ).catch(() => 0)
}
