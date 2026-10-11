/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE SIMULATION GATE (gHashTag/t27 specs/queen/simulation.t27, trios#1712
 * item 5; keyed actors and the adaptive pool: trios#1763).
 *
 * Each of the card's SEEDS_PER_RUN seeds plays STEPS_PER_RUN steps of the
 * real actor runtime - the reviewer actors and a pool on two more nodes over
 * the memory net - with the card's fault mix. seed_features turns on, by the
 * seed's index, turns that really stop, the adaptive reviewer pool and the
 * review lane queue, so the seeds hold every combination twice. The first
 * STORE_SEEDS_PER_RUN seeds play again with the nodes on the real
 * createPgLink over the simulated store. KEYED_SEEDS_PER_RUN more play the
 * keyed world (queen-sim-keyed.ts): two bee dispatchers of one deployment
 * over one lease table, every second one on a host whose timers fire early
 * (keyed_features). Every case runs RUNS_PER_SEED times. The gate fails when:
 *   - any invariant breaks in any run (the seed, the step and the minimal log
 *     tail are printed, with the command that replays it);
 *   - two runs of one case log differently (where they part is printed);
 *   - the cases together never reach one of the card's rare states.
 *
 * Replay one case:  SIM_SEED=<seed> SIM_FEATURES=<bits> [SIM_WORLD=store|keyed]
 *                   bun test tests/sim/queen-actors-sim.test.ts
 *                   (SIM_TURN_STOP=1 is SIM_FEATURES=1, as before)
 * A soak:           SIM_SEEDS=<count> SIM_BASE=<base> SIM_KEYED_SEEDS=<count>
 *                   SIM_KEYED_BASE=<base> bun test tests/sim/...
 * Timings as JSON:  SIM_OUT=<file>
 * The first failure as JSON, for the nightly run's issue: SIM_REPORT=<file>
 * The failure path, shown: SIM_RECREATE=pid-holder|unsupervised-admission|
 *                   slot-chain puts that old defect back into the keyed cases
 *                   (never set by the gate itself)
 */

import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createActorSystem } from '../../src/api/services/queen-actors'
import {
  WORKER_SHUTDOWN_MS,
  X_SHUTDOWN,
} from '../../src/api/services/queen-actors-card.gen'
import { REVIEWER_CEILING } from '../../src/api/services/queen-reviewer-card.gen'
import { RUNNER_CAP_MINUTES } from '../../src/api/services/queen-runner-work'
import * as S from '../../src/api/services/queen-simulation-card.gen'
import { TURN_STOP_GRACE_MS } from '../../src/api/services/queen-turn-stop-card.gen'
import { DEFAULT_SPECS_ROOT } from '../../src/inngest/spec-catalog'
import { VirtualClock } from '../api/queen-virtual-clock'
import { KeyedWorld, keyedFeatures, type Recreated } from './queen-sim-keyed'
import { pgStore } from './queen-sim-pg-store'
import {
  hasFeature,
  INVARIANT_NAMES,
  mustReach,
  RARE_NAMES,
  type RunResult,
  report,
  runSeed,
  SimWorld,
  seedFeatures,
  type WorldOptions,
} from './queen-sim-world'

const FILE = 'tests/sim/queen-actors-sim.test.ts'

const sha = (file: string) =>
  createHash('sha256')
    .update(readFileSync(join(DEFAULT_SPECS_ROOT, file)))
    .digest('hex')

describe('the vendored simulation card is the one PIN names', () => {
  it('simulation.t27 and simulation.wasm match', () => {
    const pin = readFileSync(join(DEFAULT_SPECS_ROOT, 'PIN'), 'utf8')
    expect(pin).toContain(
      `queen/simulation.t27 sha256 ${sha('queen/simulation.t27')}`,
    )
    expect(pin).toContain(
      `queen/simulation.wasm sha256 ${sha('queen/simulation.wasm')}`,
    )
  })
})

/**
 * One case of the gate: a seed, its world and its features (seed_features
 * for the reviewer's worlds, keyed_features for the keyed one).
 */
interface Case {
  seed: number
  world: 'memory' | 'store' | 'keyed'
  features: number
}

const has = (c: Case, feature: number) => hasFeature(c.features, feature)
/** A defect put back into the keyed cases, to show the failure path. */
const recreated = process.env.SIM_RECREATE as Recreated | undefined

const optionsOf = (c: Case): WorldOptions => ({
  turnStop: has(c, S.FEATURE_TURN_STOP),
  adaptive: has(c, S.FEATURE_ADAPTIVE_POOL),
  laneQueue: has(c, S.FEATURE_LANE_QUEUE),
  transport: c.world === 'store' ? pgStore : undefined,
})
/** The world a case plays; `captureStep` for a determinism diff. */
const worldOf = (c: Case, captureStep?: number) =>
  c.world === 'keyed'
    ? new KeyedWorld(c.seed, {
        earlyTimers: has(c, S.FEATURE_EARLY_TIMERS),
        recreate: recreated,
        captureStep,
      })
    : new SimWorld(c.seed, { ...optionsOf(c), captureStep })
const FEATURE_NAMES: Array<[number, string]> = [
  [S.FEATURE_TURN_STOP, 'turn stop'],
  [S.FEATURE_ADAPTIVE_POOL, 'the adaptive pool'],
  [S.FEATURE_LANE_QUEUE, 'the lane queue'],
  [S.FEATURE_EARLY_TIMERS, 'early timers'],
]
const nameOf = (c: Case) => {
  const on = FEATURE_NAMES.filter(([f]) => has(c, f)).map(([, n]) => n)
  return `seed ${c.seed}${c.world === 'memory' ? '' : ` on the ${c.world === 'store' ? 'store' : 'keyed world'}`}${on.length > 0 ? ` with ${on.join(', ')}` : ''}`
}
const replayOf = (c: Case) =>
  `SIM_SEED=${c.seed} SIM_FEATURES=${c.features}${c.world === 'memory' ? '' : ` SIM_WORLD=${c.world}`}${recreated ? ` SIM_RECREATE=${recreated}` : ''} bun test ${FILE}`

function casesOfThisRun(): Case[] {
  const env = process.env
  if (env.SIM_SEED) {
    const world = env.SIM_WORLD === 'store' || env.SIM_WORLD === 'keyed'
    return [
      {
        seed: Number(env.SIM_SEED) >>> 0,
        world: world ? (env.SIM_WORLD as Case['world']) : 'memory',
        features:
          Number(env.SIM_FEATURES || 0) |
          (env.SIM_TURN_STOP === '1' ? S.FEATURE_TURN_STOP : 0),
      },
    ]
  }
  const count = Number(env.SIM_SEEDS || S.SEEDS_PER_RUN)
  const stores = Math.min(count, S.STORE_SEEDS_PER_RUN)
  const keyed = Number(env.SIM_KEYED_SEEDS || S.KEYED_SEEDS_PER_RUN)
  const base = Number(env.SIM_BASE || S.GATE_BASE_SEED) >>> 0
  const keyedBase = Number(env.SIM_KEYED_BASE || S.KEYED_BASE_SEED) >>> 0
  const at = (i: number, world: 'memory' | 'store'): Case => ({
    seed: runSeed(base, i),
    world,
    features: seedFeatures(i),
  })
  return [
    ...Array.from({ length: count }, (_, i) => at(i, 'memory')),
    ...Array.from({ length: stores }, (_, i) => at(i, 'store')),
    ...Array.from(
      { length: keyed },
      (_, i): Case => ({
        seed: runSeed(keyedBase, i),
        world: 'keyed',
        features: keyedFeatures(i),
      }),
    ),
  ]
}

/** Where two runs of one case part, both sides. */
async function divergence(c: Case, a: RunResult, b: RunResult) {
  let k = 0
  while (k < a.stepHashes.length && a.stepHashes[k] === b.stepHashes[k]) k++
  // the hashes past STEPS_PER_RUN are the quiet tail's, one a virtual minute
  const at = Math.min(k, S.STEPS_PER_RUN)
  const where =
    at === S.STEPS_PER_RUN
      ? `minute ${k - S.STEPS_PER_RUN} of the quiet tail`
      : `step ${at}`
  // the two runs' own last lines, matched by line number, where they first differ
  const num = (l: string) => Number(/^#(\d+)/.exec(l)?.[1] ?? -1)
  const bAt = new Map(b.lines.map((l) => [num(l), l]))
  let own = a.lines.findIndex((l) => bAt.has(num(l)) && bAt.get(num(l)) !== l)
  if (own < 0) own = a.lines.length
  const bOwn = b.lines.findIndex((l) => num(l) === num(a.lines[own] ?? ''))
  const one = await worldOf(c, at).run()
  const two = await worldOf(c, at).run()
  let line = 0
  while (
    line < Math.max(one.captured.length, two.captured.length) &&
    one.captured[line] === two.captured[line]
  )
    line++
  const side = (r: RunResult) =>
    r.captured.slice(Math.max(0, line - 3), line + 3).map((l) => `    ${l}`)
  return [
    `SIMULATION FAILED: ${INVARIANT_NAMES[S.INV_RUNS_DIFFER]} (invariant ${S.INV_RUNS_DIFFER})`,
    `  ${nameOf(c)}: the runs part at ${where} (hashes: ${a.stepHashes.length} and ${b.stepHashes.length})`,
    ...(b.violation ? [report(b, replayOf(c))] : []),
    line < Math.max(one.captured.length, two.captured.length)
      ? `  replayed twice, they part again at line ${line} of it:`
      : '  replayed twice, that step logged the same: the difference came from outside the seed',
    `  replay: ${replayOf(c)}`,
    '  first replay:',
    ...side(one),
    '  second replay:',
    ...side(two),
    `  the gate's own two runs, at line ${own} of their last ${a.lines.length}:`,
    ...a.lines
      .slice(Math.max(0, own - 2), own + 3)
      .map((l) => `    first:  ${l}`),
    ...b.lines
      .slice(
        Math.max(0, (bOwn < 0 ? own : bOwn) - 2),
        (bOwn < 0 ? own : bOwn) + 3,
      )
      .map((l) => `    second: ${l}`),
    `  counts, first run:  ${JSON.stringify(a.counts)}`,
    `  counts, second run: ${JSON.stringify(b.counts)}`,
  ].join('\n')
}

function summary(lines: string[]) {
  const out = process.env.GITHUB_STEP_SUMMARY
  if (!out) return
  appendFileSync(
    out,
    [
      '## Actor simulation gate failed',
      '',
      `commit ${process.env.GITHUB_SHA ?? '(local)'}`,
      '',
      '```',
      ...lines,
      '```',
      '',
    ].join('\n'),
  )
}

/** A failure as the nightly run files it: the seed and the first broken invariant. */
interface Broken {
  seed: number
  world: Case['world']
  features: number
  replay: string
  invariant: number
  name: string
  step: number
  text: string
}

interface CaseOutcome {
  failures: string[]
  broken: Broken[]
  rare: Set<number>
  runs: number[]
  steps: number
}

/** One case, RUNS_PER_SEED times: its violation, and whether its runs agree. */
async function checkCase(c: Case): Promise<CaseOutcome> {
  const runs: RunResult[] = []
  for (let k = 0; k < S.RUNS_PER_SEED; k++) runs.push(await worldOf(c).run())
  const [a] = runs
  const failures: string[] = []
  const broken: Broken[] = []
  const as = (invariant: number, step: number, text: string): Broken => ({
    seed: c.seed,
    world: c.world,
    features: c.features,
    replay: replayOf(c),
    invariant,
    name: INVARIANT_NAMES[invariant],
    step,
    text,
  })
  if (a.violation) {
    failures.push(report(a, replayOf(c)))
    broken.push(as(a.violation.inv, a.violation.step, a.violation.text))
  }
  for (const b of runs.slice(1))
    if (
      b.stepHashes.length !== a.stepHashes.length ||
      b.stepHashes.some((h, i) => h !== a.stepHashes[i])
    ) {
      failures.push(await divergence(c, a, b))
      let k = 0
      while (k < a.stepHashes.length && a.stepHashes[k] === b.stepHashes[k]) k++
      broken.push(
        as(
          S.INV_RUNS_DIFFER,
          k,
          `the two runs of ${nameOf(c)} part at hash ${k}`,
        ),
      )
    }
  return {
    failures,
    broken,
    rare: a.rare,
    runs: runs.map((r) => Math.round(r.ms)),
    steps: a.steps,
  }
}

/** The rare states no case reached, over the whole gate run. */
function missed(reached: Set<number>): number[] {
  const out: number[] = []
  for (let state = 0; state < S.RARE_KINDS; state++)
    if (mustReach(state) && !reached.has(state)) out.push(state)
  return out
}

const p50 = (xs: number[]) => xs[Math.floor(xs.length / 2)]

describe('the simulation gate (simulation.t27)', () => {
  it('every case runs twice and logs the same, no invariant breaks, and together the cases reach every rare state', async () => {
    const cases = casesOfThisRun()
    const failures: string[] = []
    const broken: Broken[] = []
    const reached = new Set<number>()
    const timing: Array<Case & { runs: number[]; steps: number }> = []
    const t0 = performance.now()
    for (const c of cases) {
      const o = await checkCase(c)
      failures.push(...o.failures)
      broken.push(...o.broken)
      for (const r of o.rare) reached.add(r)
      timing.push({ ...c, runs: o.runs, steps: o.steps })
    }
    const totalMs = Math.round(performance.now() - t0)
    // a replay of one case is not asked to reach every rare state
    if (!process.env.SIM_SEED)
      for (const state of missed(reached)) {
        const text = `no case of ${cases.length} reached: ${RARE_NAMES[state]}`
        failures.push(
          `SIMULATION FAILED: ${INVARIANT_NAMES[S.INV_RARE_STATE_MISSED]} (invariant ${S.INV_RARE_STATE_MISSED})\n  ${text}`,
        )
        broken.push({
          seed: 0,
          world: 'memory',
          features: 0,
          replay: `bun test ${FILE}`,
          invariant: S.INV_RARE_STATE_MISSED,
          name: INVARIANT_NAMES[S.INV_RARE_STATE_MISSED],
          step: -1,
          text,
        })
      }
    const msOf = (world: Case['world']) =>
      timing
        .filter((t) => t.world === world)
        .flatMap((t) => t.runs)
        .sort((x, y) => x - y)
    const spread = (label: string, ms: number[]) =>
      ms.length > 0
        ? `; ${label} run min ${ms[0]} ms, p50 ${p50(ms)} ms, max ${ms[ms.length - 1]} ms`
        : ''
    const memoryMs = msOf('memory')
    console.log(
      [
        `\n## actor simulation: ${cases.length} cases x ${S.RUNS_PER_SEED} runs x ${S.STEPS_PER_RUN} steps`,
        `total ${totalMs} ms; memory-net run min ${memoryMs[0]} ms, p50 ${p50(memoryMs)} ms, max ${memoryMs[memoryMs.length - 1]} ms` +
          spread('store', msOf('store')) +
          spread('keyed', msOf('keyed')),
        `rare states reached: ${[...reached]
          .sort()
          .map((s) => RARE_NAMES[s])
          .join('; ')}`,
        ...timing.map(
          (t) =>
            `${nameOf(t)}: ${t.steps} steps, runs ${t.runs.join(' / ')} ms`,
        ),
      ].join('\n'),
    )
    if (process.env.SIM_OUT)
      writeFileSync(
        process.env.SIM_OUT,
        JSON.stringify({ totalMs, timing, reached: [...reached] }, null, 2),
      )
    if (process.env.SIM_REPORT)
      writeFileSync(
        process.env.SIM_REPORT,
        JSON.stringify(
          {
            commit: process.env.GITHUB_SHA ?? '(local)',
            totalMs,
            cases: cases.length,
            broken,
          },
          null,
          2,
        ),
      )
    if (failures.length > 0) {
      console.error(failures.join('\n\n'))
      summary(failures)
    }
    expect(failures).toEqual([])
  }, 900_000)
})

describe('the literals the simulation card keeps match their owners', () => {
  it("actors.t27's shutdown, turn_stop.t27's grace, reviewer.t27's ceiling and the runner cap", () => {
    expect(S.SIM_WORKER_SHUTDOWN_MS).toBe(WORKER_SHUTDOWN_MS)
    expect(S.SIM_TURN_STOP_GRACE_MS).toBe(TURN_STOP_GRACE_MS)
    expect(S.SIM_REVIEWER_CEILING).toBe(REVIEWER_CEILING)
    expect(S.SIM_RUNNER_CAP_SECONDS).toBe(RUNNER_CAP_MINUTES * 60)
  })
})

describe('the gate has teeth', () => {
  it('re-creates the go-live hot loop (no wait backoff) and fails it from the first gate seed', async () => {
    const seed = runSeed(S.GATE_BASE_SEED, 0)
    const r = await new SimWorld(seed, { noWaitBackoff: true }).run()
    console.log(
      `\n## the go-live defect, re-created\n${report(r, `SIM_SEED=${seed} bun test ${FILE}`)}`,
    )
    expect(r.violation?.inv).toBe(S.INV_HOT_LOOP)
  }, 120_000)

  // The three gaps #1749 closed, each put back into the first keyed gate seed.
  const keyedSeed = runSeed(S.KEYED_BASE_SEED, 0)
  const recreate = async (defect: Recreated, title: string) => {
    const r = await new KeyedWorld(keyedSeed, { recreate: defect }).run()
    console.log(
      `\n## ${title}, re-created\n${report(r, `SIM_SEED=${keyedSeed} SIM_WORLD=keyed SIM_RECREATE=${defect} bun test ${FILE}`)}`,
    )
    return r.violation?.inv
  }
  it('re-creates the pid-only claim holder: two replicas claim as one, and a second bee starts under a live lease', async () => {
    expect(await recreate('pid-holder', 'the pid-only holder')).toBe(
      S.INV_DUPLICATE_CLAIM,
    )
  }, 300_000)

  it('re-creates the unsupervised admission: after its first crash its issues wait with lanes free', async () => {
    expect(
      await recreate('unsupervised-admission', 'the unsupervised admission'),
    ).toBe(S.INV_LANE_LEAK)
  }, 300_000)

  it('re-creates the slot-limited call check: a cycle past slot 63 waits out its timeout', async () => {
    expect(await recreate('slot-chain', 'the slot-limited call check')).toBe(
      S.INV_CALL_CHAIN,
    )
  }, 300_000)

  it('a process stopped between taking its message and running the turn runs no turn (the defect the gate found)', async () => {
    // seed 3600507402 found it: a pool supervisor gave up and stopped a
    // watcher whose DOWN turn was already taken; the turn ran for a dead pid
    const clock = new VirtualClock()
    const sys = createActorSystem(clock)
    let ran = 0
    const pid = sys.spawn<number>({ name: 'p', receive: () => void ran++ })
    sys.send(pid, 1)
    // the scheduler takes the message in the next microtask; stop it after
    await Promise.resolve()
    sys.exit(pid, X_SHUTDOWN, true)
    await clock.runUntil(1000)
    expect(sys.alive(pid)).toBe(false)
    expect(ran).toBe(0)
  })
})
