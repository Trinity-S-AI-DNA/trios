/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The network feeds itself (gHashTag/trios#1756, slice 2a): the Queen watches
 * t27 master, and for each head it feeds it shards only the specs whose `use`
 * closure changed, carries every other row from the last complete receipt,
 * audits a sample of what it carried, and assembles the commit's corpus
 * receipt beside the t27b lab's.
 *
 * THIN GLUE. Every decision is a call into the feed card (hosting-feed-cards.ts,
 * gHashTag/t27 specs/hosting/feed.t27): when to ask GitHub, when to feed a
 * head, whether a toolchain is the same, why each half of each spec is sharded
 * or carried, the audit sample, a half's state, when a receipt is complete,
 * and how it compares with the lab's. This file reads GitHub and the lab,
 * resolves `use` closures (hosting-toolchain useClosure, the reading of t27c's
 * use_resolve.rs), hashes, submits jobs and keeps rows.
 *
 * THE OWNER'S PATH. Jobs go in through the hosting Queen's in-process
 * submitShard: the Queen's own owner path, with no host key and no HTTP.
 *
 * WHAT IT COSTS GITHUB. One `commits/master` request per FEED_POLL_SECONDS,
 * sent with the last ETag, so an unchanged head answers 304, which GitHub does
 * not count; one recursive tree per fed head (and once for the pin). Spec
 * files come from raw.githubusercontent.com (toolchain.t27 SPEC_SOURCE_BASE),
 * outside the API budget, once per git blob: a cold Queen reads the whole
 * corpus once (about 1860 files, 18.5 MB), a warm one only the blobs a head
 * changed.
 *
 * WHY A CLOCK IS PASSED IN: the tests run hours of feeding on a VirtualClock;
 * production passes Date.now.
 */

import { createHash } from 'node:crypto'
import { t27bVotes, verdictVotes } from './hosting-cards'
import {
  auditOutcome,
  auditPick,
  baseUsable,
  comparable,
  feedDue,
  feedState,
  halfState,
  labVerdict,
  pollDue,
  rowCompare,
  rowSettled,
  shardReason,
  shards,
  toolchainPart,
  voidsNext,
} from './hosting-feed-cards'
import type { HostingQueen } from './hosting-queen'
import type {
  FeedHalf,
  FeedRow,
  FeedSpec,
  FeedSummary,
  HostingStore,
  JobRow,
} from './hosting-store'
import { useClosure } from './hosting-toolchain'
import {
  readNormalized,
  referencePartOf,
  rowOfParts,
  sha256Hex,
} from './hosting-wire'
import {
  AU_NONE,
  AU_POISONED,
  AU_WORDS,
  CMP_WORDS,
  COMPARED_ROW_KEYS,
  FEED_COMPLETE,
  FEED_OPEN,
  FEED_POLL_SECONDS,
  FEED_WORDS,
  HOUR_SECONDS,
  HS_AGREED,
  HS_CARRIED,
  HS_GAVE_UP,
  HS_OPEN,
  HS_WORDS,
  LV_WORDS,
  REFERENCE_PART_KEYS,
  REFERENCE_SOURCES,
  SHARD_AUDIT,
  SHARD_CARRY,
  SHARD_WORDS,
  SOURCE_HOSTING,
  SOURCE_LAB,
  SOURCE_WORDS,
  T27B_PART_KEYS,
  T27B_SOURCES,
  TC_SAME,
  TC_WORDS,
} from './queen-hosting-feed-card.gen'
import { JV_PENDING, VERDICT_WORDS } from './queen-hosting-proof-card.gen'
import {
  HALF_REFERENCE,
  HALF_T27B,
  HALF_WORDS,
  T27B_WORDS,
} from './queen-hosting-row-card.gen'
import { SPEC_SOURCE_BASE, T27_COMMIT } from './queen-hosting-toolchain.gen'

/** The repository whose master is fed, and the lab whose receipt it is set beside. */
export const FEED_REPO = 'gHashTag/t27'
export const FEED_LAB = 'https://t27b-lab-production.up.railway.app'
const GITHUB_API = 'https://api.github.com'
const UA = 't27-queen-feed (github.com/gHashTag/trios)'
const HEX40 = /^[0-9a-f]{40}$/
const SPEC_FILE = /^specs\/[A-Za-z0-9_\-/.]+\.t27$/
/** Concurrent raw-file reads on a cold blob cache. */
const READS_AT_ONCE = 8
/**
 * Trees and lab runs kept in memory besides the pin's: a recursive tree is
 * about 13000 entries and a lab run about 1.4 MB, so neither is kept for every
 * commit ever fed. A feed re-reads one it dropped.
 */
const KEPT_IN_MEMORY = 4

/** Keep the newest `n` entries of a map (insertion order), and `pinned` whatever its age. */
function trim<V>(m: Map<string, V>, n: number, pinned: string) {
  for (const k of [...m.keys()]) {
    if (m.size <= n + (m.has(pinned) ? 1 : 0)) return
    if (k !== pinned) m.delete(k)
  }
}

/** master's head, unchanged since the ETag sent, or unreadable. */
export type HeadAnswer =
  | { sha: string; etag: string | null }
  | { unchanged: true }
  | null

/** One t27b-lab run: its rows (run.json `results`). */
export interface LabRun {
  results: Array<Record<string, unknown>>
}

/** Where the feed reads; a test replaces it with an in-memory fake. */
export interface FeedSource {
  head(etag: string | null): Promise<HeadAnswer>
  /** Every path of the commit's tree to its git object id; null when the tree cannot be read whole. */
  tree(commit: string): Promise<Map<string, string> | null>
  /** One file's bytes at a commit. */
  file(commit: string, path: string): Promise<Uint8Array>
  /** The lab's run of a commit, or null when the lab has none. */
  labRun(commit: string): Promise<LabRun | null>
  /** Where that run is published, for a row's provenance. */
  labUrl(commit: string): string
}

export interface HostingFeedDeps {
  store: HostingStore
  queen: Pick<HostingQueen, 'submitShard'>
  source: FeedSource
  /** Milliseconds. */
  now: () => number
  /** The t27 commit the hosts' toolchain was built from (toolchain.t27 T27_COMMIT). */
  pin?: string
  /**
   * Where a chain starts when no complete receipt can be its base: the lab's
   * receipt of the pin (feed.t27 section 5), or nothing, so every spec is new.
   */
  genesis?: 'lab' | 'none'
  log?: (line: string) => void
}

/** One blob's facts: the SHA-256 a job pins, and the `use` lines a closure reads. */
interface BlobFacts {
  sha256: string
  uses: string
}

const secondsBetween = (later: number, earlier: number) =>
  Math.max(0, Math.floor((later - earlier) / 1000))

const halfSources = (half: number): readonly string[] =>
  half === HALF_T27B ? T27B_SOURCES : REFERENCE_SOURCES

const partKeys = (half: number): readonly string[] =>
  half === HALF_T27B ? T27B_PART_KEYS : REFERENCE_PART_KEYS

/** A half's keys of a row: feed.t27 *_PART_KEYS, so a load key is never carried. */
export function partOfRow(
  row: Record<string, unknown>,
  half: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of partKeys(half)) if (k in row) out[k] = row[k]
  return out
}

/** JSON with sorted object keys: two encodings of one value compare equal. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

const partId = (part: Record<string, unknown>) =>
  sha256Hex(canonical(part)).slice(0, 32)

/** Whether a half's part is a vote: proof.t27 verdict_votes, row.t27 t27b_votes. */
function partVotes(half: number, part: Record<string, unknown> | undefined) {
  if (!part) return false
  if (half === HALF_T27B) {
    const code = T27B_WORDS.indexOf(String(part.t27b) as never)
    return t27bVotes(code < 0 ? 255 : code)
  }
  const code = VERDICT_WORDS.indexOf(String(part.reference) as never)
  return verdictVotes(code < 0 ? 255 : code)
}

/** The keys feed.t27 COMPARED_ROW_KEYS on which two rows differ. */
export function differingKeys(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): string[] {
  return COMPARED_ROW_KEYS.filter((k) => canonical(a[k]) !== canonical(b[k]))
}

/** The first 32 bits of the SHA-256 of a spec's path: its audit word. */
const pathWord = (path: string) =>
  Number.parseInt(sha256Hex(path).slice(0, 8), 16) >>> 0

export function createHostingFeed(deps: HostingFeedDeps) {
  const pin = deps.pin ?? T27_COMMIT
  const genesisFrom = deps.genesis ?? 'lab'
  const log = deps.log ?? (() => undefined)
  const blobs = new Map<string, BlobFacts>()
  const trees = new Map<string, Map<string, string>>()
  const labRuns = new Map<string, LabRun>()
  /** When the lab last had no run of a commit: asked again after FEED_POLL_SECONDS. */
  const labMisses = new Map<string, number>()
  let polledAt: number | null = null
  let etag: string | null = null
  let head: { sha: string; seenAt: number } | null = null
  let ticking: Promise<void> | null = null

  async function treeOf(commit: string) {
    const hit = trees.get(commit)
    if (hit) return hit
    const tree = await deps.source.tree(commit)
    if (tree) {
      trees.set(commit, tree)
      trim(trees, KEPT_IN_MEMORY, pin)
    }
    return tree
  }

  async function labRunOf(commit: string) {
    const hit = labRuns.get(commit)
    if (hit) return hit
    const missed = labMisses.get(commit)
    if (
      missed !== undefined &&
      secondsBetween(deps.now(), missed) < FEED_POLL_SECONDS
    )
      return null
    const run = await deps.source.labRun(commit)
    if (run) {
      labRuns.set(commit, run)
      trim(labRuns, KEPT_IN_MEMORY, pin)
    } else {
      labMisses.set(commit, deps.now())
      trim(labMisses, KEPT_IN_MEMORY * 16, pin)
    }
    return run
  }

  /** Read every blob of `paths` the cache has not seen: once per git blob. */
  async function learnBlobs(
    commit: string,
    tree: Map<string, string>,
    paths: string[],
  ) {
    const todo = paths.filter((p) => !blobs.has(tree.get(p) as string))
    let next = 0
    const worker = async () => {
      while (next < todo.length) {
        const path = todo[next++] as string
        const bytes = await deps.source.file(commit, path)
        const text = new TextDecoder().decode(bytes)
        blobs.set(tree.get(path) as string, {
          sha256: createHash('sha256').update(bytes).digest('hex'),
          uses: text
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith('use '))
            .join('\n'),
        })
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(READS_AT_ONCE, todo.length) }, worker),
    )
  }

  const specsOf = (tree: Map<string, string>) =>
    [...tree.keys()].filter((p) => SPEC_FILE.test(p)).sort()

  const closureOf = (tree: Map<string, string>, spec: string) =>
    useClosure(
      spec,
      (p) => blobs.get(tree.get(p) as string)?.uses ?? '',
      (p) => SPEC_FILE.test(p) && tree.has(p),
    )

  const inputOf = (tree: Map<string, string>, closure: string[]) =>
    sha256Hex(
      [...closure]
        .sort()
        .map((p) => `${p} ${tree.get(p)}`)
        .join('\n'),
    )

  /**
   * feed.t27 toolchain_part of one half: its SOURCES in two trees. A tree
   * that could not be read is never the same; a source a tree that was read
   * does not hold is absent, and absent equals absent (i128_plan.t27 did not
   * exist yet at cf42584c9).
   */
  function toolchainOf(
    a: Map<string, string> | null,
    b: Map<string, string> | null,
    half: number,
  ): number {
    const paths = halfSources(half)
    return toolchainPart(
      !!a && !!b,
      !!a && !!b && paths.every((p) => a.get(p) === b.get(p)),
    )
  }

  /** The two halves' toolchains of a receipt made under `basePin`, against the hosts' pin. */
  async function pinToolchains(basePin: string): Promise<[number, number]> {
    if (basePin === pin) return [TC_SAME, TC_SAME]
    const [a, b] = [await treeOf(basePin), await treeOf(pin)]
    return [toolchainOf(a, b, HALF_REFERENCE), toolchainOf(a, b, HALF_T27B)]
  }

  /** The job one half of a spec is, at a commit. */
  function jobBody(
    commit: string,
    tree: Map<string, string>,
    spec: string,
    half: number,
  ) {
    const files = closureOf(tree, spec).map((path) => ({
      path,
      sha256: (blobs.get(tree.get(path) as string) as BlobFacts).sha256,
    }))
    return {
      commit,
      spec,
      input_hash: (files.find((f) => f.path === spec) as { sha256: string })
        .sha256,
      files,
      half,
      holds_secret: false,
      holds_personal: false,
    }
  }

  // --- the chain's first receipt ----------------------------------------------

  /** feed.t27 section 5: the lab's receipt of the pin, the one lab run whose toolchain is the hosts'. */
  async function genesis(): Promise<FeedRow | null> {
    if (genesisFrom !== 'lab') return null
    const id = `lab:${pin}`
    const kept = await deps.store.tx((s) => s.feed(id))
    if (kept) return kept
    const run = await labRunOf(pin)
    const tree = await treeOf(pin)
    if (!run || !tree) return null
    const specs = specsOf(tree)
    await learnBlobs(pin, tree, specs)
    const rows = new Map(run.results.map((r) => [String(r.file), r]))
    const parts = new Map<string, Record<string, unknown>>()
    const out: FeedSpec[] = []
    for (const file of specs) {
      const row = rows.get(file)
      if (!row) continue
      const halves = [HALF_REFERENCE, HALF_T27B].map((h): FeedHalf => {
        const part = partOfRow(row, h)
        const id = partId(part)
        parts.set(id, part)
        return {
          reason: SHARD_CARRY,
          job: null,
          part: id,
          from: { source: SOURCE_LAB, commit: pin },
          state: HS_CARRIED,
          audit: AU_NONE,
        }
      }) as [FeedHalf, FeedHalf]
      out.push({ file, input: inputOf(tree, closureOf(tree, file)), halves })
    }
    const now = deps.now()
    const row: FeedRow = {
      id,
      commit: pin,
      seq: 0,
      pin,
      state: FEED_COMPLETE,
      startedAt: now,
      closedAt: now,
      base: null,
      toolchain: [TC_SAME, TC_SAME],
      voided: [false, false],
      specs: out,
    }
    await deps.store.tx(async (s) => {
      await s.putParts(parts)
      if (!(await s.feed(id))) await s.putFeed(row)
    })
    log(
      `hosting feed: genesis from the lab's run of ${pin}: ${out.length} rows`,
    )
    return row
  }

  /**
   * The base a new feed carries from: the newest complete receipt made with the
   * hosts' toolchain in both halves (feed.t27 base_usable); else the chain's
   * genesis; else the newest complete receipt of another toolchain, whose
   * halves of another toolchain are then sharded (feed.t27 SHARD_TOOLCHAIN).
   */
  async function chooseBase(): Promise<{
    base: FeedRow
    toolchain: [number, number]
  } | null> {
    const all = await deps.store.tx((s) => s.feeds())
    let fallback: { id: string; toolchain: [number, number] } | null = null
    for (const f of all) {
      if (f.state !== FEED_COMPLETE) continue
      const tc = await pinToolchains(f.pin)
      if (baseUsable(f.state, tc[0]) && baseUsable(f.state, tc[1])) {
        const base = await deps.store.tx((s) => s.feed(f.id))
        if (base) return { base, toolchain: tc }
      }
      fallback ??= { id: f.id, toolchain: tc }
    }
    const g = await genesis()
    if (g) return { base: g, toolchain: [TC_SAME, TC_SAME] }
    if (!fallback) return null
    const base = await deps.store.tx((s) => s.feed(fallback.id))
    return base ? { base, toolchain: fallback.toolchain } : null
  }

  // --- a feed --------------------------------------------------------------------

  /** Feed one head: the shard set from the card, the jobs in, the carried halves kept. */
  async function start(commit: string) {
    const tree = await treeOf(commit)
    const pinTree = await treeOf(pin)
    if (!tree) {
      log(
        `hosting feed: the tree of ${commit} could not be read whole; not fed`,
      )
      return
    }
    const specs = specsOf(tree)
    await learnBlobs(commit, tree, specs)
    const chosen = await chooseBase()
    const base = chosen?.base ?? null
    const baseTc = chosen?.toolchain ?? [TC_SAME, TC_SAME]
    const baseBy = new Map(base?.specs.map((s) => [s.file, s]) ?? [])
    const baseParts = await deps.store.tx((s) =>
      s.parts(
        (base?.specs ?? []).flatMap((s) =>
          s.halves.flatMap((h) => (h.part ? [h.part] : [])),
        ),
      ),
    )
    const seq = (base?.seq ?? 0) + 1
    const voided: [boolean, boolean] = [HALF_REFERENCE, HALF_T27B].map((h) =>
      voidsNext(
        (base?.specs ?? []).filter((s) => s.halves[h]?.audit === AU_POISONED)
          .length,
      ),
    ) as [boolean, boolean]
    const out: FeedSpec[] = specs.map((file) => {
      const input = inputOf(tree, closureOf(tree, file))
      const was = baseBy.get(file)
      const audited = auditPick(pathWord(file), seq)
      const halves = [HALF_REFERENCE, HALF_T27B].map((h): FeedHalf => {
        const before = was?.halves[h]
        const part = before?.part ? baseParts.get(before.part) : undefined
        const reason = shardReason(
          !!was,
          baseTc[h] as number,
          voided[h] as boolean,
          was?.input === input,
          partVotes(h, part),
          audited,
        )
        if (!shards(reason))
          return {
            reason,
            job: null,
            part: before?.part ?? null,
            from: before?.from ?? null,
            state: HS_CARRIED,
            audit: AU_NONE,
          }
        return {
          reason,
          job: null,
          part: null,
          carried: reason === SHARD_AUDIT ? (before?.part ?? null) : null,
          from: null,
          state: HS_OPEN,
          audit: auditOutcome(reason, HS_OPEN, false),
        }
      }) as [FeedHalf, FeedHalf]
      return { file, input, halves }
    })
    const now = deps.now()
    const row: FeedRow = {
      id: commit,
      commit,
      seq,
      pin,
      state: FEED_OPEN,
      startedAt: now,
      closedAt: null,
      base: base?.id ?? null,
      toolchain: [
        toolchainOf(tree, pinTree, HALF_REFERENCE),
        toolchainOf(tree, pinTree, HALF_T27B),
      ],
      voided,
      specs: out,
    }
    // claim the head first: a second Queen (a deploy's old and new process)
    // that got here too finds the row and leaves it alone
    const claimed = await deps.store.tx(async (s) => {
      if (await s.feed(commit)) return false
      if ((await s.feeds()).some((f) => f.state === FEED_OPEN)) return false
      await s.putFeed(row)
      return true
    })
    if (!claimed) return
    await submitMissing(row, tree)
    const counts = countsOf(row)
    log(
      `hosting feed: ${commit} fed from ${row.base ?? 'nothing'}: ${counts.sharded} halves sharded, ${counts.carried} carried`,
    )
  }

  /** Submit every sharded half that has no job yet; a job id is its content, so a retry adds nothing. */
  async function submitMissing(row: FeedRow, tree: Map<string, string>) {
    let added = 0
    for (const spec of row.specs)
      for (const [h, half] of spec.halves.entries()) {
        if (!shards(half.reason) || half.job) continue
        const { job } = await deps.queen.submitShard(
          jobBody(row.commit, tree, spec.file, h),
        )
        half.job = job.id
        added++
      }
    if (added > 0) await deps.store.tx((s) => s.putFeed(row))
  }

  /** Read every open feed's jobs and judge its halves; close the feed when the card says so. */
  async function advance() {
    const open = (await deps.store.tx((s) => s.feeds())).filter(
      (f) => f.state === FEED_OPEN,
    )
    for (const summary of open) {
      const row = await deps.store.tx((s) => s.feed(summary.id))
      if (row) await judge(row)
    }
  }

  /** A feed claimed by a Queen that stopped before every job was in: submit the rest. */
  async function resubmit(row: FeedRow) {
    const missing = row.specs.some((s) =>
      s.halves.some((h) => shards(h.reason) && !h.job),
    )
    if (!missing) return
    const tree = await treeOf(row.commit)
    if (!tree) return
    await learnBlobs(row.commit, tree, specsOf(tree))
    await submitMissing(row, tree)
  }

  /** One open feed: submit what is missing, judge every sharded half, close it when the card says so. */
  async function judge(row: FeedRow) {
    await resubmit(row)
    const ids = row.specs.flatMap((s) =>
      s.halves.flatMap((h) => (h.job ? [h.job] : [])),
    )
    const jobs = new Map(
      (await deps.store.tx((s) => s.jobsByIds(ids))).map((j) => [j.id, j]),
    )
    const fresh = new Map<string, Record<string, unknown>>()
    let changed = false
    let openHalves = 0
    for (const spec of row.specs)
      for (const [h, half] of spec.halves.entries()) {
        if (!shards(half.reason)) continue
        const job = half.job ? jobs.get(half.job) : undefined
        if (judgeHalf(row.commit, h, half, job, fresh)) changed = true
        if (half.state === HS_OPEN) openHalves++
      }
    const state = feedState(
      openHalves,
      secondsBetween(deps.now(), row.startedAt),
    )
    if (state !== row.state) {
      row.state = state
      row.closedAt = state === FEED_OPEN ? null : deps.now()
      changed = true
      log(`hosting feed: ${row.commit} is ${FEED_WORDS[state]}`)
    }
    if (changed)
      await deps.store.tx(async (s) => {
        await s.putParts(fresh)
        await s.putFeed(row)
      })
  }

  /** One sharded half against its job (feed.t27 half_state, audit_outcome); true when it changed. */
  function judgeHalf(
    commit: string,
    h: number,
    half: FeedHalf,
    job: JobRow | undefined,
    fresh: Map<string, Record<string, unknown>>,
  ): boolean {
    let state = halfState(half.reason, !!job, job?.verdict ?? JV_PENDING)
    if (state === HS_AGREED && !half.part && job) {
      const part = agreedPart(h, job)
      if (part) {
        const id = partId(part)
        fresh.set(id, part)
        half.part = id
        half.from = { source: SOURCE_HOSTING, commit, job: job.id }
      } else state = HS_GAVE_UP
    }
    // a part's id is its content's hash: equal ids are equal keys
    const audit = auditOutcome(
      half.reason,
      state,
      !!half.part && half.part === half.carried,
    )
    const changed = state !== half.state || audit !== half.audit
    half.state = state
    half.audit = audit
    return changed
  }

  /** The row keys of an agreed half, from the hosts' agreed output. */
  function agreedPart(half: number, job: JobRow) {
    const stated = readNormalized(job.result?.output ?? '')
    if (!stated || stated.half !== half) return null
    return half === HALF_T27B
      ? partOfRow(stated.row ?? {}, HALF_T27B)
      : partOfRow(referencePartOf(stated), HALF_REFERENCE)
  }

  // --- the loop ---------------------------------------------------------------------

  /** One step: ask GitHub when the card says so, judge the open feed, feed a settled head. */
  async function tickOnce() {
    const now = deps.now()
    if (
      pollDue(
        polledAt !== null,
        polledAt === null ? 0 : secondsBetween(now, polledAt),
      )
    ) {
      polledAt = now
      const answer = await deps.source.head(etag)
      if (answer && 'sha' in answer && HEX40.test(answer.sha)) {
        etag = answer.etag
        if (head?.sha !== answer.sha) head = { sha: answer.sha, seenAt: now }
      }
    }
    await advance()
    if (!head) return
    const feeds = (await deps.store.tx((s) => s.feeds())).filter(
      (f) => !f.id.startsWith('lab:'),
    )
    const due = feedDue(
      !feeds.some((f) => f.commit === head?.sha),
      secondsBetween(now, head.seenAt),
      feeds.some((f) => f.state === FEED_OPEN),
      feeds.filter((f) => now - f.startedAt < HOUR_SECONDS * 1000).length,
    )
    if (due) await start(head.sha)
  }

  /** One tick at a time: a slow tick is never overlapped by the next. */
  function tick(): Promise<void> {
    ticking ??= tickOnce().finally(() => {
      ticking = null
    })
    return ticking
  }

  // --- reads -------------------------------------------------------------------------

  function countsOf(row: FeedRow) {
    const byReason: Record<string, number> = {}
    const byState: Record<string, number> = {}
    const audit: Record<string, number> = {}
    let sharded = 0
    let carried = 0
    let rows = 0
    for (const spec of row.specs) {
      if (rowSettled(spec.halves[0].state, spec.halves[1].state)) rows++
      for (const half of spec.halves) {
        const r = SHARD_WORDS[half.reason] ?? String(half.reason)
        byReason[r] = (byReason[r] ?? 0) + 1
        const st = HS_WORDS[half.state] ?? String(half.state)
        byState[st] = (byState[st] ?? 0) + 1
        if (half.audit !== AU_NONE) {
          const a = AU_WORDS[half.audit] ?? String(half.audit)
          audit[a] = (audit[a] ?? 0) + 1
        }
        if (shards(half.reason)) sharded++
        else carried++
      }
    }
    return {
      specs: row.specs.length,
      rows,
      sharded,
      carried,
      halves_by_reason: byReason,
      halves_by_state: byState,
      audit,
    }
  }

  const summaryOf = (f: FeedSummary | FeedRow) => ({
    id: f.id,
    commit: f.commit,
    seq: f.seq,
    pin: f.pin,
    state: FEED_WORDS[f.state] ?? String(f.state),
    started_at: new Date(f.startedAt).toISOString(),
    closed_at: f.closedAt === null ? null : new Date(f.closedAt).toISOString(),
    base: f.base,
    toolchain: {
      reference: TC_WORDS[f.toolchain[0]],
      t27b: TC_WORDS[f.toolchain[1]],
      comparable_with_lab: comparable(f.toolchain[0], f.toolchain[1]),
    },
    voided: { reference: f.voided[0], t27b: f.voided[1] },
  })

  /** GET /hosting/corpus: the feed's own state and every feed, newest first. */
  async function status() {
    const feeds = await deps.store.tx((s) => s.feeds())
    return {
      repo: FEED_REPO,
      pin,
      poll_seconds: FEED_POLL_SECONDS,
      polled_at: polledAt === null ? null : new Date(polledAt).toISOString(),
      head: head?.sha ?? null,
      head_seen_at: head ? new Date(head.seenAt).toISOString() : null,
      feeds: feeds.map((f) => ({ ...summaryOf(f), specs: f.specCount })),
    }
  }

  /** A feed and its parts, or null. A sha finds the feed of that commit. */
  async function loaded(sha: string) {
    const row = await deps.store.tx((s) => s.feed(sha))
    if (!row) return null
    const ids = row.specs.flatMap((s) =>
      s.halves.flatMap((h) => (h.part ? [h.part] : [])),
    )
    const parts = await deps.store.tx((s) => s.parts(ids))
    return { row, parts }
  }

  /** The receipt's rows: every settled spec, in the lab's row shape, with each half's provenance. */
  function rowsOf(row: FeedRow, parts: Map<string, Record<string, unknown>>) {
    const rows: Array<Record<string, unknown>> = []
    const unsettled: Array<Record<string, unknown>> = []
    for (const spec of row.specs) {
      const [ref, t27b] = spec.halves
      const a = ref.part ? parts.get(ref.part) : undefined
      const b = t27b.part ? parts.get(t27b.part) : undefined
      if (rowSettled(ref.state, t27b.state) && a && b) {
        rows.push({
          ...rowOfParts(spec.file, a, b),
          provenance: Object.fromEntries(
            spec.halves.map((h, i) => [HALF_WORDS[i], provenanceOf(h)]),
          ),
        })
      } else
        unsettled.push({
          file: spec.file,
          reference: HS_WORDS[ref.state],
          t27b: HS_WORDS[t27b.state],
        })
    }
    return { rows, unsettled }
  }

  const provenanceOf = (h: FeedHalf) => ({
    reason: SHARD_WORDS[h.reason],
    state: HS_WORDS[h.state],
    audit: h.audit === AU_NONE ? undefined : AU_WORDS[h.audit],
    source: h.from ? SOURCE_WORDS[h.from.source] : null,
    commit: h.from?.commit ?? null,
    job: h.from?.job ?? (h.job || undefined),
    run:
      h.from?.source === SOURCE_LAB
        ? deps.source.labUrl(h.from.commit)
        : undefined,
  })

  /** GET /hosting/corpus/:sha: the commit's corpus receipt. */
  async function receipt(sha: string) {
    const got = await loaded(sha)
    if (!got) return null
    const { rows, unsettled } = rowsOf(got.row, got.parts)
    return {
      ...summaryOf(got.row),
      counts: countsOf(got.row),
      rows,
      unsettled,
    }
  }

  /** GET /hosting/corpus/:sha/lab: the receipt against the lab's run of the same commit. */
  async function againstLab(sha: string) {
    const got = await loaded(sha)
    if (!got) return null
    const run = await labRunOf(got.row.commit)
    const { rows } = rowsOf(got.row, got.parts)
    const ours = new Map(rows.map((r) => [String(r.file), r]))
    const theirs = new Map((run?.results ?? []).map((r) => [String(r.file), r]))
    const tally: Record<string, number> = Object.fromEntries(
      CMP_WORDS.map((w) => [w, 0]),
    )
    const different: Array<{ file: string; keys: string[] }> = []
    const missing: string[] = []
    const extra: string[] = []
    if (run)
      for (const file of [
        ...new Set([...ours.keys(), ...theirs.keys()]),
      ].sort()) {
        const a = ours.get(file)
        const b = theirs.get(file)
        const keys = a && b ? differingKeys(a, b) : []
        const code = rowCompare(
          !!a,
          !!b,
          !!b &&
            partVotes(HALF_REFERENCE, partOfRow(b, HALF_REFERENCE)) &&
            partVotes(HALF_T27B, partOfRow(b, HALF_T27B)),
          keys.length === 0,
        )
        const word = CMP_WORDS[code] ?? String(code)
        tally[word] = (tally[word] ?? 0) + 1
        if (word === 'different') different.push({ file, keys })
        if (word === 'missing') missing.push(file)
        if (word === 'extra') extra.push(file)
      }
    const isComparable = comparable(got.row.toolchain[0], got.row.toolchain[1])
    const verdict = labVerdict(
      got.row.state,
      !!run,
      isComparable,
      different.length,
      missing.length,
      extra.length,
    )
    return {
      commit: got.row.commit,
      lab: deps.source.labUrl(got.row.commit),
      lab_found: !!run,
      comparable: isComparable,
      toolchain: summaryOf(got.row).toolchain,
      state: FEED_WORDS[got.row.state],
      verdict: LV_WORDS[verdict] ?? String(verdict),
      counts: tally,
      different,
      missing,
      extra,
    }
  }

  return { tick, status, receipt, againstLab }
}

export type HostingFeed = ReturnType<typeof createHostingFeed>

/** TRIOS_HOSTING_FEED=on (and TRIOS_HOSTING=on). Off by default. */
export function hostingFeedOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.TRIOS_HOSTING_FEED ?? 'off').trim().toLowerCase() === 'on'
}

/** The real reads: GitHub's API with the Queen's optional read-only token, raw files, the lab. */
export function githubFeedSource(
  opts: {
    repo?: string
    lab?: string
    fetcher?: typeof fetch
    token?: string
  } = {},
): FeedSource {
  const repo = opts.repo ?? FEED_REPO
  const lab = (opts.lab ?? FEED_LAB).replace(/\/+$/, '')
  const get = opts.fetcher ?? fetch
  const token = opts.token ?? process.env.TRIOS_GITHUB_API_TOKEN?.trim()
  const headers = (accept: string, extra: Record<string, string> = {}) => ({
    Accept: accept,
    'User-Agent': UA,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  })
  return {
    async head(previous) {
      const res = await get(`${GITHUB_API}/repos/${repo}/commits/master`, {
        headers: headers(
          'application/vnd.github.sha',
          previous ? { 'If-None-Match': previous } : {},
        ),
        signal: AbortSignal.timeout(20_000),
      })
      if (res.status === 304) return { unchanged: true }
      if (!res.ok) return null
      const sha = (await res.text()).trim()
      return HEX40.test(sha) ? { sha, etag: res.headers.get('etag') } : null
    },
    async tree(commit) {
      const res = await get(
        `${GITHUB_API}/repos/${repo}/git/trees/${commit}?recursive=1`,
        {
          headers: headers('application/vnd.github+json'),
          signal: AbortSignal.timeout(60_000),
        },
      )
      if (!res.ok) return null
      const body = (await res.json()) as {
        truncated?: boolean
        tree?: Array<{ path: string; sha: string }>
      }
      if (body.truncated || !Array.isArray(body.tree)) return null
      return new Map(body.tree.map((e) => [e.path, e.sha]))
    },
    async file(commit, path) {
      const res = await get(
        `${SPEC_SOURCE_BASE.replace('gHashTag/t27/', `${repo}/`)}${commit}/${path}`,
        { signal: AbortSignal.timeout(30_000) },
      )
      if (!res.ok) throw new Error(`${path} at ${commit}: HTTP ${res.status}`)
      return new Uint8Array(await res.arrayBuffer())
    },
    async labRun(commit) {
      const res = await get(`${lab}/runs/${commit}.json`, {
        signal: AbortSignal.timeout(60_000),
      })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`lab run ${commit}: HTTP ${res.status}`)
      const body = (await res.json()) as { results?: unknown }
      return Array.isArray(body.results)
        ? { results: body.results as Array<Record<string, unknown>> }
        : null
    },
    labUrl: (commit) => `${lab}/runs/${commit}.json`,
  }
}
