/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE BEE DISPATCHER AS KEYED ACTORS (MVP, epic gHashTag/trios#1712 item 7,
 * gHashTag/t27#7851). It does the round's dispatch work, arranged as actors:
 *
 *   admission, one actor under its own supervisor: it answers one call per
 *     ready issue with a lane, wait, or refused (keyed_guard.t27
 *     admit_answer, and the policy's word through `deps.admit`, which is
 *     queend in production). When a lane frees, it wakes the waiting issues
 *     in the policy's order (wake_count), unless the lane's own issue
 *     restarts at once (keeps_lane_after_end): the wait ends on that event,
 *     not on the next round.
 *   one actor per issue (keyedActors, keyed.t27): the issue's state
 *     (bee_key_next, so a repeated ready starts no second bee), the claim
 *     (claim_step, with this incarnation's pid as the holder), the bee it
 *     started, and what happens when the bee ends (dispatch_exit.t27
 *     exit_reason, restart_decision, restart_wait_seconds).
 *   one bee actor per bee: one turn, which waits for the bee's work and is
 *     killed at the turn bound (actors.t27 turn_signal). The issue actor is
 *     linked to it and traps exits, so the bee actor's end is a message to it.
 *     A bee runs on a runner, so the turn only waits (ISO_LOOP) and a kill
 *     abandons the wait, not the bee. The issue actor then cancels the bee and
 *     keeps its issue and its lane until the bee's work has ended
 *     (holds_after_kill): a second bee never starts beside it.
 *
 * THE LANE BOARD (keyed_guard.t27 section 2, trios#1729 item 7). The
 * admission ran unsupervised, with the lanes in use in its own memory: one
 * crash ended every later admission, since each call met a dead pid. It is a
 * permanent child of a one_for_one supervisor now, and what it knows is on
 * the board, which outlives it as an ETS table with an heir outlives its
 * owner: the lane each issue holds, by its token, and the issues waiting.
 * Every write keeps the board true without the admission. A grant is written
 * in the turn that answers, and taken back in that turn when the answer
 * reaches nobody (grant_lands). A holder takes its own entry off before it
 * tells the admission. An issue's actor that ends holding a lane gives it
 * back unless its bee runs (lane_outlives_holder). An issue whose call finds
 * no admission waits on the board (after_admission). A restarted admission
 * wakes the waiting issues at once.
 *
 * Behind TRIOS_QUEEN_DISPATCH=actors, off by default. The round's loop stays
 * the default until the benchmark's numbers are accepted (t27#7851).
 */

import {
  type ActorSpec,
  type ActorSystem,
  actorChild,
  type Clock,
  createActorSystem,
  type Pid,
  realClock,
  supervisor,
} from './queen-actors'
import {
  CALL_REPLY,
  ISO_LOOP,
  NO_PID,
  X_KILLED,
  X_NORMAL,
} from './queen-actors-card.gen'
import { keyedActors } from './queen-actors-keyed'
import {
  type CallRequest,
  type Exit,
  KEYED_GUARD_CARD,
  linksOf,
} from './queen-actors-links'
import { flag, loadCardWasm, u32 } from './queen-card-wasm'
import {
  DX_NORMAL,
  DX_SHUTDOWN,
  EF_KILL,
  EF_NONE,
  HB_NEVER,
  LEASE_TTL_SECONDS,
  RD_GIVE_UP,
  RD_LATER,
  RD_NOW,
} from './queen-dispatch-exit-card.gen'
import {
  BE_ENDED,
  BE_GIVE_UP,
  BE_READY,
  BE_REFUSED,
  BE_RESTART_LATER,
  BE_RESTART_NOW,
  BE_RETRY_DUE,
  BE_SENT_BACK,
  BE_STARTED,
  BK_IDLE,
  CL_STAND_DOWN,
  CL_START,
} from './queen-keyed-card.gen'
import {
  AD_ASK,
  AD_GIVE_BACK,
  AD_GRANT,
  AD_KEEP,
  AD_REFUSED,
  ADMISSION_MAX_RESTARTS,
  ADMISSION_PERIOD_SECONDS,
  ADMISSION_RESTART,
  ADMISSION_STRATEGY,
  IA_START,
  IA_WAIT,
} from './queen-keyed-guard-card.gen'

export const DISPATCH_EXIT_CARD = 'queen/dispatch_exit.wasm'
const keyed = () => loadCardWasm('queen/keyed.wasm')
const exitCard = () => loadCardWasm(DISPATCH_EXIT_CARD)
const actors = () => loadCardWasm('queen/actors.wasm')
const guard = () => loadCardWasm(KEYED_GUARD_CARD)
const kc = (name: string, ...a: number[]) => keyed().call(name, ...a)
const dx = (name: string, ...a: number[]) => exitCard().call(name, ...a)
const gc = (name: string, ...a: number[]) => guard().call(name, ...a)

/** What the host saw when a bee's work ended (dispatch_exit.t27 section 2). */
export interface BeeEnd {
  /** A completion frame arrived. */
  completion: boolean
  /** The last error frame: EF_NONE, EF_CANCEL, EF_KILL or EF_PROVIDER. */
  errorFrame: number
  /** The provider's last HTTP status, 0 for none. */
  http: number
  /** Seconds since the bee's runtime last beat; HB_NEVER when none was seen. */
  heartbeatAge: number
  /** Whether the bee still held its task lease when it ended. */
  leaseHeld: boolean
}

/** A started bee: its end, and a way to ask it to stop. */
export interface BeeWork {
  /** Settles when the work has ended, however it ended. Never rejects. */
  ended: Promise<BeeEnd>
  /** Ask the work to stop; `ended` settles once it has. */
  cancel: () => void
}

export interface BeeStart {
  /** Whether the claim landed (control.t27 claim_lands, keyed.t27 claim_step). */
  claim: boolean
  /** The started bee, or null when the claim landed and nothing could start. */
  work: BeeWork | null
  /** For a lost claim: seconds since the holder's last renewal, if known. */
  holderSinceRenewal?: number
}

export interface BeeDispatchDeps {
  /** Lanes this dispatcher may fill at once. */
  lanes: () => number
  /** The policy's word on one issue, now. */
  admit: (issue: number) => Promise<boolean>
  /** The policy's order among issues waiting for a lane. Default: as they came. */
  order?: (waiting: number[]) => number[]
  /** Claim the issue for `holder` and start its bee. */
  start: (issue: number, holder: string) => Promise<BeeStart>
  /** The bee's turn bound in seconds; 0 is actors.t27 TURN_MAX_SECONDS. */
  turnMaxSeconds?: number
  /** How long an issue waits for the admission's answer. */
  admitAfterMs?: number
  /** Told of every start, end and stand-down. */
  observe?: (e: BeeEvent) => void
  /**
   * The claim's holder is this, a colon, and the issue actor's pid
   * (keyed_guard.t27 section 1). In production it names the process's boot.
   */
  holderPrefix?: string
}

export type BeeEvent =
  | { kind: 'started'; issue: number; holder: string }
  | { kind: 'ended'; issue: number; reason: number; decision: number }
  | { kind: 'stood-down'; issue: number }
  | { kind: 'killed'; issue: number }
  | { kind: 'admission-gave-up' }

type IssueMsg =
  | { kind: 'ready' }
  | { kind: 'sent-back' }
  | { kind: 'retry-due'; at: number }
  | { kind: 'work-ended'; work: BeeWork; end: BeeEnd; lane: number }
  | Exit

/** What the admission is asked; `lane`: the token of a lane the issue kept. */
type AdmissionAsk = { issue: number; lane?: number }

type AdmissionMsg =
  | CallRequest<AdmissionAsk>
  /** A holder gave its lane back; its entry is off the board already. */
  | { kind: 'freed' }
  /** A new incarnation's first message: lanes may have freed while it was down. */
  | { kind: 'wake' }

/** The admission's reply: keyed_guard.t27 AD_*, and the lane's token for a lane. */
interface Admitted {
  answer: number
  lane?: number
}

/**
 * The lane board: what the admission knows, kept where its crash cannot take
 * it (keyed_guard.t27 section 2).
 */
export interface LaneBoard {
  /** The lane each issue holds, by its token. */
  lanes: Map<number, number>
  /** The issues waiting for a lane, in the order they were told to wait. */
  waiting: number[]
}

const UNKNOWN_END: BeeEnd = {
  completion: false,
  errorFrame: EF_NONE,
  http: 0,
  heartbeatAge: HB_NEVER,
  leaseHeld: false,
}

/** The bee dispatcher on an actor system. `ready(issue)` is its input. */
export function beeDispatcher(sys: ActorSystem, deps: BeeDispatchDeps) {
  const clock = sys.clock
  const links = linksOf(sys)
  const admitAfterMs = deps.admitAfterMs ?? 30_000
  const stats = {
    started: 0,
    standDowns: 0,
    killed: 0,
    refusedLanes: 0,
    /** Admission incarnations started, the first one included. */
    admissionStarts: 0,
    /** Grants whose answer reached nobody, taken back (grant_lands). */
    grantsTakenBack: 0,
    /** Lanes given back because their issue's actor ended with no bee running. */
    lanesFreedOnExit: 0,
    /** Calls that met no admission, or none in time: those issues waited. */
    admissionMissed: 0,
  }

  // ---- the lane board, and the admission that answers from it
  const board: LaneBoard = { lanes: new Map(), waiting: [] }
  // tokens are the dispatcher's, so they stay unique across admissions
  let nextToken = 1
  let admission: Pid = BigInt(NO_PID)
  const laneFree = () =>
    kc('lane_free', u32(board.lanes.size), u32(deps.lanes())) !== 0
  const waitOnBoard = (issue: number) => {
    if (!board.waiting.includes(issue)) board.waiting.push(issue)
  }
  const wake = () => {
    const n = gc(
      'wake_count',
      u32(board.lanes.size),
      u32(deps.lanes()),
      u32(board.waiting.length),
    )
    if (n === 0) return
    const ordered = (deps.order ?? ((w) => w))([...board.waiting])
    for (const issue of ordered.slice(0, n)) {
      board.waiting.splice(board.waiting.indexOf(issue), 1)
      issues.send(issue, { kind: 'ready' })
    }
  }
  /** Take a lane off the board if it still names that token, and wake. */
  const giveBack = (issue: number, token: number) => {
    if (board.lanes.get(issue) === token) board.lanes.delete(issue)
    sys.send(admission, { kind: 'freed' } as AdmissionMsg)
  }

  /** The admission's answer, from the board as it is now. */
  const answerFor = (ask: AdmissionAsk, asked: boolean, ok: boolean) => {
    const held = board.lanes.get(ask.issue)
    const kept = ask.lane !== undefined && held === ask.lane
    return gc(
      'admit_answer',
      flag(kept),
      flag(held !== undefined),
      flag(laneFree()),
      flag(asked),
      flag(ok),
    )
  }

  const admissionSpec: ActorSpec<AdmissionMsg> = {
    name: 'bee-admission',
    init: (self) => {
      admission = self
      stats.admissionStarts++
      sys.send(self, { kind: 'wake' } as AdmissionMsg)
    },
    receive: async (msg, self) => {
      if (msg.kind !== 'call') return wake()
      const ask = msg.body
      let answer = answerFor(ask, false, false)
      if (answer === AD_ASK) {
        const ok = await deps.admit(ask.issue).catch(() => false)
        // a turn whose pid died meanwhile writes nothing, as its sends reach
        // nobody
        if (!sys.alive(self)) return
        answer = answerFor(ask, true, ok)
      }
      let lane: number | undefined
      if (answer === AD_GRANT) {
        lane = nextToken++
        board.lanes.set(ask.issue, lane)
      } else if (answer === AD_KEEP) {
        lane = ask.lane
      } else if (answer === AD_GIVE_BACK && ask.lane !== undefined) {
        if (board.lanes.get(ask.issue) === ask.lane)
          board.lanes.delete(ask.issue)
      }
      if (gc('answer_waits', answer) !== 0) {
        stats.refusedLanes++
        waitOnBoard(ask.issue)
      }
      const d = links.reply(msg, { answer, lane } as Admitted, self)
      if (lane !== undefined && gc('grant_lands', flag(d === 0)) === 0) {
        // the call ended first: nobody holds this lane
        stats.grantsTakenBack++
        if (board.lanes.get(ask.issue) === lane) board.lanes.delete(ask.issue)
      }
      if (answer === AD_GIVE_BACK || lane !== undefined) wake()
    },
  }
  const admissionSup = supervisor(
    sys,
    {
      name: 'bee-admission-sup',
      strategy: ADMISSION_STRATEGY,
      maxRestarts: ADMISSION_MAX_RESTARTS,
      periodSeconds: ADMISSION_PERIOD_SECONDS,
    },
    [actorChild(sys, admissionSpec, ADMISSION_RESTART)],
  ).start(() => deps.observe?.({ kind: 'admission-gave-up' }))

  // ---- one actor per issue
  const issueOf = new Map<Pid, number>()
  // bees whose work has not ended, by issue, whatever became of their actor
  const beeRunning = new Map<number, number>()
  const issueActor = (issue: number) => {
    let state = BK_IDLE
    let bee: Pid | undefined
    let work: BeeWork | undefined
    let end: BeeEnd | undefined
    let killed = false
    let startedAt = 0
    let runs = 0
    let streak = 0
    let retry: (() => void) | undefined
    // the lane this issue holds, by its token: from admission to its bee's end
    let lane: number | undefined
    const giveLaneBack = () => {
      if (lane !== undefined) giveBack(issue, lane)
      lane = undefined
    }
    // the lane is still this issue's while the board names its token for it
    const laneHeld = () => lane !== undefined && board.lanes.get(issue) === lane

    const move = (ev: number): boolean => {
      if (kc('bee_key_acts', state, ev) === 0) return false
      state = kc('bee_key_next', state, ev)
      return true
    }

    // A start that keeps no lane (claim_step): a bee it started is stopped,
    // since a bee runs only on a lane it keeps, and the lane goes back at
    // once. A lost claim does not poll: it tries again when the holder's
    // lease can have lapsed, or sooner when an event names this key.
    const noStart = (s: BeeStart, step: number) => {
      if (step !== CL_START) s.work?.cancel()
      giveLaneBack()
      move(BE_REFUSED)
      if (step !== CL_STAND_DOWN) return
      stats.standDowns++
      deps.observe?.({ kind: 'stood-down', issue })
      const wait = kc(
        'retry_after_lost_seconds',
        u32(s.holderSinceRenewal ?? 0),
        LEASE_TTL_SECONDS,
      )
      retry?.()
      retry = clock.after(wait * 1000, () =>
        issues.send(issue, { kind: 'ready' }),
      )
    }

    const admitAndStart = async (self: Pid) => {
      const got = await links.call<Admitted>(
        { self },
        admission,
        { issue, lane } as AdmissionAsk,
        admitAfterMs,
      )
      const replied = got.outcome === CALL_REPLY && got.value !== undefined
      const step = gc(
        'after_admission',
        got.outcome,
        replied ? (got.value as Admitted).answer : AD_REFUSED,
      )
      if (step !== IA_START) {
        // a kept lane not kept now goes back: the admission gave it back
        // already, or never answered
        giveLaneBack()
        if (step === IA_WAIT) {
          if (!replied) stats.admissionMissed++
          waitOnBoard(issue)
        }
        move(BE_REFUSED)
        return
      }
      lane = (got.value as Admitted).lane
      const holder = `${deps.holderPrefix ?? 'queen-actor'}:${self}`
      const s = await deps
        .start(issue, holder)
        .catch((): BeeStart => ({ claim: false, work: null }))
      // THE LANE AS THE BOARD HAS IT NOW, NOT AS IT WAS BEFORE THE AWAIT. While
      // the claim was out this actor's pid may have died, and its exit gave
      // the lane back (lane_outlives_holder: no bee ran yet), so another issue
      // may hold it now. claim_step was asked with the lane taken whatever
      // became of it, and a landed claim then started a bee on no lane: the
      // simulation gate's keyed world found a dispatcher running 5 bees on 4
      // lanes (seed 1072413183, trios#1763). Asked with the truth, the card
      // answers CL_NO_LANE, and the bee that claim started is stopped.
      const step2 = kc('claim_step', flag(laneHeld()), flag(s.claim))
      if (kc('keeps_lane', step2) === 0 || !s.work) return noStart(s, step2)
      const w = s.work
      work = w
      end = undefined
      killed = false
      startedAt = clock.now()
      // When the work ends, this incarnation decides what its lane does
      // (keeps_lane_after_end). If it has died meanwhile, nobody here restarts
      // the issue, and the lane goes back at once.
      const held = lane as number
      beeRunning.set(issue, (beeRunning.get(issue) ?? 0) + 1)
      void w.ended
        .catch(() => UNKNOWN_END)
        .then((e) => {
          const left = (beeRunning.get(issue) ?? 1) - 1
          if (left > 0) beeRunning.set(issue, left)
          else beeRunning.delete(issue)
          if (sys.alive(self))
            issues.send(issue, {
              kind: 'work-ended',
              work: w,
              end: e,
              lane: held,
            })
          else giveBack(issue, held)
        })
      bee = sys.spawn<{ go: true }>({
        name: `bee-${issue}`,
        turnMaxSeconds: deps.turnMaxSeconds ?? 0,
        receive: async (_m, beeSelf) => {
          await w.ended.catch(() => UNKNOWN_END)
          sys.exit(beeSelf, X_NORMAL)
        },
      })
      links.link(self, bee)
      sys.send(bee, { go: true })
      move(BE_STARTED)
      stats.started++
      deps.observe?.({ kind: 'started', issue, holder })
    }

    // Both halves are in: the work ended and its bee actor is gone.
    const decide = async (self: Pid) => {
      if (!end) return
      const e = end
      end = undefined
      work = undefined
      const reason = dx(
        'exit_reason',
        flag(e.completion),
        killed ? EF_KILL : e.errorFrame,
        dx('http_class', u32(e.http)),
        u32((clock.now() - startedAt) / 1000),
        0,
        flag(e.leaseHeld),
        u32(e.heartbeatAge),
      )
      const http = dx('http_class', u32(e.http))
      const decision = dx(
        'restart_decision',
        reason,
        http,
        u32(runs),
        u32(streak),
      )
      if (dx('counts_against_issue', reason) !== 0) runs++
      if (kc('keeps_lane_after_end', decision) === 0) giveLaneBack()
      deps.observe?.({ kind: 'ended', issue, reason, decision })
      if (decision === RD_NOW) {
        streak++
        move(BE_RESTART_NOW)
        await admitAndStart(self)
      } else if (decision === RD_LATER) {
        const wait = dx(
          'restart_wait_seconds',
          reason,
          u32(streak),
          u32(e.heartbeatAge),
        )
        streak++
        move(BE_RESTART_LATER)
        retry?.()
        retry = clock.after(wait * 1000, () =>
          issues.send(issue, { kind: 'retry-due', at: clock.now() }),
        )
      } else if (decision === RD_GIVE_UP) {
        move(BE_GIVE_UP)
      } else if (reason === DX_NORMAL || reason === DX_SHUTDOWN) {
        streak = 0
        move(BE_ENDED)
      }
    }

    const EVENT_OF = {
      ready: BE_READY,
      'sent-back': BE_SENT_BACK,
      'retry-due': BE_RETRY_DUE,
    } as const

    /** The bee actor ended, or a stopper asked this actor to end. */
    const onExit = async (msg: Exit, self: Pid) => {
      if (msg.pid === BigInt(NO_PID)) {
        sys.exit(self, X_NORMAL)
        return
      }
      if (msg.pid !== bee) return
      bee = undefined
      if (msg.reason === X_KILLED) {
        killed = true
        stats.killed++
        deps.observe?.({ kind: 'killed', issue })
        // the turn bound abandoned the wait; the bee runs on until it is
        // stopped, and holds its issue and its lane until then
        const holds = actors().call('holds_after_kill', ISO_LOOP, flag(!!end))
        if (holds !== 0) {
          work?.cancel()
          return
        }
      }
      await decide(self)
    }

    return {
      name: `issue-${issue}`,
      init: (self: Pid) => {
        issueOf.set(self, issue)
        links.trapExit(self)
      },
      holdsWork: () => kc('key_holds_work', state) !== 0 || work !== undefined,
      receive: async (msg: IssueMsg, self: Pid) => {
        if (msg.kind === 'EXIT') return onExit(msg, self)
        if (msg.kind !== 'work-ended') {
          // a repeated ready while the bee runs or its work waits: nothing
          if (move(EVENT_OF[msg.kind])) await admitAndStart(self)
          return
        }
        // another incarnation's bee: nobody here restarts it; its lane goes back
        if (msg.work !== work) return void giveBack(issue, msg.lane)
        end = msg.end
        if (bee === undefined) await decide(self)
      },
    }
  }

  const issues = keyedActors<number, IssueMsg>(sys, {
    name: 'bee-issues',
    make: issueActor,
  })

  // An issue's actor that ends while the board names a lane for its issue:
  // the lane stays only with a bee that still runs, whose end gives it back
  // (keyed_guard.t27 lane_outlives_holder).
  sys.onExit((pid) => {
    const issue = issueOf.get(pid)
    if (issue === undefined) return
    issueOf.delete(pid)
    const token = board.lanes.get(issue)
    if (token === undefined) return
    if (gc('lane_outlives_holder', flag(beeRunning.has(issue))) !== 0) return
    stats.lanesFreedOnExit++
    giveBack(issue, token)
  })

  return {
    /** An issue is ready (the round read it, or an event names it). */
    ready: (issue: number) => issues.send(issue, { kind: 'ready' }),
    /** The review sent the work back: a new attempt. */
    sentBack: (issue: number) => issues.send(issue, { kind: 'sent-back' }),
    lanesInUse: () => board.lanes.size,
    waiting: () => [...board.waiting],
    /** The admission's pid now; a restart gives it a new one. */
    admission: () => admission,
    board,
    issues,
    stats,
    /** Stop every issue actor, the last started first; bees on runners run on. */
    stop: () => {
      admissionSup.stop()
      return issues.stopAll()
    },
  }
}

export type BeeDispatcher = ReturnType<typeof beeDispatcher>

/**
 * A dispatcher on its own actor system, for production. `clock` is the real
 * one there; a test hands in a virtual one instead of faking the process's
 * timers, which Bun does not fake alike on every platform.
 */
export function startBeeDispatcher(
  deps: BeeDispatchDeps,
  clock: Clock = realClock,
): BeeDispatcher {
  return beeDispatcher(createActorSystem(clock), deps)
}
