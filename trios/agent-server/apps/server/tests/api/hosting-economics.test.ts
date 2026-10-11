/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * SELF-HOSTING, SLICE 1B (gHashTag/trios#1761, lane B), as tests: honest
 * economics. All local, on the memory store and a VirtualClock.
 *   - the cards: sybil.t27 and statement.t27 are the pinned bytes and answer
 *     as the specs say; the seeded sybil simulation prints its tables;
 *   - the anchored quorum: two colluding public keys never decide a job, and
 *     with the rules off (slice 1) they do, on the same input;
 *   - canaries: a wrong answer to a known answer is slashed and struck at once;
 *   - probation and the cap; credits named by kind;
 *   - one credit per operator (rule 6, gHashTag/t27#8853): the owner's two
 *     keys on one job are credited once, and the simulation's tables do not
 *     move where every key is its own operator;
 *   - the epoch statement: signed, chained, and a host verifies its own leaf;
 *     a tampered leaf, path or statement fails by name;
 *   - no ledger key: every epoch stays open and unsigned, and the log names the
 *     variable, never its value;
 *   - off means off: with TRIOS_HOSTING unset every path answers 503.
 */

import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import {
  createHostingRoute,
  hostingEconomicsOf,
} from '../../src/api/routes/hosting'
import type { LeasedJob, RunShard } from '../../src/api/services/hosting-agent'
import { createHostAgent } from '../../src/api/services/hosting-agent'
import * as cards from '../../src/api/services/hosting-cards'
import {
  createHostingQueen,
  type HostingEconomics,
} from '../../src/api/services/hosting-queen'
import {
  checkOwnLeaves,
  type EpochProof,
  leafHashOf,
  rootOf,
  statementFields,
  statementHash,
  statementText,
} from '../../src/api/services/hosting-statement'
import { createMemoryHostingStore } from '../../src/api/services/hosting-store'
import {
  generateHostKey,
  keyIdOf,
  normalizeShard,
  publicHexOf,
  verifyHex,
} from '../../src/api/services/hosting-wire'
import {
  ISO_JOBDIR,
  TIER_OWNER,
  TIER_PUBLIC,
  TIER_TRUSTED,
} from '../../src/api/services/queen-hosting-host-card.gen'
import {
  JV_AGREED,
  JV_PENDING,
  JV_UNRESOLVED,
  SIDE_AGREED,
  SIDE_DISSENT,
} from '../../src/api/services/queen-hosting-proof-card.gen'
import {
  EPOCH_ORIGIN_UNIX,
  EPOCH_SECONDS,
  EXECUTOR_FEE,
  GENESIS_PREV,
  LEDGER_KEY_VARIABLE,
  LK_MALFORMED,
  LK_MISSING,
  LK_OK,
  VERIFIER_FEE,
} from '../../src/api/services/queen-hosting-statement-card.gen'
import {
  CAP_PUBLIC_MTRI,
  D_ALL,
  D_ANCHOR_PER_OPERATOR,
  D_NO_ANCHOR_NO_CANARY,
  D_OPERATOR,
  D_SLICE1,
  PROBATION_JOBS,
  SIM_SEEDS,
  SR_ANCHOR_MTRI,
  SR_ATTACKER_MTRI,
  SR_ATTACKERS_SUSPENDED,
  SR_HONEST_MTRI,
  SR_JOBS_AGREED,
  SR_WRONG_AGREED,
} from '../../src/api/services/queen-hosting-sybil-card.gen'
import { DEFAULT_SPECS_ROOT } from '../../src/inngest/spec-catalog'
import { VirtualClock } from './queen-virtual-clock'

const QUEEN = 'http://queen.test'
const NEW_CARDS = ['sybil', 'statement'] as const
const sha = (file: string) =>
  createHash('sha256')
    .update(readFileSync(join(DEFAULT_SPECS_ROOT, file)))
    .digest('hex')

// --- the cards ----------------------------------------------------------------

describe('the slice 1b cards', () => {
  const pin = readFileSync(join(DEFAULT_SPECS_ROOT, 'PIN'), 'utf8')

  it('are the pinned bytes, export every fn and import nothing', () => {
    for (const card of NEW_CARDS) {
      for (const f of [`hosting/${card}.t27`, `hosting/${card}.wasm`])
        expect(pin).toContain(`${f} sha256 ${sha(f)}`)
      const source = readFileSync(
        join(DEFAULT_SPECS_ROOT, `hosting/${card}.t27`),
        'utf8',
      )
      const own = [...source.matchAll(/^pub fn (\w+)\(/gm)].map((m) => m[1])
      const imported = [
        ...source.matchAll(/^use [\w:-]+::([a-z_0-9]+);$/gm),
      ].map((m) => m[1])
      const mod = new WebAssembly.Module(
        readFileSync(join(DEFAULT_SPECS_ROOT, `hosting/${card}.wasm`)),
      )
      const exported = new Set(
        WebAssembly.Module.exports(mod).map((e) => e.name),
      )
      for (const fn of [...own, ...imported])
        expect(exported.has(fn)).toBe(true)
      expect(WebAssembly.Module.imports(mod)).toEqual([])
      expect(pin).toContain(
        `${card}.wasm = t27c gen-c + zig 0.16.0 cc --target=wasm32-wasi -Oz -DNDEBUG -mexec-model=reactor, exports every fn of the card and the ones it imports: ${[...own, ...imported].join(',')} (reproducible: two builds, one hash)`,
      )
    }
  })

  it('answer as the specs say', () => {
    expect(cards.anchors(TIER_TRUSTED)).toBe(true)
    expect(cards.anchors(TIER_PUBLIC)).toBe(false)
    expect(cards.publicMayTake(true, false, 1)).toBe(false)
    expect(cards.publicMayTake(true, true, 1)).toBe(true)
    expect(cards.publicMayTake(false, false, 1)).toBe(true)
    expect(cards.anchoredVerdict(false, 0, 2, 2, false)).toBe(JV_PENDING)
    expect(cards.anchoredVerdict(true, 2, 2, 2, false)).toBe(JV_AGREED)
    expect(cards.anchoredVerdict(true, 1, 3, 3, false)).toBe(JV_UNRESOLVED)
    expect(cards.onProbation(PROBATION_JOBS - 1)).toBe(true)
    expect(cards.epochCap(TIER_PUBLIC, false)).toBe(BigInt(CAP_PUBLIC_MTRI))
    // the owner's cap is u64 max and survives the round trip into the card
    expect(cards.epochCap(TIER_OWNER, false)).toBe(2n ** 64n - 1n)
    expect(
      cards.voteCredit(SIDE_AGREED, false, PROBATION_JOBS, 5, 2n ** 64n - 1n),
    ).toBe(1)
    // rule 6: the owner's keys are one operator, credited once per job
    expect(cards.operatorFirst([TIER_OWNER, TIER_OWNER], 0)).toBe(true)
    expect(cards.operatorFirst([TIER_OWNER, TIER_OWNER], 1)).toBe(false)
    expect(cards.operatorFirst([TIER_OWNER, TIER_PUBLIC], 1)).toBe(true)
    expect(cards.operatorFirst([TIER_OWNER, TIER_TRUSTED, TIER_OWNER], 2)).toBe(
      false,
    )
    expect(cards.operatorsOf([TIER_OWNER, TIER_OWNER, TIER_TRUSTED], 3)).toBe(2)
    expect(
      cards.operatorCredit(
        true,
        SIDE_AGREED,
        false,
        PROBATION_JOBS,
        0,
        2n ** 64n - 1n,
      ),
    ).toBe(1)
    expect(
      cards.operatorCredit(
        false,
        SIDE_AGREED,
        false,
        PROBATION_JOBS,
        0,
        2n ** 64n - 1n,
      ),
    ).toBe(0)
    expect(cards.shardKind(false, 0)).toBe(EXECUTOR_FEE)
    expect(cards.shardKind(false, 1)).toBe(VERIFIER_FEE)
    expect(cards.shardKind(true, 0)).toBe(VERIFIER_FEE)
    expect(cards.epochOf(EPOCH_ORIGIN_UNIX + EPOCH_SECONDS)).toBe(1)
    expect(cards.ledgerKeyState(true, 64, true)).toBe(LK_OK)
    expect(cards.ledgerKeyState(false, 0, false)).toBe(LK_MISSING)
    expect(cards.ledgerKeyState(true, 63, true)).toBe(LK_MALFORMED)
    expect(cards.settlementGateOpen(true, 1)).toBe(false)
  })

  it('build the RFC 6962 tree corpus_merkle.t27 pins with its hashlib vectors', () => {
    const line = (x: string) => `specs/${x}.t27\t${x}${x}`
    const leaves = ['a', 'b', 'c', 'd', 'e'].map((x) => leafHashOf(line(x)))
    const vectors = [
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      '83c2e0d01cf45c60060daee549a7a0cb6896ba11a4d9ebc8b873a8ccce57c6b7',
      '06e1671516ddf2ac56f1c576f4cd17a5a0985787b60f9807ef43c55a50eccbc2',
      'c4930743536b4efa6564f5226ffcd60900091fd014d5583bacf161dd1e15d38f',
      '40ab2ac101414f4cb382c4273b4e324dff0b90805c9859722744de74b8056105',
      '272c9664c1823398bae6b3868ab616c044e33729a5522c33e95215e551fd9905',
    ]
    for (let n = 0; n <= 5; n++)
      expect(rootOf(leaves.slice(0, n)).toString('hex')).toBe(vectors[n])
  })
})

// --- the seeded simulation: the benchmark --------------------------------------

describe('the sybil simulation (sybil.t27), printed from the card', () => {
  const M = [1, 2, 5, 20]
  const mean = (m: number, d: number, w: number) =>
    (cards.sybilMeanMilli(m, d, w) / 1000).toFixed(3)
  const table = (title: string, d: number) => {
    const rows = [
      `${title} (defenses ${d}, mean of ${SIM_SEEDS} seeds per run)`,
      '| M | attacker mTRI | honest mTRI | wrong results agreed |',
      '|---|---|---|---|',
      ...M.map(
        (m) =>
          `| ${m} | ${mean(m, d, SR_ATTACKER_MTRI)} | ${mean(m, d, SR_HONEST_MTRI)} | ${mean(m, d, SR_WRONG_AGREED)} |`,
      ),
    ]
    console.log(rows.join('\n'))
  }

  it('pays the attacker nothing with the anchor and canaries on', () => {
    table('anchor and canaries ON', D_ALL)
    for (const m of M) {
      expect(cards.sybilTotal(m, D_ALL, SR_ATTACKER_MTRI)).toBe(0)
      expect(cards.sybilTotal(m, D_ALL, SR_WRONG_AGREED)).toBe(0)
      expect(cards.sybilTotal(m, D_ALL, SR_HONEST_MTRI)).toBeGreaterThan(0)
    }
  })

  it('pays it without them (the negative control), and slice 1 pays it from two keys', () => {
    table('anchor and canaries OFF', D_NO_ANCHOR_NO_CANARY)
    table('slice 1 as merged', D_SLICE1)
    expect(
      cards.sybilTotal(20, D_NO_ANCHOR_NO_CANARY, SR_ATTACKER_MTRI),
    ).toBeGreaterThan(0)
    expect(
      cards.sybilTotal(2, D_NO_ANCHOR_NO_CANARY, SR_WRONG_AGREED),
    ).toBeGreaterThan(0)
    for (const m of [2, 5, 20])
      expect(cards.sybilTotal(m, D_SLICE1, SR_ATTACKER_MTRI)).toBeGreaterThan(0)
    // one key alone never forms a quorum
    expect(cards.sybilTotal(1, D_SLICE1, SR_ATTACKER_MTRI)).toBe(0)
  })

  // gHashTag/t27#8853: rule 6 and the anchored verdict, before and after
  const pair = (a: number, b: number) =>
    `${(a / SIM_SEEDS).toFixed(3)} / ${(b / SIM_SEEDS).toFixed(3)}`
  const owner = (m: number, d: number, w: number) =>
    cards.sybilWorldTotal(m, d, true, w)

  it("moves no number of the one-key world with rule 6, and pays the attacker nothing in the owner's", () => {
    for (const m of M)
      for (const w of [SR_ATTACKER_MTRI, SR_HONEST_MTRI, SR_WRONG_AGREED]) {
        expect(cards.sybilTotal(m, D_ALL, w)).toBe(
          cards.sybilTotal(m, D_ALL - D_OPERATOR, w),
        )
        expect(cards.sybilTotal(m, D_NO_ANCHOR_NO_CANARY, w)).toBe(
          cards.sybilTotal(m, D_NO_ANCHOR_NO_CANARY - D_OPERATOR, w),
        )
      }
    console.log(
      [
        `the owner's world, both anchors his: rule 6 off (${D_ALL - D_OPERATOR}) / on (${D_ALL}), mean of ${SIM_SEEDS} seeds per run`,
        '| M | anchor hosts mTRI | attacker mTRI | honest mTRI | wrong results agreed |',
        '|---|---|---|---|---|',
        ...M.map(
          (m) =>
            `| ${m} | ${[SR_ANCHOR_MTRI, SR_ATTACKER_MTRI, SR_HONEST_MTRI, SR_WRONG_AGREED].map((w) => pair(owner(m, D_ALL - D_OPERATOR, w), owner(m, D_ALL, w))).join(' | ')} |`,
        ),
      ].join('\n'),
    )
    for (const m of M) {
      expect(owner(m, D_ALL, SR_ATTACKER_MTRI)).toBe(0)
      expect(owner(m, D_ALL, SR_WRONG_AGREED)).toBe(0)
      expect(owner(m, D_ALL, SR_ANCHOR_MTRI)).toBeLessThanOrEqual(
        owner(m, D_ALL - D_OPERATOR, SR_ANCHOR_MTRI),
      )
    }
    expect(owner(20, D_ALL, SR_ANCHOR_MTRI)).toBeLessThan(
      owner(20, D_ALL - D_OPERATOR, SR_ANCHOR_MTRI),
    )
  })

  it('counts the anchor per receipt: per operator, an owner-only anchor set breaks no tie', () => {
    console.log(
      [
        `the owner's world, all six rules: the anchor's group per receipt (${D_ALL}) / per operator (${D_ALL + D_ANCHOR_PER_OPERATOR}), mean of ${SIM_SEEDS} seeds per run`,
        '| M | jobs agreed | attacker keys suspended | attacker mTRI | honest mTRI |',
        '|---|---|---|---|---|',
        ...M.map(
          (m) =>
            `| ${m} | ${[SR_JOBS_AGREED, SR_ATTACKERS_SUSPENDED, SR_ATTACKER_MTRI, SR_HONEST_MTRI].map((w) => pair(owner(m, D_ALL, w), owner(m, D_ALL + D_ANCHOR_PER_OPERATOR, w))).join(' | ')} |`,
        ),
      ].join('\n'),
    )
    expect(
      owner(20, D_ALL + D_ANCHOR_PER_OPERATOR, SR_JOBS_AGREED),
    ).toBeLessThan(owner(20, D_ALL, SR_JOBS_AGREED))
    expect(
      owner(20, D_ALL + D_ANCHOR_PER_OPERATOR, SR_ATTACKERS_SUSPENDED),
    ).toBeLessThan(owner(20, D_ALL, SR_ATTACKERS_SUSPENDED))
  })
})

// --- the world -------------------------------------------------------------------

const SPEC = 'specs/demo/shard.t27'
const SPEC_BYTES = 'module DemoShard;\n'
const INPUT = createHash('sha256').update(SPEC_BYTES).digest('hex')
const MODEL = createHash('sha256').update('t27c as built').digest('hex')

const report = (spec: string, fail: boolean) =>
  [
    `--- test report: ${spec} ---`,
    '  pass  a_first',
    `  ${fail ? 'FAIL' : 'pass'}  a_second`,
    '',
    '  tests       2',
    `  pass        ${fail ? 1 : 2}`,
    `  FAIL        ${fail ? 1 : 0}`,
    '  invariants  1   proved -- comptime, so compiling IS the check',
    '',
    '  runtime asserts executed, per test (#6509; a pass with 0 is vacuous, T730):',
    '       3  a_first',
    '       2  a_second',
    '  vacuous passes  0 of 2  (passed with 0 runtime asserts executed)',
    '',
  ].join('\n')

const shard = (spec: string, fail: boolean) =>
  normalizeShard(spec, {
    started: true,
    timedOut: false,
    exitCode: 0,
    stdout: report(spec, fail),
    stderr: '',
  })

/** The true answer: the spec fails one test. */
const honest: RunShard = async (j: LeasedJob) => ({
  result: shard(j.spec, true),
  modelHash: MODEL,
  zig: '0.16.0',
})
/** Every sybil key answers the same wrong hash: the spec passes. */
const sybil: RunShard = async (j: LeasedJob) => ({
  result: shard(j.spec, false),
  modelHash: MODEL,
  zig: '0.16.0',
})
const TRUE_HASH = shard(SPEC, true).outputHash

const commitOf = (i: number) => i.toString(16).padStart(40, '0')
const jobOf = (i: number, known?: string) => ({
  commit: commitOf(i),
  spec: SPEC,
  input_hash: INPUT,
  files: [{ path: SPEC, sha256: INPUT }],
  holds_secret: false,
  holds_personal: false,
  ...(known ? { known_output_hash: known } : {}),
})

async function world(
  econ: Partial<HostingEconomics>,
  allow: Record<string, number> = {},
) {
  const clock = new VirtualClock()
  // inside epoch 0 of statement.t27, a little after its start
  await clock.runUntil(EPOCH_ORIGIN_UNIX * 1000 + 60_000)
  const queen = createHostingQueen({
    store: createMemoryHostingStore(),
    now: clock.now,
    allowlist: new Map(Object.entries(allow)),
    economics: econ,
  })
  const app = new Hono().route(
    '/hosting',
    createHostingRoute({ enabled: () => true, queen: () => queen }),
  )
  const agent = (
    privatePem: string,
    ip: string,
    runShard: RunShard,
    tierClaim = TIER_PUBLIC,
  ) =>
    createHostAgent({
      queenUrl: QUEEN,
      fetch: async (url, init) =>
        app.request(url.slice(QUEEN.length), {
          ...init,
          headers: {
            ...(init.headers as Record<string, string>),
            'x-forwarded-for': ip,
          },
        }),
      privatePem,
      tierClaim,
      slots: 4,
      platform: 'darwin-arm64',
      // lane A (trios#1762): a shard is a public job and needs a measured
      // job-dir-only sandbox; these hosts have one
      isolation: ISO_JOBDIR,
      runShard,
      clock,
    })
  const get = async (path: string) => {
    const res = await app.request(path)
    // biome-ignore lint/suspicious/noExplicitAny: the tests read the routes' JSON as it comes
    return { status: res.status, json: (await res.json()) as any }
  }
  return { clock, queen, app, agent, get }
}

/** The owner, a trusted host, an honest public host and two sybil keys. */
async function cast(econ: Partial<HostingEconomics>) {
  const keys = {
    owner: generateHostKey(),
    trusted: generateHostKey(),
    honest: generateHostKey(),
    s1: generateHostKey(),
    s2: generateHostKey(),
  }
  const w = await world(econ, {
    [keyIdOf(keys.owner.publicHex)]: TIER_OWNER,
    [keyIdOf(keys.trusted.publicHex)]: TIER_TRUSTED,
  })
  const a = {
    owner: w.agent(keys.owner.privatePem, '203.0.113.7', honest, TIER_OWNER),
    trusted: w.agent(
      keys.trusted.privatePem,
      '203.0.113.8',
      honest,
      TIER_TRUSTED,
    ),
    honest: w.agent(keys.honest.privatePem, '198.51.100.20', honest),
    s1: w.agent(keys.s1.privatePem, '192.0.2.66', sybil),
    s2: w.agent(keys.s2.privatePem, '100.64.9.9', sybil),
  }
  for (const x of Object.values(a)) await x.register()
  return { w, keys, a }
}

type Agent = ReturnType<Awaited<ReturnType<typeof world>>['agent']>
const row = (ledger: { hosts: Array<{ host: string }> }, agent: Agent) =>
  // biome-ignore lint/suspicious/noExplicitAny: a public ledger row
  ledger.hosts.find((h) => h.host === agent.id) as any

/** One job run by `first` then `second`, each leasing and reporting. */
async function runJob(owner: Agent, i: number, first: Agent, second: Agent) {
  await owner.submitJob(jobOf(i))
  const l1 = await first.leaseOnce()
  const l2 = await second.leaseOnce()
  if (!l1 || !l2) throw new Error(`job ${i} was not placed`)
  await first.work(l1)
  return second.work(l2)
}

// --- the anchored quorum ------------------------------------------------------------

describe('the anchored quorum (sybil.t27), against two colluding public keys', () => {
  it('never lets the sybils decide a job; a second anchor breaks the tie', async () => {
    const { w, a } = await cast({ sybil: true })
    await a.owner.submitJob(jobOf(1))
    const s1 = await a.s1.leaseOnce()
    expect(s1?.job.commit).toBe(commitOf(1))
    // the second slot is the anchor's: no public key takes it
    expect(await a.s2.leaseOnce()).toBeNull()
    expect(await a.honest.leaseOnce()).toBeNull()
    const o = await a.owner.leaseOnce()
    expect(o?.job.commit).toBe(commitOf(1))
    expect(await a.s1.work(s1 as NonNullable<typeof s1>)).toMatchObject({
      code: 'ok',
      accepted: true,
      job: { verdict: 'pending' },
    })
    expect(await a.owner.work(o as NonNullable<typeof o>)).toMatchObject({
      job: { verdict: 'tiebreak' },
    })
    // the tiebreak is an anchor's too
    expect(await a.s2.leaseOnce()).toBeNull()
    const t = await a.trusted.leaseOnce()
    const done = await a.trusted.work(t as NonNullable<typeof t>)
    expect(done).toMatchObject({ job: { verdict: 'agreed' } })
    // the agreed half; a lab row needs its t27b half too (lane A, hosting-row.test.ts)
    expect(
      (await w.get(`/hosting/jobs/${done.job?.id}`)).json.result,
    ).toMatchObject({ word: 'fail' })
    const ledger = (await w.get('/hosting/ledger')).json
    expect(row(ledger, a.s1)).toMatchObject({
      balance_mtri: 0,
      strikes: 1,
      slashes: 1,
      probation: true,
    })
    // the anchors agreed, and are on probation like every new key
    expect(row(ledger, a.owner)).toMatchObject({ agreed: 1, strikes: 0 })
    expect(row(ledger, a.trusted)).toMatchObject({ agreed: 1, strikes: 0 })
    expect(ledger.sybil).toMatchObject({ on: true })
  })

  it('with the rules off (slice 1), the same two keys decide the job and are paid', async () => {
    const { w, a } = await cast({ sybil: false })
    await a.owner.submitJob(jobOf(1))
    const l1 = await a.s1.leaseOnce()
    const l2 = await a.s2.leaseOnce()
    expect(l1?.job.commit).toBe(commitOf(1))
    expect(l2?.job.commit).toBe(commitOf(1))
    await a.s1.work(l1 as NonNullable<typeof l1>)
    const done = await a.s2.work(l2 as NonNullable<typeof l2>)
    expect(done).toMatchObject({ job: { verdict: 'agreed' } })
    expect(
      (await w.get(`/hosting/jobs/${done.job?.id}`)).json.result,
    ).toMatchObject({ word: 'pass' })
    const ledger = (await w.get('/hosting/ledger')).json
    expect(row(ledger, a.s1)).toMatchObject({ balance_mtri: 1, strikes: 0 })
    expect(row(ledger, a.s2)).toMatchObject({ balance_mtri: 1, strikes: 0 })
  })
})

describe('canaries (sybil.t27)', () => {
  it('slash and strike a wrong answer to a known answer at once, and pay the right one as a verifier', async () => {
    const { w, a } = await cast({ sybil: true, canaryDraw: () => 0 })
    // an ordinary job and a known-answer one; the draw makes the lease a canary
    await a.owner.submitJob(jobOf(1))
    await a.owner.submitJob(jobOf(2, TRUE_HASH))
    const l = await a.s1.leaseOnce()
    expect(l?.job.commit).toBe(commitOf(2))
    // the known answer is not in the payload
    expect(JSON.stringify(l)).not.toContain(TRUE_HASH)
    expect(await a.s1.work(l as NonNullable<typeof l>)).toMatchObject({
      code: 'ok',
      job: { verdict: 'tiebreak' },
    })
    let ledger = (await w.get('/hosting/ledger')).json
    expect(row(ledger, a.s1)).toMatchObject({ strikes: 1, slashes: 1 })
    // a public host may take the tiebreak of a known-answer job
    const h = await a.honest.leaseOnce()
    expect(h?.job.commit).toBe(commitOf(2))
    expect(await a.honest.work(h as NonNullable<typeof h>)).toMatchObject({
      job: { verdict: 'agreed' },
    })
    ledger = (await w.get('/hosting/ledger')).json
    expect(row(ledger, a.honest)).toMatchObject({ agreed: 1, strikes: 0 })
    expect(row(ledger, a.s1)).toMatchObject({ strikes: 1, slashes: 1 })
  })
})

describe('probation, the cap and the kinds (sybil.t27, statement.t27)', () => {
  it('pays a new key nothing for ten agreements, then by kind, up to its cap', async () => {
    const { w, a } = await cast({ sybil: true })
    const jobs = PROBATION_JOBS + CAP_PUBLIC_MTRI + 1
    for (let i = 1; i <= jobs; i++) {
      const answer = await runJob(a.owner, i, a.honest, a.owner)
      expect(answer.job?.verdict).toBe('agreed')
    }
    const ledger = (await w.get('/hosting/ledger')).json
    // the honest public key: ten on probation, then 24 mTRI, then the cap
    expect(row(ledger, a.honest)).toMatchObject({
      agreed: jobs,
      balance_mtri: CAP_PUBLIC_MTRI,
      credited_jobs: CAP_PUBLIC_MTRI,
      probation: false,
      epoch_cap_mtri: CAP_PUBLIC_MTRI,
    })
    // the owner is not capped
    expect(row(ledger, a.owner)).toMatchObject({
      balance_mtri: jobs - PROBATION_JOBS,
      epoch_cap_mtri: null,
    })
    const kinds = (host: string) =>
      new Set(
        ledger.rows
          .filter(
            (r: { host: string; kind: string }) =>
              r.host === host && r.kind === 'credit',
          )
          .map((r: { fee_kind: string }) => r.fee_kind),
      )
    // the honest host reported first each time: the executor; the owner verified
    expect([...kinds(a.honest.id)]).toEqual(['executor_fee'])
    expect([...kinds(a.owner.id)]).toEqual(['verifier_fee'])
    for (const r of ledger.rows) expect(r.epoch).toBe(0)
  })
})

// --- one credit per operator ---------------------------------------------------------

describe('one credit per operator (sybil.t27 rule 6, gHashTag/t27#8853)', () => {
  /** Two of the owner's keys on one machine, as production ran on 2026-10-10 (trios#1763). */
  async function ownersTwoKeys(econ: Partial<HostingEconomics>) {
    const k1 = generateHostKey()
    const k2 = generateHostKey()
    const w = await world(econ, {
      [keyIdOf(k1.publicHex)]: TIER_OWNER,
      [keyIdOf(k2.publicHex)]: TIER_OWNER,
    })
    const o1 = w.agent(k1.privatePem, '203.0.113.7', honest, TIER_OWNER)
    const o2 = w.agent(k2.privatePem, '203.0.113.7', honest, TIER_OWNER)
    await o1.register()
    await o2.register()
    const jobs = PROBATION_JOBS + 3
    for (let i = 1; i <= jobs; i++)
      expect((await runJob(o1, i, o1, o2)).job?.verdict).toBe('agreed')
    const ledger = (await w.get('/hosting/ledger')).json
    const credits = ledger.rows.filter(
      (r: { kind: string }) => r.kind === 'credit',
    )
    return { ledger, o1, o2, jobs, credits }
  }

  it('credits the owner once for a job both of his keys ran: the first receipt, as the executor', async () => {
    const { ledger, o1, o2, jobs, credits } = await ownersTwoKeys({
      sybil: true,
    })
    // both keys agreed every time, and neither is struck
    expect(row(ledger, o1)).toMatchObject({
      agreed: jobs,
      strikes: 0,
      balance_mtri: 3,
      credited_jobs: 3,
    })
    // the second receipt is the same operator's: nothing, and no ledger row
    expect(row(ledger, o2)).toMatchObject({
      agreed: jobs,
      strikes: 0,
      balance_mtri: 0,
      credited_jobs: 0,
    })
    expect(credits).toHaveLength(3)
    for (const r of credits) {
      expect(r.host).toBe(o1.id)
      expect(r.fee_kind).toBe('executor_fee')
    }
  })

  it('with the rules off (slice 1), both of his keys are credited, as before', async () => {
    const { ledger, o1, o2, jobs, credits } = await ownersTwoKeys({
      sybil: false,
    })
    expect(row(ledger, o1)).toMatchObject({ balance_mtri: jobs })
    expect(row(ledger, o2)).toMatchObject({ balance_mtri: jobs })
    expect(credits).toHaveLength(2 * jobs)
  })
})

// --- the epoch statement ------------------------------------------------------------

describe('the epoch statement (statement.t27)', () => {
  it('closes once past the epoch, is signed and chained, and a host finds its credit inside the root', async () => {
    const ledgerKey = generateHostKey()
    const { w, a } = await cast({
      sybil: true,
      ledgerKeyPem: ledgerKey.privatePem,
    })
    for (let i = 1; i <= PROBATION_JOBS + 3; i++)
      await runJob(a.owner, i, a.honest, a.owner)
    // still inside epoch 0: nothing closes
    let epochs = (await w.get('/hosting/ledger/epochs')).json
    expect(epochs).toMatchObject({
      signed: true,
      chain_of_record: 'ton',
      settlement: 'shut',
      transferable: false,
      queen_key: ledgerKey.publicHex,
      epochs: [],
    })
    await w.clock.runUntil((EPOCH_ORIGIN_UNIX + EPOCH_SECONDS) * 1000 + 5)
    epochs = (await w.get('/hosting/ledger/epochs')).json
    expect(epochs.epochs).toHaveLength(1)
    const [st] = epochs.epochs
    expect(st).toMatchObject({
      epoch: 0,
      from_unix: EPOCH_ORIGIN_UNIX,
      to_unix: EPOCH_ORIGIN_UNIX + EPOCH_SECONDS,
      prev: GENESIS_PREV,
      credit_mtri: 3 + 3,
      slash_mtri: 0,
      chain: 'ton',
      settlement: 'shut',
      transferable: false,
    })
    // the signature verifies over the statement's own text
    const { signature, ...fields } = st
    expect(
      verifyHex(ledgerKey.publicHex, statementText(fields), signature),
    ).toBe(true)

    // the honest host checks its own credit, as `trios-host statement` does
    const res = await w.get(`/hosting/ledger/epochs/0/proof?key=${a.honest.id}`)
    expect(res.status).toBe(200)
    const proof = res.json as EpochProof & { queen_key: string }
    expect(proof.leaves).toHaveLength(1)
    expect(proof.leaves[0]?.leaf).toMatchObject({
      host: a.honest.id,
      kind: 'executor_fee',
      mtri: 3,
    })
    expect(proof.leaves[0]?.leaf.receipts).toHaveLength(3)
    const ok = checkOwnLeaves(proof, proof.queen_key, a.honest.id)
    expect(ok.map((c) => c.word)).toEqual(['ok'])

    // tampering fails by name, in statement.t27's order
    const leaf = proof.leaves[0] as EpochProof['leaves'][number]
    const more = {
      ...proof,
      leaves: [{ ...leaf, leaf: { ...leaf.leaf, mtri: 4 } }],
    }
    expect(checkOwnLeaves(more, proof.queen_key, a.honest.id)[0]?.word).toBe(
      'root_mismatch',
    )
    const short = { ...proof, leaves: [{ ...leaf, path: leaf.path.slice(1) }] }
    expect(checkOwnLeaves(short, proof.queen_key, a.honest.id)[0]?.word).toBe(
      'bad_shape',
    )
    expect(checkOwnLeaves(proof, proof.queen_key, a.owner.id)[0]?.word).toBe(
      'not_my_leaf',
    )
    const forged = {
      ...proof,
      statement: proof.statement.replace('credit_mtri=6\n', 'credit_mtri=60\n'),
    }
    expect(forged.statement).not.toBe(proof.statement)
    expect(checkOwnLeaves(forged, proof.queen_key, a.honest.id)[0]?.word).toBe(
      'bad_signature',
    )
    expect(
      checkOwnLeaves(proof, generateHostKey().publicHex, a.honest.id)[0]?.word,
    ).toBe('bad_signature')

    // the next epoch closes too, empty, chained to the first
    await w.clock.runUntil((EPOCH_ORIGIN_UNIX + 2 * EPOCH_SECONDS) * 1000 + 5)
    epochs = (await w.get('/hosting/ledger/epochs')).json
    expect(epochs.epochs).toHaveLength(2)
    expect(epochs.epochs[1]).toMatchObject({
      epoch: 1,
      leaves: 0,
      root: createHash('sha256').digest('hex'),
      prev: statementHash(proof.statement),
    })
    expect(statementFields(proof.statement).root).toBe(st.root)
    // a key with nothing in an epoch gets no leaf, and an epoch not closed is 404
    expect(
      (await w.get(`/hosting/ledger/epochs/0/proof?key=${a.s1.id}`)).json
        .leaves,
    ).toEqual([])
    expect(
      (await w.get(`/hosting/ledger/epochs/9/proof?key=${a.s1.id}`)).status,
    ).toBe(404)
    expect(
      (await w.get('/hosting/ledger/epochs/0/proof?key=not-a-key')).status,
    ).toBe(400)
  })

  it('records a slash in its leaf and subtracts it', async () => {
    const ledgerKey = generateHostKey()
    const { w, a } = await cast({
      sybil: true,
      ledgerKeyPem: ledgerKey.privatePem,
      canaryDraw: () => 0,
    })
    await a.owner.submitJob(jobOf(1, TRUE_HASH))
    const l = await a.s1.leaseOnce()
    await a.s1.work(l as NonNullable<typeof l>)
    await w.clock.runUntil((EPOCH_ORIGIN_UNIX + EPOCH_SECONDS) * 1000 + 5)
    const res = await w.get(`/hosting/ledger/epochs/0/proof?key=${a.s1.id}`)
    expect(
      res.json.leaves.map((x: { leaf: { kind: string } }) => x.leaf.kind),
    ).toEqual(['slash'])
    expect(
      checkOwnLeaves(res.json, ledgerKey.publicHex, a.s1.id).map((c) => c.word),
    ).toEqual(['ok'])
  })
})

describe('the write path for work that is not a shard (a lab receipt)', () => {
  it('records a credit for a key that is not a host, once, in the same leaf shape and root', async () => {
    const ledgerKey = generateHostKey()
    const { w, a } = await cast({
      sybil: true,
      ledgerKeyPem: ledgerKey.privatePem,
    })
    const lab = keyIdOf(generateHostKey().publicHex)
    const work = {
      source: 'lab',
      key: lab,
      job: 'run-8613-0001',
      kind: VERIFIER_FEE,
      mtri: 5,
      receipt: 'rcpt-0001',
    }
    expect(await w.queen.recordWork(work)).toEqual({ recorded: true, epoch: 0 })
    // once per (key, job, kind)
    expect(await w.queen.recordWork(work)).toEqual({
      recorded: false,
      epoch: 0,
    })
    // only a leaf kind, a key id and a named source other than the shards'
    for (const bad of [
      { ...work, kind: 1 },
      { ...work, kind: 5 },
      { ...work, key: 'lab' },
      { ...work, source: 'hosting' },
      { ...work, mtri: -1 },
      { ...work, receipt: '' },
    ])
      await expect(w.queen.recordWork(bad)).rejects.toThrow('bad_work')
    await runJob(a.owner, 1, a.honest, a.owner)
    const ledger = (await w.get('/hosting/ledger')).json
    expect(ledger.hosts.map((h: { host: string }) => h.host)).not.toContain(lab)
    expect(
      ledger.rows.find((r: { host: string }) => r.host === lab),
    ).toMatchObject({
      kind: 'credit',
      fee_kind: 'verifier_fee',
      mtri: 5,
      source: 'lab',
      receipt: 'rcpt-0001',
    })
    await w.clock.runUntil((EPOCH_ORIGIN_UNIX + EPOCH_SECONDS) * 1000 + 5)
    const proof = (await w.get(`/hosting/ledger/epochs/0/proof?key=${lab}`))
      .json as EpochProof & { queen_key: string }
    expect(proof.leaves.map((l) => l.leaf)).toEqual([
      {
        epoch: 0,
        host: lab,
        kind: 'verifier_fee',
        mtri: 5,
        receipts: ['rcpt-0001'],
      },
    ])
    expect(
      checkOwnLeaves(proof, proof.queen_key, lab).map((c) => c.word),
    ).toEqual(['ok'])
  })
})

describe('the ledger key (statement.t27 section 6)', () => {
  it('missing: every epoch stays open and unsigned, and nothing crashes', async () => {
    const { w, a } = await cast({ sybil: true })
    for (let i = 1; i <= 2; i++) await runJob(a.owner, i, a.honest, a.owner)
    await w.clock.runUntil((EPOCH_ORIGIN_UNIX + 3 * EPOCH_SECONDS) * 1000)
    const epochs = await w.get('/hosting/ledger/epochs')
    expect(epochs.status).toBe(200)
    expect(epochs.json).toMatchObject({
      signed: false,
      ledger_key: 'missing',
      queen_key: null,
      epochs: [],
    })
    expect(
      (await w.get(`/hosting/ledger/epochs/0/proof?key=${a.honest.id}`)).json,
    ).toEqual({ error: 'ledger_key_missing' })
    expect((await w.get('/hosting/ledger')).status).toBe(200)
  })

  it('is read from one variable, judged by the card, and its value is never logged', () => {
    const seed = 'ab'.repeat(32)
    const lines: string[] = []
    const set = hostingEconomicsOf({ [LEDGER_KEY_VARIABLE]: seed }, (l) =>
      lines.push(l),
    )
    expect(lines).toEqual([])
    expect(set.ledgerKeyState).toBe(LK_OK)
    expect(publicHexOf(set.ledgerKeyPem as string)).toMatch(/^[0-9a-f]{64}$/)

    const bad = `${seed.slice(0, 60)}ZZZZ`
    const malformed = hostingEconomicsOf({ [LEDGER_KEY_VARIABLE]: bad }, (l) =>
      lines.push(l),
    )
    expect(malformed).toMatchObject({
      ledgerKeyPem: null,
      ledgerKeyState: LK_MALFORMED,
    })
    const missing = hostingEconomicsOf({}, (l) => lines.push(l))
    expect(missing).toMatchObject({
      ledgerKeyPem: null,
      ledgerKeyState: LK_MISSING,
    })
    expect(lines).toEqual([
      'hosting: TRIOS_HOSTING_LEDGER_KEY is malformed; every epoch stays open and unsigned',
      'hosting: TRIOS_HOSTING_LEDGER_KEY is missing; every epoch stays open and unsigned',
    ])
    for (const l of lines) {
      expect(l).not.toContain(bad)
      expect(l).not.toContain(seed.slice(0, 16))
    }
    expect(hostingEconomicsOf({}, () => {}).sybil).toBe(false)
    expect(
      hostingEconomicsOf({ TRIOS_HOSTING_SYBIL: 'on' }, () => {}).sybil,
    ).toBe(true)
  })
})

describe('off means off', () => {
  it('with TRIOS_HOSTING unset every path answers 503 and no Queen is built', async () => {
    const saved = process.env.TRIOS_HOSTING
    delete process.env.TRIOS_HOSTING
    try {
      let built = 0
      const app = new Hono().route(
        '/hosting',
        createHostingRoute({
          queen: () => {
            built += 1
            return null
          },
        }),
      )
      const paths: Array<[string, string]> = [
        ['POST', '/hosting/hosts'],
        ['POST', '/hosting/hosts/abcdef0123456789/beat'],
        ['POST', '/hosting/lease'],
        ['POST', '/hosting/receipts'],
        ['POST', '/hosting/jobs'],
        ['GET', '/hosting/ledger'],
        ['GET', '/hosting/ledger/epochs'],
        ['GET', '/hosting/ledger/epochs/0/proof?key=abcdef0123456789'],
        ['GET', '/hosting/verdicts'],
        ['GET', '/hosting/jobs/j_1'],
      ]
      for (const [method, path] of paths) {
        const res = await app.request(path, {
          method,
          ...(method === 'POST' ? { body: '{}' } : {}),
        })
        expect(res.status).toBe(503)
        expect(await res.json()).toEqual({ error: 'hosting_off' })
      }
      expect(built).toBe(0)
    } finally {
      if (saved === undefined) delete process.env.TRIOS_HOSTING
      else process.env.TRIOS_HOSTING = saved
    }
  })

  it('credit is non-transferable: no route moves it and every statement says so', async () => {
    const app = createHostingRoute({ enabled: () => true, queen: () => null })
    const routes = app.routes.map((r) => `${r.method} ${r.path}`)
    for (const r of routes)
      expect(r).not.toMatch(/transfer|withdraw|settle|payout/i)
    const ledger = await (await world({ sybil: true })).get('/hosting/ledger')
    expect(ledger.json).toMatchObject({
      transferable: false,
      settlement: { enabled: false, chain_of_record: 'ton' },
    })
    expect(SIDE_DISSENT).toBe(1)
  })
})
