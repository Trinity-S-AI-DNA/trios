/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE BENCHMARK BEFORE THE SWAP, FOR TURNS THAT STOP (turn_stop.t27,
 * trios#1713, numbers on t27#7851). The owner's rule: a mechanism replaces
 * another only after both run the same input and the numbers are posted.
 *
 * Part A, the reviewer under stalls, on a virtual clock. Each scenario is
 * drawn once from a fixed seed: arrivals, and for each row the fate of each
 * attempt. The same draw runs twice: `before` is the actor reviewer as it is
 * (createActorSystem without turnStop), `after` is the reviewer with
 * turnStop, which also puts its workers under their own one_for_one
 * supervisor (queen-review-actors.ts, `tree`). A fate is one of:
 *   ok     the review ends inside its row bound (lognormal, at most 0.9 x 300 s)
 *   crash  it throws at 30% of its length
 *   hears  a stall that hears its abort: its measurement runs 180-300 s, then
 *          it takes a key lane and its model call hangs to the call's own
 *          120 s timeout (REVIEW_TIMEOUT_MS). The turn is killed at 300 s
 *          with the call in flight. This is the stall production shows.
 *   deaf   a stall in a step that never hears its abort: it hangs 1800 s.
 *          Nothing on the loop can stop it; this measures what is left.
 * A row whose attempt stalled still waits and is tried again.
 * Columns: mostAtOnce is the most reviews running at once; secondsAboveBound
 * the time more than REVIEWER_CONCURRENCY ran; reviewSecondsBeyondBound the
 * review-seconds run past the bound; hearsFree* and deafFree* the seconds from
 * a stalled review's kill to its lane freed. The simulation has no key-lane
 * limit, so a review past the bound costs nothing here; in production it is a
 * call on a lane the bound exists to protect (z.ai refuses a third concurrent
 * request with 1302).
 *
 * Part B, process turns that leave a grandchild, on the real clock and real
 * processes. `before` is processWork as it was at actors-next b7aaf6bb0
 * (SIGKILL to the one pid spawned), copied below; `after` is processWork now
 * with turnStop. Half of the turns ignore SIGTERM.
 *
 * The tables are printed. QUEEN_BENCH_OUT writes them as JSON too. The
 * asserts check only that every run accounts for its input and that nothing
 * is left running when the bench ends; which side wins is the output.
 */

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createActorSystem,
  type IsolatedWork,
  supervisor,
} from '../../src/api/services/queen-actors'
import {
  ROOT_MAX_RESTARTS,
  ROOT_PERIOD_SECONDS,
  STRAT_ONE_FOR_ONE,
} from '../../src/api/services/queen-actors-card.gen'
import { processWork } from '../../src/api/services/queen-actors-isolate'
import { reviewerTree } from '../../src/api/services/queen-review-actors'
import { REVIEW_TIMEOUT_MS } from '../../src/api/services/queen-reviewer'
import {
  REVIEW_ROW_SECONDS,
  REVIEWER_CONCURRENCY,
} from '../../src/api/services/queen-reviewer-card.gen'
import { VirtualClock } from './queen-virtual-clock'

const HOUR = 3_600_000
const DEAF_SECONDS = 1800
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Fate = 'ok' | 'crash' | 'hears' | 'deaf'
interface Attempt {
  fate: Fate
  /** ok/crash: its length. hears: its measurement before the model call. */
  seconds: number
}
interface Workload {
  name: string
  arrivals: Array<{ issue: number; at: number }>
  attempts: Map<number, Attempt[]>
  horizonMs: number
}

const mulberry32 = (seed: number) => {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function workload(
  name: string,
  seed: number,
  o: {
    perHour: number
    hours: number
    medianSeconds: number
    crash: number
    hears: number
    deaf: number
  },
): Workload {
  const rnd = mulberry32(seed)
  const normal = () =>
    Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd())
  const arrivals: Workload['arrivals'] = []
  let issue = 1000
  let t = 0
  for (;;) {
    t += (-Math.log(1 - rnd()) / o.perHour) * HOUR
    if (t >= o.hours * HOUR) break
    arrivals.push({ issue: issue++, at: Math.floor(t) })
  }
  const attempts = new Map<number, Attempt[]>()
  for (const a of arrivals) {
    const list: Attempt[] = []
    for (let k = 0; k < 8; k++) {
      const u = rnd()
      const fate: Fate =
        u < o.crash
          ? 'crash'
          : u < o.crash + o.hears
            ? 'hears'
            : u < o.crash + o.hears + o.deaf
              ? 'deaf'
              : 'ok'
      const length = Math.min(
        Math.round(REVIEW_ROW_SECONDS * 0.9),
        Math.max(5, Math.round(o.medianSeconds * Math.exp(0.7 * normal()))),
      )
      // a stalled model call starts late enough to be in flight at the bound
      const measured = 180 + Math.floor(rnd() * (REVIEW_ROW_SECONDS - 181))
      list.push({ fate, seconds: fate === 'hears' ? measured : length })
    }
    attempts.set(a.issue, list)
  }
  return { name, arrivals, attempts, horizonMs: (o.hours + 1) * HOUR }
}

type Side = 'before' | 'after'

interface ReviewerResult {
  scenario: string
  side: Side
  rows: number
  done: number
  open: number
  perHour: number
  doneP95: number
  mostAtOnce: number
  secondsAboveBound: number
  reviewSecondsBeyondBound: number
  killed: number
  hearsKilled: number
  hearsFreeP50: number
  hearsFreeMax: number
  deafKilled: number
  deafFreeMax: number
}

const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const sec = (ms: number) => Math.round(ms / 1000)
const judged = () => ({ acted: [], strays: [], tally: [] })

async function simulate(w: Workload, side: Side): Promise<ReviewerResult> {
  const clock = new VirtualClock()
  const arrived = new Map<number, number>()
  const completed = new Map<number, number>()
  const attemptOf = new Map<number, number>()
  const fence = new Map<number, number>()
  const freed: Record<'hears' | 'deaf', number[]> = { hears: [], deaf: [] }
  let live = 0
  let most = 0
  let aboveSince = -1
  let aboveMs = 0
  // review-seconds run beyond the bound: the integral of (live - bound) > 0
  let excessMs = 0
  let lastAt = 0
  const track = (delta: number) => {
    const now = clock.now()
    excessMs += Math.max(0, live - REVIEWER_CONCURRENCY) * (now - lastAt)
    lastAt = now
    live += delta
    most = Math.max(most, live)
    if (live > REVIEWER_CONCURRENCY && aboveSince < 0) aboveSince = now
    if (live <= REVIEWER_CONCURRENCY && aboveSince >= 0) {
      aboveMs += now - aboveSince
      aboveSince = -1
    }
  }

  const waiting = async () =>
    [...arrived.keys()].filter((n) => !completed.has(n))
  const reviewOne = async (
    issue: number,
    onLane: (k: number | undefined) => void,
    signal?: AbortSignal,
  ) => {
    const start = clock.now()
    const k = attemptOf.get(issue) ?? 0
    attemptOf.set(issue, k + 1)
    const token = (fence.get(issue) ?? 0) + 1
    fence.set(issue, token)
    const a = (w.attempts.get(issue) as Attempt[])[k % 8]
    track(1)
    // the wait a step does: `hearing` steps end at once on the abort
    const step = (ms: number, hearing: boolean) =>
      new Promise<void>((resolve, reject) => {
        clock.after(ms, resolve)
        if (hearing)
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          })
      })
    try {
      if (a.fate === 'ok') {
        await step(a.seconds * 1000, true)
        if (fence.get(issue) === token && !completed.has(issue))
          completed.set(issue, clock.now())
      } else if (a.fate === 'crash') {
        await step(a.seconds * 300, true)
        throw new Error('review crashed')
      } else if (a.fate === 'hears') {
        await step(a.seconds * 1000, true)
        onLane(issue % 97)
        // the model call: its own timeout, and the turn's abort
        await step(REVIEW_TIMEOUT_MS, true)
      } else {
        await step(DEAF_SECONDS * 1000, false)
      }
      return judged()
    } finally {
      track(-1)
      const ran = clock.now() - start
      if (
        (a.fate === 'hears' || a.fate === 'deaf') &&
        ran >= REVIEW_ROW_SECONDS * 1000
      )
        freed[a.fate].push(ran - REVIEW_ROW_SECONDS * 1000)
    }
  }

  const sys = createActorSystem(clock, { turnStop: side === 'after' })
  const r = reviewerTree(sys, {
    holdsLease: async () => true,
    waiting,
    reviewOne: (issue, _keys, onLane, signal) =>
      reviewOne(issue, onLane, signal),
  })
  supervisor(
    sys,
    {
      name: 'root',
      strategy: STRAT_ONE_FOR_ONE,
      maxRestarts: ROOT_MAX_RESTARTS,
      periodSeconds: ROOT_PERIOD_SECONDS,
    },
    [r.tree],
  ).start(() => {})
  for (const a of w.arrivals)
    clock.after(a.at, () => {
      arrived.set(a.issue, a.at)
      r.wake()
    })
  await clock.runUntil(w.horizonMs)
  if (aboveSince >= 0) aboveMs += w.horizonMs - aboveSince

  const done = [...completed].map(([n, at]) => at - (arrived.get(n) as number))
  return {
    scenario: w.name,
    side,
    rows: arrived.size,
    done: completed.size,
    open: arrived.size - completed.size,
    perHour: Math.round((completed.size / (w.horizonMs / HOUR)) * 10) / 10,
    doneP95: sec(pct(done, 95)),
    mostAtOnce: most,
    secondsAboveBound: sec(aboveMs),
    reviewSecondsBeyondBound: sec(excessMs),
    killed: sys.stats.killed,
    hearsKilled: freed.hears.length,
    hearsFreeP50: sec(pct(freed.hears, 50)),
    hearsFreeMax: sec(Math.max(0, ...freed.hears)),
    deafKilled: freed.deaf.length,
    deafFreeMax: sec(Math.max(0, ...freed.deaf)),
  }
}

const SCENARIOS: Workload[] = [
  workload('steady 45/h, 120 s reviews, 4% hearing + 1% deaf stalls', 17121, {
    perHour: 45,
    hours: 6,
    medianSeconds: 120,
    crash: 0.05,
    hears: 0.04,
    deaf: 0.01,
  }),
  workload('steady 45/h, 180 s reviews, 8% hearing stalls', 17122, {
    perHour: 45,
    hours: 6,
    medianSeconds: 180,
    crash: 0.05,
    hears: 0.08,
    deaf: 0,
  }),
  workload('overload 120/h, 180 s reviews, 4% hearing + 1% deaf', 17123, {
    perHour: 120,
    hours: 6,
    medianSeconds: 180,
    crash: 0.05,
    hears: 0.04,
    deaf: 0.01,
  }),
  workload('overload 120/h, 180 s reviews, 5% hearing stalls', 17124, {
    perHour: 120,
    hours: 6,
    medianSeconds: 180,
    crash: 0.05,
    hears: 0.05,
    deaf: 0,
  }),
]

/**
 * processWork at actors-next b7aaf6bb0, before this change: SIGKILL to the
 * one pid it spawned. Kept here only as the benchmark's `before`.
 */
function processWorkBefore(argv: string[]): IsolatedWork {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  const result = (async () => {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(`exit ${code}: ${err.slice(0, 200)}`)
    return out
  })()
  return { result, stop: () => proc.kill(9) }
}

interface ProcessResult {
  side: Side
  turns: number
  freedWithin10s: number
  hearsTermFreeMaxMs: number | string
  deafToTermFreeMaxMs: number | string
  survivors: number
}

/** Whether a pid is still a process. 0 or less is never one: kill(0) is our own group. */
const alive = (pid: number) => {
  if (!(pid > 0)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The pid a turn's shell wrote to `file`; 0 while there is none. */
const pidIn = (file: string) => {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim())
    return pid > 0 ? pid : 0
  } catch {
    return 0
  }
}

/** Wait until `cond` holds or `deadline` (performance.now) has passed. */
async function until(cond: () => boolean, deadline: number): Promise<boolean> {
  while (!cond()) {
    if (performance.now() > deadline) return false
    await sleep(20)
  }
  return true
}

async function processKills(side: Side, turns: number): Promise<ProcessResult> {
  const dir = mkdtempSync(join(tmpdir(), 'queen-turn-stop-bench-'))
  const sys = createActorSystem(undefined, { turnStop: side === 'after' })
  const killedAt = new Map<number, number>()
  const endedAt = new Map<number, number>()
  const files: string[] = []
  for (let i = 0; i < turns; i++) {
    const file = join(dir, `g${i}`)
    files.push(file)
    const deaf = i % 2 === 0
    const script = `${deaf ? "trap '' TERM; " : ''}sleep 30 & echo $! > "$1"; wait`
    const argv = ['sh', '-c', script, 'sh', file]
    const pid = sys.spawn<number>(
      {
        name: `p${i}`,
        turnMaxSeconds: 1,
        isolated: {
          cpuBound: false,
          foreignCode: true,
          start: (_n, signal) => {
            const work =
              side === 'before'
                ? processWorkBefore(argv)
                : processWork(argv, undefined, signal)
            work.result.then(
              () => endedAt.set(i, performance.now()),
              () => endedAt.set(i, performance.now()),
            )
            return work
          },
        },
        receive: () => {},
      },
      () => killedAt.set(i, performance.now()),
    )
    sys.send(pid, i)
  }
  // WAIT FOR WHAT IS MEASURED, NOT A FIXED 11 S FROM THE SPAWN. On a loaded
  // runner a turn can start late, and a fixed sleep could read a pid file
  // before its shell wrote it (Number('') is 0, and kill(0) is this process's
  // own group).
  // So: every turn killed, every grandchild's pid known (or its turn over
  // before it had one), then up to 10 s after the last kill for the
  // turns to end and the grandchildren to go. The bound is 1 s, the grace
  // 3 s (trios#1766).
  const deadline = performance.now() + 60_000
  await until(
    () =>
      killedAt.size === turns &&
      files.every((f, i) => pidIn(f) > 0 || endedAt.has(i)),
    deadline,
  )
  const grandchildren = files.map(pidIn)
  const lastKill = Math.max(...killedAt.values())
  await until(
    () => endedAt.size === turns && !grandchildren.some(alive),
    lastKill + 10_000,
  )
  const survivors = grandchildren.filter(alive).length
  // leave nothing behind, whatever the side
  for (const g of grandchildren) if (alive(g)) process.kill(g, 'SIGKILL')
  await sleep(200)
  rmSync(dir, { recursive: true, force: true })
  // kill to lane freed (the work's end), for the turns that hear SIGTERM
  // (odd) and the ones that ignore it (even); unfreed after 10 s is "> 10000"
  const freedMax = (deaf: boolean) => {
    const ms: number[] = []
    let unfreed = 0
    for (let i = deaf ? 0 : 1; i < turns; i += 2) {
      const k = killedAt.get(i)
      const e = endedAt.get(i)
      if (k === undefined || e === undefined || e - k > 10_000) unfreed++
      else ms.push(e - k)
    }
    return unfreed > 0 ? '> 10000' : Math.round(Math.max(...ms))
  }
  let freedWithin10s = 0
  for (let i = 0; i < turns; i++) {
    const k = killedAt.get(i)
    const e = endedAt.get(i)
    if (k !== undefined && e !== undefined && e - k <= 10_000) freedWithin10s++
  }
  return {
    side,
    turns,
    freedWithin10s,
    hearsTermFreeMaxMs: freedMax(false),
    deafToTermFreeMaxMs: freedMax(true),
    survivors,
  }
}

const table = <T extends object>(
  title: string,
  rows: T[],
  cols: Array<keyof T>,
) =>
  [
    `\n## ${title}`,
    `| ${cols.join(' | ')} |`,
    `|${cols.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${cols.map((c) => String(r[c])).join(' | ')} |`),
  ].join('\n')

describe('turns that stop: before and after, same input', () => {
  it('A: the reviewer under stalls, seeded, on a virtual clock', async () => {
    const results: ReviewerResult[] = []
    for (const w of SCENARIOS)
      for (const side of ['before', 'after'] as Side[]) {
        const r = await simulate(w, side)
        expect(r.rows).toBe(w.arrivals.length)
        expect(r.done + r.open).toBe(r.rows)
        results.push(r)
      }
    const cols: Array<keyof ReviewerResult> = [
      'side',
      'rows',
      'done',
      'perHour',
      'doneP95',
      'mostAtOnce',
      'secondsAboveBound',
      'reviewSecondsBeyondBound',
      'killed',
      'hearsKilled',
      'hearsFreeP50',
      'hearsFreeMax',
      'deafKilled',
      'deafFreeMax',
    ]
    const out = SCENARIOS.map((w) =>
      table(
        `${w.name} (${w.arrivals.length} rows, horizon ${w.horizonMs / HOUR} h, bound ${REVIEWER_CONCURRENCY})`,
        results.filter((x) => x.scenario === w.name),
        cols,
      ),
    )
    console.log(out.join('\n'))
    const file = process.env.QUEEN_BENCH_OUT
    if (file)
      writeFileSync(`${file}.reviewer.json`, JSON.stringify(results, null, 2))
  }, 600_000)

  it('B: process turns that leave a grandchild, half of them deaf to SIGTERM, real processes', async () => {
    const before = await processKills('before', 10)
    const after = await processKills('after', 10)
    console.log(
      table(
        'process turns killed at their 1 s bound (kill to lane freed; grandchildren alive 10 s after the kill)',
        [before, after],
        [
          'side',
          'turns',
          'freedWithin10s',
          'hearsTermFreeMaxMs',
          'deafToTermFreeMaxMs',
          'survivors',
        ],
      ),
    )
    const file = process.env.QUEEN_BENCH_OUT
    if (file)
      writeFileSync(
        `${file}.process.json`,
        JSON.stringify([before, after], null, 2),
      )
    expect(after.survivors).toBe(0)
  }, 240_000)
})
