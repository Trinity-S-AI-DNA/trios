/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE KEYED WORLD (gHashTag/t27 specs/queen/simulation.t27 section 7,
 * gHashTag/trios#1763, ledger #1729).
 *
 * WHY. The published actors post says the simulation gate "does not yet
 * simulate keyed actors". The keyed actors' three gaps (#1749: the claim's
 * holder, the unsupervised admission, the slot-limited call-cycle check) and
 * the early-timer defect (#1809, #1811) were each found by a test written for
 * that one defect, after the fact. This world draws the work, the faults and
 * the host's timers from one seed and checks the dispatcher's own promises
 * after every step, so the next such defect is a seed, not a postmortem.
 *
 * WHAT RUNS IS THE REAL DISPATCHER: queen-bee-actors.ts beeDispatcher, with
 * its keyed actors (queen-actors-keyed.ts), its admission under a supervisor
 * and its lane board, and the call chain of queen-actors-links.ts, on the
 * virtual clock. KEYED_DISPATCHERS of them run as two replicas of one
 * deployment: one process name, one node number, so their pids are drawn
 * alike, and each holder names its process's boot, as queenActorHolderPrefix
 * does in production. A redeploy stops one and boots a new one with a new
 * boot. What is simulated is what the dispatcher talks to:
 *   - the store: one lease table, a claim landing by keyed_guard.t27
 *     claim_lands_for on the holder strings, a lease renewed by its bee's
 *     runner once a heartbeat while it lives; the policy's word (done and
 *     given-up issues are refused);
 *   - the bees: a runner's process that works, fails and says so, dies
 *     without a word (only its lapsed lease tells), or hangs until its turn's
 *     kill stops it at the runner's next poll;
 *   - the round, which readies every open issue every KEYED_ROUND_SECONDS;
 *   - two probes on a node of their own: chains of keyed actors that call one
 *     another and close into a cycle or not, and a turn whose isolated work is
 *     deaf to its abort.
 *
 * WHAT DECIDES. The simulation card: the event of each step (keyed_event),
 * the time that passes (step_ms), a bee's fate (bee_fate), how early each
 * timer fires (timer_early_ms), the probes' shapes, and every bound an
 * invariant is checked against (stop_overran, deaf_work_overran,
 * waiting_stuck, fails_gate). This file holds the world's state.
 *
 * A RE-CREATED DEFECT (`recreate`, never set by the gate) puts an old rule
 * back, so the gate's teeth can be shown on the defects it exists for:
 *   pid-holder              the holder without the boot: two replicas, and a
 *                           process and its next boot, claim as one;
 *   unsupervised-admission  nothing restarts a crashed admission (its
 *                           supervisor's decision is answered "nothing");
 *   slot-chain              the call check of actors.t27 over slots 0..63.
 */

import {
  type ActorSpec,
  type ActorSystem,
  type Clock,
  createActorSystem,
  type Pid,
} from '../../src/api/services/queen-actors'
import {
  CALL_CYCLE,
  CALL_REPLY,
  SUP_NOTHING,
  X_CRASH,
  X_KILLED,
} from '../../src/api/services/queen-actors-card.gen'
import {
  type Keyed,
  keyedActors,
} from '../../src/api/services/queen-actors-keyed'
import {
  type CallRequest,
  KEYED_GUARD_CARD,
  linksOf,
} from '../../src/api/services/queen-actors-links'
import {
  type BeeDispatcher,
  type BeeEnd,
  type BeeStart,
  beeDispatcher,
  DISPATCH_EXIT_CARD,
} from '../../src/api/services/queen-bee-actors'
import { loadCardWasm } from '../../src/api/services/queen-card-wasm'
import {
  EF_CANCEL,
  EF_NONE,
  EF_PROVIDER,
  LEASE_TTL_SECONDS,
  RD_GIVE_UP,
} from '../../src/api/services/queen-dispatch-exit-card.gen'
import * as S from '../../src/api/services/queen-simulation-card.gen'
import { VirtualClock } from '../api/queen-virtual-clock'
import {
  type JournalOptions,
  pickBetween,
  type RunResult,
  SIMULATION_CARD,
  SimJournal,
} from './queen-sim-journal'

const ACTORS_CARD = 'queen/actors.wasm'
const KEYED_CARD = 'queen/keyed.wasm'

const sim = () => loadCardWasm(SIMULATION_CARD)
const u32 = (n: number) => n >>> 0
const keyedEvent = (roll: number) => sim().call('keyed_event', u32(roll))
const stepMs = (roll: number) => u32(sim().call('step_ms', u32(roll)))
const beeFate = (roll: number) => sim().call('bee_fate', u32(roll))
const stopOverran = (elapsedMs: number, stopped: number, shutdownMs: number) =>
  sim().call('stop_overran', u32(elapsedMs), u32(stopped), u32(shutdownMs)) !==
  0
const probeLength = (roll: number) => u32(sim().call('probe_length', u32(roll)))
const probeOpen = (roll: number) => sim().call('probe_open', u32(roll)) !== 0
const probeBackTo = (roll: number, length: number) =>
  u32(sim().call('probe_back_to', u32(roll), u32(length)))
const deafWorkOverran = (msAfterKill: number) =>
  sim().call('deaf_work_overran', u32(msAfterKill)) !== 0
export const keyedFeatures = (i: number) =>
  u32(sim().call('keyed_features', u32(i)))
const timerEarlyMs = (roll: number, ms: number) =>
  u32(sim().call('timer_early_ms', u32(roll), u32(ms)))
const waitingStuck = (seconds: number) =>
  sim().call('waiting_stuck', u32(seconds)) !== 0
const laneHeldByNobody = (seconds: number) =>
  sim().call('lane_held_by_nobody', u32(seconds)) !== 0
const laneFree = (running: number, lanes: number) =>
  loadCardWasm(KEYED_CARD).call('lane_free', u32(running), u32(lanes)) !== 0

/** A defect put back for the teeth tests. */
export type Recreated = 'pid-holder' | 'unsupervised-admission' | 'slot-chain'

export interface KeyedWorldOptions extends JournalOptions {
  /** The host's timers fire early (FEATURE_EARLY_TIMERS). */
  earlyTimers?: boolean
  recreate?: Recreated
}

/**
 * A virtual clock whose every timer fires timer_early_ms early, drawn per
 * timer from the seed: the host's timers, as trios#1766 measured them.
 */
class EarlyByClock extends VirtualClock {
  constructor(early: (ms: number) => number) {
    super()
    const on = this.after
    this.after = (ms, fn) => on(ms - early(ms), fn)
  }
}

interface Lease {
  holder: string
  fence: number
  claimedAt: number
  released: boolean
  bee?: Bee
}

type How = 'ok' | 'fail' | 'stopped'

interface Bee {
  id: number
  issue: number
  inc: Inc
  fate: number
  start: number
  /** When its process is gone: finished, failed, died, or stopped. */
  endAt?: number
  lease: Lease
  stopping: boolean
  /** The dispatcher knows it ended: its runner said so, or its lease lapsed. */
  known: boolean
  onReport: Array<(how: How) => void>
}

/** One incarnation of one dispatcher: a process, from its boot to its stop. */
interface Inc {
  id: number
  slot: number
  boot: string
  sys: ActorSystem
  d: BeeDispatcher
  /** Its stop has begun: the round no longer readies it. */
  stopping: boolean
  /** Its process has exited: its timers and its store calls go nowhere. */
  dead: boolean
  /** Bees this incarnation started that still run. */
  running: number
  crashNext: boolean
  stallNext: boolean
  /** Its claims hang until then (a redeploy's). */
  claimsHangUntil: number
  /** While it stops: its issue actors not yet gone, and each exit's time. */
  toStop: Set<Pid>
  exits: Array<{ pid: Pid; at: number }>
  /** Since when an issue has waited on its board with a lane free. */
  freeWaitSince?: number
  /** Since when each board lane has had neither a turn nor a bee of its issue. */
  laneIdleSince: Map<number, number>
}

/** One call of a probe's chain: the keys in order, and which one is called. */
type Hop = { route: number[]; i: number; probe: number }
type ProbeMsg = CallRequest<Hop> | { kind: 'wake' }

/**
 * One keyed seed's world. `run` plays STEPS_PER_RUN steps (or `steps`) and the
 * quiet tail, and stops at the first violation.
 */
export class KeyedWorld extends SimJournal {
  readonly clock: VirtualClock
  private finalHash = 0
  private timers = 0

  // the store and the work
  private readonly leases = new Map<number, Lease>()
  private readonly live = new Map<number, Set<Bee>>()
  private readonly lastFate = new Map<number, number>()
  private readonly attempts = new Map<number, number>()
  private readonly arrived = new Map<number, number>()
  private readonly indexOf = new Map<number, number>()
  private readonly completed = new Set<number>()
  private readonly givenUp = new Set<number>()
  private nextIssue = 5000
  private nextBee = 1
  /** Bees whose end the dispatcher does not know yet. */
  private bees: Bee[] = []

  // the dispatchers, every incarnation they had
  private readonly incs: Inc[] = []
  private readonly current: Array<Inc | undefined> = []
  private nextIncId = 1
  /** The spec whose exit the supervisor is deciding now. */
  private exitOf: string | undefined

  // the probes' node
  private psys!: ActorSystem
  private probes!: Keyed<number, ProbeMsg>
  private probeCaller: Pid = 0n
  private nextProbeKey = 1
  private nextProbe = 1

  constructor(
    seed: number,
    readonly options: KeyedWorldOptions = {},
  ) {
    super(seed, options)
    this.clock = options.earlyTimers
      ? new EarlyByClock((ms) =>
          timerEarlyMs(this.roll(S.STREAM_EARLY, this.timers++), ms),
        )
      : new VirtualClock()
  }

  private sleep(ms: number) {
    return new Promise<void>((r) => this.clock.after(ms, r))
  }

  // --- the card tap ------------------------------------------------------------

  private onActorsCall(
    name: string,
    a: Array<number | bigint>,
    r: number | bigint,
  ): number | bigint | undefined {
    // nothing restarts the admission: its supervisor is told "nothing"
    const o =
      this.options.recreate === 'unsupervised-admission' &&
      name === 'on_child_exit' &&
      this.exitOf === 'bee-admission'
        ? SUP_NOTHING
        : undefined
    this.journal(name, a, o ?? r)
    return o
  }

  private onGuardCall(
    name: string,
    a: Array<number | bigint>,
    r: number | bigint,
  ): number | bigint | undefined {
    let o: number | bigint | undefined
    if (this.options.recreate === 'slot-chain' && name === 'call_admit_chain') {
      // the rule before keyed_guard.t27: actors.t27 call_admit over a chain
      // of slots, one bit each, slots 0..63
      this.tapping = true
      const actors = loadCardWasm(ACTORS_CARD)
      const slot = (p: number | bigint) => actors.call64('slot_of', BigInt(p))
      let chain: number | bigint = 0n
      for (const caller of a.slice(2))
        if (BigInt(caller) !== 0n)
          chain = actors.call64('chain_add', BigInt(chain), slot(caller))
      o = actors.call64('call_admit', BigInt(chain), a[0], slot(a[1]))
      this.tapping = false
    }
    this.journal(name, a, o ?? r)
    return o
  }

  private onCall = (
    name: string,
    a: Array<number | bigint>,
    r: number | bigint,
  ): undefined => {
    this.journal(name, a, r)
    return undefined
  }

  // --- the store -----------------------------------------------------------------

  /** A holder as keyed_guard.t27 section 1 reads it: a process, and a pid. */
  private parts(holder: string) {
    const at = holder.lastIndexOf(':')
    return at < 0
      ? { process: holder, pid: 0n }
      : { process: holder.slice(0, at), pid: BigInt(holder.slice(at + 1)) }
  }

  /** keyed_guard.t27 claim_lands_for on a live lease, over the holder strings. */
  private landsAgain(held: string, claimer: string) {
    const a = this.parts(held)
    const b = this.parts(claimer)
    return (
      loadCardWasm(KEYED_GUARD_CARD).call64(
        'claim_lands_for',
        1,
        a.process === b.process ? 1 : 0,
        a.pid,
        b.pid,
      ) !== 0
    )
  }

  /** The last renewal: the bee's runner renews once a heartbeat while it lives. */
  private renewedAt(l: Lease): number {
    const b = l.bee
    if (!b) return l.claimedAt
    const now = this.clock.now()
    const until = Math.min(now, b.endAt ?? now)
    const hb = S.HEARTBEAT_SECONDS * 1000
    return Math.max(
      l.claimedAt,
      b.start + Math.floor((until - b.start) / hb) * hb,
    )
  }

  private expired(l: Lease | undefined) {
    return (
      !l ||
      l.released ||
      this.clock.now() - this.renewedAt(l) >= LEASE_TTL_SECONDS * 1000
    )
  }

  private claim(issue: number, holder: string): Lease | undefined {
    const l = this.leases.get(issue)
    if (l && !this.expired(l) && !this.landsAgain(l.holder, holder))
      return undefined
    const next: Lease = {
      holder,
      fence: (l?.fence ?? 0) + 1,
      claimedAt: this.clock.now(),
      released: false,
    }
    this.leases.set(issue, next)
    return next
  }

  // --- the bees ------------------------------------------------------------------

  private startBee(issue: number, inc: Inc, lease: Lease): Bee {
    const now = this.clock.now()
    // NO DUPLICATE CLAIM: another bee of this issue still runs under a live lease
    for (const other of this.live.get(issue) ?? [])
      if (other.endAt === undefined && !this.expired(other.lease))
        this.fail(
          S.INV_DUPLICATE_CLAIM,
          `#${issue}: bee ${other.id} (holder ${other.lease.holder}) still runs under a live lease, and bee ${this.nextBee} starts for ${lease.holder}`,
          `#${issue}`,
        )
    if (this.lastFate.get(issue) === S.BEE_CRASH)
      this.rare.add(S.RARE_LEASE_LAPSED)
    const k = this.attempts.get(issue) ?? 0
    this.attempts.set(issue, k + 1)
    const draw = (this.indexOf.get(issue) ?? 0) * 64 + k
    const fate = beeFate(this.roll(S.STREAM_ATTEMPT, draw))
    this.lastFate.set(issue, fate)
    const len =
      pickBetween(
        this.roll(S.STREAM_DURATION, draw),
        S.BEE_MIN_SECONDS,
        S.BEE_MAX_SECONDS,
      ) * 1000
    const b: Bee = {
      id: this.nextBee++,
      issue,
      inc,
      fate,
      start: now,
      lease,
      stopping: false,
      known: false,
      onReport: [],
    }
    lease.bee = b
    this.bees = this.bees.filter((x) => !x.known)
    this.bees.push(b)
    const set = this.live.get(issue) ?? new Set<Bee>()
    set.add(b)
    this.live.set(issue, set)
    inc.running++
    this.log(
      `bee ${b.id} #${issue} starts (fate ${fate}, ${len} ms) for ${lease.holder}, fence ${lease.fence}`,
      `#${issue}`,
      `inc ${inc.id}`,
    )
    const at = (percent: number) => Math.floor((len * percent) / 100)
    if (fate === S.BEE_OK) this.clock.after(len, () => this.endBee(b, 'ok'))
    else if (fate === S.BEE_FAIL)
      this.clock.after(at(S.BEE_FAIL_PERCENT), () => this.endBee(b, 'fail'))
    else if (fate === S.BEE_CRASH)
      this.clock.after(at(S.BEE_CRASH_PERCENT), () => this.endBee(b, 'crash'))
    // a hang: alive and vouched for, no progress, until it is stopped
    return b
  }

  private endBee(b: Bee, how: How | 'crash') {
    if (b.endAt !== undefined) return
    b.endAt = this.clock.now()
    b.inc.running--
    this.live.get(b.issue)?.delete(b)
    this.log(`bee ${b.id} #${b.issue} ends: ${how}`, `#${b.issue}`)
    if (how === 'ok' && !this.completed.has(b.issue)) {
      this.completed.add(b.issue)
      this.count('done')
    }
    // a runner that died says nothing, and its lease lapses on its own
    if (how === 'crash') return
    // the row closes, so its claim goes with it
    if (b.lease.bee === b) b.lease.released = true
    for (const told of b.onReport) told(how)
  }

  /** A stop asked of a bee: its runner ends it at its next poll. */
  private stopBee(b: Bee) {
    if (b.endAt !== undefined || b.stopping) return
    b.stopping = true
    this.count('beeStops')
    const poll = S.RUNNER_POLL_SECONDS * 1000
    const polls = Math.floor((this.clock.now() - b.start) / poll) + 1
    this.clock.after(b.start + polls * poll - this.clock.now(), () =>
      this.endBee(b, 'stopped'),
    )
  }

  /** The bee's work as the dispatcher sees it: its end, and a stop. */
  private workOf(b: Bee): BeeStart {
    const ended = new Promise<BeeEnd>((told) => {
      const resolve = (e: BeeEnd) => {
        b.known = true
        told(e)
      }
      b.onReport.push((how) =>
        resolve({
          completion: how === 'ok',
          errorFrame:
            how === 'fail'
              ? EF_PROVIDER
              : how === 'stopped'
                ? EF_CANCEL
                : EF_NONE,
          http: how === 'fail' ? 503 : how === 'ok' ? 200 : 0,
          heartbeatAge: 0,
          leaseHeld: true,
        }),
      )
      // a runner that died says nothing: the dispatcher's own look at the
      // lease, once a heartbeat, finds it lapsed
      const hb = S.HEARTBEAT_SECONDS * 1000
      const check = () => {
        if (
          b.endAt !== undefined &&
          b.fate === S.BEE_CRASH &&
          this.expired(b.lease)
        ) {
          resolve({
            completion: false,
            errorFrame: EF_NONE,
            http: 0,
            heartbeatAge: u32(
              (this.clock.now() - this.renewedAt(b.lease)) / 1000,
            ),
            leaseHeld: false,
          })
          return
        }
        if (b.endAt === undefined || b.fate === S.BEE_CRASH)
          this.clock.after(hb, check)
      }
      this.clock.after(hb, check)
    })
    return { claim: true, work: { ended, cancel: () => this.stopBee(b) } }
  }

  // --- the dispatchers -------------------------------------------------------------

  /** The incarnation's process: its timers die with it. */
  private incClock(inc: { dead: boolean }): Clock {
    return {
      now: () => this.clock.now(),
      after: (ms, fn) =>
        this.clock.after(ms, () => {
          if (!inc.dead) fn()
        }),
    }
  }

  /** The system, as the world sees it: a supervisor's decision knows whose exit it is. */
  private observed(raw: ActorSystem): ActorSystem {
    return {
      ...raw,
      spawn: <M>(
        spec: ActorSpec<M>,
        onExit: (reason: number) => void = () => {},
        slot?: bigint,
      ): Pid =>
        raw.spawn(
          spec,
          (reason) => {
            const outer = this.exitOf
            this.exitOf = spec.name
            try {
              onExit(reason)
            } finally {
              this.exitOf = outer
            }
          },
          slot,
        ),
    }
  }

  /** Wait out a store call; a process that has exited is never answered. */
  private async storeCall(inc: Inc, ms: number, hangUntil = 0) {
    const now = this.clock.now()
    await this.sleep((hangUntil > now ? hangUntil - now : 0) + ms)
    if (inc.dead) await new Promise<void>(() => {})
  }

  private boot(slot: number) {
    const id = this.nextIncId++
    const boot = this.roll(S.STREAM_TARGET, 1_000_000 + id)
      .toString(16)
      .padStart(8, '0')
    // its system and its dispatcher come next: both need the incarnation
    const state: Omit<Inc, 'sys' | 'd'> = {
      id,
      slot,
      boot,
      stopping: false,
      dead: false,
      running: 0,
      crashNext: false,
      stallNext: false,
      claimsHangUntil: 0,
      toStop: new Set<Pid>(),
      exits: [],
      laneIdleSince: new Map<number, number>(),
    }
    const inc = state as Inc
    // both replicas are node 0 of one process name: their pids are drawn alike
    const raw = createActorSystem(this.incClock(inc), {
      slices: false,
      node: 0,
    })
    const sys = this.observed(raw)
    inc.sys = sys
    // the process name both replicas share, and this process's boot
    const holderPrefix =
      this.options.recreate === 'pid-holder' ? 'queen' : `queen/${boot}`
    inc.d = beeDispatcher(sys, {
      lanes: () => {
        if (inc.crashNext) {
          inc.crashNext = false
          this.log(
            `dispatcher ${slot}: the admission's lane count throws`,
            `inc ${id}`,
          )
          throw new Error('the lane count could not be read (simulated)')
        }
        return S.KEYED_LANES
      },
      admit: async (issue) => {
        let ms = S.POLICY_MS
        if (inc.stallNext) {
          inc.stallNext = false
          ms = S.POLICY_STALL_SECONDS * 1000
          this.log(
            `dispatcher ${slot}: the policy stalls on #${issue}`,
            `#${issue}`,
          )
        }
        await this.storeCall(inc, ms)
        return !this.completed.has(issue) && !this.givenUp.has(issue)
      },
      order: (waiting) =>
        [...waiting].sort(
          (a, b) => (this.arrived.get(a) ?? 0) - (this.arrived.get(b) ?? 0),
        ),
      start: async (issue, holder): Promise<BeeStart> => {
        await this.storeCall(inc, S.CLAIM_MS, inc.claimsHangUntil)
        const lease = this.completed.has(issue)
          ? undefined
          : this.claim(issue, holder)
        if (!lease) {
          const l = this.leases.get(issue)
          this.log(`#${issue}: claim for ${holder} lost`, `#${issue}`)
          return {
            claim: false,
            work: null,
            holderSinceRenewal: l
              ? u32((this.clock.now() - this.renewedAt(l)) / 1000)
              : 0,
          }
        }
        return this.workOf(this.startBee(issue, inc, lease))
      },
      observe: (e) => {
        if (e.kind === 'stood-down') this.rare.add(S.RARE_STOOD_DOWN)
        if (e.kind === 'ended' && e.decision === RD_GIVE_UP) {
          this.givenUp.add(e.issue)
          this.count('givenUp')
        }
        this.log(
          `dispatcher ${slot}: ${e.kind}${'issue' in e ? ` #${e.issue}` : ''}`,
          `inc ${id}`,
        )
      },
      holderPrefix,
      turnMaxSeconds: S.BEE_TURN_MAX_SECONDS,
      admitAfterMs: S.ADMIT_AFTER_SECONDS * 1000,
    })
    // while it stops: when each issue actor exits, and whether a kill did it
    raw.onExit((pid, reason) => {
      if (!inc.toStop.delete(pid)) return
      inc.exits.push({ pid, at: this.clock.now() })
      if (reason === X_KILLED) this.rare.add(S.RARE_STOP_KILLED)
    })
    this.incs.push(inc)
    this.current[slot] = inc
    this.log(
      `dispatcher ${slot} boots: incarnation ${id}, holder ${holderPrefix}`,
      `inc ${id}`,
    )
    return inc
  }

  private open(): number[] {
    return [...this.arrived.keys()].filter(
      (n) => !this.completed.has(n) && !this.givenUp.has(n),
    )
  }

  /** The issues of a list that are neither done nor given up. */
  private openOf(issues: number[]): number[] {
    return issues.filter((n) => !this.completed.has(n) && !this.givenUp.has(n))
  }

  private liveIncs(): Inc[] {
    return this.current.filter(
      (i): i is Inc => i !== undefined && !i.stopping && !i.dead,
    )
  }

  /**
   * The round: reap what runners held past the runner cap, ready every open
   * issue, and look at every board.
   */
  private round = () => {
    const now = this.clock.now()
    // reapSilentRunners: the row of a runner task past RUNNER_CAP_MINUTES ends
    for (const set of this.live.values())
      for (const b of [...set])
        if (
          b.endAt === undefined &&
          now - b.start >= S.SIM_RUNNER_CAP_SECONDS * 1000
        ) {
          this.count('reaped')
          this.log(
            `bee ${b.id} #${b.issue} reaped at the runner cap`,
            `#${b.issue}`,
          )
          this.endBee(b, 'stopped')
        }
    for (const inc of this.liveIncs()) {
      this.checkLanes(inc, now)
      for (const issue of this.open()) inc.d.ready(issue)
      // an open issue's wait with a lane free ends as soon as the admission
      // is there; a done one's is not judged (WAITING_STUCK_SECONDS)
      const waiting = this.openOf(inc.d.waiting())
      const stuck =
        waiting.length > 0 && laneFree(inc.d.lanesInUse(), S.KEYED_LANES)
      if (!stuck) inc.freeWaitSince = undefined
      else {
        inc.freeWaitSince ??= now
        const s = Math.floor((now - inc.freeWaitSince) / 1000)
        if (waitingStuck(s))
          this.fail(
            S.INV_LANE_LEAK,
            `dispatcher ${inc.slot} (incarnation ${inc.id}): open issues ${waiting.join(', ')} waited ${s} s on its board with ${inc.d.lanesInUse()} of ${S.KEYED_LANES} lanes in use`,
            `inc ${inc.id}`,
          )
      }
    }
    this.clock.after(S.KEYED_ROUND_SECONDS * 1000, this.round)
  }

  /**
   * Every lane on a board is held by a turn of its issue's actor (admitting,
   * claiming) or by a bee of its issue; with neither for LANE_IDLE_SECONDS it
   * is held by nobody.
   */
  private checkLanes(inc: Inc, now: number) {
    const idle = new Map<number, number>()
    for (const issue of inc.d.board.lanes.keys()) {
      // a bee holds its lane until the dispatcher knows it ended: a runner
      // that died is known only once its lease has lapsed
      const bee = this.bees.some(
        (b) => b.inc === inc && b.issue === issue && !b.known,
      )
      const pid = inc.d.issues.pidOf(issue)
      const turn = pid !== undefined && inc.sys.busy(pid)
      if (bee || turn) continue
      const since = inc.laneIdleSince.get(issue) ?? now
      idle.set(issue, since)
      const s = Math.floor((now - since) / 1000)
      if (laneHeldByNobody(s))
        this.fail(
          S.INV_LANE_LEAK,
          `dispatcher ${inc.slot} (incarnation ${inc.id}): the lane of #${issue} has been held for ${s} s with no bee running and no turn of its actor (${pid === undefined ? 'no actor' : `actor ${pid} idle`})`,
          `inc ${inc.id}`,
          `#${issue}`,
        )
    }
    inc.laneIdleSince = idle
  }

  /** A redeploy of one dispatcher, while its claims hang. */
  private deploy(slot: number) {
    const inc = this.current[slot]
    if (!inc || inc.stopping || inc.dead) return
    const now = this.clock.now()
    inc.claimsHangUntil = now + S.CLAIM_HANG_SECONDS * 1000
    this.log(
      `dispatcher ${slot}: its claims hang, a deploy comes`,
      `inc ${inc.id}`,
    )
    for (const issue of this.open()) inc.d.ready(issue)
    this.clock.after(S.DEPLOY_STOP_AFTER_MS, () => this.stop(inc))
  }

  private stop(inc: Inc) {
    inc.stopping = true
    const t0 = this.clock.now()
    const n = inc.d.issues.active()
    let ended = false
    let busy = 0
    for (const k of inc.d.issues.keys()) {
      const pid = inc.d.issues.pidOf(k)
      if (pid === undefined) continue
      inc.toStop.add(pid)
      if (inc.sys.busy(pid)) busy++
    }
    this.log(
      `dispatcher ${inc.slot} stops ${n} issue actors, ${busy} of them in a turn`,
      `inc ${inc.id}`,
    )
    // a stop that has not ended a second past its bound will not end in time
    this.clock.after(n * S.SIM_WORKER_SHUTDOWN_MS + 1000, () => {
      const elapsed = this.clock.now() - t0
      if (!ended && stopOverran(elapsed, n, S.SIM_WORKER_SHUTDOWN_MS))
        this.fail(
          S.INV_STOP_OVERRAN,
          `dispatcher ${inc.slot} (incarnation ${inc.id}): its stop of ${n} issue actors has not ended after ${elapsed} ms`,
          `inc ${inc.id}`,
        )
    })
    void inc.d.stop().then(() => {
      ended = true
      const elapsed = this.clock.now() - t0
      this.log(
        `dispatcher ${inc.slot} stopped in ${elapsed} ms`,
        `inc ${inc.id}`,
      )
      if (stopOverran(elapsed, n, S.SIM_WORKER_SHUTDOWN_MS))
        this.fail(
          S.INV_STOP_OVERRAN,
          `dispatcher ${inc.slot} (incarnation ${inc.id}): stopping ${n} issue actors took ${elapsed} ms, past ${n} x ${S.SIM_WORKER_SHUTDOWN_MS} ms`,
          `inc ${inc.id}`,
        )
      // one after another: each child's stop begins at the exit before it
      let prev = t0
      for (const e of inc.exits) {
        if (stopOverran(e.at - prev, 1, S.SIM_WORKER_SHUTDOWN_MS))
          this.fail(
            S.INV_STOP_OVERRAN,
            `dispatcher ${inc.slot} (incarnation ${inc.id}): issue actor ${e.pid} outlived its ${S.SIM_WORKER_SHUTDOWN_MS} ms shutdown by ${e.at - prev - S.SIM_WORKER_SHUTDOWN_MS} ms`,
            `inc ${inc.id}`,
          )
        prev = e.at
      }
      // the process exits; the next one boots after the gap
      inc.dead = true
      this.clock.after(S.DEPLOY_GAP_SECONDS * 1000, () => this.boot(inc.slot))
    })
  }

  // --- the probes ----------------------------------------------------------------

  private bootProbes() {
    this.psys = createActorSystem(this.clock, { slices: false, turnStop: true })
    // past the slot chain: every probe's slot is above 63
    for (let i = 0; i < S.PROBE_FILLERS; i++)
      this.psys.spawn({ name: 'filler', receive: () => {} })
    const links = linksOf(this.psys)
    this.probes = keyedActors<number, ProbeMsg>(this.psys, {
      name: 'probe',
      make: (key) => ({
        name: `probe-${key}`,
        receive: async (msg, self) => {
          if (msg.kind !== 'call') return
          const req = msg
          const { route, i, probe } = req.body
          if (i + 1 < route.length) {
            const to = this.probePid(route[i + 1])
            const t0 = this.clock.now()
            const got = await links.call(
              { self, serving: req },
              to,
              { route, i: i + 1, probe },
              S.PROBE_CALL_MS,
            )
            if (i + 2 === route.length)
              this.judgeProbe(probe, route, got.outcome, this.clock.now() - t0)
          }
          links.reply(req, i, self)
        },
      }),
    })
    this.probeCaller = this.psys.spawn({
      name: 'probe-caller',
      receive: () => {},
    })
  }

  private probePid(key: number): Pid {
    let pid = this.probes.pidOf(key)
    if (pid === undefined) {
      this.probes.send(key, { kind: 'wake' })
      pid = this.probes.pidOf(key)
    }
    return pid ?? 0n
  }

  /** The last call of a chain: refused at once when it closes a cycle, answered when not. */
  private judgeProbe(
    probe: number,
    route: number[],
    outcome: number,
    ms: number,
  ) {
    const last = route[route.length - 1]
    const cycle = route.indexOf(last) < route.length - 1
    this.log(
      `probe ${probe} [${route.join(' -> ')}]: ${cycle ? 'cycle' : 'open'}, outcome ${outcome} after ${ms} ms`,
      `probe ${probe}`,
    )
    if (cycle && outcome === CALL_CYCLE && ms === 0) {
      this.rare.add(S.RARE_CYCLE_REFUSED)
      return
    }
    if (!cycle && outcome === CALL_REPLY) return
    this.fail(
      S.INV_CALL_CHAIN,
      cycle
        ? `probe ${probe}: the call from key ${route[route.length - 2]} back to key ${last}, already on its chain, ended with outcome ${outcome} after ${ms} ms instead of being refused at once`
        : `probe ${probe}: the call to key ${last}, off its chain, ended with outcome ${outcome}`,
      `probe ${probe}`,
    )
  }

  private cycleProbe(step: number) {
    const r = (k: number) => this.roll(S.STREAM_TARGET, step * 8 + k)
    const length = probeLength(r(0))
    const keys = Array.from({ length }, () => this.nextProbeKey++)
    const back = probeOpen(r(1))
      ? this.nextProbeKey++
      : keys[probeBackTo(r(2), length)]
    const route = [...keys, back]
    const probe = this.nextProbe++
    void linksOf(this.psys).call(
      { self: this.probeCaller },
      this.probePid(route[0]),
      { route, i: 0, probe },
      S.PROBE_CALL_MS * (route.length + 1),
    )
  }

  /** A turn whose isolated work does not hear its abort. */
  private deafTurn() {
    const probe = this.nextProbe++
    const work = { ended: false, stoppedAt: -1, killedAt: -1 }
    const pid = this.psys.spawn<{ go: true }>({
      name: `deaf-${probe}`,
      turnMaxSeconds: S.DEAF_TURN_SECONDS,
      isolated: {
        cpuBound: false,
        foreignCode: true,
        mustStop: true,
        start: () => {
          let resolve: () => void = () => {}
          const result = new Promise<void>((r) => {
            resolve = r
          })
          const cancel = this.clock.after(S.DEAF_WORK_SECONDS * 1000, () => {
            work.ended = true
            resolve()
          })
          return {
            result,
            stop: () => {
              if (work.ended) return
              work.ended = true
              work.stoppedAt = this.clock.now()
              cancel()
              resolve()
            },
          }
        },
      },
      receive: () => {},
    })
    const unhook = this.psys.onExit((p, reason) => {
      if (p !== pid) return
      unhook()
      if (reason === X_KILLED) work.killedAt = this.clock.now()
    })
    this.psys.send(pid, { go: true })
    this.log(`deaf turn ${probe} starts`, `probe ${probe}`)
    this.clock.after(
      S.DEAF_TURN_SECONDS * 1000 + S.SIM_TURN_STOP_GRACE_MS + 1000,
      () => {
        const after = work.stoppedAt - work.killedAt
        this.log(
          `deaf turn ${probe}: killed at ${work.killedAt}, its work ${work.ended ? `stopped at ${work.stoppedAt}` : 'still runs'}`,
          `probe ${probe}`,
        )
        if (
          work.killedAt >= 0 &&
          work.stoppedAt >= 0 &&
          !deafWorkOverran(after)
        ) {
          this.rare.add(S.RARE_GROUP_KILLED)
          return
        }
        this.fail(
          S.INV_STOP_OVERRAN,
          work.ended
            ? `deaf turn ${probe}: its work stopped ${after} ms after its kill, past the ${S.SIM_TURN_STOP_GRACE_MS} ms grace`
            : `deaf turn ${probe}: its work still runs ${this.clock.now() - work.killedAt} ms after its kill (killed ${work.killedAt >= 0})`,
          `probe ${probe}`,
        )
      },
    )
  }

  // --- the steps -------------------------------------------------------------------

  private pickInc(step: number): Inc | undefined {
    const live = this.liveIncs()
    if (live.length === 0) return undefined
    return live[this.roll(S.STREAM_TARGET, step) % live.length]
  }

  private apply(event: number, step: number) {
    this.count(`kevent${event}`)
    switch (event) {
      case S.K_ARRIVAL: {
        const issue = this.nextIssue++
        this.indexOf.set(issue, this.arrived.size)
        this.arrived.set(issue, this.clock.now())
        this.log(`arrival #${issue}`, `#${issue}`)
        for (const inc of this.liveIncs()) inc.d.ready(issue)
        return
      }
      case S.KF_ADMISSION_CRASH: {
        const inc = this.pickInc(step)
        if (inc) inc.crashNext = true
        return
      }
      case S.KF_ISSUE_CRASH: {
        const inc = this.pickInc(step)
        if (!inc) return
        // one in a turn when there is one: the crash a turn's await outlives
        const all = inc.d.issues.keys()
        const busy = all.filter((k) => {
          const pid = inc.d.issues.pidOf(k)
          return pid !== undefined && inc.sys.busy(pid)
        })
        const keys = busy.length > 0 ? busy : all
        if (keys.length === 0) return
        const issue = keys[this.roll(S.STREAM_DURATION, step) % keys.length]
        const pid = inc.d.issues.pidOf(issue)
        if (pid === undefined) return
        this.log(
          `dispatcher ${inc.slot}: the actor of #${issue} crashes${busy.length > 0 ? ' in a turn' : ''}`,
          `#${issue}`,
        )
        inc.sys.exit(pid, X_CRASH)
        return
      }
      case S.KF_POLICY_STALL: {
        const inc = this.pickInc(step)
        if (inc) inc.stallNext = true
        return
      }
      case S.KF_DEPLOY: {
        const inc = this.pickInc(step)
        if (inc) this.deploy(inc.slot)
        return
      }
      case S.KF_CYCLE_PROBE:
        this.cycleProbe(step)
        return
      case S.KF_DEAF_TURN:
        this.deafTurn()
        return
      default:
        return
    }
  }

  /** After a step: no board holds more lanes than it has. */
  /**
   * After a step: no board holds more lanes than it has, and no dispatcher
   * runs more bees than its lanes. AT MOST N RUNNING PER LANE BOUND, counted
   * from the bees themselves: every bee it started that still works, a hung
   * one included. A bee it asked to stop is on its way out (its runner ends it
   * at the next poll) and is not counted; one killed at its turn bound keeps
   * its lane on the board until it ends (holds_after_kill), so no other bee
   * runs on that lane meanwhile.
   */
  private checkBoards() {
    for (const inc of this.liveIncs()) {
      if (inc.d.lanesInUse() > S.KEYED_LANES)
        this.fail(
          S.INV_OVER_LANES,
          `dispatcher ${inc.slot} (incarnation ${inc.id}): ${inc.d.lanesInUse()} lanes on a board of ${S.KEYED_LANES}`,
          `inc ${inc.id}`,
        )
      const working = this.bees.filter(
        (b) => b.inc === inc && b.endAt === undefined && !b.stopping,
      )
      if (working.length > S.KEYED_LANES)
        this.fail(
          S.INV_OVER_LANES,
          `dispatcher ${inc.slot} (incarnation ${inc.id}) runs ${working.length} bees on ${S.KEYED_LANES} lanes: ${working.map((b) => `#${b.issue}`).join(', ')}`,
          `inc ${inc.id}`,
          ...working.map((b) => `#${b.issue}`),
        )
    }
  }

  /** At the end, everything is done and nothing is held. */
  private checkEnd() {
    for (const issue of this.arrived.keys())
      if (!this.completed.has(issue) && !this.givenUp.has(issue)) {
        const bees = [...(this.live.get(issue) ?? [])].map((b) => b.id)
        this.fail(
          S.INV_NOT_FINISHED,
          `#${issue} arrived at ${this.arrived.get(issue)} ms and is neither done nor given up at ${this.clock.now()} ms (attempts ${this.attempts.get(issue) ?? 0}, bees running ${bees.join(', ') || 'none'})`,
          `#${issue}`,
        )
        return
      }
    for (const inc of this.liveIncs()) {
      const lanes = inc.d.lanesInUse()
      const waiting = this.openOf(inc.d.waiting())
      if (lanes > inc.running || waiting.length > 0)
        this.fail(
          S.INV_LANE_LEAK,
          `dispatcher ${inc.slot} (incarnation ${inc.id}) ends with ${lanes} lanes held for ${inc.running} running bees and open issues ${waiting.join(', ') || 'none'} waiting (lanes of ${[...inc.d.board.lanes.keys()].join(', ') || 'none'})`,
          `inc ${inc.id}`,
        )
    }
  }

  async run(steps: number = S.STEPS_PER_RUN): Promise<RunResult> {
    const t0 = performance.now()
    const untaps = [
      this.tap(ACTORS_CARD, (n, a, r) => this.onActorsCall(n, a, r)),
      this.tap(KEYED_GUARD_CARD, (n, a, r) => this.onGuardCall(n, a, r)),
      this.tap(KEYED_CARD, this.onCall),
      this.tap(DISPATCH_EXIT_CARD, this.onCall),
    ]
    let ran = 0
    try {
      for (let slot = 0; slot < S.KEYED_DISPATCHERS; slot++) this.boot(slot)
      this.bootProbes()
      this.clock.after(S.KEYED_ROUND_SECONDS * 1000, this.round)
      for (let step = 0; step < steps && !this.violation; step++) {
        this.step = step
        this.mix(step)
        this.apply(keyedEvent(this.roll(S.STREAM_STEP, step)), step)
        await this.clock.runUntil(
          this.clock.now() + stepMs(this.roll(S.STREAM_DELAY, step)),
        )
        this.checkBoards()
        this.stepHashes.push(this.hash >>> 0)
        ran = step + 1
      }
      // the quiet tail: no new event, every bee and every retry runs out
      this.step = steps
      const start = this.clock.now()
      for (let m = 1; m * 60 <= S.KEYED_TAIL_SECONDS && !this.violation; m++) {
        await this.clock.runUntil(start + m * 60_000)
        this.checkBoards()
        this.stepHashes.push(this.hash >>> 0)
      }
      if (!this.violation) this.checkEnd()
      await this.quiesce()
      this.stepHashes.push(this.hash >>> 0)
      for (const inc of this.incs) {
        if (inc.d.stats.admissionStarts > 1)
          this.rare.add(S.RARE_ADMISSION_RESTARTED)
        if (inc.d.stats.lanesFreedOnExit > 0)
          this.rare.add(S.RARE_LANE_FREED_ON_EXIT)
        if (inc.d.stats.grantsTakenBack > 0)
          this.rare.add(S.RARE_GRANT_TAKEN_BACK)
        this.counts.started = (this.counts.started ?? 0) + inc.d.stats.started
        this.counts.standDowns =
          (this.counts.standDowns ?? 0) + inc.d.stats.standDowns
        this.counts.admissionStarts =
          (this.counts.admissionStarts ?? 0) + inc.d.stats.admissionStarts
      }
      this.counts.incarnations = this.incs.length
      this.counts.issues = this.arrived.size
      this.counts.virtualSeconds = Math.round(this.clock.now() / 1000)
    } finally {
      await this.quiesce()
      const hash = this.hash >>> 0
      this.closed = true
      for (const untap of untaps) untap()
      this.finalHash = hash
    }
    return this.result(ran, this.finalHash, performance.now() - t0)
  }
}
