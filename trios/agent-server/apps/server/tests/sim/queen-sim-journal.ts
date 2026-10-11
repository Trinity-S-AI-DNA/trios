/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE RUN'S JOURNAL, SHARED BY EVERY SIMULATED WORLD (gHashTag/t27
 * specs/queen/simulation.t27). A world - the reviewer's (queen-sim-world.ts)
 * or the keyed dispatcher's (queen-sim-keyed.ts) - logs what happens, taps
 * the cards it runs so their decisions are logged too, and hashes all of it
 * into one number a step. Two runs of one seed must hash alike, step for
 * step: that is the determinism check. The first broken invariant stops the
 * run and keeps the log lines that name its subjects, the minimal tail.
 *
 * Nothing here decides: which invariant fails the gate is the simulation
 * card's fails_gate.
 */

import {
  type CardWasm,
  loadCardWasm,
} from '../../src/api/services/queen-card-wasm'
import * as S from '../../src/api/services/queen-simulation-card.gen'
import type { VirtualClock } from '../api/queen-virtual-clock'

export const SIMULATION_CARD = 'queen/simulation.wasm'

const sim = () => loadCardWasm(SIMULATION_CARD)
const u32 = (n: number) => n >>> 0
export const simRoll = (seed: number, stream: number, index: number) =>
  u32(sim().call('sim_roll', u32(seed), stream, u32(index)))
export const pickBetween = (roll: number, lo: number, hi: number) =>
  u32(sim().call('pick_between', u32(roll), u32(lo), u32(hi)))
export const failsGate = (inv: number) => sim().call('fails_gate', inv) !== 0

export const INVARIANT_NAMES: Record<number, string> = {
  [S.INV_PID_REUSED]: 'a pid was reused while mail to it was on the wire',
  [S.INV_DELIVERED_AFTER_EXIT]: 'a turn ran for a process that had exited',
  [S.INV_INTENSITY]: 'a supervisor restarted past its intensity',
  [S.INV_OVER_CAP]: 'concurrency exceeded its cap',
  [S.INV_RESTART_WITHOUT_EXIT]:
    'a child started again before its previous incarnation ended',
  [S.INV_HOT_LOOP]: 'a row was visited in a hot loop',
  [S.INV_RUNS_DIFFER]: 'two runs of one seed logged differently',
  [S.INV_RARE_STATE_MISSED]: 'a rare state was never reached',
  [S.INV_TAKEN_NOT_HANDLED]:
    'a node took mail off the wire and never handled it',
  [S.INV_DUPLICATE_CLAIM]:
    'a second bee started on an issue whose first bee held a live lease',
  [S.INV_OVER_LANES]: 'a dispatcher ran more bees than its lanes',
  [S.INV_NOT_FINISHED]: 'an issue was neither done nor given up',
  [S.INV_LANE_LEAK]: 'a lane or a wait was left behind',
  [S.INV_CALL_CHAIN]: 'the call chain was judged wrong',
  [S.INV_STOP_OVERRAN]: 'a stop outlived its bound',
}
export const RARE_NAMES: Record<number, string> = {
  [S.RARE_MAILBOX_FULL]: 'mailbox full',
  [S.RARE_INTENSITY_SPENT]: 'intensity spent (a supervisor gave up)',
  [S.RARE_TURN_KILLED]: 'turn killed at its bound',
  [S.RARE_MAIL_TO_LOST_NODE]: 'mail lost on the wire to a lost node',
  [S.RARE_WAIT_BACKED_OFF]: 'a row held back by the wait backoff',
  [S.RARE_SLICE_YIELDED]: 'a scheduler yielded its slice',
  [S.RARE_MOVED_NODE]: 'a child restarted on another node',
  [S.RARE_REVIEW_STOPPED]: "a review stopped by its turn's abort",
  [S.RARE_STOOD_DOWN]: 'a dispatcher stood down at a claim the other held',
  [S.RARE_ADMISSION_RESTARTED]: 'an admission restarted by its supervisor',
  [S.RARE_LEASE_LAPSED]:
    "a silent runner's lease lapsed and its issue ran again",
  [S.RARE_CYCLE_REFUSED]: 'a call cycle past slot 63 refused at once',
  [S.RARE_STOP_KILLED]: 'a stop killed a busy actor at its shutdown',
  [S.RARE_GROUP_KILLED]: "a deaf turn's work stopped at the grace",
  [S.RARE_LANE_FREED_ON_EXIT]: 'a crashed issue actor gave its lane back',
  [S.RARE_GRANT_TAKEN_BACK]: 'a grant that reached nobody went back',
  [S.RARE_POOL_GREW]: 'the adaptive pool grew past the fixed 4',
  [S.RARE_POOL_RETIRED]: 'the adaptive pool retired an idle worker',
  [S.RARE_LANE_WAITED]: 'a review waited for a lane and was let through',
}

export interface Violation {
  inv: number
  step: number
  t: number
  text: string
  subjects: string[]
}

export interface RunResult {
  seed: number
  steps: number
  violation: Violation | null
  stepHashes: number[]
  hash: number
  rare: Set<number>
  captured: string[]
  /** Card calls made while the world quiesced after its steps. */
  afterTail: string[]
  /** The last log lines of the run, for a divergence the replay does not repeat. */
  lines: string[]
  counts: Record<string, number>
  tail: string[]
  ms: number
}

export interface JournalOptions {
  /** Keep every log line of this step, for a determinism diff. */
  captureStep?: number
  /**
   * Invariants this run logs and counts but does not stop on: a known
   * defect, so a run can look past it for another. Never set by the gate.
   */
  known?: number[]
}

interface LogLine {
  n: number
  t: number
  step: number
  text: string
  subjects: string[]
}

const RING = 4000

/** A tap's answer: undefined keeps the card's own. */
export type CardCall = (
  name: string,
  a: Array<number | bigint>,
  r: number | bigint,
) => number | bigint | undefined

export abstract class SimJournal {
  abstract readonly clock: VirtualClock
  step = -1
  violation: Violation | null = null
  readonly rare = new Set<number>()
  readonly counts: Record<string, number> = {}
  protected hash = 0x811c9dc5
  protected lineNo = 0
  /** Set when the run has ended: what still runs afterwards logs nothing. */
  protected closed = false
  protected readonly stepHashes: number[] = []
  protected readonly ring: LogLine[] = []
  protected readonly captured: string[] = []
  private readonly names = new Map<string, number>()
  /** Set while the harness calls a card itself: those calls are not journaled. */
  protected tapping = false
  protected quiescing = false
  /** What ran while the world quiesced, for a divergence report. */
  protected readonly afterTail: string[] = []

  constructor(
    readonly seed: number,
    private readonly journalOptions: JournalOptions = {},
  ) {}

  roll(stream: number, index: number): number {
    return simRoll(this.seed, stream, index)
  }

  protected mix(n: number) {
    if (this.closed) return
    this.hash = Math.imul(this.hash ^ (n | 0), 16777619)
  }
  protected mixText(s: string) {
    for (let i = 0; i < s.length; i++) this.mix(s.charCodeAt(i))
  }
  protected nameId(name: string): number {
    let id = this.names.get(name)
    if (id === undefined) {
      id = this.names.size + 1
      this.names.set(name, id)
    }
    return id
  }
  log(text: string, ...subjects: string[]) {
    if (this.closed) return
    this.mixText(text)
    const line = {
      n: this.lineNo++,
      t: this.clock.now(),
      step: this.step,
      text,
      subjects,
    }
    this.ring.push(line)
    if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING)
    if (this.journalOptions.captureStep === this.step)
      this.captured.push(`t=${line.t} ${text}`)
  }

  fail(inv: number, text: string, ...subjects: string[]) {
    if (this.closed || this.violation || !failsGate(inv)) return
    if (this.journalOptions.known?.includes(inv)) {
      this.count(`known${inv}`)
      this.log(`known defect ${INVARIANT_NAMES[inv]}: ${text}`, ...subjects)
      return
    }
    this.violation = {
      inv,
      step: this.step,
      t: this.clock.now(),
      text,
      subjects,
    }
    this.log(`VIOLATION ${INVARIANT_NAMES[inv]}: ${text}`, ...subjects)
  }

  count(key: string) {
    this.counts[key] = (this.counts[key] ?? 0) + 1
  }

  /** The last lines that name a subject of the violation: the minimal tail. */
  tail(): string[] {
    const v = this.violation
    const fmt = (l: LogLine) =>
      `  step ${l.step} t=${(l.t / 1000).toFixed(3)}s ${l.text}`
    if (!v) return this.ring.slice(-S.LOG_TAIL_LINES).map(fmt)
    const named = this.ring.filter((l) =>
      l.subjects.some((s) => v.subjects.includes(s)),
    )
    return named.slice(-S.LOG_TAIL_LINES).map(fmt)
  }

  /**
   * Tap a card: every call is journaled, and `onCall` may answer in the
   * card's place (a re-created defect; never in the gate). Returns the untap.
   */
  protected tap(file: string, onCall: CardCall) {
    const card = loadCardWasm(file) as CardWasm
    const call = card.call
    const call64 = card.call64
    card.call = (name: string, ...a: number[]) => {
      const r = call(name, ...a)
      if (this.tapping) return r
      const o = onCall(name, a, r)
      return o === undefined ? r : Number(o)
    }
    card.call64 = (name: string, ...a: Array<number | bigint>) => {
      const r = call64(name, ...a)
      if (this.tapping) return r
      const o = onCall(name, a, r)
      return o === undefined ? r : o
    }
    return () => {
      card.call = call
      card.call64 = call64
    }
  }

  /** Mix one card call into the hash, and keep it where a diff wants it. */
  protected journal(
    name: string,
    a: Array<number | bigint>,
    r: number | bigint,
  ) {
    this.mix(this.nameId(name))
    for (const v of a) {
      if (typeof v === 'bigint') {
        this.mix(Number(v & 0xffffffffn))
        this.mix(Number((v >> 32n) & 0xffffffffn))
      } else this.mix(v)
    }
    if (typeof r === 'bigint') this.mix(Number(r & 0xffffffffn))
    else this.mix(r)
    if (this.journalOptions.captureStep === this.step)
      this.captured.push(`card ${name}(${a.join(',')}) = ${r}`)
    if (this.quiescing && this.afterTail.length < 200)
      this.afterTail.push(`card ${name}(${a.join(',')}) = ${r}`)
  }

  /**
   * Let the world's own scheduled work - a scheduler that yielded its slice,
   * promises a step left settling - finish before the run closes, so none of
   * it runs while the next world's taps are in place.
   */
  protected async quiesce() {
    let last = -1
    this.quiescing = true
    for (let i = 0; i < 1000 && (this.hash | 0) !== last; i++) {
      last = this.hash | 0
      this.count('quiesceRounds')
      for (let k = 0; k < 3; k++)
        await new Promise<void>((r) => setImmediate(r))
    }
    this.quiescing = false
  }

  /** The run's result, once it has closed. */
  protected result(steps: number, hash: number, ms: number): RunResult {
    return {
      seed: this.seed,
      steps,
      violation: this.violation,
      stepHashes: this.stepHashes,
      hash,
      rare: this.rare,
      captured: this.captured,
      afterTail: this.afterTail,
      lines: this.ring.map(
        (l) => `#${l.n} step ${l.step} t=${(l.t / 1000).toFixed(3)}s ${l.text}`,
      ),
      counts: this.counts,
      tail: this.tail(),
      ms,
    }
  }
}

/** The report of a failed run: the seed, how to replay it, the minimal tail. */
export function report(r: RunResult, replay: string): string {
  const v = r.violation
  if (!v) return `seed ${r.seed}: ok`
  return [
    `SIMULATION FAILED: ${INVARIANT_NAMES[v.inv]} (invariant ${v.inv})`,
    `  seed ${r.seed}, step ${v.step}, t=${(v.t / 1000).toFixed(3)} s`,
    `  ${v.text}`,
    `  replay: ${replay}`,
    `  log tail (the last lines that name ${v.subjects.join(', ') || 'anything'}):`,
    ...r.tail,
  ].join('\n')
}
