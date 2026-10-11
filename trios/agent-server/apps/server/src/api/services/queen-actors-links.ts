/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * LINKS, CALLS AND ORDERLY STOPS (gHashTag/t27 specs/queen/actors.t27
 * sections 2-5, epic gHashTag/trios#1712 item 7).
 *
 * The runtime in queen-actors.ts had monitors and nothing else: a failure
 * travelled only as a DOWN to whoever asked for one. The card already said
 * the rest; this file runs it.
 *   - links: bidirectional, one per pair (links_after_link). A death sends
 *     its reason to every linked process. A trapping one gets it as an EXIT
 *     message; another ignores `normal` and dies of anything else
 *     (on_exit_signal), with death_reason(signal). Linking to a dead pid
 *     answers noproc at once (attach_answer).
 *   - demonitor: drops the monitor; with flush, also a DOWN already queued
 *     for it (down_left_after_demonitor).
 *   - call: a request with a fresh alias, a monitor on the callee and an
 *     `after`. The first of reply, DOWN or timeout ends it (call_outcome).
 *     The alias then dies (live_alias), so a late reply is a dead letter, as
 *     OTP's process alias drops it. A call into its own chain is refused at
 *     once. The chain is its callers' pids, and keyed_guard.t27
 *     call_admit_chain refuses a call to any of them, at any slot. actors.t27
 *     chain_has saw slots 0..63 only, and this runtime never reuses a slot,
 *     so it passed every call once 63 processes had started (trios#1729
 *     item 7).
 *   - orderly stop: shutdown first, kill after the timeout (stop_signal),
 *     one child after another in reverse start order (stop_rank).
 *
 * WHY A SIDE FILE AND NOT queen-actors.ts. Other lanes change that file.
 * Its hooks here are four: `onExit`, `unwatch`, `mailbox` and `busy`.
 *
 * NOT HERE: links across nodes (a link to a remote pid is refused with
 * noproc), and a kill that stops an isolated turn's work. A link kill ends
 * the pid; only the turn-timeout kill in queen-actors.ts calls stopWork.
 */

import {
  ACTORS_CARD,
  type ActorSystem,
  type Down,
  letterOf,
  type Pid,
} from './queen-actors'
import {
  ACT_DIE,
  ACT_MESSAGE,
  CALL_PENDING,
  CALL_TIMEOUT,
  NO_PID,
  SHUTDOWN_INFINITY,
  X_KILL,
  X_NOPROC,
  X_NORMAL,
} from './queen-actors-card.gen'
import { flag, loadCardWasm, u32 } from './queen-card-wasm'
import { CHAIN_CALLERS } from './queen-keyed-guard-card.gen'

export const KEYED_GUARD_CARD = 'queen/keyed_guard.wasm'
const card = () => loadCardWasm(ACTORS_CARD)
const guard = () => loadCardWasm(KEYED_GUARD_CARD)
const c = (name: string, ...a: number[]) => card().call(name, ...a)
const c64 = (name: string, ...a: Array<number | bigint>) =>
  BigInt.asUintN(64, BigInt(card().call64(name, ...a)))

/** What a trapping process gets instead of dying. */
export interface Exit {
  kind: 'EXIT'
  /** Who died, or NO_PID (0n) when the signal came from a stopper. */
  pid: Pid
  reason: number
}

/** What the callee receives. Answer it with `links.reply(req, value, self)`. */
export interface CallRequest<M = unknown> {
  kind: 'call'
  body: M
  /** The address a reply reaches while the call is pending, and then nobody. */
  alias: Pid
  /** The pids blocked on this request, oldest first, its caller last. */
  callers: Pid[]
  depth: number
}

export interface CallResult<R = unknown> {
  /** CALL_REPLY, CALL_DOWN, CALL_TIMEOUT, CALL_CYCLE or CALL_TOO_DEEP. */
  outcome: number
  value?: R
  /** The callee's exit reason, for CALL_DOWN. */
  reason?: number
}

interface Reply {
  kind: 'reply'
  value: unknown
}

/**
 * The chain as the card takes it: CHAIN_CALLERS pids, NO_PID past the last.
 * No admitted call carries more (keyed_guard.t27 invariant
 * the_chain_holds_every_caller_an_admitted_call_can_have).
 */
const chainArgs = (callers: Pid[]): bigint[] =>
  Array.from({ length: CHAIN_CALLERS }, (_, i) => callers[i] ?? BigInt(NO_PID))

const systems = new WeakMap<ActorSystem, ReturnType<typeof makeLinks>>()

/** The links, calls and stops of one actor system (one set per system). */
export function linksOf(sys: ActorSystem) {
  let l = systems.get(sys)
  if (!l) {
    l = makeLinks(sys)
    systems.set(sys, l)
  }
  return l
}

function makeLinks(sys: ActorSystem) {
  const clock = sys.clock
  const links = new Map<Pid, Set<Pid>>()
  const trapping = new Set<Pid>()
  const waits = new Map<Pid, Array<(reason: number) => void>>()
  const stats = { signals: 0, trapped: 0, callsRefused: 0, lateReplies: 0 }

  /** An exit signal arrives at `target` (actors.t27 on_exit_signal). */
  function signal(target: Pid, reason: number, from: Pid = BigInt(NO_PID)) {
    if (!sys.alive(target)) return
    stats.signals++
    const act = c('on_exit_signal', reason, flag(trapping.has(target)))
    if (act === ACT_MESSAGE) {
      stats.trapped++
      sys.send(target, { kind: 'EXIT', pid: from, reason } as Exit)
    } else if (act === ACT_DIE) {
      sys.exit(target, c('death_reason', reason))
    }
  }

  sys.onExit((pid, reason) => {
    trapping.delete(pid)
    const linked = links.get(pid)
    links.delete(pid)
    for (const other of linked ?? []) {
      links.get(other)?.delete(pid)
      signal(other, reason, pid)
    }
    const told = waits.get(pid)
    waits.delete(pid)
    for (const resolve of told ?? []) resolve(reason)
  })

  /**
   * Link two processes. Linking twice is linking once. A link to a pid that
   * is not alive answers noproc at once, as an exit signal to `a`.
   */
  function link(a: Pid, b: Pid): void {
    if (c('attach_answer', flag(sys.alive(b))) === X_NOPROC) {
      signal(a, X_NOPROC, b)
      return
    }
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      const set = links.get(x) ?? new Set<Pid>()
      const n = c('links_after_link', flag(set.has(y)), u32(set.size))
      set.add(y)
      if (set.size !== n)
        throw new Error(`links ${set.size}, the card says ${n}`)
      links.set(x, set)
    }
  }

  function unlink(a: Pid, b: Pid): void {
    links.get(a)?.delete(b)
    links.get(b)?.delete(a)
  }

  /** trap_exit: exit signals come as EXIT messages; kill still kills. */
  function trapExit(pid: Pid, on = true): void {
    if (on) trapping.add(pid)
    else trapping.delete(pid)
  }

  /** Resolves with the pid's exit reason; at once with noproc if it is dead. */
  function exited(pid: Pid): Promise<number> {
    if (!sys.alive(pid)) return Promise.resolve(X_NOPROC)
    return new Promise((resolve) => {
      const list = waits.get(pid) ?? []
      list.push(resolve)
      waits.set(pid, list)
    })
  }

  /**
   * Demonitor, called for the watcher that made the monitor. With `flush`, a
   * DOWN for this monitor already sitting in the watcher's mailbox goes too
   * (down_left_after_demonitor), found by its reference.
   */
  function demonitor(watcher: Pid, ref: number, flush = false): void {
    sys.unwatch(ref)
    const box = sys.mailbox(watcher)
    if (!box) return
    const at = box.findIndex((m) => {
      const d = letterOf(m) as Down | undefined
      return d?.kind === 'DOWN' && d.ref === ref
    })
    const left = c('down_left_after_demonitor', flag(flush), flag(at >= 0))
    if (left === 0 && at >= 0) box.splice(at, 1)
  }

  /**
   * Stop one process: shutdown first, which a trapping process gets as an
   * EXIT and may use to finish, then kill once `timeoutMs` has passed
   * (stop_signal). 0 is a brutal kill; SHUTDOWN_INFINITY waits for good.
   * `quiet` is a stop its owner asked for: its onExit is not told.
   */
  function stop(pid: Pid, timeoutMs: number, quiet = true): Promise<number> {
    const ended = exited(pid)
    if (!sys.alive(pid)) return ended
    const t0 = clock.now()
    const deliver = (s: number) => {
      if (!sys.alive(pid)) return
      const act = c('on_exit_signal', s, flag(trapping.has(pid)))
      if (act === ACT_MESSAGE)
        sys.send(pid, { kind: 'EXIT', pid: BigInt(NO_PID), reason: s } as Exit)
      else if (act === ACT_DIE) sys.exit(pid, c('death_reason', s), quiet)
    }
    deliver(c('stop_signal', 0, u32(timeoutMs)))
    if (sys.alive(pid) && timeoutMs !== SHUTDOWN_INFINITY) {
      // A timer can fire before its clock says the timeout has passed (see
      // stopTurn in queen-actors.ts, trios#1766): then stop_signal is X_NONE
      // and the kill was never delivered. Ask again once the rest has passed.
      let cancel = () => {}
      const due = () => {
        const waited = u32(clock.now() - t0)
        if (c('stop_signal', waited, u32(timeoutMs)) === X_KILL) deliver(X_KILL)
        else if (sys.alive(pid))
          cancel = clock.after(Math.max(1, timeoutMs - waited), due)
      }
      cancel = clock.after(timeoutMs, due)
      void ended.then(() => cancel())
    }
    return ended
  }

  /**
   * Stop children one after another, the last started first (stop_rank),
   * each with its own shutdown time. The next one is asked only once the one
   * before it has exited, as an OTP supervisor stops its children.
   */
  async function stopInOrder(
    children: Array<{ pid: Pid; shutdownMs: number }>,
    quiet = true,
  ): Promise<number[]> {
    const n = children.length
    const byRank = new Array<number>(n)
    for (let i = 0; i < n; i++) byRank[c('stop_rank', u32(i), u32(n))] = i
    const reasons = new Array<number>(n)
    for (const i of byRank)
      reasons[i] = await stop(children[i].pid, children[i].shutdownMs, quiet)
    return reasons
  }

  /**
   * Call `to` and wait for its answer, at most `afterMs`. `from.self` is the
   * caller; `from.serving` the request it is answering, if any, so the chain
   * carries on and a call back into it is refused at once (call_admit).
   */
  function call<R = unknown>(
    from: { self: Pid; serving?: CallRequest },
    to: Pid,
    body: unknown,
    afterMs: number,
  ): Promise<CallResult<R>> {
    // the chain carries on: whoever is blocked on the request being served,
    // then this caller (keyed_guard.t27 section 3)
    const callers = [...(from.serving?.callers ?? []), from.self]
    const depth = (from.serving?.depth ?? 0) + 1
    const admitted = guard().call64(
      'call_admit_chain',
      u32(depth),
      to,
      ...chainArgs(callers),
    )
    if (Number(admitted) !== CALL_PENDING) {
      stats.callsRefused++
      return Promise.resolve({ outcome: Number(admitted) })
    }
    return new Promise<CallResult<R>>((resolve) => {
      const t0 = clock.now()
      let ref = 0
      let ended = false
      let cancelTimer = () => {}
      const queued = (kind: string) =>
        (sys.mailbox(alias) ?? [])
          .map(letterOf)
          .find((m) => (m as { kind?: string })?.kind === kind)
      const end = (outcome: number, value?: unknown, reason?: number) => {
        ended = true
        cancelTimer()
        // the alias dies with the call: what comes later reaches nobody
        if (c64('live_alias', alias, outcome) === BigInt(NO_PID)) {
          demonitor(alias, ref, true)
          sys.exit(alias, X_NORMAL, true)
        }
        resolve({ outcome, value: value as R, reason })
      }
      const settle = (m: Reply | { kind: 'DOWN'; reason: number }) => {
        if (ended) return
        const reply = m.kind === 'reply' ? m : (queued('reply') as Reply)
        const outcome = c(
          'call_outcome',
          flag(!!reply),
          flag(m.kind === 'DOWN'),
          u32(clock.now() - t0),
          u32(afterMs),
        )
        if (outcome === CALL_PENDING) return
        end(outcome, reply?.value, m.kind === 'DOWN' ? m.reason : undefined)
      }
      const alias: Pid = sys.spawn<Reply | { kind: 'DOWN'; reason: number }>({
        name: 'call-alias',
        receive: (m) => settle(m),
      })
      ref = sys.monitor(alias, to)
      cancelTimer = clock.after(afterMs, () => {
        if (ended) return
        // a reply or a DOWN already queued wins over the timeout
        const r = queued('reply') as Reply | undefined
        const d = queued('DOWN') as { reason: number } | undefined
        const outcome = c(
          'call_outcome',
          flag(!!r),
          flag(!!d),
          u32(clock.now() - t0),
          u32(afterMs),
        )
        if (outcome === CALL_TIMEOUT) end(outcome)
        else end(outcome, r?.value, r ? undefined : d?.reason)
      })
      sys.send(
        to,
        { kind: 'call', body, alias, callers, depth } as CallRequest,
        from.self,
      )
    })
  }

  /** Answer a call. A reply to an alias whose call ended is a dead letter. */
  function reply(req: CallRequest, value: unknown, self: Pid): number {
    const d = sys.send(req.alias, { kind: 'reply', value } as Reply, self)
    if (d !== 0) stats.lateReplies++
    return d
  }

  return {
    link,
    unlink,
    trapExit,
    trapping: (pid: Pid) => trapping.has(pid),
    linked: (pid: Pid): Pid[] => [...(links.get(pid) ?? [])],
    signal,
    kill: (pid: Pid) => signal(pid, X_KILL),
    exited,
    demonitor,
    stop,
    stopInOrder,
    call,
    reply,
    stats,
  }
}

export type Links = ReturnType<typeof linksOf>
