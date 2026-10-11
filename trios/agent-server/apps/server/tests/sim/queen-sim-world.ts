/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE SIMULATION WORLD (gHashTag/t27 specs/queen/simulation.t27, trios#1712
 * item 5).
 *
 * WHY. The benchmark that cleared the actor reviewer ran on a virtual clock
 * and a seed, and still missed the go-live hot loop: it had no unreadable
 * row, so ~184 visits a minute against 22 such rows were found in production
 * (t27#7851). This world draws the work, the interleaving and the faults from
 * one seed, checks the invariants after every event, and is run twice per
 * seed by the gate so that a run which logs differently is caught too.
 *
 * WHAT RUNS IS THE REAL RUNTIME: createActorSystem, supervisor, remoteChild,
 * createMemoryNet (or the real createPgLink over the simulated store, see
 * queen-sim-pg-store.ts) and the reviewer actors (reviewerTree,
 * withWaitBackoff), on the virtual clock, with turns that really stop, the
 * adaptive pool (a dynamic supervisor the intake sizes) and the review lane
 * queue on the seeds the card names (seed_features). What is simulated is only
 * what the runtime talks to: the store (which rows wait, the lease), the
 * review itself (its length, its fate, its abort, and with the queue its
 * witness on no lane before its model call), the keys bees hold, the bus, and
 * the nodes of the pool.
 *
 * WHAT DECIDES. The simulation card (queen/simulation.wasm): every random
 * number is its sim_roll(seed, stream, index); each step's event is its
 * step_event, the time that passes its step_ms, which seeds stop turns its
 * seed_features, which jobs go to a remembered pid its stale_job; which
 * invariant fails the gate, the hot-loop bound, the cap and the intensity
 * checks are its functions. The wall clock the runtime reads (the slice; the
 * store link's lease age) is the virtual clock plus work the card draws,
 * handed to each system and link (`micros`). This file holds the world's
 * state, applies events and watches.
 *
 * HOW IT WATCHES. The reviewer and the pool are handed an observed system: a
 * copy of the runtime's whose spawn, send, exit and monitor log and check
 * before they delegate. Every spec spawned through it, and every kind started
 * on a node, gets a receive that checks its process is alive. Every mail that
 * crosses nodes carries a wire id, so mail still on the wire is known when a
 * pid is given out, and a job names the incarnation its sender meant. The
 * actors and reviewer cards are tapped, so their decisions go into the run's
 * log, and each supervisor's restart decisions are counted on the harness's
 * own clock, the supervisor told by the exit that caused the decision.
 */

import {
  type ActorSpec,
  type ActorSystem,
  createActorSystem,
  type Down,
  type Mail,
  type NodeLink,
  type Pid,
  remoteChild,
  supervisor,
} from '../../src/api/services/queen-actors'
import {
  D_DROPPED_FULL,
  DOMAIN_MAX_RESTARTS,
  DOMAIN_PERIOD_SECONDS,
  MAILBOX_CAP,
  ROOT_MAX_RESTARTS,
  ROOT_PERIOD_SECONDS,
  STRAT_ONE_FOR_ONE,
  SUP_GIVE_UP,
  SUP_RESTART,
  X_KILLED,
} from '../../src/api/services/queen-actors-card.gen'
import { createMemoryNet } from '../../src/api/services/queen-actors-net'
import { loadCardWasm } from '../../src/api/services/queen-card-wasm'
import {
  type PoolSize,
  REVIEWER_SIZING_CARD,
  type ReviewerActorDeps,
  reviewerTree,
} from '../../src/api/services/queen-review-actors'
import {
  type LaneGate,
  REVIEW_LANES_CARD,
} from '../../src/api/services/queen-review-lanes'
import {
  LANE_GO,
  LANE_STOPPED,
} from '../../src/api/services/queen-review-lanes-card.gen'
import {
  type Judged,
  type ReviewerDeps,
  withWaitBackoff,
} from '../../src/api/services/queen-review-loop'
import {
  REVIEWER_CEILING,
  REVIEWER_CONCURRENCY,
  WAIT_REVISIT_BASE_SECONDS,
} from '../../src/api/services/queen-reviewer-card.gen'
import * as S from '../../src/api/services/queen-simulation-card.gen'
import { VirtualClock } from '../api/queen-virtual-clock'
import {
  type JournalOptions,
  pickBetween,
  type RunResult,
  SIMULATION_CARD,
  SimJournal,
} from './queen-sim-journal'

export {
  failsGate,
  INVARIANT_NAMES,
  pickBetween,
  RARE_NAMES,
  type RunResult,
  report,
  SIMULATION_CARD,
  simRoll,
  type Violation,
} from './queen-sim-journal'

const ACTORS_CARD = 'queen/actors.wasm'
/** The name queen-actors-links.ts gives a call's alias process. */
const CALL_ALIAS = 'call-alias'
const REVIEWER_CARD = 'queen/reviewer.wasm'

const sim = () => loadCardWasm(SIMULATION_CARD)
const u32 = (n: number) => n >>> 0
export const runSeed = (base: number, i: number) =>
  u32(sim().call('run_seed', u32(base), u32(i)))
const stepEvent = (roll: number) => sim().call('step_event', u32(roll))
const stepMs = (roll: number) => u32(sim().call('step_ms', u32(roll)))
const mailboxBurst = (cap: number) => u32(sim().call('mailbox_burst', cap))
const hotLoop = (visits: number, base: number) =>
  sim().call('hot_loop', visits, base) !== 0
const overCap = (atOnce: number, cap: number) =>
  sim().call('over_cap', atOnce, cap) !== 0
const intensityKept = (inPeriod: number, max: number) =>
  sim().call('intensity_kept', inPeriod, max) !== 0
export const seedFeatures = (i: number) =>
  u32(sim().call('seed_features', u32(i)))
export const hasFeature = (features: number, feature: number) =>
  sim().call('has_feature', u32(features), u32(feature)) !== 0
const stale = (roll: number) => sim().call('stale_job', u32(roll)) !== 0
const beeKeys = (roll: number) => u32(sim().call('bee_keys', u32(roll)))
const laneHeldByNobody = (seconds: number) =>
  sim().call('lane_held_by_nobody', u32(seconds)) !== 0
export const answerLost = (roll: number) =>
  sim().call('answer_lost', u32(roll)) !== 0
export const mustReach = (state: number) =>
  sim().call('must_reach', state) !== 0

/** A node link the world can crash and bring back, over some wire. */
export interface Transport {
  /** The link a (re)started node `n` runs on. */
  link(n: number): NodeLink | Promise<NodeLink>
  /** The node stops: no heartbeat, no mail in or out. */
  crash(n: number): void
  /** Called at the end of each step: the transport settles what it owes. */
  settle?(): Promise<void>
  stop?(): Promise<void>
}

export interface WorldOptions extends JournalOptions {
  /** Re-create the go-live defect: the reviewer without the wait backoff. */
  noWaitBackoff?: boolean
  /** A transport other than the memory net (the PgLink store model). */
  transport?: (world: SimWorld) => Transport
  /** Turns that really stop (turn_stop.t27), the flag TRIOS_QUEEN_TURN_STOP sets. */
  turnStop?: boolean
  /** The adaptive pool (reviewer_sizing.t27), TRIOS_QUEEN_REVIEWER_ADAPTIVE=1. */
  adaptive?: boolean
  /** The review lane queue (review_lanes.t27), TRIOS_QUEEN_REVIEW_LANES=semaphore. */
  laneQueue?: boolean
}

interface Incarnation {
  id: number
  name: string
  node: number
  pid: Pid
  /** The pool child an echo worker runs for. */
  child?: string
  exited: boolean
  inTurn: number
}

type Fate = 'ok' | 'wait' | 'refused' | 'stall' | 'crash'

interface Row {
  issue: number
  unreadableUntil: number
  decided: boolean
}

const fmtPid = (pid: Pid) => {
  const slot = pid >> 32n
  return `${pid}(n${Number(slot >> 20n)}.${Number(slot & 0xfffffn)}.g${Number(pid & 0xffffffffn)})`
}

/**
 * One seed's world. `run` plays STEPS_PER_RUN steps (or `steps`) and the
 * quiet tail, and stops at the first violation.
 */
export class SimWorld extends SimJournal {
  readonly clock = new VirtualClock()
  private finalHash = 0

  // the runtime, as the world sees it
  private readonly systems = new Map<number, ActorSystem>()
  private readonly rawSystems: ActorSystem[] = []
  private readonly crashed = new Set<number>()
  private transport!: Transport
  private nextInc = 1
  private readonly live = new Set<Incarnation>()
  private readonly byPid = new Map<Pid, Incarnation>()
  private readonly lastByName = new Map<string, Incarnation>()
  private readonly lastByChild = new Map<string, Incarnation>()
  // mail on the wire, by the pid it is addressed to
  private nextWire = 1
  private readonly wire = new Map<
    number,
    { pid?: Pid; intended?: number; toNode: number }
  >()
  private readonly wireByPid = new Map<Pid, Set<number>>()

  // the reviewer's world
  private readonly rows = new Map<number, Row>()
  private nextIssue = 1000
  private attempts = 0
  private dbCalls = 0
  private pendingHung = 0
  private pendingCrash = 0
  private refusedUntil = 0
  private leaseLostUntil = 0
  private readonly reviewsOf = new Map<number, number>()
  private readonly keysHeld = new Map<number, number>()
  private readonly visits = new Map<number, number[]>()
  private wake: () => void = () => {}
  // the keys bees hold now, and the lane queue as the reviews see it: only on
  // the seeds with the adaptive pool or the queue (simulation.t27 section 8)
  private readonly beeKeys = new Set<number>()
  private waiters = 0
  /** The keys the reviewer reserves for its reviews, as it hands them out. */
  private reserved: (() => number[]) | undefined
  /** Since when each key the reviewer reserves has had no review holding it. */
  private unheldSince = new Map<number, number>()
  /**
   * The reviewer's process, as the world models it. A reviewer whose root gave
   * up comes back with the next deploy, a new process: the reviews the old
   * one abandoned die with it and hold no row or lane any more.
   */
  private reviewerProcess = 0

  // the pool's world
  private registrar: Pid = 0n
  private readonly known = new Map<string, Pid>()
  private readonly svc = new Map<number, Pid>()
  private readonly remembered: Array<{ pid: Pid; inc: number }> = []
  private nextJob = 1

  // restart decisions per supervisor, by its maximum
  private readonly decisions = new Map<string, number[]>()
  private lastExitMax = -1
  /** The exit being handled now, and how many decisions it has caused. */
  private exitCtx: { name: string; depth: number } | undefined
  private readonly periods = new Map<number, number>([
    [DOMAIN_MAX_RESTARTS, DOMAIN_PERIOD_SECONDS],
    [ROOT_MAX_RESTARTS, ROOT_PERIOD_SECONDS],
    [S.POOL_MAX_RESTARTS, S.POOL_PERIOD_SECONDS],
  ])

  constructor(
    seed: number,
    readonly options: WorldOptions = {},
  ) {
    super(seed, options)
  }

  // THE WALL CLOCK THE RUNTIME READS (the slice; the store link's lease
  // age): the virtual clock plus the work the card draws for each read. It is
  // handed to every system and link this world starts (`micros`, `now`) and
  // never set on performance.now. WHY: set there, every reader in the process
  // moved it. Under coverage, beside other test files, two runs of one seed
  // read it 16 525 and 16 518 times and yielded 637 and 634 times; one 1 ms
  // timer reading performance.now beside the gate parts 3 runs of 3
  // (gHashTag/trios#1729 item 8).
  private wallMicros = 0
  private wallReads = 0
  /** The runtime's wall clock, in microseconds. */
  readonly micros = (): number => {
    this.wallMicros += pickBetween(
      this.roll(S.STREAM_CLOCK, this.wallReads++),
      0,
      S.CLOCK_TICK_MAX_MICROS,
    )
    return this.clock.now() * 1000 + this.wallMicros
  }
  /** The same clock in milliseconds, for the store link. */
  readonly wallMs = (): number => this.micros() / 1000

  // --- the card tap: every decision of the actors and reviewer cards -------

  private onActorsCall(
    name: string,
    a: Array<number | bigint>,
    r: number | bigint,
  ): undefined {
    this.journal(name, a, r)
    if (name === 'on_child_exit') this.lastExitMax = a[3] as number
    else if (name === 'with_backoff') this.decided(r as number)
    return undefined
  }

  private onReviewerCall(
    name: string,
    a: Array<number | bigint>,
    r: number | bigint,
  ): undefined {
    this.journal(name, a, r)
    if (name === 'due_again' && r === 0) this.rare.add(S.RARE_WAIT_BACKED_OFF)
    return undefined
  }

  /**
   * The supervisors above a child, nearest first, as this world builds its
   * trees: the reviewer's (queen-review-actors.ts; with turnStop the workers
   * get a supervisor of their own) and the pool's.
   */
  private supervisorsOf(child: string): string[] {
    if (child === 'reviewer-intake' || child === 'review-lanes')
      return ['reviewer-domain', 'queen-root']
    if (child.startsWith('reviewer-worker-'))
      return this.options.adaptive
        ? ['reviewer-pool', 'reviewer-domain', 'queen-root']
        : this.options.turnStop
          ? ['reviewer-workers', 'reviewer-domain', 'queen-root']
          : ['reviewer-domain', 'queen-root']
    if (child.endsWith('-watch')) return ['pool']
    return []
  }

  /**
   * Which supervisor decided. Every decision runs inside the exit that caused
   * it, synchronously: the child's own supervisor first, and when it gives
   * up, its parent, and so on. Two supervisors with the same maximum and
   * period are told apart this way; with no exit in view, by the maximum.
   */
  private decider(): { key: string; max: number; period: number } | undefined {
    const ctx = this.exitCtx
    const sup = ctx ? this.supervisorsOf(ctx.name)[ctx.depth] : undefined
    if (ctx) ctx.depth++
    if (sup) {
      const top = sup === 'queen-root'
      const max = top
        ? ROOT_MAX_RESTARTS
        : sup === 'pool'
          ? S.POOL_MAX_RESTARTS
          : DOMAIN_MAX_RESTARTS
      if (max !== this.lastExitMax) this.count('deciderMismatch')
      const period = this.periods.get(max)
      return period === undefined ? undefined : { key: sup, max, period }
    }
    const period = this.periods.get(this.lastExitMax)
    if (period === undefined) return undefined
    return { key: `max ${this.lastExitMax}`, max: this.lastExitMax, period }
  }

  /** A supervisor decided; count its restarts in its period on our clock. */
  private decided(decision: number) {
    const who = this.decider()
    if (!who) return
    const { key, max, period } = who
    const now = this.clock.now()
    const list = this.decisions.get(key) ?? []
    if (decision === SUP_GIVE_UP) {
      this.rare.add(S.RARE_INTENSITY_SPENT)
      this.log(`supervisor ${key} gave up`)
      // that supervisor is gone; the one that replaces it counts afresh
      this.decisions.set(key, [])
      return
    }
    if (decision !== SUP_RESTART) return
    this.tapping = true
    const kept = [...list, now].filter(
      (t) =>
        loadCardWasm(ACTORS_CARD).call(
          'in_period',
          u32((now - t) / 1000),
          period,
        ) !== 0,
    )
    this.tapping = false
    this.decisions.set(key, kept)
    this.log(`supervisor ${key} restarts: ${kept.length} in ${period} s`)
    if (!intensityKept(kept.length, max))
      this.fail(
        S.INV_INTENSITY,
        `supervisor ${key} (at most ${max} in ${period} s) decided ${kept.length} restarts in its period`,
      )
  }

  // --- the observed system --------------------------------------------------

  private incOf(pid: Pid): Incarnation | undefined {
    return this.byPid.get(pid)
  }

  private alive(inc: Incarnation): boolean {
    if (inc.exited || this.crashed.has(inc.node)) return false
    return this.systems.get(inc.node)?.alive(inc.pid) ?? false
  }

  private exited(inc: Incarnation | undefined, why: string) {
    if (!inc || inc.exited) return
    inc.exited = true
    this.live.delete(inc)
    this.log(`exit ${inc.name} ${fmtPid(inc.pid)} (${why})`, String(inc.pid))
  }

  /** A spec, watched: its turns check that their process lives. */
  private watch<M>(
    spec: ActorSpec<M>,
    node: number,
    child?: string,
  ): { spec: ActorSpec<M>; inc: Incarnation } {
    const inc: Incarnation = {
      id: this.nextInc++,
      name: spec.name,
      node,
      pid: 0n,
      child,
      exited: false,
      inTurn: 0,
    }
    const turnCheck = (self: Pid, what: string) => {
      if (inc.exited || !this.systems.get(node)?.alive(self))
        this.fail(
          S.INV_DELIVERED_AFTER_EXIT,
          `${what} ran for ${inc.name} ${fmtPid(self)} after it exited`,
          String(self),
        )
    }
    const watched: ActorSpec<M> = {
      ...spec,
      init: (self) => {
        inc.pid = self
        this.born(inc)
        spec.init?.(self)
      },
      receive: async (msg, self, result, signal) => {
        turnCheck(self, 'a turn')
        const m = msg as { intended?: number; kind?: string }
        if (
          m &&
          typeof m === 'object' &&
          m.intended !== undefined &&
          m.intended !== inc.id
        )
          this.fail(
            S.INV_PID_REUSED,
            `mail for incarnation ${m.intended} of ${fmtPid(self)} reached incarnation ${inc.id} (${inc.name})`,
            String(self),
          )
        inc.inTurn++
        // a remote child's watcher tells its supervisor of the exit in this
        // turn, synchronously: that exit is the context of the decision
        const outer = this.exitCtx
        if (inc.name.endsWith('-watch'))
          this.exitCtx = { name: inc.name, depth: 0 }
        try {
          const turn = spec.receive(msg, self, result, signal)
          this.exitCtx = outer
          return await turn
        } finally {
          this.exitCtx = outer
          inc.inTurn--
        }
      },
      control: spec.control
        ? (tag, self) => {
            turnCheck(self, 'a control turn')
            spec.control?.(tag, self)
          }
        : undefined,
    }
    return { spec: watched, inc }
  }

  /** A process got its pid: no mail to an earlier holder may be on the wire. */
  private born(inc: Incarnation) {
    const flying = this.wireByPid.get(inc.pid)
    if (flying)
      for (const id of flying) {
        const w = this.wire.get(id)
        if (w && w.intended !== undefined && w.intended !== inc.id)
          this.fail(
            S.INV_PID_REUSED,
            `${inc.name} got pid ${fmtPid(inc.pid)} while mail ${id} to incarnation ${w.intended} was on the wire`,
            String(inc.pid),
          )
      }
    // a child starts again only once the previous one ended. A call's alias
    // is a process of its own for each call, never a restart of another: two
    // reviews in the lane queue call its owner at once (review_lanes.t27)
    const key = inc.child ?? `${inc.node}:${inc.name}`
    const prev =
      inc.name === CALL_ALIAS
        ? undefined
        : inc.child
          ? this.lastByChild.get(key)
          : this.lastByName.get(key)
    if (prev && prev !== inc) {
      if (!prev.exited && this.alive(prev))
        this.fail(
          S.INV_RESTART_WITHOUT_EXIT,
          `${inc.name} started as ${fmtPid(inc.pid)} while ${fmtPid(prev.pid)} still lived`,
          String(inc.pid),
          String(prev.pid),
        )
      else if (!prev.exited && !inc.child)
        this.fail(
          S.INV_RESTART_WITHOUT_EXIT,
          `${inc.name} started as ${fmtPid(inc.pid)} before the exit of ${fmtPid(prev.pid)} was seen`,
          String(inc.pid),
          String(prev.pid),
        )
      if (inc.child && prev.node !== inc.node) this.rare.add(S.RARE_MOVED_NODE)
    }
    if (inc.child) this.lastByChild.set(key, inc)
    else this.lastByName.set(key, inc)
    this.byPid.set(inc.pid, inc)
    this.live.add(inc)
    this.log(
      `spawn ${inc.name} ${fmtPid(inc.pid)} on node ${inc.node} (incarnation ${inc.id})`,
      String(inc.pid),
    )
  }

  /** The runtime of node `n`, observed. */
  private observe(raw: ActorSystem): ActorSystem {
    const node = raw.node
    return {
      ...raw,
      spawn: <M>(
        spec: ActorSpec<M>,
        onExit: (reason: number) => void = () => {},
        slot?: bigint,
      ): Pid => {
        const { spec: watched, inc } = this.watch(spec, node)
        return raw.spawn(
          watched,
          (reason) => {
            if (reason === X_KILLED) this.rare.add(S.RARE_TURN_KILLED)
            this.exited(inc, `reason ${reason}`)
            const outer = this.exitCtx
            this.exitCtx = { name: inc.name, depth: 0 }
            try {
              onExit(reason)
            } finally {
              this.exitCtx = outer
            }
          },
          slot,
        )
      },
      send: (pid: Pid, msg: unknown, from?: Pid): number => {
        const d = raw.send(pid, msg, from)
        const kind = (msg as { kind?: string })?.kind ?? 'msg'
        if (d === D_DROPPED_FULL) {
          this.rare.add(S.RARE_MAILBOX_FULL)
          this.count('droppedFull')
        }
        this.log(`send ${kind} -> ${fmtPid(pid)} = ${d}`, String(pid))
        return d
      },
      exit: (pid: Pid, reason: number, quiet = false) => {
        const inc = this.incOf(pid)
        const was = inc ? this.alive(inc) : false
        raw.exit(pid, reason, quiet)
        if (inc && was && !raw.alive(pid) && inc.node === node)
          this.exited(inc, `stopped, reason ${reason}`)
      },
      monitor: (watcher: Pid, target: Pid) => {
        this.log(
          `monitor ${fmtPid(watcher)} -> ${fmtPid(target)}`,
          String(target),
        )
        return raw.monitor(watcher, target)
      },
      spawnOn: (on: number, kind: string, arg: unknown) => {
        this.log(`spawnOn node ${on} ${kind}`)
        return raw.spawnOn(on, kind, arg)
      },
    }
  }

  /** A node's link, with every crossing mail on the wire until it lands. */
  private wired(link: NodeLink, settleMs: number | null): NodeLink {
    return {
      ...link,
      node: link.node,
      up: (n) => link.up(n),
      carry: (to, mail, toInc) => {
        const id = this.nextWire++
        const pid =
          mail.kind === 'send'
            ? mail.to
            : mail.kind === 'monitor' || mail.kind === 'exit'
              ? mail.target
              : undefined
        const inc = pid === undefined ? undefined : this.incOf(pid)
        this.wire.set(id, { pid, intended: inc?.id, toNode: to })
        if (pid !== undefined) {
          const set = this.wireByPid.get(pid) ?? new Set<number>()
          set.add(id)
          this.wireByPid.set(pid, set)
        }
        this.log(
          `wire ${id} ${mail.kind} node ${link.node} -> ${to}${pid === undefined ? '' : ` for ${fmtPid(pid)}`}`,
          `wire ${id}`,
          ...(pid === undefined ? [] : [String(pid)]),
        )
        // the wire id rides along; the runtime reads only the fields it knows
        link.carry(to, { ...mail, simWire: id } as unknown as Mail, toInc)
        // the memory net lands or loses a mail after its latency; a store
        // model settles its own wire
        if (settleMs !== null)
          this.clock.after(settleMs, () => this.landed(id, false))
      },
      onMail: (h) =>
        link.onMail((mail) => {
          this.landed((mail as { simWire?: number }).simWire, true)
          h(mail)
        }),
      onNodeDown: (h) => link.onNodeDown(h),
    }
  }

  /** Whether a mail is still on the wire: neither handed to a node nor lost. */
  onWire(id: number): boolean {
    return this.wire.has(id)
  }

  /** A mail left the wire: handed to its node, or lost. */
  landed(id: number | undefined, arrived: boolean) {
    if (id === undefined) return
    const w = this.wire.get(id)
    if (!w) return
    this.wire.delete(id)
    if (w.pid !== undefined) {
      const set = this.wireByPid.get(w.pid)
      set?.delete(id)
      if (set && set.size === 0) this.wireByPid.delete(w.pid)
    }
    if (!arrived) {
      if (this.crashed.has(w.toNode)) this.rare.add(S.RARE_MAIL_TO_LOST_NODE)
      this.count('lostOnWire')
      this.log(`wire ${id} lost`, `wire ${id}`)
    }
  }

  // --- the nodes ------------------------------------------------------------

  private async bootNode(n: number) {
    const link = this.wired(
      await this.transport.link(n),
      this.options.transport ? null : S.NET_LATENCY_MS,
    )
    const raw = createActorSystem(this.clock, {
      node: n,
      link,
      turnStop: this.options.turnStop,
      micros: this.micros,
    })
    this.rawSystems.push(raw)
    const sys = this.observe(raw)
    this.systems.set(n, sys)
    this.crashed.delete(n)
    this.log(`node ${n} up`)
    if (n === 0) return sys
    raw.registerKind('echo', (arg: { registrar: Pid; child: string }) => {
      const { spec } = this.watch(
        {
          name: `echo-${arg.child}`,
          init: (self: Pid) => {
            sys.send(
              arg.registrar,
              { kind: 'up', pid: self, child: arg.child },
              self,
            )
          },
          receive: async (m: { kind: string; id?: number }, self: Pid) => {
            if (m.kind !== 'job') return
            const ms = pickBetween(
              this.roll(S.STREAM_DURATION, m.id ?? 0),
              0,
              S.JOB_MAX_MS,
            )
            await new Promise<void>((r) => this.clock.after(ms, r))
            sys.send(arg.registrar, { kind: 'done', id: m.id }, self)
          },
        },
        n,
        arg.child,
      )
      return spec as ActorSpec<unknown>
    })
    // every node starts its own service at boot: the first local slot
    const svc = sys.spawn<{ kind: string }>({
      name: `svc-${n}`,
      receive: () => {},
    })
    this.svc.set(n, svc)
    this.remember(svc)
    return sys
  }

  /** A pid learned now, kept with the incarnation it named then. */
  private remember(pid: Pid) {
    const inc = this.incOf(pid)?.id
    if (inc === undefined) return
    this.remembered.push({ pid, inc })
    if (this.remembered.length > S.STALE_PIDS_KEPT) this.remembered.shift()
  }

  private crashNode(n: number) {
    if (this.crashed.has(n) || n === 0) return
    const sys = this.systems.get(n)
    this.crashed.add(n)
    this.transport.crash(n)
    this.log(`node ${n} lost`)
    // the process is gone: its actors with it, quietly (nothing leaves the node)
    for (const inc of [...this.live])
      if (inc.node === n) {
        sys?.exit(inc.pid, X_KILLED, true)
        this.exited(inc, 'node lost')
      }
    const back = pickBetween(
      this.roll(S.STREAM_DURATION, this.step),
      S.NODE_RESTART_MIN_SECONDS,
      S.NODE_RESTART_MAX_SECONDS,
    )
    this.clock.after(back * 1000, () => {
      void this.bootNode(n)
    })
  }

  // --- the reviewer ---------------------------------------------------------

  private db(): Promise<void> {
    const ms = pickBetween(
      this.roll(S.STREAM_LATENCY, this.dbCalls++),
      0,
      S.DB_MAX_MS,
    )
    return new Promise((r) => this.clock.after(ms, r))
  }

  /** Lanes free for a review now: keys no review reserves and no bee holds. */
  private freeLanes(reserved: number[]): number {
    const taken = new Set(reserved)
    let n = 0
    for (let k = 0; k < S.REVIEW_KEYS; k++)
      if (!taken.has(k) && !this.beeKeys.has(k)) n++
    return n
  }

  /** The reviewer's dependencies, with the pool's and the queue's on their seeds. */
  private reviewerActorDeps(): ReviewerActorDeps {
    return {
      ...this.reviewerDeps(),
      laneQueue: this.options.laneQueue,
      ...(this.options.adaptive
        ? {
            capacity: async (reserved: number[]) => {
              await this.db()
              return {
                freeLanes: this.freeLanes(reserved),
                freeMb: S.POOL_FREE_MB,
                mbPerReview: 0,
              }
            },
            onResize: (size: PoolSize) => {
              this.log(
                `pool: target ${size.target}, live ${size.live}, busy ${size.busy}, queued ${size.queued}, lanes ${size.lanes}`,
              )
              if (size.live > REVIEWER_CONCURRENCY)
                this.rare.add(S.RARE_POOL_GREW)
            },
          }
        : {}),
    }
  }

  private reviewerDeps(): ReviewerDeps {
    const base: ReviewerDeps = {
      holdsLease: async () => {
        await this.db()
        return this.clock.now() >= this.leaseLostUntil
      },
      waiting: async () => {
        await this.db()
        return [...this.rows.values()]
          .filter((r) => !r.decided)
          .map((r) => r.issue)
      },
      reviewOne: (issue, reservedKeys, onLane, signal, lanes) =>
        this.reviewOne(issue, reservedKeys, onLane, signal, lanes),
    }
    return this.options.noWaitBackoff
      ? base
      : withWaitBackoff(base, this.clock.now)
  }

  private liveWorkerTurns(): number {
    let n = 0
    for (const inc of this.live)
      if (
        inc.node === 0 &&
        inc.name.startsWith('reviewer-worker-') &&
        inc.inTurn > 0
      )
        n++
    return n
  }

  /** The hot loop: this row's visits in the last minute, against the card's bound. */
  private visit(issue: number, now: number) {
    const seen = (this.visits.get(issue) ?? []).filter((t) => now - t < 60_000)
    seen.push(now)
    this.visits.set(issue, seen)
    this.count('visits')
    this.counts.maxRowVisitsPerMinute = Math.max(
      this.counts.maxRowVisitsPerMinute ?? 0,
      seen.length,
    )
    if (hotLoop(seen.length, WAIT_REVISIT_BASE_SECONDS))
      this.fail(
        S.INV_HOT_LOOP,
        `row #${issue} visited ${seen.length} times in a minute`,
        `#${issue}`,
      )
  }

  /**
   * Concurrency: live review turns against the cap (the fixed workers', or
   * the adaptive pool's ceiling), and one row once.
   */
  private startReview(issue: number) {
    const turns = this.liveWorkerTurns()
    const cap = this.options.adaptive ? REVIEWER_CEILING : REVIEWER_CONCURRENCY
    if (overCap(turns, cap))
      this.fail(
        S.INV_OVER_CAP,
        `${turns} review turns at once, past ${cap}`,
        `#${issue}`,
      )
    const sameRow = (this.reviewsOf.get(issue) ?? 0) + 1
    this.reviewsOf.set(issue, sameRow)
    if (overCap(sameRow, 1))
      this.fail(
        S.INV_OVER_CAP,
        `row #${issue} reviewed ${sameRow} times at once`,
        `#${issue}`,
      )
  }

  /** What this attempt will do: a fault queued for it, the provider, or the row. */
  private fateOf(row: Row | undefined, now: number): Fate {
    if (this.pendingHung > 0) {
      this.pendingHung--
      return 'stall'
    }
    if (this.pendingCrash > 0) {
      this.pendingCrash--
      return 'crash'
    }
    if (now < this.refusedUntil) return 'refused'
    if (!row || row.unreadableUntil > now) return 'wait'
    return 'ok'
  }

  /**
   * The lane a review takes: one the runtime does not hold for a sibling
   * (reservedKeys), as the review sweep picks it. Whether it is really free
   * is the invariant's question, not the picker's.
   */
  private bookLane(
    issue: number,
    reservedKeys: () => number[],
    onLane: (keyIndex: number | undefined) => void,
  ): number | undefined {
    const taken = new Set(reservedKeys())
    let key: number | undefined
    for (let k = 0; k < S.REVIEW_KEYS && key === undefined; k++)
      if (!taken.has(k) && !this.beeKeys.has(k)) key = k
    if (key === undefined) return undefined
    const held = (this.keysHeld.get(key) ?? 0) + 1
    this.keysHeld.set(key, held)
    if (overCap(held, 1))
      this.fail(
        S.INV_OVER_CAP,
        `lane ${key} booked ${held} times at once`,
        `#${issue}`,
      )
    onLane(key)
    return key
  }

  private lengthOf(fate: Fate, attempt: number): number {
    if (fate === 'stall') return S.STALL_SECONDS * 1000
    if (fate === 'refused') return S.REFUSED_REVIEW_MS
    if (fate === 'wait') return S.WAIT_ANSWER_MS
    const ms = pickBetween(
      this.roll(S.STREAM_ATTEMPT, attempt),
      S.REVIEW_MIN_SECONDS * 1000,
      S.REVIEW_MAX_SECONDS * 1000,
    )
    // a crash comes 30% of the way into the review, as in the benchmark
    return fate === 'crash' ? Math.floor((ms * 3) / 10) : ms
  }

  private endReview(issue: number, key: number | undefined) {
    this.reviewsOf.set(issue, (this.reviewsOf.get(issue) ?? 1) - 1)
    if (key === undefined) return
    const left = (this.keysHeld.get(key) ?? 1) - 1
    if (left > 0) this.keysHeld.set(key, left)
    else this.keysHeld.delete(key)
  }

  /** Let `ms` pass, or less when the turn is stopped: whether it was. */
  private pass(ms: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((r) => {
      const cancel = this.clock.after(ms, () => {
        signal?.removeEventListener('abort', stop)
        r(false)
      })
      const stop = () => {
        cancel()
        r(true)
      }
      if (signal?.aborted) stop()
      else signal?.addEventListener('abort', stop, { once: true })
    })
  }

  /** A wait in the lane queue, counted: never more waiters than the ceiling. */
  private async laneWait(issue: number, lanes: LaneGate): Promise<number> {
    this.waiters++
    this.counts.mostWaiters = Math.max(
      this.counts.mostWaiters ?? 0,
      this.waiters,
    )
    if (overCap(this.waiters, S.SIM_REVIEWER_CEILING))
      this.fail(
        S.INV_OVER_CAP,
        `${this.waiters} reviews wait in the lane queue at once, past ${S.SIM_REVIEWER_CEILING}`,
        `#${issue}`,
      )
    try {
      return await lanes.wait()
    } finally {
      this.waiters--
    }
  }

  /**
   * A review with the lane queue (review_lanes.t27): its witness and criteria
   * on no lane, WITNESS_PERCENT of its length; then its model call, on a lane
   * it books, or waits for in the queue when none is free. A crash comes in
   * the witness; a stall and a 429 come in the model call, holding the lane.
   * Returns the fate it ended with, the lane it held, and whether its turn
   * stopped it.
   */
  private async queuedReview(
    issue: number,
    a: number,
    fate: Fate,
    reservedKeys: () => number[],
    onLane: (keyIndex: number | undefined) => void,
    lanes: LaneGate,
    held: (key: number) => void,
    signal?: AbortSignal,
  ): Promise<{ fate: Fate; stopped: boolean }> {
    const whole = pickBetween(
      this.roll(S.STREAM_ATTEMPT, a),
      S.REVIEW_MIN_SECONDS * 1000,
      S.REVIEW_MAX_SECONDS * 1000,
    )
    const witness = Math.floor((whole * S.WITNESS_PERCENT) / 100)
    if (await this.pass(witness, signal)) return { fate, stopped: true }
    if (fate === 'crash') return { fate, stopped: false }
    let key = this.bookLane(issue, reservedKeys, onLane)
    while (key === undefined) {
      const answer = await this.laneWait(issue, lanes)
      this.log(
        `review #${issue} attempt ${a}: lane queue answers ${answer}`,
        `#${issue}`,
      )
      if (answer === LANE_STOPPED) return { fate, stopped: true }
      if (answer !== LANE_GO) return { fate: 'wait', stopped: false }
      this.rare.add(S.RARE_LANE_WAITED)
      key = this.bookLane(issue, reservedKeys, onLane)
    }
    held(key)
    lanes.held()
    const call =
      fate === 'stall'
        ? S.STALL_SECONDS * 1000
        : fate === 'refused'
          ? S.REFUSED_REVIEW_MS
          : whole - witness
    this.log(
      `review #${issue} attempt ${a}: model call on lane ${key}, ${call} ms`,
      `#${issue}`,
    )
    try {
      return { fate, stopped: await this.pass(call, signal) }
    } finally {
      lanes.released()
    }
  }

  private async reviewOne(
    issue: number,
    reservedKeys: () => number[],
    onLane: (keyIndex: number | undefined) => void,
    signal?: AbortSignal,
    lanes?: LaneGate,
  ): Promise<Judged> {
    const now = this.clock.now()
    const row = this.rows.get(issue)
    this.reserved = reservedKeys
    this.visit(issue, now)
    this.startReview(issue)
    const a = this.attempts++
    let fate = this.fateOf(row, now)
    const process = this.reviewerProcess
    // a stopped turn aborts its review (turn_stop.t27): the model call ends at
    // once, as a transient refusal does, and the row is not judged
    let stopped = false
    let key: number | undefined
    if (lanes && fate !== 'wait') {
      this.log(
        `review #${issue} attempt ${a}: ${fate}, in the lane queue's way`,
        `#${issue}`,
      )
      try {
        const out = await this.queuedReview(
          issue,
          a,
          fate,
          reservedKeys,
          onLane,
          lanes,
          (k) => {
            key = k
          },
          signal,
        )
        fate = out.fate
        stopped = out.stopped
      } finally {
        if (process === this.reviewerProcess) this.endReview(issue, key)
      }
    } else {
      // an unreadable row answers before any lane is taken; no free lane is a refusal
      key =
        fate === 'wait' ? undefined : this.bookLane(issue, reservedKeys, onLane)
      if (fate !== 'wait' && key === undefined) fate = 'refused'
      const ms = this.lengthOf(fate, a)
      this.log(
        `review #${issue} attempt ${a}: ${fate}, ${ms} ms, lane ${key ?? '-'}`,
        `#${issue}`,
      )
      try {
        stopped = await this.pass(ms, signal)
      } finally {
        if (process === this.reviewerProcess) this.endReview(issue, key)
      }
    }
    if (stopped) {
      this.rare.add(S.RARE_REVIEW_STOPPED)
      this.count('reviewsStopped')
      this.log(`review #${issue} attempt ${a} stopped by its turn`, `#${issue}`)
      fate = 'wait'
    }
    if (fate === 'crash') {
      this.log(`review #${issue} attempt ${a} threw`, `#${issue}`)
      throw new Error('review crashed (simulated)')
    }
    // a review of a process that was replaced died with it: it decides nothing
    if (process !== this.reviewerProcess) fate = 'wait'
    if (fate === 'ok' && row) row.decided = true
    const verdict = fate === 'ok' ? 'accept' : 'wait'
    this.log(`review #${issue} attempt ${a} ended: ${verdict}`, `#${issue}`)
    return { acted: [`#${issue}:${verdict}`], strays: [], tally: [] }
  }

  private startReviewer(sys0: ActorSystem) {
    const r = reviewerTree(sys0, this.reviewerActorDeps())
    this.wake = r.wake
    supervisor(
      sys0,
      {
        name: 'queen-root',
        strategy: STRAT_ONE_FOR_ONE,
        maxRestarts: ROOT_MAX_RESTARTS,
        periodSeconds: ROOT_PERIOD_SECONDS,
      },
      [r.tree],
    ).start(() => {
      // reviewing goes back to the round; the next deploy starts it again
      this.wake = () => {}
      this.count('reviewerGaveUp')
      this.log('reviewer root gave up')
      this.clock.after(S.GIVE_UP_REARM_SECONDS * 1000, () => {
        // the next deploy: a new process, so the old one's reviews are gone
        this.reviewerProcess++
        this.reviewsOf.clear()
        this.keysHeld.clear()
        // the old process's reservations went with it
        this.reserved = undefined
        this.unheldSince.clear()
        this.log('reviewer starts again in a new process')
        this.startReviewer(sys0)
      })
    })
    r.wake()
  }

  // --- the pool -------------------------------------------------------------

  private startPool(sys0: ActorSystem) {
    if (this.registrar === 0n)
      this.registrar = sys0.spawn<
        { kind: string; pid?: Pid; child?: string } | Down
      >({
        name: 'registrar',
        receive: (m, self) => {
          if (m.kind === 'up') {
            const up = m as { pid: Pid; child: string }
            this.known.set(up.child, up.pid)
            this.remember(up.pid)
            sys0.monitor(self, up.pid)
          } else if (m.kind === 'DOWN') {
            for (const [c, p] of this.known)
              if (p === (m as Down).pid) this.known.delete(c)
          } else if (m.kind === 'done') this.count('jobsDone')
        },
      })
    // the placer's count: where each child's latest start went
    const assigned = new Map<string, number | null>()
    const placedOn = (n: number) => {
      let k = 0
      for (const at of assigned.values()) if (at === n) k++
      return k
    }
    const nodes = Array.from({ length: S.POOL_NODES }, (_, i) => i + 1)
    supervisor(
      sys0,
      {
        name: 'pool',
        strategy: STRAT_ONE_FOR_ONE,
        maxRestarts: S.POOL_MAX_RESTARTS,
        periodSeconds: S.POOL_PERIOD_SECONDS,
      },
      Array.from({ length: S.POOL_WORKERS }, (_, i) =>
        remoteChild(sys0, {
          name: `w${i}`,
          kind: 'echo',
          arg: { registrar: this.registrar, child: `w${i}` },
          nodes: () => nodes,
          room: (n) => S.POOL_WORKERS - placedOn(n),
          placed: (n) => assigned.set(`w${i}`, n),
        }),
      ),
    ).start(() => {
      this.count('poolGaveUp')
      this.log('pool gave up')
      this.clock.after(S.GIVE_UP_REARM_SECONDS * 1000, () =>
        this.startPool(sys0),
      )
    })
  }

  // --- the steps --------------------------------------------------------------

  private apply(event: number, step: number, sys0: ActorSystem) {
    const now = this.clock.now()
    const r = () => this.roll(S.STREAM_TARGET, step)
    const span = (lo: number, hi: number) =>
      pickBetween(this.roll(S.STREAM_DURATION, step), lo, hi) * 1000
    this.count(`event${event}`)
    switch (event) {
      case S.E_ARRIVAL: {
        const issue = this.nextIssue++
        this.rows.set(issue, { issue, unreadableUntil: 0, decided: false })
        this.log(`arrival #${issue}`, `#${issue}`)
        this.wake()
        return
      }
      case S.F_UNREADABLE_ROW: {
        const issue = this.nextIssue++
        const until =
          now + span(S.UNREADABLE_MIN_SECONDS, S.UNREADABLE_MAX_SECONDS)
        this.rows.set(issue, { issue, unreadableUntil: until, decided: false })
        this.log(`arrival #${issue}, unreadable until ${until}`, `#${issue}`)
        this.wake()
        return
      }
      case S.E_JOB: {
        const id = this.nextJob++
        // a remembered pid, as a reference kept in a row is: it names the
        // incarnation it was learned from, whatever became of it since
        if (stale(r()) && this.remembered.length > 0) {
          const old = this.remembered[(r() >>> 2) % this.remembered.length]
          this.count('staleJobs')
          sys0.send(old.pid, { kind: 'job', id, intended: old.inc })
          return
        }
        const targets = [...this.known.values(), ...this.svc.values()]
        if (targets.length === 0) return
        const to = targets[r() % targets.length]
        sys0.send(to, { kind: 'job', id, intended: this.incOf(to)?.id })
        return
      }
      case S.F_NODE_LOSS:
        this.crashNode(1 + (r() % S.POOL_NODES))
        return
      case S.F_HUNG_TURN:
        this.pendingHung++
        this.log('the next review hangs')
        return
      case S.F_CRASH:
        this.pendingCrash++
        this.log('the next review throws')
        return
      case S.F_MAILBOX_OVERFLOW: {
        const burst = mailboxBurst(MAILBOX_CAP)
        this.log(`bus burst of ${burst} wake-ups`)
        for (let i = 0; i < burst; i++) this.wake()
        return
      }
      case S.F_PROVIDER_429:
        this.refusedUntil = Math.max(
          this.refusedUntil,
          now + span(S.PROVIDER_429_MIN_SECONDS, S.PROVIDER_429_MAX_SECONDS),
        )
        this.log(`provider 429 until ${this.refusedUntil}`)
        return
      case S.F_STALE_LEASE:
        this.leaseLostUntil = Math.max(
          this.leaseLostUntil,
          now + span(S.STALE_LEASE_MIN_SECONDS, S.STALE_LEASE_MAX_SECONDS),
        )
        this.log(`lease lost until ${this.leaseLostUntil}`)
        return
      default:
        return
    }
  }

  /** Run the clock until `p` settles: a store's answers come on the clock. */
  private async drive<T>(p: Promise<T>): Promise<T> {
    let done = false
    const out = p.finally(() => {
      done = true
    })
    for (let ms = 0; !done && ms < 60_000; ms++)
      await this.clock.runUntil(this.clock.now() + 1)
    return out
  }

  /**
   * Bees take keys: a new count every LANE_EPOCH_STEPS steps (bee_keys), the
   * highest keys first, so reviews see lanes come and go.
   */
  private beeKeysFor(epoch: number) {
    const n = beeKeys(this.roll(S.STREAM_LANES, epoch))
    this.beeKeys.clear()
    for (let k = S.REVIEW_KEYS - 1; k >= S.REVIEW_KEYS - n; k--)
      this.beeKeys.add(k)
    this.log(`bees hold ${n} of ${S.REVIEW_KEYS} keys`)
  }

  /**
   * Every key the reviewer reserves (its `reviewing` map, which it hands each
   * review and the pool's capacity read) is held by a review that still runs,
   * an abandoned one included. A key reserved with no review behind it for
   * LANE_IDLE_SECONDS is a lane held by nobody: the pool counts it as taken,
   * and no review may book it again.
   */
  private checkReserved() {
    if (!this.reserved) return
    const now = this.clock.now()
    const unheld = new Map<number, number>()
    for (const k of this.reserved()) {
      if (this.keysHeld.has(k)) continue
      const since = this.unheldSince.get(k) ?? now
      unheld.set(k, since)
      const s = Math.floor((now - since) / 1000)
      if (laneHeldByNobody(s))
        this.fail(
          S.INV_LANE_LEAK,
          `the reviewer has reserved lane ${k} for ${s} s with no review holding it`,
        )
    }
    this.unheldSince = unheld
  }

  /** After a step: processes that ended without a word are marked ended. */
  private sweep() {
    for (const inc of [...this.live])
      if (!this.alive(inc)) this.exited(inc, 'gone')
  }

  async run(steps: number = S.STEPS_PER_RUN): Promise<RunResult> {
    const t0 = performance.now()
    const untapActors = this.tap(ACTORS_CARD, (n, a, r) =>
      this.onActorsCall(n, a, r),
    )
    const untapReviewer = this.tap(REVIEWER_CARD, (n, a, r) =>
      this.onReviewerCall(n, a, r),
    )
    // the pool's and the queue's cards: their decisions go into the log, and
    // an idle worker the pool stops is a rare state
    const untapSizing = this.tap(REVIEWER_SIZING_CARD, (n, a, r) => {
      this.journal(n, a, r)
      if (n === 'worker_retires' && r !== 0) this.rare.add(S.RARE_POOL_RETIRED)
      return undefined
    })
    const untapLanes = this.tap(REVIEW_LANES_CARD, (n, a, r) => {
      this.journal(n, a, r)
      return undefined
    })
    const poolWorld = !!(this.options.adaptive || this.options.laneQueue)
    let ran = 0
    try {
      if (this.options.transport) this.transport = this.options.transport(this)
      else {
        const net = createMemoryNet(this.clock, { latencyMs: S.NET_LATENCY_MS })
        this.transport = {
          link: (n) => net.link(n),
          crash: (n) => net.crash(n),
        }
      }
      const sys0 = await this.drive(this.bootNode(0))
      for (let n = 1; n <= S.POOL_NODES; n++) await this.drive(this.bootNode(n))
      this.startReviewer(sys0)
      this.startPool(sys0)
      for (let step = 0; step < steps && !this.violation; step++) {
        this.step = step
        this.mix(step)
        if (poolWorld && step % S.LANE_EPOCH_STEPS === 0)
          this.beeKeysFor(step / S.LANE_EPOCH_STEPS)
        const event = stepEvent(this.roll(S.STREAM_STEP, step))
        this.apply(event, step, sys0)
        await this.clock.runUntil(
          this.clock.now() + stepMs(this.roll(S.STREAM_DELAY, step)),
        )
        await this.transport.settle?.()
        this.sweep()
        this.checkReserved()
        // the clock moves in whole milliseconds; a fraction is a hidden input
        if (!Number.isInteger(this.clock.now())) this.count('fractionalClock')
        this.stepHashes.push(this.hash >>> 0)
        ran = step + 1
      }
      // the quiet tail: nothing new, every window and stall runs out
      this.step = steps
      const start = this.clock.now()
      this.counts.tailStartMs = start
      // one hash a virtual minute, so two runs that part are placed; a fixed
      // count of minutes from a fixed start, never a test against the clock
      for (let m = 1; m * 60 <= S.TAIL_SECONDS && !this.violation; m++) {
        await this.clock.runUntil(start + m * 60_000)
        await this.transport.settle?.()
        this.sweep()
        this.checkReserved()
        this.stepHashes.push(this.hash >>> 0)
      }
      this.counts.tailEndMs = this.clock.now()
      await this.quiesce()
      this.stepHashes.push(this.hash >>> 0)
      for (const s of this.rawSystems)
        if (s.stats.yields > 0) this.rare.add(S.RARE_SLICE_YIELDED)
      for (const s of this.rawSystems) {
        this.counts.killed = (this.counts.killed ?? 0) + s.stats.killed
        this.counts.crashed = (this.counts.crashed ?? 0) + s.stats.crashed
        this.counts.yields = (this.counts.yields ?? 0) + s.stats.yields
        this.counts.deadLetters =
          (this.counts.deadLetters ?? 0) + s.stats.deadLetters
      }
      this.counts.rows = this.rows.size
      this.counts.decided = [...this.rows.values()].filter(
        (r) => r.decided,
      ).length
      this.counts.virtualSeconds = Math.round(this.clock.now() / 1000)
      this.counts.clockReads = this.wallReads
    } finally {
      // a run that stopped at a violation still lets its own work finish here
      await this.quiesce()
      const hash = this.hash >>> 0
      this.closed = true
      untapActors()
      untapReviewer()
      untapSizing()
      untapLanes()
      await this.transport?.stop?.()
      this.finalHash = hash
    }
    return this.result(ran, this.finalHash, performance.now() - t0)
  }
}
