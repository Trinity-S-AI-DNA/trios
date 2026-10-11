/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The Queen's half of self-hosting (gHashTag/trios#1756, slice 1): hosts
 * register with a key, beat, lease one replica of a shard at a time and post
 * a signed receipt; the Queen judges each receipt, decides each job by k-of-n
 * agreement and keeps the off-chain ledger.
 *
 * THIN GLUE. This file reads and writes rows, checks signatures and hashes,
 * and counts. Every decision is a call into a card (hosting-cards.ts):
 * the tier a key gets, whether a write is admitted, whether a host may take a
 * job, when a lease lapses, what a receipt's code is, whether a job is agreed,
 * who is credited and who is struck. A number the cards own (k, the lease
 * TTL, the run bound, the credit rate) is never written here.
 *
 * WHY A CLOCK IS PASSED IN: the demo runs the whole protocol, lapses
 * included, on a VirtualClock; production passes Date.now.
 *
 * THE LAB'S ROW (trios#1761): a shard job is one half of a lab row, the
 * reference or t27b (row.t27). A host takes a half only when may_take_half
 * says so: its instruction set runs the half, and its measured isolation meets
 * the job's. GET /hosting/verdicts serves the rows whose two halves are both
 * agreed (row_complete), assembled the lab's way (hosting-wire assembleRow).
 *
 * SLICE 1B (trios#1761). Behind `economics.sybil` (TRIOS_HOSTING_SYBIL=on):
 * sybil.t27's anchored quorum, canaries, probation, the per-key cap and the
 * slash. Always on: every credit row is named by statement.t27's kind and
 * carries its epoch and receipt, and, once the Queen holds its ledger key
 * (statement.t27 LEDGER_KEY_VARIABLE), each epoch past its end closes into
 * one signed statement (/hosting/ledger/epochs). Without the key every epoch
 * stays open and unsigned. No path here moves value or calls a chain.
 */

import { randomBytes, randomInt } from 'node:crypto'
import {
  anchoredVerdict,
  anchors,
  attested,
  attributable,
  balanceAfterEntry,
  canaryDue,
  canaryWrong,
  creditMtri,
  epochCap,
  epochCloses,
  epochFrom,
  epochOf,
  epochsClose,
  epochTo,
  exhausted,
  halfVote,
  hostWriteAdmitted,
  jobClosed,
  jobFirst,
  jobVerdict,
  leafKindKnown,
  mayTakeHalf,
  nextIncarnation,
  nextToClose,
  onProbation,
  openReplicas,
  operatorCredit,
  operatorFirst,
  originBlocks,
  places,
  publicMayTake,
  receiptCode,
  replicaLapsed,
  replicasWanted,
  requestFresh,
  rowAdmitted,
  rowComplete,
  rowEpochOpen,
  settlementDue,
  settlementGateOpen,
  shardKind,
  sideOf,
  slashDue,
  slashMtri,
  slotsAdmitted,
  spreadOk,
  strikeDue,
  struck,
  suspended,
  tampered,
  tierOf,
  wantedAfter,
} from './hosting-cards'
import {
  leafHashOf,
  leafText,
  leavesOf,
  proofOf,
  rootOf,
  signStatement,
  statementFields,
  statementHash,
  statementText,
} from './hosting-statement'
import type {
  HostingStore,
  HostingTx,
  HostRow,
  JobFile,
  JobRow,
  LeaseRow,
} from './hosting-store'
import { archOf } from './hosting-toolchain'
import {
  assembleRow,
  keyIdOf,
  messageOf,
  publicHexOf,
  readNormalized,
  sha256Hex,
  verifyHex,
} from './hosting-wire'
import {
  CREDIT_TRANSFERABLE,
  LE_CREDIT,
  LE_SLASH,
  LE_STRIKE,
  SETTLE_THRESHOLD_MTRI,
  SETTLEMENT_ENABLED,
  SIDE_AGREED,
  SIDE_NONE,
  TOKEN_VALUE_CLAIMED,
} from './queen-hosting-credit-card.gen'
import {
  ALLOW_NONE,
  NODE_HEARTBEAT_SECONDS,
  NODE_TTL_SECONDS,
  TIER_OWNER,
  TIER_PUBLIC,
  WC_SHARD,
} from './queen-hosting-host-card.gen'
import { JOB_RUN_BOUND_SECONDS } from './queen-hosting-placement-card.gen'
import {
  JV_AGREED,
  JV_PENDING,
  LEASE_NONCE_BYTES,
  RECEIPT_DOMAIN,
  RECEIPT_SIGNED_FIELDS,
  REGISTER_DOMAIN,
  REGISTER_SIGNED_FIELDS,
  REPLICAS_K,
  REQUEST_DOMAIN,
  REQUEST_SIGNED_FIELDS,
  VERDICT_WORDS,
} from './queen-hosting-proof-card.gen'
import {
  HALF_REFERENCE,
  HALF_T27B,
  HALF_WORDS,
  HALVES,
  T27B_WORDS,
} from './queen-hosting-row-card.gen'
import {
  CHAIN_OF_RECORD,
  CHAIN_WORD,
  CLOSES_PER_CALL_MAX,
  ENTRY_SLASH,
  EPOCH_SECONDS,
  GENESIS_PREV,
  KIND_WORDS,
  LK_MISSING,
  LK_OK,
  SETTLEMENT_SHUT_WORD,
} from './queen-hosting-statement-card.gen'
import {
  ATTEST_NONE,
  CANARY_PERMILLE,
  PERMILLE,
  PROBATION_JOBS,
} from './queen-hosting-sybil-card.gen'

export const TIER_WORDS = ['owner', 'trusted', 'public'] as const
export const ISOLATION_WORDS = [
  'none',
  'no-network',
  'job-dir-only',
  'vm',
] as const
/** A half's verdict words, by row.t27 HALF_*. */
const halfWords = (half: number): readonly string[] =>
  half === HALF_T27B ? T27B_WORDS : VERDICT_WORDS
export const LEDGER_KIND_WORDS = ['credit', 'strike', 'slash'] as const
/** statement.t27 LK_OK, LK_MISSING, LK_MALFORMED. */
export const LEDGER_KEY_WORDS = ['set', 'missing', 'malformed'] as const
export const JOB_VERDICT_WORDS = [
  'pending',
  'agreed',
  'tiebreak',
  'unresolved',
] as const
export const RECEIPT_CODE_WORDS = [
  'ok',
  'unknown_host',
  'bad_signature',
  'not_leased',
  'duplicate',
  'equivocation',
  'late',
  'input_mismatch',
  'model_mismatch',
  'output_mismatch',
] as const

/** A beat age for an incarnation the row no longer holds: it beats no more. */
const SUPERSEDED_AGE = 0xffff_ffff
const HEX40 = /^[0-9a-f]{40}$/
const HEX64 = /^[0-9a-f]{64}$/
const SPEC_PATH = /^specs\/[A-Za-z0-9_\-/.]+\.t27$/
const MAX_OUTPUT_BYTES = 256 * 1024

export class HostingError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 503,
  ) {
    super(code)
  }
}

/** One signed host request, as the route hands it over. */
export interface HostRequest {
  method: string
  path: string
  header: (name: string) => string | undefined
  body: string
}

/** Slice 1b (trios#1761). */
export interface HostingEconomics {
  /** sybil.t27's five rules. Off unless TRIOS_HOSTING_SYBIL=on. */
  sybil: boolean
  /** Key ids the owner's allowlist marks attested (TRIOS_HOSTING_ATTESTED). */
  attested: ReadonlySet<string>
  /** The Queen's Ed25519 ledger key (PKCS#8 PEM), from statement.t27 LEDGER_KEY_VARIABLE. */
  ledgerKeyPem: string | null
  /** statement.t27 ledger_key_state of that variable; anything but LK_OK closes nothing. */
  ledgerKeyState: number
  /** A draw in [0, PERMILLE) the host cannot see: the canary's source. */
  canaryDraw: () => number
}

export interface HostingQueenDeps {
  store: HostingStore
  /** Milliseconds. */
  now: () => number
  /** The owner's allowlist: key id to tier. A key it does not name is public. */
  allowlist: ReadonlyMap<string, number>
  random?: (bytes: number) => string
  economics?: Partial<HostingEconomics>
}

/** One vote (or one receipt) to account: credit.t27, sybil.t27 and statement.t27. */
interface Vote {
  hostId: string
  lease: string | null
  side: number
  tamper: boolean
  wrongCanary: boolean
  /** Its place among the job's agreeing receipts, by arrival (statement.t27 shard_kind). */
  index: number
  /**
   * sybil.t27 rule 6: the first receipt of its operator among the job's
   * agreeing ones (operator_first). Set only when a closed job is accounted;
   * a vote without it is credited nothing under the sybil rules.
   */
  firstOfOperator?: boolean
}

const int = (v: unknown, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null

const text = (v: unknown, re: RegExp): string | null =>
  typeof v === 'string' && re.test(v) ? v : null

function specPath(v: unknown): string | null {
  const p = text(v, SPEC_PATH)
  return p && !p.split('/').includes('..') ? p : null
}

export function createHostingQueen(deps: HostingQueenDeps) {
  const random =
    deps.random ?? ((bytes: number) => randomBytes(bytes).toString('hex'))
  const nowMs = deps.now
  const econ: HostingEconomics = {
    sybil: deps.economics?.sybil ?? false,
    attested: deps.economics?.attested ?? new Set(),
    ledgerKeyPem: deps.economics?.ledgerKeyPem ?? null,
    ledgerKeyState: deps.economics?.ledgerKeyPem
      ? LK_OK
      : (deps.economics?.ledgerKeyState ?? LK_MISSING),
    canaryDraw: deps.economics?.canaryDraw ?? (() => randomInt(PERMILLE)),
  }
  const signing = epochsClose(econ.ledgerKeyState) && !!econ.ledgerKeyPem
  const statementPublicHex =
    signing && econ.ledgerKeyPem ? publicHexOf(econ.ledgerKeyPem) : null
  const nowEpoch = () => epochOf(Math.floor(nowMs() / 1000))
  const tierOfHost = (h: HostRow | undefined | null) => h?.tier ?? TIER_PUBLIC
  const knownOf = (job: JobRow) => (econ.sybil ? (job.knownHash ?? null) : null)
  const capOf = (h: HostRow) =>
    epochCap(h.tier, attested(econ.attested.has(h.id), ATTEST_NONE, false, 0))
  const secondsSince = (ms: number) =>
    Math.max(0, Math.floor((nowMs() - ms) / 1000))
  const skew = (utc: number) => Math.abs(Math.floor(nowMs() / 1000) - utc)

  /** The beat age of the incarnation a lease was given to. */
  const leaseBeatAge = (h: HostRow | undefined | null, l: LeaseRow) =>
    !h || h.incarnation !== l.incarnation
      ? SUPERSEDED_AGE
      : secondsSince(h.beatAt)

  // --- writes from a host ---------------------------------------------------

  async function admit(s: HostingTx, req: HostRequest): Promise<HostRow> {
    const id = req.header('x-trios-host') ?? ''
    const inc = Number(req.header('x-trios-inc'))
    const utc = Number(req.header('x-trios-ts'))
    if (!Number.isInteger(inc) || !Number.isInteger(utc))
      throw new HostingError('unsigned_request', 401)
    if (!requestFresh(skew(utc))) throw new HostingError('stale_request', 401)
    const host = await s.host(id)
    if (!host) throw new HostingError('unknown_host', 401)
    const message = messageOf(REQUEST_DOMAIN, REQUEST_SIGNED_FIELDS, {
      method: req.method,
      path: req.path,
      host: id,
      incarnation: inc,
      utc_unix: utc,
      body_sha256: sha256Hex(req.body),
    })
    if (!verifyHex(host.publicKey, message, req.header('x-trios-sig')))
      throw new HostingError('bad_signature', 401)
    // netlink section 2: a write from an incarnation that is over, or from a
    // lease that lapsed, is refused, and the host registers again.
    if (!hostWriteAdmitted(host.incarnation, inc, secondsSince(host.beatAt)))
      throw new HostingError('fenced', 409)
    host.beatAt = nowMs()
    await s.putHost(host)
    return host
  }

  async function register(body: unknown, origin: string) {
    const b = (body ?? {}) as Record<string, unknown>
    const publicKey = text(b.public_key, HEX64)
    const tierClaim = int(b.tier_claim, 255)
    const slots = int(b.slots, 1_000_000)
    const platform = text(b.platform, /^[a-z0-9-]{1,32}$/)
    const isolation = int(b.isolation, 255)
    const utc = int(b.utc_unix, Number.MAX_SAFE_INTEGER)
    if (
      publicKey === null ||
      tierClaim === null ||
      slots === null ||
      platform === null ||
      isolation === null ||
      utc === null
    )
      throw new HostingError('bad_registration', 400)
    if (!requestFresh(skew(utc))) throw new HostingError('stale_request', 401)
    const message = messageOf(REGISTER_DOMAIN, REGISTER_SIGNED_FIELDS, {
      public_key: publicKey,
      tier_claim: tierClaim,
      slots,
      platform,
      isolation,
      utc_unix: utc,
    })
    if (!verifyHex(publicKey, message, b.signature))
      throw new HostingError('bad_signature', 401)
    const id = keyIdOf(publicKey)
    return deps.store.tx(async (s) => {
      const prev = await s.host(id)
      if (prev && prev.publicKey !== publicKey)
        throw new HostingError('key_conflict', 409)
      const tier = tierOf(tierClaim, deps.allowlist.get(id) ?? ALLOW_NONE)
      const row: HostRow = {
        id,
        publicKey,
        tier,
        tierClaim,
        slots: slotsAdmitted(tier, slots),
        platform,
        isolation,
        origin,
        incarnation: nextIncarnation(prev?.incarnation ?? 0),
        beatAt: nowMs(),
        strikes: prev?.strikes ?? 0,
        registeredAt: nowMs(),
        agreed: prev?.agreed ?? 0,
      }
      // host.t27 section 4: the last incarnation is down for good. Its leases
      // carry its number, so the next sweep reads them as a host that beats
      // no more, and replica_lapsed places them again.
      await s.putHost(row)
      return {
        host: id,
        incarnation: row.incarnation,
        tier: TIER_WORDS[tier],
        slots: row.slots,
        isolation: ISOLATION_WORDS[isolation] ?? String(isolation),
        beat_seconds: NODE_HEARTBEAT_SECONDS,
        ttl_seconds: NODE_TTL_SECONDS,
      }
    })
  }

  async function beat(req: HostRequest, id: string) {
    return deps.store.tx(async (s) => {
      const host = await admit(s, req)
      if (host.id !== id) throw new HostingError('not_this_host', 403)
      return { ok: true, incarnation: host.incarnation }
    })
  }

  // --- placement --------------------------------------------------------------

  /** Lapse what the cards say is over, then decide each job again. */
  async function sweep(s: HostingTx) {
    const hosts = new Map((await s.hosts()).map((h) => [h.id, h]))
    for (const job of await s.openJobs()) {
      for (const l of await s.leasesOf(job.id)) {
        if (l.state !== 'out') continue
        const lapsed = replicaLapsed(
          leaseBeatAge(hosts.get(l.hostId), l),
          secondsSince(l.leasedAt),
        )
        if (!lapsed) continue
        l.state = 'lapsed'
        await s.putLease(l)
      }
      await settle(s, job)
    }
  }

  async function lease(req: HostRequest) {
    return deps.store.tx(async (s) => {
      const host = await admit(s, req)
      await closeEpochs(s)
      await sweep(s)
      const hosts = new Map((await s.hosts()).map((h) => [h.id, h]))
      const running = (await s.outLeasesOfHost(host.id)).length
      const candidates = await Promise.all(
        (await s.openJobs()).map(async (job) => {
          const leases = await s.leasesOf(job.id)
          return { job, leases, votes: leases.filter((l) => l.vote).length }
        }),
      )
      candidates.sort((a, b) => {
        const ageA = secondsSince(a.job.createdAt)
        const ageB = secondsSince(b.job.createdAt)
        const ab = jobFirst(a.votes, ageA, b.votes, ageB)
        const ba = jobFirst(b.votes, ageB, a.votes, ageA)
        if (ab && ba) return a.job.id < b.job.id ? -1 : 1
        return ab ? -1 : 1
      })
      // sybil.t27 canaries: a public host's lease is a known-answer job on a
      // draw it cannot see; an anchor host takes the jobs that need an anchor
      const isPublic = !anchors(host.tier)
      if (econ.sybil) {
        const knownFirst =
          isPublic && canaryDue(econ.canaryDraw(), CANARY_PERMILLE)
        const rank = (job: JobRow) => (!!knownOf(job) === knownFirst ? 0 : 1)
        candidates.sort((a, b) => rank(a.job) - rank(b.job))
      }
      for (const { job, leases, votes } of candidates) {
        if (econ.sybil && isPublic) {
          // the anchor's slot is never a public host's (sybil.t27)
          const publicIn = leases.filter(
            (l) =>
              (l.state === 'out' || l.vote) &&
              !anchors(tierOfHost(hosts.get(l.hostId))),
          ).length
          if (!publicMayTake(true, !!knownOf(job), publicIn)) continue
        }
        const outstanding = leases.filter((l) => l.state === 'out').length
        const open = openReplicas(job.wanted, outstanding, votes)
        const leasedBefore = leases.some((l) => l.hostId === host.id)
        // the job's other live leases and votes from this host's network,
        // each counted when the card says that holder's tier blocks it
        const blocking = leases.filter((l) => {
          const other = hosts.get(l.hostId)
          if (!other || other.id === host.id) return false
          if (l.state !== 'out' && !l.vote) return false
          return (
            other.origin === host.origin &&
            originBlocks(host.tier, other.tier, 1)
          )
        }).length
        const take = mayTakeHalf({
          half: job.half ?? HALF_REFERENCE,
          arch: archOf(host.platform),
          isolation: host.isolation ?? 0,
          tier: host.tier,
          workloadClass: job.workloadClass,
          holdsSecret: job.holdsSecret,
          holdsPersonal: job.holdsPersonal,
          beatAgeSeconds: 0,
          strikes: host.strikes,
          slots: host.slots,
          running,
        })
        const spread = spreadOk(host.tier, leasedBefore, blocking)
        if (!places(take, spread, open, job.leasesIssued)) continue
        const row: LeaseRow = {
          id: `l_${random(8)}`,
          jobId: job.id,
          hostId: host.id,
          incarnation: host.incarnation,
          nonce: random(LEASE_NONCE_BYTES),
          leasedAt: nowMs(),
          state: 'out',
          code: null,
          vote: false,
          outputHash: null,
          receipt: null,
          receivedAt: null,
        }
        job.leasesIssued += 1
        await s.putJob(job)
        await s.putLease(row)
        return {
          lease: row.id,
          nonce: row.nonce,
          run_bound_seconds: JOB_RUN_BOUND_SECONDS,
          job: jobPayload(job),
        }
      }
      return { lease: null }
    })
  }

  // --- receipts and agreement ---------------------------------------------------

  /** Decide the job from its votes (proof.t27), and credit or strike once it closes. */
  async function settle(s: HostingTx, job: JobRow): Promise<number> {
    if (job.state !== 'open') return job.verdict
    const leases = await s.leasesOf(job.id)
    const votes = leases
      .filter((l) => l.vote)
      .sort(
        (a, b) =>
          (a.receivedAt ?? 0) - (b.receivedAt ?? 0) ||
          (a.arrival ?? 0) - (b.arrival ?? 0),
      )
    const groups = new Map<string, LeaseRow[]>()
    for (const v of votes) {
      const key = v.outputHash ?? ''
      groups.set(key, [...(groups.get(key) ?? []), v])
    }
    // largest first; a tie keeps first arrival (Map order), which no verdict reads
    let ranked = [...groups.values()].sort((a, b) => b.length - a.length)
    const outstanding = leases.filter((l) => l.state === 'out').length
    const isExhausted = exhausted(job.leasesIssued, outstanding)
    let verdict: number
    if (econ.sybil) {
      // sybil.t27: only the group holding the anchor (a known answer, or an
      // owner or trusted host's vote) can agree; it is ranked first
      const hosts = new Map((await s.hosts()).map((h) => [h.id, h]))
      const known = knownOf(job)
      const anchorVote = (l: LeaseRow) =>
        anchors(tierOfHost(hosts.get(l.hostId)))
      const sizeOf = (hash: string, members: LeaseRow[]) =>
        members.length + (hash === known ? 1 : 0)
      const anchored = [...groups.entries()].filter(
        ([hash, members]) => hash === known || members.some(anchorVote),
      )
      if (known && !groups.has(known)) anchored.push([known, []])
      anchored.sort((a, b) => sizeOf(b[0], b[1]) - sizeOf(a[0], a[1]))
      const best = anchored[0]
      verdict = anchoredVerdict(
        known !== null || votes.some(anchorVote),
        best ? sizeOf(best[0], best[1]) : 0,
        votes.length,
        job.wanted,
        isExhausted,
      )
      if (best)
        ranked = [
          best[1],
          ...ranked.filter((g) => g[0]?.outputHash !== best[0]),
        ]
    } else {
      verdict = jobVerdict(
        votes.length,
        ranked[0]?.length ?? 0,
        ranked[1]?.length ?? 0,
        job.wanted,
        isExhausted,
      )
    }
    job.verdict = verdict
    job.wanted = wantedAfter(verdict, job.wanted)
    if (jobClosed(verdict)) await close(s, job, verdict, leases, ranked)
    await s.putJob(job)
    return verdict
  }

  /** A closed job: its open leases end, each vote is accounted, the result is kept. */
  async function close(
    s: HostingTx,
    job: JobRow,
    verdict: number,
    leases: LeaseRow[],
    ranked: LeaseRow[][],
  ) {
    job.state = verdict === JV_AGREED ? 'agreed' : 'unresolved'
    job.closedAt = nowMs()
    for (const l of leases) {
      if (l.state !== 'out') continue
      l.state = 'closed'
      await s.putLease(l)
    }
    const known = knownOf(job)
    // sybil.t27 rule 6 reads the tiers of each group's receipts, by arrival
    const hosts = econ.sybil
      ? new Map((await s.hosts()).map((h) => [h.id, h]))
      : null
    for (const [group, members] of ranked.entries()) {
      const tiers = members.map((l) => tierOfHost(hosts?.get(l.hostId)))
      for (const [index, l] of members.entries())
        await account(s, job, {
          hostId: l.hostId,
          lease: l.id,
          side: sideOf(verdict, group),
          tamper: false,
          wrongCanary:
            econ.sybil && canaryWrong(known !== null, l.outputHash === known),
          index,
          firstOfOperator: econ.sybil && operatorFirst(tiers, index),
        })
    }
    const top = ranked[0]?.[0]?.receipt
    if (verdict !== JV_AGREED || !top) return
    const stated = readNormalized(String(top.output ?? ''))
    job.result = {
      outputHash: String(top.output_hash),
      output: String(top.output ?? ''),
      word: String(top.verdict),
      tests: stated?.tests ?? 0,
      ops: Number(top.ops),
      hosts: (ranked[0] ?? []).map((l) => l.hostId),
    }
  }

  /** What a key earned in an epoch: its credits less its slashes (statement.t27). */
  async function earnedIn(s: HostingTx, hostId: string, epoch: number) {
    let earned = 0
    for (const r of await s.ledgerOfEpoch(epoch))
      if (r.hostId === hostId && (r.kind === LE_CREDIT || r.kind === LE_SLASH))
        earned = balanceAfterEntry(earned, r.feeKind, r.mtri)
    return earned
  }

  /**
   * credit.t27: one credit, one strike, one slash per (host, job), never more.
   * With the sybil rules: probation, the epoch cap, the slash, and one credit
   * per operator per job (sybil.t27 rule 6). Every row is named by
   * statement.t27's kind, in the epoch of its time.
   */
  async function account(s: HostingTx, job: JobRow, v: Vote) {
    const host = await s.host(v.hostId)
    const epoch = nowEpoch()
    const last = await s.lastStatement()
    if (last && !rowEpochOpen(epoch, nextToClose(true, last.epoch, 0), true))
      throw new HostingError('epoch_closed', 409)
    const credited = await s.ledgerHas(v.hostId, job.id, LE_CREDIT)
    const cap = host ? capOf(host) : 0n
    let earned = econ.sybil && host ? await earnedIn(s, v.hostId, epoch) : 0
    const mtri =
      econ.sybil && host
        ? operatorCredit(
            v.firstOfOperator === true,
            v.side,
            credited,
            host.agreed ?? 0,
            earned,
            cap,
          )
        : creditMtri(v.side, false, credited)
    const row = { hostId: v.hostId, jobId: job.id, epoch, receipt: v.lease }
    if (mtri > 0 && rowAdmitted(LE_CREDIT, credited)) {
      const feeKind = shardKind(knownOf(job) !== null, v.index)
      await s.addLedger({ ...row, kind: LE_CREDIT, mtri, at: nowMs(), feeKind })
      earned = balanceAfterEntry(earned, feeKind, mtri)
    }
    const agreed = !!host && v.side === SIDE_AGREED
    if (host && agreed) host.agreed = (host.agreed ?? 0) + 1
    const struckNow = await penalize(s, host, v, row, earned, cap)
    if (host && (agreed || struckNow)) await s.putHost(host)
  }

  /** The strike and, with the sybil rules, the slash one vote is due. */
  async function penalize(
    s: HostingTx,
    host: HostRow | null,
    v: Vote,
    row: {
      hostId: string
      jobId: string
      epoch: number
      receipt: string | null
    },
    earned: number,
    cap: bigint,
  ): Promise<boolean> {
    let changed = false
    const struckBefore = await s.ledgerHas(v.hostId, row.jobId, LE_STRIKE)
    const strike =
      strikeDue(v.tamper, v.side, struckBefore) ||
      (econ.sybil && struck(v.wrongCanary, v.side, struckBefore))
    if (strike && rowAdmitted(LE_STRIKE, struckBefore)) {
      await s.addLedger({
        ...row,
        kind: LE_STRIKE,
        mtri: 0,
        at: nowMs(),
        feeKind: 0,
      })
      if (host) {
        host.strikes += 1
        changed = true
      }
    }
    if (econ.sybil && host) {
      const slashedBefore = await s.ledgerHas(v.hostId, row.jobId, LE_SLASH)
      if (
        slashDue(v.wrongCanary, v.side, slashedBefore) &&
        rowAdmitted(LE_SLASH, slashedBefore)
      )
        await s.addLedger({
          ...row,
          kind: LE_SLASH,
          mtri: slashMtri(earned, cap),
          at: nowMs(),
          feeKind: ENTRY_SLASH,
        })
    }
    return changed
  }

  // --- epoch statements (statement.t27) ----------------------------------------

  /** Close every epoch past its end, in order, once each, and sign it. */
  async function closeEpochs(s: HostingTx) {
    const key = econ.ledgerKeyPem
    if (!signing || !key) return
    if (settlementGateOpen(false, CHAIN_OF_RECORD))
      throw new Error('statement.t27 opened settlement; this Queen has none')
    for (let i = 0; i < CLOSES_PER_CALL_MAX; i++) {
      const last = await s.lastStatement()
      const first = await s.firstLedgerEpoch()
      const next = nextToClose(last !== null, last?.epoch ?? 0, first ?? 0)
      if (!epochCloses(next, next, nowEpoch(), first !== null, last !== null))
        return
      const rows = await s.ledgerOfEpoch(next)
      const leaves = leavesOf(next, rows)
      const root = rootOf(leaves.map((l) => leafHashOf(leafText(l)))).toString(
        'hex',
      )
      let credit = 0
      let slash = 0
      for (const r of rows) {
        if (!leafKindKnown(r.feeKind)) continue
        if (r.feeKind === ENTRY_SLASH) slash += r.mtri
        else credit += r.mtri
      }
      const message = statementText({
        epoch: next,
        from_unix: epochFrom(next),
        to_unix: epochTo(next),
        leaves: leaves.length,
        root,
        prev: last ? statementHash(last.message) : GENESIS_PREV,
        credit_mtri: credit,
        slash_mtri: slash,
        chain: CHAIN_WORD,
        settlement: SETTLEMENT_SHUT_WORD,
        transferable: CREDIT_TRANSFERABLE,
      })
      await s.putStatement({
        epoch: next,
        message,
        signature: signStatement(key, message),
        root,
        leaves,
        closedAt: nowMs(),
      })
    }
  }

  /**
   * THE LEDGER'S WRITE PATH FOR WORK THAT IS NOT A SHARD (trios#1761). A
   * source in this process that judged a run itself, such as the network
   * MVP's job card over two t27b lab receipts (specs/network/mvp.t27),
   * records its credit here instead of keeping a second ledger:
   *   source   who judged it, lowercase ('lab'); 'hosting' is the shards'
   *   key      the credited key id: KEY_ID_HEX_LEN hex of SHA-256 of an
   *            Ed25519 public key, e.g. a lab signer's id from .trinity/keys.
   *            It need not be a joined host.
   *   job      the job or run the credit is for: one row per (key, job, kind)
   *   kind     a statement.t27 leaf kind: EXECUTOR_FEE, PROVIDER_FEE or
   *            VERIFIER_FEE, or ENTRY_SLASH for a slash
   *   mtri     the amount, as the source's own spec priced it
   *   receipt  the id of the signed receipt behind it
   * The row lands in the current epoch, and in that epoch's statement leaf
   * (key, kind, amount, receipt ids) exactly as a shard's does. Nothing here
   * moves value; a slash only records a forfeit.
   */
  async function recordWork(w: {
    source: string
    key: string
    job: string
    kind: number
    mtri: number
    receipt: string
  }) {
    const printable = /^[\x21-\x7e]{1,128}$/
    if (
      !/^[a-z][a-z0-9-]{1,31}$/.test(w.source) ||
      w.source === 'hosting' ||
      !/^[0-9a-f]{16}$/.test(w.key) ||
      !printable.test(w.job) ||
      !printable.test(w.receipt) ||
      !Number.isSafeInteger(w.mtri) ||
      w.mtri < 0 ||
      !leafKindKnown(w.kind)
    )
      throw new HostingError('bad_work', 400)
    const ledgerKind = w.kind === ENTRY_SLASH ? LE_SLASH : LE_CREDIT
    return deps.store.tx(async (s) => {
      await closeEpochs(s)
      const epoch = nowEpoch()
      const last = await s.lastStatement()
      if (last && !rowEpochOpen(epoch, nextToClose(true, last.epoch, 0), true))
        throw new HostingError('epoch_closed', 409)
      const exists = await s.ledgerHas(w.key, w.job, ledgerKind)
      if (!rowAdmitted(ledgerKind, exists)) return { recorded: false, epoch }
      await s.addLedger({
        hostId: w.key,
        jobId: w.job,
        kind: ledgerKind,
        mtri: w.mtri,
        at: nowMs(),
        feeKind: w.kind,
        epoch,
        receipt: w.receipt,
        source: w.source,
      })
      return { recorded: true, epoch }
    })
  }

  async function epochs() {
    return deps.store.tx(async (s) => {
      await closeEpochs(s)
      return {
        unit: 'mTRI',
        // without the ledger key every epoch stays open and unsigned
        signed: signing,
        ledger_key: LEDGER_KEY_WORDS[econ.ledgerKeyState] ?? 'missing',
        chain_of_record: CHAIN_WORD,
        settlement: SETTLEMENT_SHUT_WORD,
        transferable: CREDIT_TRANSFERABLE,
        epoch_seconds: EPOCH_SECONDS,
        queen_key: statementPublicHex,
        epochs: (await s.statements()).map((r) => ({
          ...statementFields(r.message),
          signature: r.signature,
        })),
      }
    })
  }

  /** One epoch's statement, and this key's leaves in it with their paths. */
  async function epochProof(epochParam: string, key: string | undefined) {
    if (!signing) throw new HostingError('ledger_key_missing', 503)
    const epoch = Number(epochParam)
    if (
      !Number.isSafeInteger(epoch) ||
      epoch < 0 ||
      !/^[0-9a-f]{16}$/.test(key ?? '')
    )
      throw new HostingError('bad_proof_request', 400)
    return deps.store.tx(async (s) => {
      await closeEpochs(s)
      const row = await s.statement(epoch)
      if (!row) throw new HostingError('no_such_epoch', 404)
      return {
        epoch,
        queen_key: statementPublicHex,
        ...proofOf(row, key as string),
      }
    })
  }

  /**
   * What one receipt costs its signer before any quorum: a strike for a
   * tampered one (proof.t27), and with the sybil rules a slash and a strike
   * for a wrong answer to a known answer (sybil.t27).
   */
  async function accountReceipt(
    s: HostingTx,
    job: JobRow,
    hostId: string,
    lease: string | null,
    f: { tamper: boolean; wrongCanary: boolean },
  ) {
    if (f.tamper)
      await account(s, job, {
        hostId,
        lease,
        side: SIDE_NONE,
        tamper: true,
        wrongCanary: false,
        index: 0,
      })
    if (f.wrongCanary)
      await account(s, job, {
        hostId,
        lease,
        side: SIDE_NONE,
        tamper: false,
        wrongCanary: true,
        index: 0,
      })
  }

  async function receipt(body: unknown) {
    const r = (body ?? {}) as Record<string, unknown>
    if (typeof r.output !== 'string' || r.output.length > MAX_OUTPUT_BYTES)
      throw new HostingError('bad_receipt', 400)
    let message: string
    try {
      message = messageOf(RECEIPT_DOMAIN, RECEIPT_SIGNED_FIELDS, r)
    } catch {
      throw new HostingError('bad_receipt', 400)
    }
    return deps.store.tx(async (s) => {
      await closeEpochs(s)
      await sweep(s)
      const host = await s.host(String(r.host))
      const lease = await s.lease(String(r.lease))
      const job = lease ? await s.job(lease.jobId) : null
      const facts = receiptFacts(r, message, host, lease, job)
      const code = receiptCode(facts)
      const half = job?.half ?? HALF_REFERENCE
      const verdictCode = halfWords(half).indexOf(r.verdict as never)
      const vote = halfVote(code, half, verdictCode < 0 ? 255 : verdictCode)
      if (
        lease &&
        facts.leased &&
        !facts.reportedBefore &&
        lease.state === 'out'
      ) {
        lease.state = 'reported'
        lease.code = code
        lease.vote = vote
        lease.outputHash = String(r.output_hash)
        lease.receipt = r
        lease.receivedAt = nowMs()
        // the order receipts arrived in, under the store's lock: two receipts
        // in one millisecond still have one first (statement.t27 shard_kind)
        lease.arrival =
          (await s.leasesOf(lease.jobId)).filter((l) => l.receipt !== null)
            .length + 1
        await s.putLease(lease)
      }
      if (host && job)
        await accountReceipt(s, job, host.id, lease?.id ?? null, {
          tamper: attributable(code),
          wrongCanary:
            vote &&
            knownOf(job) !== null &&
            canaryWrong(true, String(r.output_hash) === knownOf(job)),
        })
      const verdict =
        job && job.state === 'open'
          ? await settle(s, job)
          : (job?.verdict ?? JV_PENDING)
      return {
        code: RECEIPT_CODE_WORDS[code] ?? String(code),
        accepted: vote,
        tampered: tampered(code),
        job: job
          ? {
              id: job.id,
              verdict: JOB_VERDICT_WORDS[verdict] ?? String(verdict),
            }
          : null,
      }
    })
  }

  // --- jobs, owner only -------------------------------------------------------

  async function createJob(req: HostRequest) {
    const b = (() => {
      try {
        return JSON.parse(req.body || '{}') as Record<string, unknown>
      } catch {
        throw new HostingError('bad_job', 400)
      }
    })()
    const commit = text(b.commit, HEX40)
    const spec = specPath(b.spec)
    const inputHash = text(b.input_hash, HEX64)
    const modelHash =
      b.model_hash === undefined || b.model_hash === null
        ? null
        : text(b.model_hash, HEX64)
    // sybil.t27: a known answer (a lab row). Not in the id, never in a payload.
    const knownHash =
      b.known_output_hash === undefined || b.known_output_hash === null
        ? null
        : text(b.known_output_hash, HEX64)
    const files: JobFile[] = Array.isArray(b.files)
      ? b.files.map((f) => ({
          path: specPath((f as JobFile)?.path) ?? '',
          sha256: text((f as JobFile)?.sha256, HEX64) ?? '',
        }))
      : []
    // host.t27 section 2: a workload must carry both declarations
    if (
      typeof b.holds_secret !== 'boolean' ||
      typeof b.holds_personal !== 'boolean'
    )
      throw new HostingError('undeclared_workload', 400)
    if (
      !commit ||
      !spec ||
      !inputHash ||
      (b.model_hash !== undefined && b.model_hash !== null && !modelHash) ||
      (b.known_output_hash !== undefined &&
        b.known_output_hash !== null &&
        !knownHash) ||
      files.length === 0 ||
      files.length > 512 ||
      files.some((f) => !f.path || !f.sha256) ||
      !files.some((f) => f.path === spec && f.sha256 === inputHash)
    )
      throw new HostingError('bad_job', 400)
    // slice 1 runs shards only; a service needs slice 2's tunnel
    if (b.workload_class !== undefined && b.workload_class !== WC_SHARD)
      throw new HostingError('shards_only', 400)
    // row.t27: the reference half unless the job names another
    const half = b.half === undefined ? HALF_REFERENCE : int(b.half, HALVES - 1)
    if (half === null) throw new HostingError('bad_job', 400)
    const sorted = [...files].sort((x, y) => (x.path < y.path ? -1 : 1))
    const id = `j_${sha256Hex(
      JSON.stringify([
        commit,
        spec,
        inputHash,
        sorted,
        modelHash,
        b.holds_secret,
        b.holds_personal,
        half,
      ]),
    ).slice(0, 16)}`
    return deps.store.tx(async (s) => {
      const owner = await admit(s, req)
      if (owner.tier !== TIER_OWNER) throw new HostingError('owner_only', 403)
      const existing = await s.job(id)
      if (existing) {
        if (knownHash && !existing.knownHash && existing.state === 'open') {
          existing.knownHash = knownHash
          await s.putJob(existing)
        }
        return { job: jobPayload(existing), created: false }
      }
      const row: JobRow = {
        id,
        kind: 'shard',
        half,
        commit,
        spec,
        inputHash,
        files: sorted,
        modelHash,
        workloadClass: WC_SHARD,
        holdsSecret: b.holds_secret as boolean,
        holdsPersonal: b.holds_personal as boolean,
        wanted: econ.sybil ? replicasWanted(knownHash !== null) : REPLICAS_K,
        leasesIssued: 0,
        knownHash,
        state: 'open',
        verdict: JV_PENDING,
        createdAt: nowMs(),
        closedAt: null,
        result: null,
      }
      await s.putJob(row)
      return { job: jobPayload(row), created: true }
    })
  }

  // --- reads ------------------------------------------------------------------

  /** The public ledger: key ids, tiers, balances, strikes. No address, origin or key. */
  async function ledger() {
    return deps.store.tx(async (s) => {
      await closeEpochs(s)
      const rows = await s.ledger()
      const hosts = (await s.hosts()).map((h) => {
        const mine = rows.filter((r) => r.hostId === h.id)
        let balance = 0
        for (const r of mine)
          if (r.kind === LE_CREDIT || r.kind === LE_SLASH)
            balance = balanceAfterEntry(balance, r.feeKind, r.mtri)
        const cap = capOf(h)
        return {
          host: h.id,
          tier: TIER_WORDS[h.tier] ?? 'public',
          balance_mtri: balance,
          credited_jobs: mine.filter((r) => r.kind === LE_CREDIT).length,
          strikes: h.strikes,
          slashes: mine.filter((r) => r.kind === LE_SLASH).length,
          agreed: h.agreed ?? 0,
          probation: econ.sybil && onProbation(h.agreed ?? 0),
          attested: econ.attested.has(h.id),
          // the owner's cap is u64 max: shown as null, not as a rounded number
          epoch_cap_mtri: !econ.sybil || cap >= 2n ** 63n ? null : Number(cap),
          suspended: suspended(h.strikes),
          settlement_due: settlementDue(
            balance,
            SETTLEMENT_ENABLED,
            false,
            false,
          ),
        }
      })
      return {
        unit: 'mTRI',
        off_chain: true,
        transferable: CREDIT_TRANSFERABLE,
        token_value_claimed: TOKEN_VALUE_CLAIMED,
        settlement: {
          enabled: SETTLEMENT_ENABLED,
          threshold_mtri: SETTLE_THRESHOLD_MTRI,
          chain_of_record: CHAIN_WORD,
        },
        sybil: {
          on: econ.sybil,
          canary_permille: CANARY_PERMILLE,
          probation_jobs: PROBATION_JOBS,
        },
        hosts,
        rows: rows.map((r) => ({
          seq: r.seq,
          host: r.hostId,
          job: r.jobId,
          kind: LEDGER_KIND_WORDS[r.kind] ?? String(r.kind),
          fee_kind: KIND_WORDS[r.feeKind] || null,
          mtri: r.mtri,
          epoch: r.epoch,
          receipt: r.receipt,
          source: r.source ?? 'hosting',
          at: new Date(r.at).toISOString(),
        })),
      }
    })
  }

  /**
   * The lab's rows (row.t27): for each spec at a commit, its two halves, and a
   * row once both are agreed (row_complete), in run.json's row shape, keys in
   * the lab's order, with each half's output digest and agreeing hosts.
   */
  async function verdicts(commit?: string) {
    return deps.store.tx(async (s) => {
      const halves = new Map<string, Array<JobRow | undefined>>()
      for (const j of await s.jobs()) {
        if (commit && j.commit !== commit) continue
        const key = `${j.commit} ${j.spec}`
        const pair = halves.get(key) ?? [undefined, undefined]
        pair[j.half ?? HALF_REFERENCE] = j
        halves.set(key, pair)
      }
      const rows: Array<Record<string, unknown>> = []
      for (const [ref, t27b] of halves.values()) {
        if (!ref?.result || !t27b?.result) continue
        if (!rowComplete(ref.verdict, t27b.verdict)) continue
        const a = readNormalized(ref.result.output ?? '')
        const b = readNormalized(t27b.result.output ?? '')
        if (!a || !b) continue
        rows.push({
          commit: ref.commit,
          ...assembleRow(ref.spec, a, b),
          input_sha256: ref.inputHash,
          halves: Object.fromEntries(
            [ref, t27b].map((j) => [
              HALF_WORDS[j.half ?? HALF_REFERENCE],
              {
                job: j.id,
                output_sha256: j.result?.outputHash,
                hosts: j.result?.hosts,
              },
            ]),
          ),
        })
      }
      return rows
    })
  }

  async function job(id: string) {
    return deps.store.tx(async (s) => {
      const row = await s.job(id)
      if (!row) throw new HostingError('no_such_job', 404)
      const leases = await s.leasesOf(id)
      return {
        ...jobPayload(row),
        state: row.state,
        verdict: JOB_VERDICT_WORDS[row.verdict] ?? String(row.verdict),
        wanted: row.wanted,
        leases_issued: row.leasesIssued,
        leases: leases.map((l) => ({
          lease: l.id,
          host: l.hostId,
          state: l.state,
          code: l.code === null ? null : RECEIPT_CODE_WORDS[l.code],
          vote: l.vote,
          output_sha256: l.outputHash,
        })),
        result: row.result,
      }
    })
  }

  return {
    register,
    beat,
    lease,
    receipt,
    createJob,
    ledger,
    verdicts,
    job,
    epochs,
    epochProof,
    recordWork,
  }
}

export type HostingQueen = ReturnType<typeof createHostingQueen>

/** What proof.t27 receipt_code reads, from the receipt and the rows it names. */
function receiptFacts(
  r: Record<string, unknown>,
  message: string,
  host: HostRow | null,
  lease: LeaseRow | null,
  job: JobRow | null,
) {
  const leased =
    !!lease &&
    !!job &&
    lease.hostId === r.host &&
    lease.jobId === r.job &&
    lease.incarnation === r.incarnation &&
    lease.nonce === r.nonce
  const reportedBefore = leased && lease.receipt !== null
  const stated = readNormalized(String(r.output))
  return {
    hostKnown: !!host,
    signatureOk: !!host && verifyHex(host.publicKey, message, r.signature),
    leased,
    reportedBefore,
    // WHY CANONICAL: Postgres keeps the receipt as jsonb, which reorders its
    // keys; a byte-for-byte retry read back from it is not the same string,
    // and was judged equivocation (tampered, and struck) on the live store
    // while the memory twin, which keeps key order, said duplicate (#1761).
    sameAsBefore:
      reportedBefore && canonicalJson(lease.receipt) === canonicalJson(r),
    lapsed: leased && lease.state !== 'out',
    inputMatches:
      !!job &&
      r.commit === job.commit &&
      r.spec === job.spec &&
      r.input_hash === job.inputHash,
    modelMatches: !job?.modelHash || r.model_hash === job.modelHash,
    outputRehashes:
      sha256Hex(String(r.output)) === r.output_hash &&
      stated?.half === (job?.half ?? HALF_REFERENCE) &&
      stated?.word === r.verdict &&
      stated?.ops === r.ops &&
      stated?.spec === r.spec,
  }
}

/** JSON with every object's keys sorted, so two encodings of one value compare equal. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

function jobPayload(j: JobRow) {
  return {
    id: j.id,
    kind: j.kind,
    half: j.half ?? HALF_REFERENCE,
    commit: j.commit,
    spec: j.spec,
    input_hash: j.inputHash,
    files: j.files,
    model_hash: j.modelHash,
    holds_secret: j.holdsSecret,
    holds_personal: j.holdsPersonal,
  }
}

/** The owner's allowlist from `<key id>=<owner|trusted|public>,...`. */
export function parseAllowlist(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>()
  for (const part of (raw ?? '').split(',')) {
    const [id, word] = part.trim().split('=')
    const tier = TIER_WORDS.indexOf((word ?? '').trim() as never)
    if (id && /^[0-9a-f]{16}$/.test(id.trim()) && tier >= 0)
      out.set(id.trim(), tier)
  }
  return out
}
