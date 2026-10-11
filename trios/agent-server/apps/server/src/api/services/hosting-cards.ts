/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The self-hosting cards (gHashTag/trios#1756): every decision the Queen and
 * the host agent make about hosts, placement, receipts and credit, called
 * here and nowhere restated. The specs are gHashTag/t27 specs/hosting/*.t27,
 * vendored byte-identical under specs/hosting with their wasm (specs/PIN).
 *
 *   host.t27       tiers, eligibility, capacity, the netlink lease, freshness,
 *                  strikes, the toolchain action, isolation
 *   placement.t27  fit, spread, k replicas, the lease that lapses, which
 *                  host runs which half of a lab row
 *   proof.t27      the shard's verdict and reason, the receipt's checks,
 *                  k-of-n agreement
 *   credit.t27     credit, strikes, the ledger, settlement (off)
 *   row.t27        the lab row's two halves, the t27b half's verdict, and
 *                  how a row is assembled from both
 *   sybil.t27      slice 1b: the anchored quorum, canaries, probation, the
 *                  per-key cap, attestation, the slash; and the simulation
 *   statement.t27  slice 1b: the kind each credit is paid as, epochs, the
 *                  leaf, the inclusion proof's shape, the settlement gate
 *
 * WHY A LOCATOR: the Queen reads the cards from specs/ on disk; the compiled
 * host agent carries them inside its binary (`bun build --compile`) and points
 * the locator at the embedded files once, before the first call.
 */

import { basename, dirname } from 'node:path'
import { type CardWasm, flag, loadCardWasm, u32, u64 } from './queen-card-wasm'
import { TIER_PUBLIC } from './queen-hosting-host-card.gen'

export const HOSTING_CARDS = {
  host: 'hosting/host.wasm',
  proof: 'hosting/proof.wasm',
  placement: 'hosting/placement.wasm',
  credit: 'hosting/credit.wasm',
  row: 'hosting/row.wasm',
  sybil: 'hosting/sybil.wasm',
  statement: 'hosting/statement.wasm',
} as const

export type HostingCardName = keyof typeof HOSTING_CARDS

let locate = (name: HostingCardName): CardWasm =>
  loadCardWasm(HOSTING_CARDS[name])

/** The host agent's binary: each card at the path its bundler gave it. */
export function useHostingCardFiles(
  files: Record<HostingCardName, string>,
): void {
  locate = (name) => loadCardWasm(basename(files[name]), dirname(files[name]))
}

const host = () => locate('host')
const proof = () => locate('proof')
const placement = () => locate('placement')
const credit = () => locate('credit')
const row = () => locate('row')
const sybil = () => locate('sybil')
const statement = () => locate('statement')
const yes = (n: number | bigint) => Number(n) !== 0

// --- host.t27 ---------------------------------------------------------------

export const tierOf = (claimed: number, allowed: number): number =>
  host().call('tier_of', claimed & 0xff, allowed & 0xff) >>> 0

export const eligible = (
  tier: number,
  workloadClass: number,
  holdsSecret: boolean,
  holdsPersonal: boolean,
): boolean =>
  yes(
    host().call(
      'eligible',
      tier & 0xff,
      workloadClass & 0xff,
      flag(holdsSecret),
      flag(holdsPersonal),
    ),
  )

export const slotsAdmitted = (tier: number, claimed: number): number =>
  host().call('slots_admitted', tier & 0xff, u32(claimed)) >>> 0

export const hasRoom = (slots: number, running: number): boolean =>
  yes(host().call('has_room', u32(slots), u32(running)))

export const hostUp = (beatAgeSeconds: number): boolean =>
  yes(host().call('host_up', u32(beatAgeSeconds)))

export const nextIncarnation = (prev: number): number =>
  Number(host().call64('next_incarnation', u64(prev)))

export const hostWriteAdmitted = (
  rowInc: number,
  writerInc: number,
  beatAgeSeconds: number,
): boolean =>
  yes(
    host().call64(
      'host_write_admitted',
      u64(rowInc),
      u64(writerInc),
      u32(beatAgeSeconds),
    ),
  )

export const mustRegisterAgain = (
  refused: boolean,
  secondsSinceConfirmed: number,
): boolean =>
  yes(
    host().call(
      'must_register_again',
      flag(refused),
      u32(secondsSinceConfirmed),
    ),
  )

export const requestFresh = (skewSeconds: number): boolean =>
  yes(host().call('request_fresh', u32(skewSeconds)))

export const suspended = (strikes: number): boolean =>
  yes(host().call('suspended', u32(strikes)))

export const toolchainAction = (pinned: boolean, localGiven: boolean): number =>
  host().call('toolchain_action', flag(pinned), flag(localGiven)) >>> 0

export const isolationRequired = (
  workloadClass: number,
  holdsSecret: boolean,
  holdsPersonal: boolean,
): number =>
  host().call(
    'isolation_required',
    workloadClass & 0xff,
    flag(holdsSecret),
    flag(holdsPersonal),
  ) >>> 0

export const isolationMeets = (have: number, need: number): boolean =>
  yes(host().call('isolation_meets', have & 0xff, need & 0xff))

export interface SandboxFacts {
  macos: boolean
  hasSandboxExec: boolean
  hasBwrap: boolean
  hasUnshare: boolean
  turnedOff: boolean
}

export const sandboxChoice = (f: SandboxFacts): number =>
  host().call(
    'sandbox_choice',
    flag(f.macos),
    flag(f.hasSandboxExec),
    flag(f.hasBwrap),
    flag(f.hasUnshare),
    flag(f.turnedOff),
  ) >>> 0

export const isolationOf = (
  sandbox: number,
  connectFailed: boolean,
  writeFailed: boolean,
): number =>
  host().call(
    'isolation_of',
    sandbox & 0xff,
    flag(connectFailed),
    flag(writeFailed),
  ) >>> 0

export const downloadKept = (
  digestMatches: boolean,
  sizeMatches: boolean,
): boolean =>
  yes(host().call('download_kept', flag(digestMatches), flag(sizeMatches)))

// --- placement.t27 ----------------------------------------------------------

export interface TakeFacts {
  tier: number
  workloadClass: number
  holdsSecret: boolean
  holdsPersonal: boolean
  beatAgeSeconds: number
  strikes: number
  slots: number
  running: number
}

export const mayTake = (f: TakeFacts): boolean =>
  yes(
    placement().call(
      'may_take',
      f.tier & 0xff,
      f.workloadClass & 0xff,
      flag(f.holdsSecret),
      flag(f.holdsPersonal),
      u32(f.beatAgeSeconds),
      u32(f.strikes),
      u32(f.slots),
      u32(f.running),
    ),
  )

export const originBlocks = (
  tier: number,
  otherTier: number,
  sameOrigin: number,
): boolean =>
  yes(
    placement().call(
      'origin_blocks',
      tier & 0xff,
      otherTier & 0xff,
      u32(sameOrigin),
    ),
  )

export const spreadOk = (
  tier: number,
  leasedBefore: boolean,
  sameOriginPublic: number,
): boolean =>
  yes(
    placement().call(
      'spread_ok',
      tier & 0xff,
      flag(leasedBefore),
      u32(sameOriginPublic),
    ),
  )

export const openReplicas = (
  wanted: number,
  outstanding: number,
  votes: number,
): number =>
  placement().call(
    'open_replicas',
    u32(wanted),
    u32(outstanding),
    u32(votes),
  ) >>> 0

export const exhausted = (leasesIssued: number, outstanding: number): boolean =>
  yes(placement().call('exhausted', u32(leasesIssued), u32(outstanding)))

export const places = (
  mayTakeIt: boolean,
  spreadIsOk: boolean,
  open: number,
  leasesIssued: number,
): boolean =>
  yes(
    placement().call(
      'places',
      flag(mayTakeIt),
      flag(spreadIsOk),
      u32(open),
      u32(leasesIssued),
    ),
  )

export const jobFirst = (
  aVotes: number,
  aAgeSeconds: number,
  bVotes: number,
  bAgeSeconds: number,
): boolean =>
  yes(
    placement().call(
      'job_first',
      u32(aVotes),
      u32(aAgeSeconds),
      u32(bVotes),
      u32(bAgeSeconds),
    ),
  )

export const halfFits = (half: number, arch: number): boolean =>
  yes(placement().call('half_fits', half & 0xff, arch & 0xff))

export interface HalfTakeFacts extends TakeFacts {
  half: number
  arch: number
  isolation: number
}

export const mayTakeHalf = (f: HalfTakeFacts): boolean =>
  yes(
    placement().call(
      'may_take_half',
      f.half & 0xff,
      f.arch & 0xff,
      f.isolation & 0xff,
      f.tier & 0xff,
      f.workloadClass & 0xff,
      flag(f.holdsSecret),
      flag(f.holdsPersonal),
      u32(f.beatAgeSeconds),
      u32(f.strikes),
      u32(f.slots),
      u32(f.running),
    ),
  )

export const replicaLapsed = (
  beatAgeSeconds: number,
  runAgeSeconds: number,
): boolean =>
  yes(
    placement().call('replica_lapsed', u32(beatAgeSeconds), u32(runAgeSeconds)),
  )

// --- proof.t27 --------------------------------------------------------------

export const reportVerdict = (
  blockedLine: boolean,
  hasCounts: boolean,
  fail: number,
): number =>
  proof().call(
    'report_verdict',
    flag(blockedLine),
    flag(hasCounts),
    u32(fail),
  ) >>> 0

export interface RunFacts {
  started: boolean
  outOfResources: boolean
  timedOut: boolean
  exitedZero: boolean
  report: number
}

export const runVerdict = (f: RunFacts): number =>
  proof().call(
    'run_verdict',
    flag(f.started),
    flag(f.outOfResources),
    flag(f.timedOut),
    flag(f.exitedZero),
    f.report & 0xff,
  ) >>> 0

export const listsTests = (verdict: number): boolean =>
  yes(proof().call('lists_tests', verdict & 0xff))

export const reasonOf = (
  verdict: number,
  exitedZero: boolean,
  blockedLine: boolean,
): number =>
  proof().call(
    'reason_of',
    verdict & 0xff,
    flag(exitedZero),
    flag(blockedLine),
  ) >>> 0

export const reasonKept = (namesJobDir: boolean): boolean =>
  yes(proof().call('reason_kept', flag(namesJobDir)))

export interface ReceiptFacts {
  hostKnown: boolean
  signatureOk: boolean
  leased: boolean
  reportedBefore: boolean
  sameAsBefore: boolean
  lapsed: boolean
  inputMatches: boolean
  modelMatches: boolean
  outputRehashes: boolean
}

export const receiptCode = (f: ReceiptFacts): number =>
  proof().call(
    'receipt_code',
    flag(f.hostKnown),
    flag(f.signatureOk),
    flag(f.leased),
    flag(f.reportedBefore),
    flag(f.sameAsBefore),
    flag(f.lapsed),
    flag(f.inputMatches),
    flag(f.modelMatches),
    flag(f.outputRehashes),
  ) >>> 0

export const tampered = (code: number): boolean =>
  yes(proof().call('tampered', code & 0xff))

export const attributable = (code: number): boolean =>
  yes(proof().call('attributable', code & 0xff))

export const isVote = (code: number, verdict: number): boolean =>
  yes(proof().call('is_vote', code & 0xff, verdict & 0xff))

export const jobVerdict = (
  votes: number,
  top: number,
  second: number,
  wanted: number,
  isExhausted: boolean,
): number =>
  proof().call(
    'job_verdict',
    u32(votes),
    u32(top),
    u32(second),
    u32(wanted),
    flag(isExhausted),
  ) >>> 0

export const wantedAfter = (verdict: number, wanted: number): number =>
  proof().call('wanted_after', verdict & 0xff, u32(wanted)) >>> 0

export const jobClosed = (verdict: number): boolean =>
  yes(proof().call('job_closed', verdict & 0xff))

export const sideOf = (verdict: number, group: number): number =>
  proof().call('side_of', verdict & 0xff, u32(group)) >>> 0

// --- credit.t27 -------------------------------------------------------------

export const creditMtri = (
  side: number,
  deviceBound: boolean,
  alreadyCredited: boolean,
): number =>
  Number(
    credit().call64(
      'credit_mtri',
      side & 0xff,
      flag(deviceBound),
      flag(alreadyCredited),
    ),
  )

export const strikeDue = (
  attributableTamper: boolean,
  side: number,
  alreadyStruck: boolean,
): boolean =>
  yes(
    credit().call(
      'strike_due',
      flag(attributableTamper),
      side & 0xff,
      flag(alreadyStruck),
    ),
  )

export const rowAdmitted = (kind: number, exists: boolean): boolean =>
  yes(credit().call('row_admitted', kind & 0xff, flag(exists)))

export const balanceAfter = (balance: number, add: number): number =>
  Number(credit().call64('balance_after', u64(balance), u64(add)))

export const settlementDue = (
  balanceMtri: number,
  enabled: boolean,
  legalCleared: boolean,
  deviceBound: boolean,
): boolean =>
  yes(
    credit().call64(
      'settlement_due',
      u64(balanceMtri),
      flag(enabled),
      flag(legalCleared),
      flag(deviceBound),
    ),
  )

// --- row.t27 ----------------------------------------------------------------

export const t27bRunVerdict = (
  started: boolean,
  wroteRow: boolean,
  word: number,
): number =>
  row().call('t27b_run_verdict', flag(started), flag(wroteRow), word & 0xff) >>>
  0

export const t27bVotes = (verdict: number): boolean =>
  yes(row().call('t27b_votes', verdict & 0xff))

export const halfVote = (
  code: number,
  half: number,
  verdict: number,
): boolean =>
  yes(row().call('half_vote', code & 0xff, half & 0xff, verdict & 0xff))

export const rowComplete = (reference: number, t27b: number): boolean =>
  yes(row().call('row_complete', reference & 0xff, t27b & 0xff))

export const detailKind = (referenceVerdict: number): number =>
  row().call('detail_kind', referenceVerdict & 0xff) >>> 0

export const referenceTestsListed = (
  referenceVerdict: number,
  listed: number,
  tests: number,
): boolean =>
  yes(
    row().call(
      'reference_tests_listed',
      referenceVerdict & 0xff,
      u32(listed),
      u32(tests),
    ),
  )

export const disagreeListed = (
  t27bListed: boolean,
  referenceListed: boolean,
): boolean =>
  yes(row().call('disagree_listed', flag(t27bListed), flag(referenceListed)))

export const disagreement = (
  t27bHas: boolean,
  t27bPassed: boolean,
  referenceHas: boolean,
  referencePassed: boolean,
): number =>
  row().call(
    'disagreement',
    flag(t27bHas),
    flag(t27bPassed),
    flag(referenceHas),
    flag(referencePassed),
  ) >>> 0
// --- sybil.t27 (slice 1b) ---------------------------------------------------
// WHY A CAP IS A BIGINT: the owner's cap is u64 max; a Number cannot carry it
// back into the card exactly, and BigInt(2 ** 64) wraps to 0 there.

export const anchors = (tier: number): boolean =>
  yes(sybil().call('anchors', tier & 0xff))

export const replicasWanted = (knownAnswer: boolean): number =>
  sybil().call('replicas_wanted', flag(knownAnswer)) >>> 0

export const publicMayTake = (
  anchorOn: boolean,
  knownAnswer: boolean,
  publicIn: number,
): boolean =>
  yes(
    sybil().call(
      'public_may_take',
      flag(anchorOn),
      flag(knownAnswer),
      u32(publicIn),
    ),
  )

export const anchoredVerdict = (
  anchorPresent: boolean,
  anchorGroup: number,
  replicas: number,
  wanted: number,
  isExhausted: boolean,
): number =>
  sybil().call(
    'anchored_verdict',
    flag(anchorPresent),
    u32(anchorGroup),
    u32(replicas),
    u32(wanted),
    flag(isExhausted),
  ) >>> 0

export const canaryDue = (draw: number, ratePermille: number): boolean =>
  yes(sybil().call('canary_due', u32(draw), u32(ratePermille)))

export const canaryWrong = (knownAnswer: boolean, matches: boolean): boolean =>
  yes(sybil().call('canary_wrong', flag(knownAnswer), flag(matches)))

export const onProbation = (agreedBefore: number): boolean =>
  yes(sybil().call('on_probation', u32(agreedBefore)))

export const epochCap = (tier: number, attestedKey: boolean): bigint =>
  BigInt.asUintN(
    64,
    BigInt(sybil().call64('epoch_cap', tier & 0xff, flag(attestedKey))),
  )

export const attested = (
  ownerMarked: boolean,
  kind: number,
  signatureOk: boolean,
  githubAgeDays: number,
): boolean =>
  yes(
    sybil().call(
      'attested',
      flag(ownerMarked),
      kind & 0xff,
      flag(signatureOk),
      u32(githubAgeDays),
    ),
  )

export const voteCredit = (
  side: number,
  alreadyCredited: boolean,
  agreedBefore: number,
  earnedThisEpoch: number,
  cap: bigint,
): number =>
  Number(
    sybil().call64(
      'vote_credit',
      side & 0xff,
      flag(alreadyCredited),
      u32(agreedBefore),
      u64(earnedThisEpoch),
      BigInt.asIntN(64, cap),
    ),
  )

// Rule 6 (gHashTag/t27#8853): an operator is credited once per job. The card
// takes the tiers of a job's agreeing receipts, by arrival; every owner-tier
// key is one operator (network/quorum.t27 OPERATOR_OWNER).

/** REPLICAS_MAX tiers; a slot past the job's receipts is never read by the card. */
const tiersOf = (tiers: readonly number[]): [number, number, number] => [
  (tiers[0] ?? TIER_PUBLIC) & 0xff,
  (tiers[1] ?? TIER_PUBLIC) & 0xff,
  (tiers[2] ?? TIER_PUBLIC) & 0xff,
]

export const operatorFirst = (
  tiers: readonly number[],
  index: number,
): boolean => yes(sybil().call('operator_first', ...tiersOf(tiers), u32(index)))

export const operatorsOf = (tiers: readonly number[], count: number): number =>
  sybil().call('operators_of', ...tiersOf(tiers), u32(count)) >>> 0

export const operatorCredit = (
  firstOfOperator: boolean,
  side: number,
  alreadyCredited: boolean,
  agreedBefore: number,
  earnedThisEpoch: number,
  cap: bigint,
): number =>
  Number(
    sybil().call64(
      'operator_credit',
      flag(firstOfOperator),
      side & 0xff,
      flag(alreadyCredited),
      u32(agreedBefore),
      u64(earnedThisEpoch),
      BigInt.asIntN(64, cap),
    ),
  )

export const slashDue = (
  wrongCanary: boolean,
  side: number,
  alreadySlashed: boolean,
): boolean =>
  yes(
    sybil().call(
      'slash_due',
      flag(wrongCanary),
      side & 0xff,
      flag(alreadySlashed),
    ),
  )

export const struck = (
  wrongCanary: boolean,
  side: number,
  alreadyStruck: boolean,
): boolean =>
  yes(
    sybil().call('struck', flag(wrongCanary), side & 0xff, flag(alreadyStruck)),
  )

export const slashMtri = (earnedThisEpoch: number, cap: bigint): number =>
  Number(
    sybil().call64('slash_mtri', u64(earnedThisEpoch), BigInt.asIntN(64, cap)),
  )

/** The simulation's expectation over its seeds, in thousandths (sybil_mean_milli). */
export const sybilMeanMilli = (
  attackers: number,
  defenses: number,
  what: number,
): number =>
  Number(
    sybil().call64(
      'sybil_mean_milli',
      u32(attackers),
      u32(defenses),
      what & 0xff,
    ),
  )

/** The simulation's sum over its seeds (sybil_total). */
export const sybilTotal = (
  attackers: number,
  defenses: number,
  what: number,
): number =>
  Number(
    sybil().call64('sybil_total', u32(attackers), u32(defenses), what & 0xff),
  )

/** The same sum in the owner's world, both anchors his (sybil_world_total). */
export const sybilWorldTotal = (
  attackers: number,
  defenses: number,
  ownerAnchors: boolean,
  what: number,
): number =>
  Number(
    sybil().call64(
      'sybil_world_total',
      u32(attackers),
      u32(defenses),
      flag(ownerAnchors),
      what & 0xff,
    ),
  )

// --- statement.t27 (slice 1b) -----------------------------------------------

export const shardKind = (knownAnswer: boolean, index: number): number =>
  statement().call('shard_kind', flag(knownAnswer), u32(index)) >>> 0

export const leafKindKnown = (kind: number): boolean =>
  yes(statement().call('leaf_kind_known', kind & 0xff))

export const balanceAfterEntry = (
  balance: number,
  kind: number,
  mtri: number,
): number =>
  Number(
    statement().call64(
      'balance_after_entry',
      u64(balance),
      kind & 0xff,
      u64(mtri),
    ),
  )

export const epochOf = (unixSeconds: number): number =>
  Number(statement().call64('epoch_of', u64(unixSeconds)))

export const epochFrom = (epoch: number): number =>
  Number(statement().call64('epoch_from', u64(epoch)))

export const epochTo = (epoch: number): number =>
  Number(statement().call64('epoch_to', u64(epoch)))

export const nextToClose = (
  anyClosed: boolean,
  lastClosed: number,
  firstRowEpoch: number,
): number =>
  Number(
    statement().call64(
      'next_to_close',
      flag(anyClosed),
      u64(lastClosed),
      u64(firstRowEpoch),
    ),
  )

export const epochCloses = (
  epoch: number,
  next: number,
  nowEpoch: number,
  hasRows: boolean,
  anyClosed: boolean,
): boolean =>
  yes(
    statement().call64(
      'epoch_closes',
      u64(epoch),
      u64(next),
      u64(nowEpoch),
      flag(hasRows),
      flag(anyClosed),
    ),
  )

export const rowEpochOpen = (
  epoch: number,
  next: number,
  anyClosed: boolean,
): boolean =>
  yes(
    statement().call64(
      'row_epoch_open',
      u64(epoch),
      u64(next),
      flag(anyClosed),
    ),
  )

/** host_order: the byte order of the two host ids, as -1, 0 or 1. */
export const leafBefore = (
  hostOrder: number,
  kindA: number,
  kindB: number,
): boolean =>
  yes(
    statement().call(
      'leaf_before',
      Math.sign(hostOrder) | 0,
      kindA & 0xff,
      kindB & 0xff,
    ),
  )

export const auditPathLen = (index: number, size: number): number =>
  statement().call('audit_path_len', u32(index), u32(size)) >>> 0

export const siblingLeft = (index: number, size: number, i: number): boolean =>
  yes(statement().call('sibling_left', u32(index), u32(size), u32(i)))

export const proofShapeOk = (
  index: number,
  size: number,
  pathLen: number,
): boolean =>
  yes(statement().call('proof_shape_ok', u32(index), u32(size), u32(pathLen)))

export const verifyCode = (
  signatureOk: boolean,
  leafIsMine: boolean,
  shapeOk: boolean,
  rootMatches: boolean,
): number =>
  statement().call(
    'verify_code',
    flag(signatureOk),
    flag(leafIsMine),
    flag(shapeOk),
    flag(rootMatches),
  ) >>> 0

export const settlementGateOpen = (
  counselCleared: boolean,
  chain: number,
): boolean =>
  yes(
    statement().call(
      'settlement_gate_open',
      flag(counselCleared),
      chain & 0xff,
    ),
  )

/** corpus_receipt.t27's split, compiled into the statement card. */
export const splitPoint = (n: number): number =>
  statement().call('split_point', u32(n)) >>> 0

/** statement.t27 section 6: the state of the ledger key variable's value. */
export const ledgerKeyState = (
  set: boolean,
  length: number,
  allLowerHex: boolean,
): number =>
  statement().call(
    'ledger_key_state',
    flag(set),
    u32(length),
    flag(allLowerHex),
  ) >>> 0

export const epochsClose = (keyState: number): boolean =>
  yes(statement().call('epochs_close', keyState & 0xff))
