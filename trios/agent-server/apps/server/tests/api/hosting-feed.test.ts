/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * SELF-HOSTING, SLICE 2A (gHashTag/trios#1867): the Queen feeds the network
 * itself. The feed card as the wasm answers it; then the whole loop on a
 * VirtualClock: an in-memory GitHub and lab, the hosting Queen on the memory
 * store behind its own route, and two owner hosts that lease, run and report
 * through that route. Then parity on real data: t27 cf42584c9, every spec of a
 * closed subset of the corpus, against the t27b lab's own rows
 * (fixtures/hosting-feed-parity.json says where every byte came from).
 *
 * A last block runs the carry rule over the whole corpus on two real lab
 * runs, when FEED_LIVE_T27_REPO (a t27 clone) and FEED_LIVE_LAB_RUNS (a
 * directory of the lab's /runs/<sha>.json) are set.
 */

import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createHostingRoute } from '../../src/api/routes/hosting'
import {
  createHostAgent,
  type HostAgent,
  type LeasedJob,
} from '../../src/api/services/hosting-agent'
import {
  createHostingFeed,
  differingKeys,
  type FeedSource,
  partOfRow,
} from '../../src/api/services/hosting-feed'
import * as feedCard from '../../src/api/services/hosting-feed-cards'
import { createHostingQueen } from '../../src/api/services/hosting-queen'
import { createMemoryHostingStore } from '../../src/api/services/hosting-store'
import {
  generateHostKey,
  keyIdOf,
  readNormalized,
  rowOfParts,
  sha256Hex,
} from '../../src/api/services/hosting-wire'
import {
  FEED_DEADLINE_SECONDS,
  FEED_DEBOUNCE_SECONDS,
  FEED_POLL_SECONDS,
  FEEDS_PER_HOUR_MAX,
  HS_AGREED,
  HS_GAVE_UP,
  REFERENCE_SOURCES,
  SHARD_CARRY,
  SHARD_INPUT,
  SHARD_TOOLCHAIN,
  T27B_SOURCES,
  TC_DIFF,
  TC_SAME,
  TC_UNKNOWN,
} from '../../src/api/services/queen-hosting-feed-card.gen'
import {
  ISO_JOBDIR,
  TIER_OWNER,
} from '../../src/api/services/queen-hosting-host-card.gen'
import {
  JV_AGREED,
  JV_UNRESOLVED,
  SHARD_DOMAIN,
  VERDICT_WORDS,
} from '../../src/api/services/queen-hosting-proof-card.gen'
import {
  HALF_REFERENCE,
  HALF_T27B,
  T27B_DOMAIN,
  T27B_ROW_KEYS,
  T27B_WORDS,
} from '../../src/api/services/queen-hosting-row-card.gen'
import { DEFAULT_SPECS_ROOT } from '../../src/inngest/spec-catalog'
import { VirtualClock } from './queen-virtual-clock'

// Hours of Queen time on a VirtualClock are a few seconds of real time on an
// idle machine; at this Mac's usual load average (10 to 40) bun's 5 s default
// cut them short.
setDefaultTimeout(120_000)

const QUEEN = 'http://queen.test'
const MODEL = sha256Hex('t27c 0.5.2 as pinned for the feed tests')
const shaOf = (file: string) =>
  createHash('sha256')
    .update(readFileSync(join(DEFAULT_SPECS_ROOT, file)))
    .digest('hex')

type Row = Record<string, unknown>

// --- the card -----------------------------------------------------------------

describe('the feed card', () => {
  const pin = readFileSync(join(DEFAULT_SPECS_ROOT, 'PIN'), 'utf8')

  it('is the pinned bytes, and exports every fn of the spec and the ones gen-c pulls in', () => {
    for (const f of ['hosting/feed.t27', 'hosting/feed.wasm'])
      expect(pin).toContain(`${f} sha256 ${shaOf(f)}`)
    const source = readFileSync(
      join(DEFAULT_SPECS_ROOT, 'hosting/feed.t27'),
      'utf8',
    )
    const own = [...source.matchAll(/^pub fn (\w+)\(/gm)].map((m) => m[1])
    const mod = new WebAssembly.Module(
      readFileSync(join(DEFAULT_SPECS_ROOT, 'hosting/feed.wasm')),
    )
    const exported = new Set(WebAssembly.Module.exports(mod).map((e) => e.name))
    for (const fn of [...own, 'job_verdict', 'safe_m'])
      expect(exported.has(fn)).toBe(true)
    expect(WebAssembly.Module.imports(mod)).toEqual([])
    expect(pin).toContain(
      `exports every fn of the card and the ones gen-c pulls in: ${[...own, 'job_verdict', 'safe_m'].join(',')} (reproducible: two builds, one hash)`,
    )
  })

  it('answers as feed.t27 says', () => {
    expect(feedCard.pollDue(false, 0)).toBe(true)
    expect(feedCard.pollDue(true, FEED_POLL_SECONDS - 1)).toBe(false)
    expect(feedCard.feedDue(true, FEED_DEBOUNCE_SECONDS - 1, false, 0)).toBe(
      false,
    )
    expect(feedCard.feedDue(true, FEED_DEBOUNCE_SECONDS, false, 0)).toBe(true)
    expect(
      feedCard.feedDue(true, FEED_DEBOUNCE_SECONDS, false, FEEDS_PER_HOUR_MAX),
    ).toBe(false)
    expect(feedCard.toolchainPart(false, true)).toBe(TC_UNKNOWN)
    expect(feedCard.shardReason(true, TC_SAME, false, true, true, false)).toBe(
      SHARD_CARRY,
    )
    expect(feedCard.shardReason(true, TC_DIFF, false, true, true, false)).toBe(
      SHARD_TOOLCHAIN,
    )
    expect(feedCard.halfState(SHARD_INPUT, true, JV_AGREED)).toBe(HS_AGREED)
    expect(feedCard.halfState(SHARD_INPUT, true, JV_UNRESOLVED)).toBe(
      HS_GAVE_UP,
    )
    expect(feedCard.slotsToKeepUp(feedCard.slotMsPerHour(1858, 5830))).toBe(13)
  })
})

// --- a world on a VirtualClock -------------------------------------------------

interface FakeCommit {
  tree: Record<string, string>
  lab?: Row[]
}

/** GitHub and the lab, in memory; every request counted. */
function fakeSource(
  commits: Map<string, FakeCommit>,
  blobs: Map<string, string>,
  headOf: () => string,
) {
  const counts = { head: 0, unchanged: 0, tree: 0, file: 0, lab: 0 }
  const source: FeedSource = {
    async head(etag) {
      counts.head++
      const sha = headOf()
      const tag = `"${sha}"`
      if (etag === tag) {
        counts.unchanged++
        return { unchanged: true }
      }
      return { sha, etag: tag }
    },
    async tree(commit) {
      counts.tree++
      const t = commits.get(commit)?.tree
      return t ? new Map(Object.entries(t)) : null
    },
    async file(commit, path) {
      counts.file++
      const blob = commits.get(commit)?.tree[path]
      const text = blob === undefined ? undefined : blobs.get(blob)
      if (text === undefined) throw new Error(`${path} at ${commit}: 404`)
      return new TextEncoder().encode(text)
    },
    async labRun(commit) {
      counts.lab++
      const lab = commits.get(commit)?.lab
      return lab ? { results: lab } : null
    },
    labUrl: (commit) => `https://lab.test/runs/${commit}.json`,
  }
  return { source, counts }
}

/**
 * The normalized output an honest host reports for one half, made from the
 * lab's row of that spec: proof.t27 section 1 for the reference, t27b's own
 * row for t27b. readNormalized and the row assembly read it back to the row.
 */
function outputOfRow(spec: string, half: number, row: Row): string {
  if (half === HALF_T27B) {
    const lines = [T27B_DOMAIN, `spec=${spec}`]
    for (const k of T27B_ROW_KEYS)
      if (k in row) lines.push(`${k}=${JSON.stringify(row[k])}`)
    return `${lines.join('\n')}\n`
  }
  const word = String(row.reference)
  if (word === 'blocked')
    return `${SHARD_DOMAIN}\nspec=${spec}\nverdict=blocked\nreason=${row.reference_detail}\n`
  const listed = Object.entries(
    (row.reference_tests ?? {}) as Record<string, boolean>,
  )
  const counted = /^(\d+) of (\d+) tests fail$/.exec(
    String(row.reference_detail ?? ''),
  )
  const tests = counted
    ? Number(counted[2])
    : row.reference_tests
      ? listed.length
      : listed.length + 1
  const fail = counted ? Number(counted[1]) : 0
  return [
    SHARD_DOMAIN,
    `spec=${spec}`,
    `verdict=${word}`,
    `tests=${tests}`,
    `fail=${fail}`,
    'invariants=0',
    'asserts=0',
    'vacuous=0',
    ...listed.map(([name, ok]) => `test=${ok ? 'pass' : 'FAIL'} 0 ${name}`),
    '',
  ].join('\n')
}

/** A host's ShardResult from a normalized output, as normalizeShard would make it. */
function resultOf(half: number, output: string) {
  const stated = readNormalized(output)
  if (!stated) throw new Error(`unreadable output: ${output.slice(0, 80)}`)
  const words: readonly string[] =
    half === HALF_T27B ? T27B_WORDS : VERDICT_WORDS
  return {
    half,
    verdict: words.indexOf(stated.word),
    word: stated.word,
    output,
    outputHash: sha256Hex(output),
    ops: stated.ops,
    tests: stated.tests,
    fail: stated.fail ?? 0,
  }
}

function feedWorld(opts: {
  source: FeedSource
  pin: string
  genesis?: 'lab' | 'none'
  /** What an honest host outputs for a half of a spec at a commit; null: it never answers. */
  answer: (job: LeasedJob, host: number) => string | null
  hosts?: number
}) {
  const clock = new VirtualClock()
  const store = createMemoryHostingStore()
  const keys = Array.from({ length: opts.hosts ?? 2 }, () => generateHostKey())
  const queen = createHostingQueen({
    store,
    now: clock.now,
    allowlist: new Map(keys.map((k) => [keyIdOf(k.publicHex), TIER_OWNER])),
  })
  const lines: string[] = []
  const feed = createHostingFeed({
    store,
    queen,
    source: opts.source,
    now: clock.now,
    pin: opts.pin,
    genesis: opts.genesis ?? 'lab',
    log: (l) => lines.push(l),
  })
  let feedOn = true
  const app = new Hono().route(
    '/hosting',
    createHostingRoute({
      enabled: () => true,
      queen: () => queen,
      feed: () => (feedOn ? feed : null),
    }),
  )
  const agents: HostAgent[] = keys.map((k, i) =>
    createHostAgent({
      queenUrl: QUEEN,
      fetch: async (url, init) =>
        app.request(url.slice(QUEEN.length), {
          ...init,
          headers: {
            ...(init.headers as Record<string, string>),
            'x-forwarded-for': `203.0.113.${10 + i}`,
          },
        }),
      privatePem: k.privatePem,
      tierClaim: TIER_OWNER,
      slots: 1,
      platform: 'darwin-arm64',
      isolation: ISO_JOBDIR,
      runShard: async (job) => {
        const out = opts.answer(job, i)
        if (out === null) return new Promise(() => undefined)
        return {
          result: resultOf(job.half ?? HALF_REFERENCE, out),
          modelHash: MODEL,
          zig: '0.16.0',
        }
      },
      clock,
    }),
  )
  let started = false
  let halted = false
  async function start() {
    if (started) return
    started = true
    for (const a of agents) {
      await a.register()
      a.start()
    }
    const loop = () => {
      if (halted) return
      void feed.tick().finally(() => {
        if (!halted) clock.after(FEED_POLL_SECONDS * 1000, loop)
      })
    }
    loop()
  }
  const run = async (seconds: number) => {
    await start()
    await clock.runUntil(clock.now() + seconds * 1000)
  }
  // biome-ignore lint/suspicious/noExplicitAny: the tests read the routes' JSON as it comes
  const get = async (path: string): Promise<any> =>
    (await app.request(path)).json()
  const status = async (path: string) => (await app.request(path)).status
  const stop = () => {
    halted = true
    for (const a of agents) a.stop()
  }
  return {
    clock,
    store,
    queen,
    feed,
    run,
    get,
    status,
    stop,
    lines,
    setFeedOn: (on: boolean) => {
      feedOn = on
    },
  }
}

// --- the synthetic repository ------------------------------------------------

const P0 = '1'.repeat(40)
const H1 = '2'.repeat(40)
const H2 = '3'.repeat(40)
const H3 = '4'.repeat(40)
const blobId = (text: string) => sha256Hex(`blob ${text}`).slice(0, 40)

/** A small corpus: base <- mid <- top, and two specs that import nothing. */
function corpus(edits: Record<string, string> = {}) {
  const files: Record<string, string> = {
    'specs/a/base.t27': 'module A;\n',
    'specs/a/mid.t27': 'use a::base;\nmodule M;\n',
    'specs/a/top.t27': 'use a::mid::thing;\nmodule T;\n',
    'specs/b/single.t27': 'module B;\n',
    'specs/c/lone.t27': 'module C;\n',
    // two of t27b's own sources are specs of the corpus too (feed.t27 T27B_SOURCES)
    'specs/tri/t27b/libm.t27': 'module Libm;\n',
    'specs/tri/t27b/i128_plan.t27': 'module I128Plan;\n',
    ...edits,
  }
  return files
}

/** The toolchain sources that are not specs; the two that are come with the corpus. */
const TOOLCHAIN = Object.fromEntries(
  [...new Set([...REFERENCE_SOURCES, ...T27B_SOURCES])]
    .filter((p) => !p.startsWith('specs/'))
    .map((p) => [p, blobId(`toolchain ${p}`)]),
)

/** A lab-shaped row for a spec: pass/pass, with its tests named. */
function passRow(file: string, tag = ''): Row {
  const name = `${file.replace(/\W/g, '_')}${tag}`
  return {
    file,
    reference: 'pass',
    reference_detail: '',
    t27b: 'pass',
    tests: 1,
    invariants: 0,
    asserts: 1,
    blockers: [],
    detail: '',
    test_verdicts: { [name]: true },
    reference_tests: { [name]: true },
    reference_disagree: [],
  }
}

function syntheticWorld(
  heads: Array<{
    sha: string
    edits?: Record<string, string>
    toolchain?: Record<string, string>
    rows?: Record<string, Row>
  }>,
) {
  const commits = new Map<string, FakeCommit>()
  const blobs = new Map<string, string>()
  const truth = new Map<string, Row>()
  for (const h of heads) {
    const files = corpus(h.edits)
    const tree: Record<string, string> = {
      ...TOOLCHAIN,
      ...(h.toolchain ?? {}),
    }
    for (const [p, text] of Object.entries(files)) {
      const id = blobId(text)
      blobs.set(id, text)
      tree[p] = id
    }
    const lab = Object.keys(files)
      .sort()
      .map(
        (f) =>
          h.rows?.[f] ?? passRow(f, blobId(files[f] as string).slice(0, 4)),
      )
    for (const r of lab) truth.set(`${h.sha} ${r.file}`, r)
    commits.set(h.sha, { tree, lab })
  }
  let head = heads[0]?.sha as string
  const { source, counts } = fakeSource(commits, blobs, () => head)
  return {
    commits,
    source,
    counts,
    truth,
    setHead: (sha: string) => {
      head = sha
    },
  }
}

describe('the feed, on a VirtualClock', () => {
  it('asks GitHub no oftener than every FEED_POLL_SECONDS, and an unchanged head costs a 304', async () => {
    const s = syntheticWorld([{ sha: P0 }])
    const w = feedWorld({
      source: s.source,
      pin: P0,
      answer: () => null,
    })
    await w.run(3600)
    // ticks at 0, 300, ..., 3600: 13 requests in the hour, 12 of them 304
    expect(s.counts.head).toBe(13)
    expect(s.counts.unchanged).toBe(12)
    w.stop()
  })

  it('feeds a settled head, shards only the closures that changed, and agrees with the lab', async () => {
    const s = syntheticWorld([
      { sha: P0 },
      { sha: H1, edits: { 'specs/a/base.t27': 'module A;\nconst X = 1;\n' } },
    ])
    s.setHead(H1)
    const w = feedWorld({
      source: s.source,
      pin: P0,
      answer: (job) =>
        outputOfRow(
          job.spec,
          job.half ?? 0,
          s.truth.get(`${job.commit} ${job.spec}`) as Row,
        ),
    })
    // seen at 0; not fed before FEED_DEBOUNCE_SECONDS
    await w.run(FEED_DEBOUNCE_SECONDS - 10)
    expect((await w.get('/hosting/corpus')).feeds).toEqual([])
    await w.run(600)
    const receipt = await w.get(`/hosting/corpus/${H1}`)
    expect(receipt.state).toBe('complete')
    expect(receipt.base).toBe(`lab:${P0}`)
    const reasons = Object.fromEntries(
      receipt.rows.map((r: Row) => [
        r.file,
        (r.provenance as Record<string, Row>).reference.reason,
      ]),
    )
    // base changed, and mid and top import it: three specs, both halves
    expect(reasons['specs/a/base.t27']).toBe('input')
    expect(reasons['specs/a/mid.t27']).toBe('input')
    expect(reasons['specs/a/top.t27']).toBe('input')
    expect(reasons['specs/b/single.t27']).toBe('carry')
    expect(reasons['specs/c/lone.t27']).toBe('carry')
    const solo = receipt.rows.find((r: Row) => r.file === 'specs/b/single.t27')
    expect(solo.provenance.t27b).toMatchObject({
      source: 'lab',
      commit: P0,
      run: `https://lab.test/runs/${P0}.json`,
    })
    const top = receipt.rows.find((r: Row) => r.file === 'specs/a/top.t27')
    expect(top.provenance.reference).toMatchObject({
      source: 'hosting',
      commit: H1,
      state: 'agreed',
    })
    expect(receipt.counts).toMatchObject({ specs: 7, rows: 7, sharded: 6 })
    const lab = await w.get(`/hosting/corpus/${H1}/lab`)
    expect(lab).toMatchObject({
      verdict: 'agrees',
      comparable: true,
      lab_found: true,
      counts: { equal: 7, different: 0, missing: 0, extra: 0 },
    })
    // the jobs came in through the Queen's own owner path: no host submitted one
    const job = await w.get(`/hosting/jobs/${top.provenance.reference.job}`)
    expect(job).toMatchObject({
      commit: H1,
      spec: 'specs/a/top.t27',
      verdict: 'agreed',
    })
    w.stop()
  })

  it('carries from its own last receipt, keeps the provenance, and never feeds a head twice', async () => {
    const s = syntheticWorld([
      { sha: P0 },
      { sha: H1, edits: { 'specs/a/base.t27': 'module A;\nconst X = 1;\n' } },
      {
        sha: H2,
        edits: {
          'specs/a/base.t27': 'module A;\nconst X = 1;\n',
          'specs/b/single.t27': 'module B;\nconst Y = 2;\n',
        },
      },
    ])
    s.setHead(H1)
    const w = feedWorld({
      source: s.source,
      pin: P0,
      answer: (job) =>
        outputOfRow(
          job.spec,
          job.half ?? 0,
          s.truth.get(`${job.commit} ${job.spec}`) as Row,
        ),
    })
    await w.run(1200)
    s.setHead(H2)
    await w.run(1800)
    const receipt = await w.get(`/hosting/corpus/${H2}`)
    expect(receipt.base).toBe(H1)
    const prov = (file: string) =>
      receipt.rows.find((r: Row) => r.file === file).provenance.reference
    expect(prov('specs/b/single.t27')).toMatchObject({
      reason: 'input',
      commit: H2,
    })
    // carried from H1's feed, still naming the H1 job that made it
    expect(prov('specs/a/top.t27')).toMatchObject({
      reason: 'carry',
      source: 'hosting',
      commit: H1,
    })
    expect(prov('specs/c/lone.t27')).toMatchObject({
      reason: 'carry',
      source: 'lab',
      commit: P0,
    })
    expect(receipt.counts.sharded).toBe(2)
    expect((await w.get(`/hosting/corpus/${H2}/lab`)).verdict).toBe('agrees')
    // the head did not move again: no third feed
    await w.run(3600)
    expect(
      (await w.get('/hosting/corpus')).feeds.map((f: Row) => f.id),
    ).toEqual([H2, H1, `lab:${P0}`])
    w.stop()
  })

  it('a commit whose toolchain moved is fed under the pin and never called equal to the lab', async () => {
    const moved = { 'cli/t27b': blobId('a newer t27b') }
    const s = syntheticWorld([
      { sha: P0 },
      {
        sha: H3,
        toolchain: moved,
        edits: { 'specs/c/lone.t27': 'module C;\n// edited\n' },
      },
    ])
    s.setHead(H3)
    const w = feedWorld({
      source: s.source,
      pin: P0,
      answer: (job) =>
        outputOfRow(
          job.spec,
          job.half ?? 0,
          s.truth.get(`${job.commit} ${job.spec}`) as Row,
        ),
    })
    await w.run(1500)
    const lab = await w.get(`/hosting/corpus/${H3}/lab`)
    expect(lab.toolchain).toMatchObject({
      reference: 'same',
      t27b: 'different',
      comparable_with_lab: false,
    })
    // every row is equal, and still it is not the lab's receipt
    expect(lab.counts.different).toBe(0)
    expect(lab.verdict).toBe('not_comparable')
    // the pin did not move, so the carrying did not either: one spec sharded
    expect((await w.get(`/hosting/corpus/${H3}`)).counts.sharded).toBe(2)
    w.stop()
  })

  it('re-runs a base half that was no vote, and a half whose base was made with another toolchain', async () => {
    const timedOut = { ...passRow('specs/c/lone.t27'), t27b: 'timeout' }
    const s = syntheticWorld([
      { sha: P0, rows: { 'specs/c/lone.t27': timedOut } },
      { sha: H1 },
    ])
    s.setHead(H1)
    const w = feedWorld({
      source: s.source,
      pin: P0,
      answer: (job) =>
        outputOfRow(
          job.spec,
          job.half ?? 0,
          s.truth.get(`${job.commit} ${job.spec}`) as Row,
        ),
    })
    await w.run(1500)
    const row = (await w.get(`/hosting/corpus/${H1}`)).rows.find(
      (r: Row) => r.file === 'specs/c/lone.t27',
    )
    expect(row.provenance.t27b.reason).toBe('unsettled')
    expect(row.provenance.reference.reason).toBe('carry')
    expect(row.t27b).toBe('pass')
    w.stop()
    // hosts re-pinned to a toolchain whose t27b sources moved, with no lab
    // receipt of the new pin: the old pin's receipt is the base, its
    // reference halves carry and its t27b halves are sharded (SHARD_TOOLCHAIN)
    const s2 = syntheticWorld([
      { sha: P0 },
      { sha: H1, toolchain: { 'cli/t27b': blobId('another t27b') } },
    ])
    s2.setHead(P0)
    const w2 = feedWorld({
      source: s2.source,
      pin: P0,
      genesis: 'none',
      answer: (job) =>
        outputOfRow(
          job.spec,
          job.half ?? 0,
          s2.truth.get(`${job.commit} ${job.spec}`) as Row,
        ),
    })
    await w2.run(1500)
    expect((await w2.get(`/hosting/corpus/${P0}`)).state).toBe('complete')
    w2.stop()
    const repinned = createHostingFeed({
      store: w2.store,
      queen: w2.queen,
      source: s2.source,
      now: w2.clock.now,
      pin: H1,
      genesis: 'none',
    })
    s2.setHead(H1)
    await repinned.tick()
    await w2.clock.runUntil(w2.clock.now() + FEED_DEBOUNCE_SECONDS * 1000)
    await repinned.tick()
    const fed = await repinned.receipt(H1)
    expect(fed?.base).toBe(P0)
    expect(fed?.counts.halves_by_reason).toEqual({ carry: 7, toolchain: 7 })
  })

  it('an audit that disagrees poisons its half, and the next feed carries nothing in it', async () => {
    // a spec whose path falls in round 1 of the audit (feed.t27 audit_pick)
    let picked = ''
    for (let i = 0; !picked; i++) {
      const p = `specs/z/pick${i}.t27`
      if (feedCard.auditPick(Number.parseInt(sha256Hex(p).slice(0, 8), 16), 1))
        picked = p
    }
    const edits = { [picked]: 'module Z;\n' }
    const s = syntheticWorld([
      { sha: P0, edits },
      { sha: H1, edits },
      {
        sha: H2,
        edits: { ...edits, 'specs/b/single.t27': 'module B;\n// two\n' },
      },
    ])
    s.setHead(H1)
    // the hosts see the picked spec's t27b half fail, where the lab saw a pass:
    // what a carry that hides a difference looks like to the audit
    const w = feedWorld({
      source: s.source,
      pin: P0,
      answer: (job) => {
        const row = s.truth.get(`${job.commit} ${job.spec}`) as Row
        return outputOfRow(
          job.spec,
          job.half ?? 0,
          job.spec === picked ? { ...row, t27b: 'fail' } : row,
        )
      },
    })
    await w.run(1500)
    const first = await w.get(`/hosting/corpus/${H1}`)
    const audited = first.rows.find((r: Row) => r.file === picked)
    expect(audited.provenance.t27b).toMatchObject({
      reason: 'audit',
      audit: 'poisoned',
    })
    expect(audited.provenance.reference).toMatchObject({
      reason: 'audit',
      audit: 'agrees',
    })
    // the receipt takes the hosts' answer
    expect(audited.t27b).toBe('fail')
    expect(first.counts.audit).toMatchObject({ poisoned: 1, agrees: 1 })
    s.setHead(H2)
    await w.run(1800)
    const second = await w.get(`/hosting/corpus/${H2}`)
    expect(second.voided).toEqual({ reference: false, t27b: true })
    // every t27b half is sharded again; the reference halves carry as before
    for (const r of second.rows) {
      expect(r.provenance.t27b.reason).toBe('voided')
      expect(['carry', 'input', 'audit']).toContain(
        r.provenance.reference.reason,
      )
    }
    w.stop()
  })

  it('a feed nobody can finish is abandoned after FEED_DEADLINE_SECONDS and is never a base', async () => {
    const s = syntheticWorld([
      { sha: P0 },
      { sha: H1, edits: { 'specs/c/lone.t27': 'module C;\n// one\n' } },
      { sha: H2, edits: { 'specs/c/lone.t27': 'module C;\n// two\n' } },
    ])
    s.setHead(H1)
    // no host at all: nothing is ever leased
    const w = feedWorld({
      source: s.source,
      pin: P0,
      answer: () => null,
      hosts: 0,
    })
    await w.run(FEED_DEADLINE_SECONDS + 1200)
    const feeds = (await w.get('/hosting/corpus')).feeds
    expect(feeds.find((f: Row) => f.id === H1).state).toBe('abandoned')
    s.setHead(H2)
    await w.run(1200)
    const next = await w.get(`/hosting/corpus/${H2}`)
    expect(next.base).toBe(`lab:${P0}`)
    w.stop()
  })

  it('a job that ends unresolved is given up: the receipt completes without that row', async () => {
    const s = syntheticWorld([
      { sha: P0 },
      { sha: H1, edits: { 'specs/c/lone.t27': 'module C;\n// one\n' } },
    ])
    s.setHead(H1)
    const w = feedWorld({ source: s.source, pin: P0, answer: () => null })
    await w.run(FEED_DEBOUNCE_SECONDS + 10)
    // the hosts never answer; the Queen ends both jobs unresolved
    await w.store.tx(async (st) => {
      for (const j of await st.jobs()) {
        j.state = 'unresolved'
        j.verdict = JV_UNRESOLVED
        await st.putJob(j)
      }
    })
    await w.run(FEED_POLL_SECONDS)
    const receipt = await w.get(`/hosting/corpus/${H1}`)
    expect(receipt.state).toBe('complete')
    expect(receipt.rows.length).toBe(6)
    expect(receipt.unsettled).toEqual([
      { file: 'specs/c/lone.t27', reference: 'gave_up', t27b: 'gave_up' },
    ])
    const lab = await w.get(`/hosting/corpus/${H1}/lab`)
    expect(lab).toMatchObject({
      verdict: 'differs',
      missing: ['specs/c/lone.t27'],
    })
    w.stop()
  })

  it('starts at most FEEDS_PER_HOUR_MAX feeds an hour while master keeps moving', async () => {
    const heads = Array.from({ length: 12 }, (_, i) => ({
      sha: (i + 10).toString(16).repeat(40).slice(0, 40),
      edits: { 'specs/c/lone.t27': `module C;\n// ${i}\n` },
    }))
    const s = syntheticWorld([{ sha: P0 }, ...heads])
    const w = feedWorld({
      source: s.source,
      pin: P0,
      answer: (job) =>
        outputOfRow(
          job.spec,
          job.half ?? 0,
          s.truth.get(`${job.commit} ${job.spec}`) as Row,
        ),
    })
    // a new head every 11 minutes for two hours
    for (const h of heads) {
      s.setHead(h.sha)
      await w.run(660)
    }
    const starts = (await w.get('/hosting/corpus')).feeds
      .filter((f: Row) => f.seq > 0)
      .map((f: Row) => Date.parse(String(f.started_at)))
      .sort()
    for (const t of starts)
      expect(
        starts.filter((u: number) => u >= t && u < t + 3600_000).length,
      ).toBeLessThanOrEqual(FEEDS_PER_HOUR_MAX)
    // master moved 12 times; the debounce and the cap fed fewer
    expect(starts.length).toBeGreaterThan(0)
    expect(starts.length).toBeLessThan(heads.length)
    w.stop()
  })

  it('answers 503 with the feed off, and 404 for a commit never fed', async () => {
    const s = syntheticWorld([{ sha: P0 }])
    const w = feedWorld({ source: s.source, pin: P0, answer: () => null })
    expect(await w.status(`/hosting/corpus/${H1}`)).toBe(404)
    w.setFeedOn(false)
    expect(await w.status('/hosting/corpus')).toBe(503)
    expect((await w.get('/hosting/corpus')).error).toBe('feed_off')
    const off = new Hono().route(
      '/hosting',
      createHostingRoute({ enabled: () => false }),
    )
    expect((await off.request('/hosting/corpus')).status).toBe(503)
    expect(await (await off.request('/hosting/corpus')).json()).toEqual({
      error: 'hosting_off',
    })
  })

  it('two Queens over one store feed a head once', async () => {
    const s = syntheticWorld([
      { sha: P0 },
      { sha: H1, edits: { 'specs/c/lone.t27': 'module C;\n// one\n' } },
    ])
    s.setHead(H1)
    const w = feedWorld({ source: s.source, pin: P0, answer: () => null })
    const second = createHostingFeed({
      store: w.store,
      queen: w.queen,
      source: s.source,
      now: w.clock.now,
      pin: P0,
    })
    await second.tick()
    await w.clock.runUntil(FEED_DEBOUNCE_SECONDS * 1000)
    await Promise.all([w.feed.tick(), second.tick()])
    const feeds = await w.store.tx((st) => st.feeds())
    expect(feeds.filter((f) => f.id === H1).length).toBe(1)
    expect((await w.store.tx((st) => st.jobs())).length).toBe(2)
  })
})

// --- parity on real data --------------------------------------------------------

interface Fixture {
  pin: string
  base: string
  commits: Record<string, { paths: string[]; ids: string[]; lab: Row[] }>
  blobs: Record<string, string>
  hosts: Record<string, string>
  host_source: Record<string, string>
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dir, 'fixtures/hosting-feed-parity.json'),
    'utf8',
  ),
) as Fixture

function fixtureSource(head: string) {
  const commits = new Map(
    Object.entries(fixture.commits).map(([c, v]) => [
      c,
      {
        tree: Object.fromEntries(
          v.paths.map((p, i) => [p, v.ids[i] as string]),
        ),
        lab: v.lab,
      },
    ]),
  )
  return fakeSource(commits, new Map(Object.entries(fixture.blobs)), () => head)
}

describe('parity on real data: t27 cf42584c9 against the t27b lab', () => {
  it("a lab row's two halves reassemble to the lab's row, on every compared key", () => {
    for (const c of Object.values(fixture.commits))
      for (const row of c.lab) {
        const again = rowOfParts(
          String(row.file),
          partOfRow(row, HALF_REFERENCE),
          partOfRow(row, HALF_T27B),
        )
        expect(differingKeys(again, row)).toEqual([])
        expect(Object.keys(again)).not.toContain('retried_after_timeout')
      }
  })

  it('every fed row equals the lab row: 43 specs, both halves, from real host outputs', async () => {
    const { source } = fixtureSource(fixture.pin)
    const w = feedWorld({
      source,
      pin: fixture.pin,
      genesis: 'none',
      answer: (job) => fixture.hosts[`${job.spec} ${job.half ?? 0}`] ?? null,
    })
    await w.run(FEED_DEBOUNCE_SECONDS + 1800)
    const receipt = await w.get(`/hosting/corpus/${fixture.pin}`)
    expect(receipt.state).toBe('complete')
    expect(receipt.counts).toMatchObject({
      specs: 43,
      rows: 43,
      sharded: 86,
      carried: 0,
    })
    expect(receipt.counts.halves_by_reason).toEqual({ new: 86 })
    const lab = await w.get(`/hosting/corpus/${fixture.pin}/lab`)
    expect(lab).toMatchObject({
      verdict: 'agrees',
      comparable: true,
      counts: { equal: 43, different: 0, missing: 0, extra: 0, excused: 0 },
    })
    // 24 of the 43 are the production rehearsal's own outputs
    const production = Object.values(fixture.host_source).filter((v) =>
      v.startsWith('production'),
    ).length
    expect(production).toBe(48)
    w.stop()
  })

  it('a stale pin carries rows the lab later changed: they are named, and the receipt is not comparable', async () => {
    // the hosts as if pinned at 8e2e44b7e, the lab run before cf42584c9
    const { source } = fixtureSource(fixture.pin)
    const w = feedWorld({
      source,
      pin: fixture.base,
      answer: (job) => fixture.hosts[`${job.spec} ${job.half ?? 0}`] ?? null,
    })
    await w.run(FEED_DEBOUNCE_SECONDS + 1800)
    const receipt = await w.get(`/hosting/corpus/${fixture.pin}`)
    expect(receipt.state).toBe('complete')
    expect(receipt.base).toBe(`lab:${fixture.base}`)
    const lab = await w.get(`/hosting/corpus/${fixture.pin}/lab`)
    expect(lab.verdict).toBe('not_comparable')
    expect(lab.toolchain).toMatchObject({
      reference: 'different',
      t27b: 'different',
    })
    const reasonOf = new Map(
      receipt.rows.map((r: Row) => [
        r.file,
        (r.provenance as Record<string, Row>).t27b.reason,
      ]),
    )
    // t27b 9a0f4c394 ("refuse a reached fn with no body") landed between the two
    // runs: three carried t27b halves are not what the lab saw at cf42584c9
    const differing = lab.different.map((d: { file: string }) => d.file).sort()
    expect(differing).toEqual([
      'specs/file/watcher.t27',
      'specs/git/diff.t27',
      'specs/ml/optimizer/adamw.t27',
    ])
    for (const d of lab.different) {
      expect(reasonOf.get(d.file)).toBe('carry')
      expect(d.keys).toEqual(['blockers', 'detail'])
    }
    w.stop()
  })
})

// --- the whole corpus, two real lab runs (opt-in) ------------------------------------

const LIVE_REPO = process.env.FEED_LIVE_T27_REPO
const LIVE_RUNS = process.env.FEED_LIVE_LAB_RUNS
const LIVE_FROM =
  process.env.FEED_LIVE_FROM ?? 'd2570f4a8a391151e4a8ee246217ff02bbe6e767'
const LIVE_TO =
  process.env.FEED_LIVE_TO ?? '7cb53d623023e3bfbf9da94d7f4e2a5d320a094e'

describe.skipIf(!LIVE_REPO || !LIVE_RUNS)(
  'the carry rule over the whole corpus, on two real lab runs',
  () => {
    it('carries every unchanged row of a toolchain that held: every settled row equals the lab', async () => {
      const git = (...args: string[]) =>
        spawnSync('git', ['-C', LIVE_REPO as string, ...args], {
          encoding: 'utf8',
          maxBuffer: 1 << 28,
        }).stdout
      const commits = new Map<string, FakeCommit>()
      const blobs = new Map<string, string>()
      for (const c of [LIVE_FROM, LIVE_TO]) {
        const tree: Record<string, string> = {}
        for (const line of git('ls-tree', '-r', '-t', c).split('\n')) {
          const [meta, path] = line.split('\t')
          if (path) tree[path] = (meta as string).split(' ')[2] as string
        }
        const runFile = join(LIVE_RUNS as string, `${c}.json`)
        expect(existsSync(runFile)).toBe(true)
        commits.set(c, {
          tree,
          lab: (JSON.parse(readFileSync(runFile, 'utf8')) as { results: Row[] })
            .results,
        })
      }
      const want = new Set(
        [...commits.values()].flatMap((c) =>
          Object.entries(c.tree)
            .filter(([p]) => /^specs\/.*\.t27$/.test(p))
            .map(([, b]) => b),
        ),
      )
      for (const b of want) blobs.set(b, git('cat-file', 'blob', b))
      const { source } = fakeSource(commits, blobs, () => LIVE_TO)
      const rows = new Map(
        (commits.get(LIVE_TO)?.lab ?? []).map((r) => [String(r.file), r]),
      )
      const w = feedWorld({
        source,
        pin: LIVE_FROM,
        answer: (job) => {
          const r = rows.get(job.spec)
          return r ? outputOfRow(job.spec, job.half ?? 0, r) : null
        },
      })
      await w.run(FEED_DEBOUNCE_SECONDS + 3600)
      const receipt = await w.get(`/hosting/corpus/${LIVE_TO}`)
      const lab = await w.get(`/hosting/corpus/${LIVE_TO}/lab`)
      console.log(
        JSON.stringify({
          counts: receipt.counts,
          unsettled: receipt.unsettled,
          lab: {
            verdict: lab.verdict,
            counts: lab.counts,
            toolchain: lab.toolchain,
          },
        }),
      )
      expect(lab.comparable).toBe(true)
      expect(lab.counts.different).toBe(0)
      expect(lab.counts.missing).toBe(0)
      expect(lab.counts.extra).toBe(0)
      expect(lab.counts.equal).toBe(receipt.rows.length)
      // what stays open is what the lab itself timed out on: a replayed
      // timeout is no vote (row.t27), so no job of it can agree, and the
      // receipt honestly stays incomplete
      const timedOut = new Set(
        [...rows.values()]
          .filter((r) => r.reference === 'timeout' || r.t27b === 'timeout')
          .map((r) => String(r.file)),
      )
      for (const u of receipt.unsettled) expect(timedOut.has(u.file)).toBe(true)
      expect(lab.verdict).toBe(
        receipt.unsettled.length === 0 ? 'agrees' : 'incomplete',
      )
      w.stop()
    }, 600_000)
  },
)
