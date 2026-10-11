/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * What the Queen and a host agent both speak (gHashTag/trios#1756): the
 * signed message layout, the Ed25519 keys, and the shard's normalized output.
 * Plumbing only. Every decision is a card call (hosting-cards.ts); every name,
 * domain line and field list comes from the generated constants of
 * specs/hosting/proof.t27.
 *
 * THE MESSAGE: gHashTag/t27 specs/verified/signed_receipt.t27's layout, kept
 * exactly: the domain line, then one `name=value` line per signed field in the
 * spec's order, value being the field's JSON text, every line ending in a
 * newline. A missing field is refused here rather than signed as `undefined`.
 *
 * THE KEY: Ed25519 (RFC 8032) through node:crypto. A public key travels as 64
 * lowercase hex characters (its 32 raw bytes); a host id is the key id,
 * KEY_ID_HEX_LEN hex characters of the SHA-256 of those bytes.
 *
 * THE ROW (gHashTag/trios#1761): a lab row is two halves, each a job of its
 * own (specs/hosting/row.t27). The reference half's output is proof.t27
 * section 1 (v2, with the blocked reason); the t27b half's is t27b's own row
 * for the spec, one `key=<JSON>` line per row.t27 T27B_ROW_KEYS. assembleRow
 * puts the two agreed outputs together the lab's way; which key is written,
 * and which line a disagreeing test gets, are row.t27 card calls.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto'
import {
  detailKind,
  disagreeListed,
  disagreement,
  listsTests,
  reasonKept,
  reasonOf,
  referenceTestsListed,
  reportVerdict,
  runVerdict,
  t27bRunVerdict,
} from './hosting-cards'
import { JOB_RUN_BOUND_SECONDS } from './queen-hosting-placement-card.gen'
import {
  KEY_ID_HEX_LEN,
  REASON_EXIT_WORDS,
  REASON_MAX_BYTES,
  REASON_UNREADABLE,
  REASON_WITHHELD,
  RS_BLOCKED_LINE,
  RS_EXIT,
  RS_UNREADABLE,
  SHARD_COUNT_KEYS,
  SHARD_DOMAIN,
  SHARD_REASON_KEY,
  SHARD_SPEC_KEY,
  SHARD_TEST_KEY,
  SHARD_VERDICT_KEY,
  VERDICT_WORDS,
} from './queen-hosting-proof-card.gen'
import {
  DETAIL_FAIL_COUNT,
  DETAIL_FAIL_WORDS,
  DETAIL_REASON,
  DETAIL_TIMEOUT,
  DETAIL_TIMEOUT_WORDS,
  DIS_NONE,
  DISAGREE_TEXT,
  HALF_REFERENCE,
  HALF_T27B,
  ROW_KEYS,
  T27B_DOMAIN,
  T27B_ROW_KEYS,
  T27B_SPEC_KEY,
  T27B_WORDS,
  TEST_WORDS,
} from './queen-hosting-row-card.gen'

// --- messages ---------------------------------------------------------------

export function messageOf(
  domain: string,
  fields: readonly string[],
  record: Record<string, unknown>,
): string {
  let text = `${domain}\n`
  for (const name of fields) {
    const value = record[name]
    if (value === undefined) throw new Error(`no ${name} to sign`)
    text += `${name}=${JSON.stringify(value)}\n`
  }
  return text
}

export const sha256Hex = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex')

// --- keys -------------------------------------------------------------------

/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 raw bytes follow it. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const HEX64 = /^[0-9a-f]{64}$/

export function generateHostKey(): { privatePem: string; publicHex: string } {
  const { privateKey } = generateKeyPairSync('ed25519')
  const privatePem = privateKey
    .export({ format: 'pem', type: 'pkcs8' })
    .toString()
  return { privatePem, publicHex: publicHexOf(privatePem) }
}

/** DER prefix of an Ed25519 PKCS#8 private key; the 32-byte seed follows it. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

/** A PKCS#8 PEM from a 32-byte Ed25519 seed given as hex (statement.t27 section 6). */
export function privatePemOfSeed(seedHex: string): string {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seedHex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  })
    .export({ format: 'pem', type: 'pkcs8' })
    .toString()
}

export function publicHexOf(privatePem: string): string {
  const der = createPublicKey(createPrivateKey(privatePem)).export({
    format: 'der',
    type: 'spki',
  })
  return Buffer.from(der).subarray(SPKI_PREFIX.length).toString('hex')
}

export function publicKeyOf(publicHex: string): KeyObject | null {
  if (!HEX64.test(publicHex)) return null
  try {
    return createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicHex, 'hex')]),
      format: 'der',
      type: 'spki',
    })
  } catch {
    return null
  }
}

export const keyIdOf = (publicHex: string): string =>
  sha256Hex(Buffer.from(publicHex, 'hex')).slice(0, KEY_ID_HEX_LEN)

export const signHex = (privatePem: string, message: string): string =>
  sign(null, Buffer.from(message), createPrivateKey(privatePem)).toString('hex')

export function verifyHex(
  publicHex: string,
  message: string,
  signatureHex: unknown,
): boolean {
  const key = publicKeyOf(publicHex)
  if (!key || typeof signatureHex !== 'string') return false
  if (!/^[0-9a-f]{128}$/.test(signatureHex)) return false
  try {
    return verify(
      null,
      Buffer.from(message),
      key,
      Buffer.from(signatureHex, 'hex'),
    )
  } catch {
    return false
  }
}

// --- the shard's output -----------------------------------------------------

/** What `t27c test-report <spec> --verbose` reports, read as the t27b lab reads it. */
export interface TestReport {
  blockedLine: boolean
  /** The text after the first BLOCKED, trimmed: lab.py parse_test_report's reason. */
  blockedReason: string
  tests: number | null
  fail: number | null
  invariants: number
  vacuous: number
  /** In report order. */
  results: Array<{ name: string; passed: boolean }>
  /** Runtime asserts executed, by test name. */
  asserts: Map<string, number>
}

/**
 * The reading of contrib/railway/t27b-lab/lab.py parse_test_report and
 * parse_test_verdicts, line for line: the `tests` and `FAIL` counts, a
 * BLOCKED line, the per-test `pass`/`FAIL` lines after `--- test report:` up
 * to the first blank line; and the per-test runtime asserts after their
 * heading.
 */
export function readTestReport(stdout: string): TestReport {
  const lines = stdout.split(/\r?\n/)
  const blocked = lines.find((l) => l.trim().startsWith('BLOCKED'))
  const report: TestReport = {
    blockedLine: blocked !== undefined,
    blockedReason: (blocked ?? '').trim().slice('BLOCKED'.length).trim(),
    tests: null,
    fail: null,
    invariants: 0,
    vacuous: 0,
    results: [],
    asserts: new Map(),
  }
  for (const line of lines) {
    const count = /^\s*(tests|FAIL)\s+(\d+)\s*$/.exec(line)
    if (count?.[1] === 'tests') report.tests = Number(count[2])
    if (count?.[1] === 'FAIL') report.fail = Number(count[2])
    const inv = /^\s*invariants\s+(\d+)\b/.exec(line)
    if (inv) report.invariants = Number(inv[1])
    const vac = /^\s*vacuous passes\s+(\d+)\s+of\b/.exec(line)
    if (vac) report.vacuous = Number(vac[1])
  }
  const start = lines.findIndex((l) => l.startsWith('--- test report:'))
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      const t = line.trimStart()
      if (!t) break
      if (t.startsWith('pass  '))
        report.results.push({ name: t.slice(6), passed: true })
      else if (t.startsWith('FAIL  '))
        report.results.push({ name: t.slice(6), passed: false })
      else break
    }
  }
  const heading = lines.findIndex((l) =>
    l.trim().startsWith('runtime asserts executed'),
  )
  if (heading >= 0) {
    for (const line of lines.slice(heading + 1)) {
      const m = /^\s+(\d+)\s+(\S+)\s*$/.exec(line)
      if (!m) break
      report.asserts.set(m[2] as string, Number(m[1]))
    }
  }
  return report
}

export interface RunOutcome {
  started: boolean
  timedOut: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  /** The directory the job ran in: a reason that names it is withheld (proof.t27 reason_kept). */
  jobDir?: string
}

export interface ShardResult {
  /** row.t27 HALF_*: which half of the lab's row this is. */
  half: number
  verdict: number
  word: string
  /** The normalized output (proof.t27 section 1); output_hash is its SHA-256. */
  output: string
  outputHash: string
  /** Runtime asserts executed: the receipt's ops. */
  ops: number
  tests: number
  fail: number
}

/** lab.py reference_one: a fork the host could not afford is not a verdict. */
const outOfResources = (stderr: string) =>
  stderr.includes('Resource temporarily unavailable') ||
  stderr.includes('SystemResources')

/** The reason a blocked reference half carries: lab.py's text, cut as lab.py cuts it. */
function reasonText(kind: number, run: RunOutcome, report: TestReport): string {
  let text = ''
  if (kind === RS_EXIT)
    text = `${REASON_EXIT_WORDS[0]}${run.exitCode}${REASON_EXIT_WORDS[1]}${run.stderr.trim().split(/\r?\n/)[0] ?? ''}`
  else if (kind === RS_BLOCKED_LINE) text = report.blockedReason
  else if (kind === RS_UNREADABLE) text = REASON_UNREADABLE
  text = text.slice(0, REASON_MAX_BYTES)
  const namesJobDir = !!run.jobDir && text.includes(run.jobDir)
  return reasonKept(namesJobDir) ? text : REASON_WITHHELD
}

/** The reference half's verdict (the card) and its normalized output (proof.t27 section 1). */
export function normalizeShard(spec: string, run: RunOutcome): ShardResult {
  const report = readTestReport(run.stdout)
  const verdict = runVerdict({
    started: run.started,
    outOfResources: outOfResources(run.stderr),
    timedOut: run.timedOut,
    exitedZero: run.exitCode === 0,
    report: reportVerdict(
      report.blockedLine,
      report.tests !== null && report.fail !== null,
      report.fail ?? 0,
    ),
  })
  const word = VERDICT_WORDS[verdict] ?? 'blocked'
  let output = `${SHARD_DOMAIN}\n${SHARD_SPEC_KEY}=${spec}\n${SHARD_VERDICT_KEY}=${word}\n`
  let ops = 0
  for (const n of report.asserts.values()) ops += n
  if (!listsTests(verdict)) {
    const kind = reasonOf(verdict, run.exitCode === 0, report.blockedLine)
    if (kind !== 0)
      output += `${SHARD_REASON_KEY}=${reasonText(kind, run, report)}\n`
    return finish(HALF_REFERENCE, output, verdict, word, 0, 0, 0)
  }
  const [tests, fail, invariants, asserts, vacuous] = SHARD_COUNT_KEYS
  output += `${tests}=${report.tests ?? 0}\n${fail}=${report.fail ?? 0}\n`
  output += `${invariants}=${report.invariants}\n${asserts}=${ops}\n${vacuous}=${report.vacuous}\n`
  for (const r of report.results) {
    const n = report.asserts.get(r.name)
    output += `${SHARD_TEST_KEY}=${r.passed ? 'pass' : 'FAIL'} ${n ?? '-'} ${r.name}\n`
  }
  return finish(
    HALF_REFERENCE,
    output,
    verdict,
    word,
    ops,
    report.tests ?? 0,
    report.fail ?? 0,
  )
}

/** What a run of `t27b corpus specs --json <file>` left behind. */
export interface T27bOutcome {
  started: boolean
  /** The --json file's text, or null when t27b wrote none. */
  json: string | null
}

/**
 * The t27b half's verdict (row.t27 t27b_run_verdict) and its normalized
 * output: T27B_DOMAIN, the spec, then t27b's own row for the spec, one
 * `key=<JSON>` line per T27B_ROW_KEYS key it wrote, in that order.
 */
export function normalizeT27b(spec: string, run: T27bOutcome): ShardResult {
  let found: Record<string, unknown> | undefined
  try {
    const doc = JSON.parse(run.json ?? 'null') as {
      results?: Array<Record<string, unknown>>
    } | null
    found = doc?.results?.find((r) => r.file === spec)
  } catch {
    found = undefined
  }
  const code = T27B_WORDS.indexOf(found?.t27b as never)
  const verdict = t27bRunVerdict(run.started, !!found, code < 0 ? 255 : code)
  const word = T27B_WORDS[verdict] ?? 'host_error'
  let output = `${T27B_DOMAIN}\n${T27B_SPEC_KEY}=${spec}\n`
  const facts: Record<string, unknown> = { ...(found ?? {}), t27b: word }
  if (word === 'host_error') output += `t27b=${JSON.stringify(word)}\n`
  else
    for (const key of T27B_ROW_KEYS)
      if (key in facts) output += `${key}=${JSON.stringify(facts[key])}\n`
  const asserts = typeof facts.asserts === 'number' ? facts.asserts : 0
  const tests = typeof facts.tests === 'number' ? facts.tests : 0
  return finish(HALF_T27B, output, verdict, word, asserts, tests, 0)
}

function finish(
  half: number,
  output: string,
  verdict: number,
  word: string,
  ops: number,
  tests: number,
  fail: number,
): ShardResult {
  return {
    half,
    verdict,
    word,
    output,
    outputHash: sha256Hex(output),
    ops,
    tests,
    fail,
  }
}

/** What a normalized output of either half states. */
export interface Stated {
  half: number
  spec: string
  word: string
  ops: number
  tests: number
  /** The reference half: its counts, reason and per-test lines. */
  fail?: number
  reason?: string
  results?: Array<{ name: string; passed: boolean }>
  /** The t27b half: the keys of t27b's row it reported. */
  row?: Record<string, unknown>
}

/** The verdict word and asserts a normalized output states, for the Queen's check and the row. */
export function readNormalized(output: string): Stated | null {
  const lines = output.split('\n')
  const field = (key: string) => {
    const line = lines.find((l) => l.startsWith(`${key}=`))
    return line === undefined ? undefined : line.slice(key.length + 1)
  }
  if (lines[0] === T27B_DOMAIN) {
    const spec = field(T27B_SPEC_KEY)
    const row: Record<string, unknown> = {}
    try {
      for (const key of T27B_ROW_KEYS) {
        const v = field(key)
        if (v !== undefined) row[key] = JSON.parse(v)
      }
    } catch {
      return null
    }
    if (spec === undefined || typeof row.t27b !== 'string') return null
    return {
      half: HALF_T27B,
      spec,
      word: row.t27b,
      ops: typeof row.asserts === 'number' ? row.asserts : 0,
      tests: typeof row.tests === 'number' ? row.tests : 0,
      row,
    }
  }
  if (lines[0] !== SHARD_DOMAIN) return null
  const spec = field(SHARD_SPEC_KEY)
  const word = field(SHARD_VERDICT_KEY)
  if (spec === undefined || word === undefined) return null
  const results = lines
    .filter((l) => l.startsWith(`${SHARD_TEST_KEY}=`))
    .map((l) => {
      const [mark, , ...name] = l.slice(SHARD_TEST_KEY.length + 1).split(' ')
      return { name: name.join(' '), passed: mark === 'pass' }
    })
  return {
    half: HALF_REFERENCE,
    spec,
    word,
    ops: Number(field(SHARD_COUNT_KEYS[3]) ?? 0),
    tests: Number(field(SHARD_COUNT_KEYS[0]) ?? 0),
    fail: Number(field(SHARD_COUNT_KEYS[1]) ?? 0),
    reason: field(SHARD_REASON_KEY),
    results,
  }
}

/**
 * One row of the lab's run.json from the two agreed halves, keys in the lab's
 * order (row.t27 ROW_KEYS): t27b's row, then the reference's verdict, its
 * reason or fail count, its per-test verdicts when complete, and one line per
 * test the two sides judge differently. Which of these is written, and which
 * line a test gets, are row.t27's; the loops and the text are here.
 */
export function assembleRow(
  file: string,
  reference: Stated,
  t27b: Stated,
): Record<string, unknown> {
  return rowOfParts(file, referencePartOf(reference), t27b.row ?? {})
}

/**
 * The reference half's keys of a row (feed.t27 REFERENCE_PART_KEYS) from its
 * agreed output: the verdict, its reason or fail count (row.t27 detail_kind),
 * and its per-test verdicts when every test is listed.
 */
export function referencePartOf(reference: Stated): Record<string, unknown> {
  const refCode = VERDICT_WORDS.indexOf(reference.word as never)
  const kind = detailKind(refCode < 0 ? 255 : refCode)
  let detail = ''
  if (kind === DETAIL_FAIL_COUNT)
    detail = `${reference.fail ?? 0}${DETAIL_FAIL_WORDS[0]}${reference.tests}${DETAIL_FAIL_WORDS[1]}`
  else if (kind === DETAIL_REASON) detail = reference.reason ?? ''
  else if (kind === DETAIL_TIMEOUT)
    detail = `${DETAIL_TIMEOUT_WORDS[0]}${JOB_RUN_BOUND_SECONDS}${DETAIL_TIMEOUT_WORDS[1]}`
  const part: Record<string, unknown> = {
    reference: reference.word,
    reference_detail: detail,
  }
  const listed = reference.results ?? []
  if (
    referenceTestsListed(
      refCode < 0 ? 255 : refCode,
      listed.length,
      reference.tests,
    )
  ) {
    const verdicts: Record<string, boolean> = {}
    for (const r of listed) verdicts[r.name] = r.passed
    part.reference_tests = verdicts
  }
  return part
}

/**
 * A row from its two halves' keys, however each half came (agreed now, or
 * carried from an earlier receipt: feed.t27 section 4). reference_disagree is
 * recomputed from the two, never carried.
 */
export function rowOfParts(
  file: string,
  referencePart: Record<string, unknown>,
  t27bPart: Record<string, unknown>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {
    ...t27bPart,
    file,
    reference: referencePart.reference,
    reference_detail: referencePart.reference_detail ?? '',
  }
  const refVerdicts =
    referencePart.reference_tests &&
    typeof referencePart.reference_tests === 'object'
      ? (referencePart.reference_tests as Record<string, boolean>)
      : null
  if (refVerdicts) values.reference_tests = refVerdicts
  const t27bVerdicts =
    t27bPart.test_verdicts && typeof t27bPart.test_verdicts === 'object'
      ? (t27bPart.test_verdicts as Record<string, boolean>)
      : null
  if (disagreeListed(t27bVerdicts !== null, refVerdicts !== null)) {
    const lines: string[] = []
    const names = [
      ...new Set([
        ...Object.keys(t27bVerdicts ?? {}),
        ...Object.keys(refVerdicts ?? {}),
      ]),
    ].sort()
    for (const name of names) {
      const a = t27bVerdicts?.[name]
      const b = refVerdicts?.[name]
      const line = disagreement(
        a !== undefined,
        a === true,
        b !== undefined,
        b === true,
      )
      if (line === DIS_NONE) continue
      lines.push(
        (DISAGREE_TEXT[line] ?? '')
          .replace('{name}', name)
          .replace('{t27b}', TEST_WORDS[a ? 1 : 0] as string)
          .replace('{reference}', TEST_WORDS[b ? 1 : 0] as string),
      )
    }
    values.reference_disagree = lines
  }
  const out: Record<string, unknown> = {}
  for (const key of ROW_KEYS) if (key in values) out[key] = values[key]
  return out
}
