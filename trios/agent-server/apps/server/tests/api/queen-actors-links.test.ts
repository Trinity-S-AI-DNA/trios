/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * LINKS, CALLS, DEMONITOR, ORDERLY STOPS AND KEYED ACTORS (actors.t27
 * sections 2-5, keyed.t27; gHashTag/trios#1712 item 7). Every decision is the
 * wasm card's; this suite runs it under a virtual clock, with the slice off:
 * a slice yields on the host's real clock, which a virtual one does not wait
 * for, and none of these rules is about the slice.
 */

import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createActorSystem,
  type Pid,
} from '../../src/api/services/queen-actors'
import {
  CALL_CYCLE,
  CALL_DOWN,
  CALL_REPLY,
  CALL_TIMEOUT,
  CALL_TOO_DEEP,
  X_CRASH,
  X_KILLED,
  X_NOPROC,
  X_NORMAL,
  X_SHUTDOWN,
} from '../../src/api/services/queen-actors-card.gen'
import { keyedActors } from '../../src/api/services/queen-actors-keyed'
import {
  type CallRequest,
  type Exit,
  linksOf,
} from '../../src/api/services/queen-actors-links'
import {
  KEYED_ACTIVE_CAP,
  PASSIVATE_IDLE_SECONDS,
} from '../../src/api/services/queen-keyed-card.gen'
import { DEFAULT_SPECS_ROOT } from '../../src/inngest/spec-catalog'
import { EarlyClock, VirtualClock } from './queen-virtual-clock'

const sha = (file: string) =>
  createHash('sha256')
    .update(readFileSync(join(DEFAULT_SPECS_ROOT, file)))
    .digest('hex')

describe('the vendored keyed and dispatch_exit cards are the ones PIN names', () => {
  it('keyed.t27, keyed.wasm, dispatch_exit.t27 and dispatch_exit.wasm match', () => {
    const pin = readFileSync(join(DEFAULT_SPECS_ROOT, 'PIN'), 'utf8')
    for (const f of [
      'queen/keyed.t27',
      'queen/keyed.wasm',
      'queen/dispatch_exit.t27',
      'queen/dispatch_exit.wasm',
    ])
      expect(pin).toContain(`${f} sha256 ${sha(f)}`)
  })
})

/** A process that records what it receives. */
const recorder = (sys: ReturnType<typeof createActorSystem>, got: unknown[]) =>
  sys.spawn<unknown>({ name: 'rec', receive: (m) => void got.push(m) })

describe('monitors', () => {
  it('two monitors on one target are two DOWNs, as the card counts them', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const got: unknown[] = []
    const watcher = recorder(sys, got)
    const target = sys.spawn<string>({ name: 't', receive: () => {} })
    sys.monitor(watcher, target)
    sys.monitor(watcher, target)
    sys.exit(target, X_CRASH)
    await clock.runUntil(10)
    expect(got).toEqual([
      { kind: 'DOWN', pid: target, reason: X_CRASH },
      { kind: 'DOWN', pid: target, reason: X_CRASH },
    ])
  })

  it('demonitor drops the monitor; with flush also a DOWN already queued', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const links = linksOf(sys)
    // a watcher whose turn is held, so DOWNs stay queued in its mailbox
    let open: () => void = () => {}
    const gate = new Promise<void>((r) => {
      open = r
    })
    const got: unknown[] = []
    const watcher = sys.spawn<unknown>({
      name: 'w',
      receive: async (m) => {
        if (m === 'hold') await gate
        else got.push(m)
      },
    })
    sys.send(watcher, 'hold')
    const a = sys.spawn<string>({ name: 'a', receive: () => {} })
    const b = sys.spawn<string>({ name: 'b', receive: () => {} })
    const c = sys.spawn<string>({ name: 'c', receive: () => {} })
    const ra = sys.monitor(watcher, a)
    const rb = sys.monitor(watcher, b)
    sys.monitor(watcher, c)
    await clock.runUntil(1)
    sys.exit(a, X_CRASH)
    sys.exit(b, X_CRASH)
    // both DOWNs are queued now; one is flushed, one is not
    links.demonitor(watcher, ra, true)
    links.demonitor(watcher, rb, false)
    // a demonitor before the death: no DOWN at all
    const r2 = sys.monitor(watcher, c)
    links.demonitor(watcher, r2)
    sys.exit(c, X_NORMAL)
    open()
    await clock.runUntil(10)
    expect(got).toEqual([
      { kind: 'DOWN', pid: b, reason: X_CRASH },
      { kind: 'DOWN', pid: c, reason: X_NORMAL },
    ])
  })
})

describe('links', () => {
  it('a crash kills a linked process that does not trap, with the same reason', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const links = linksOf(sys)
    const reasons: number[] = []
    const a = sys.spawn<string>({ name: 'a', receive: () => {} })
    const b = sys.spawn<string>(
      { name: 'b', receive: () => {} },
      (r) => void reasons.push(r),
    )
    links.link(a, b)
    links.link(a, b) // linking twice is linking once
    expect(links.linked(a)).toEqual([b])
    sys.exit(a, X_CRASH)
    expect(sys.alive(b)).toBe(false)
    expect(reasons).toEqual([X_CRASH])
  })

  it('a trapping process gets the EXIT as a message and lives', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const links = linksOf(sys)
    const got: unknown[] = []
    const a = sys.spawn<string>({ name: 'a', receive: () => {} })
    const b = recorder(sys, got)
    links.trapExit(b)
    links.link(a, b)
    sys.exit(a, X_CRASH)
    await clock.runUntil(1)
    expect(sys.alive(b)).toBe(true)
    expect(got).toEqual([{ kind: 'EXIT', pid: a, reason: X_CRASH } as Exit])
  })

  it('a normal end does not kill a linked process that does not trap', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const links = linksOf(sys)
    const a = sys.spawn<string>({ name: 'a', receive: () => {} })
    const b = sys.spawn<string>({ name: 'b', receive: () => {} })
    links.link(a, b)
    sys.exit(a, X_NORMAL)
    expect(sys.alive(b)).toBe(true)
    expect(links.linked(b)).toEqual([])
  })

  it('kill is untrappable, and the victim dies of killed, which a trapping neighbour survives', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const links = linksOf(sys)
    const got: unknown[] = []
    const victim = sys.spawn<string>({ name: 'v', receive: () => {} })
    const neighbour = recorder(sys, got)
    links.trapExit(victim)
    links.trapExit(neighbour)
    links.link(victim, neighbour)
    links.kill(victim)
    await clock.runUntil(1)
    expect(sys.alive(victim)).toBe(false)
    expect(sys.alive(neighbour)).toBe(true)
    expect(got).toEqual([{ kind: 'EXIT', pid: victim, reason: X_KILLED }])
  })

  it('a link to a dead pid answers noproc at once, as an exit signal', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const links = linksOf(sys)
    const dead = sys.spawn<string>({ name: 'd', receive: () => {} })
    sys.exit(dead, X_NORMAL)
    const reasons: number[] = []
    const a = sys.spawn<string>(
      { name: 'a', receive: () => {} },
      (r) => void reasons.push(r),
    )
    links.link(a, dead)
    expect(reasons).toEqual([X_NOPROC])
    const got: unknown[] = []
    const t = recorder(sys, got)
    links.trapExit(t)
    links.link(t, dead)
    await clock.runUntil(1)
    expect(got).toEqual([{ kind: 'EXIT', pid: dead, reason: X_NOPROC }])
  })
})

describe('a call', () => {
  const server = (
    sys: ReturnType<typeof createActorSystem>,
    answerAfterMs: number,
  ) => {
    const links = linksOf(sys)
    return sys.spawn<CallRequest<number>>({
      name: 'server',
      receive: (req, self) => {
        sys.clock.after(answerAfterMs, () =>
          links.reply(req, req.body * 2, self),
        )
      },
    })
  }

  it('ends on the reply', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const links = linksOf(sys)
    const caller = sys.spawn<string>({ name: 'c', receive: () => {} })
    const s = server(sys, 100)
    const p = links.call<number>({ self: caller }, s, 21, 5000)
    await clock.runUntil(200)
    expect(await p).toEqual({
      outcome: CALL_REPLY,
      value: 42,
      reason: undefined,
    })
  })

  it('ends on the timeout, and the late reply reaches nobody', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const links = linksOf(sys)
    const caller = sys.spawn<string>({ name: 'c', receive: () => {} })
    const s = server(sys, 9000)
    const p = links.call<number>({ self: caller }, s, 21, 5000)
    await clock.runUntil(6000)
    expect((await p).outcome).toBe(CALL_TIMEOUT)
    const before = sys.stats.deadLetters
    await clock.runUntil(10_000)
    expect(links.stats.lateReplies).toBe(1)
    expect(sys.stats.deadLetters).toBe(before + 1)
  })

  it('ends on the callee DOWN, with its reason', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const links = linksOf(sys)
    const caller = sys.spawn<string>({ name: 'c', receive: () => {} })
    const s = sys.spawn<CallRequest>({
      name: 'dies',
      receive: (_req, self) => sys.exit(self, X_CRASH),
    })
    const p = links.call({ self: caller }, s, 1, 5000)
    await clock.runUntil(10)
    expect(await p).toEqual({
      outcome: CALL_DOWN,
      value: undefined,
      reason: X_CRASH,
    })
  })

  it('a call into its own chain is refused at once, and so is one too deep', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const links = linksOf(sys)
    const seen: string[] = []
    let a: Pid = 0n
    // b serves a's call by calling a back: the chain already holds a
    const b = sys.spawn<CallRequest>({
      name: 'b',
      receive: async (req, self) => {
        const back = await links.call({ self, serving: req }, a, 'back', 5000)
        seen.push(`b->a ${back.outcome}`)
        links.reply(req, 'done', self)
      },
    })
    a = sys.spawn<string>({ name: 'a', receive: () => {} })
    const top = links.call<string>({ self: a }, b, 'go', 5000)
    await clock.runUntil(10)
    expect(seen).toEqual([`b->a ${CALL_CYCLE}`])
    expect((await top).outcome).toBe(CALL_REPLY)
    // depth 9 > CALL_MAX_DEPTH 8
    const deep = await links.call(
      {
        self: b,
        serving: { kind: 'call', body: 0, alias: 0n, callers: [], depth: 8 },
      },
      a,
      'x',
      5000,
    )
    expect(deep.outcome).toBe(CALL_TOO_DEEP)
    expect(links.stats.callsRefused).toBe(2)
  })
})

describe('an orderly stop', () => {
  it('stops the last started first, shutdown first and kill after the timeout', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const links = linksOf(sys)
    const order: string[] = []
    const plain = (name: string) =>
      sys.spawn<string>({ name, receive: () => {} })
    const first = plain('first')
    // traps, takes 2 s to finish, then ends by itself
    const tidy: Pid = sys.spawn<Exit>({
      name: 'tidy',
      init: (self) => links.trapExit(self),
      receive: (m, self) => {
        order.push(`tidy got ${m.reason}`)
        clock.after(2000, () => sys.exit(self, X_SHUTDOWN))
      },
    })
    // traps and never ends: killed at its timeout
    const stubborn = sys.spawn<Exit>({
      name: 'stubborn',
      init: (self) => links.trapExit(self),
      receive: () => void order.push('stubborn ignores it'),
    })
    for (const [pid, name] of [
      [first, 'first'],
      [tidy, 'tidy'],
      [stubborn, 'stubborn'],
    ] as const)
      void links
        .exited(pid)
        .then((r) => order.push(`${name} ended ${r} at ${clock.now()}`))
    const done = links.stopInOrder([
      { pid: first, shutdownMs: 5000 },
      { pid: tidy, shutdownMs: 5000 },
      { pid: stubborn, shutdownMs: 5000 },
    ])
    await clock.runUntil(20_000)
    expect(await done).toEqual([X_SHUTDOWN, X_SHUTDOWN, X_KILLED])
    expect(order).toEqual([
      'stubborn ignores it',
      `stubborn ended ${X_KILLED} at 5000`,
      `tidy got ${X_SHUTDOWN}`,
      `tidy ended ${X_SHUTDOWN} at 7000`,
      `first ended ${X_SHUTDOWN} at 7000`,
    ])
  })

  it('a timer that fires before its clock says so still kills at the timeout (trios#1766)', async () => {
    // stop_signal(4999, 5000) is X_NONE; asked once, the kill never came
    const clock = new EarlyClock()
    const sys = createActorSystem(clock, { slices: false })
    const links = linksOf(sys)
    const stubborn = sys.spawn<Exit>({
      name: 'stubborn',
      init: (self) => links.trapExit(self),
      receive: () => {},
    })
    const r = links.stop(stubborn, 5000)
    await clock.runUntil(4999)
    expect(sys.alive(stubborn)).toBe(true)
    await clock.runUntil(5000)
    expect(sys.alive(stubborn)).toBe(false)
    expect(await r).toBe(X_KILLED)
  })

  it('a brutal stop kills at once, trapping or not', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const links = linksOf(sys)
    const p = sys.spawn<Exit>({
      name: 'p',
      init: (self) => links.trapExit(self),
      receive: () => {},
    })
    const r = links.stop(p, 0)
    await clock.runUntil(1)
    expect(await r).toBe(X_KILLED)
  })
})

describe('keyed actors', () => {
  const counting = (
    sys: ReturnType<typeof createActorSystem>,
    seen: Array<[number, Pid, string]>,
    holds?: () => boolean,
  ) =>
    keyedActors<number, string>(sys, {
      name: 'k',
      make: (key) => ({
        name: `k-${key}`,
        holdsWork: holds,
        receive: (m, self) => void seen.push([key, self, m]),
      }),
    })

  it('one actor per key: a send reaches it, or starts it', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const seen: Array<[number, Pid, string]> = []
    const k = counting(sys, seen)
    k.send(7, 'a')
    k.send(7, 'b')
    k.send(8, 'c')
    await clock.runUntil(10)
    // order holds per key; the two keys' turns interleave
    const of = (key: number) => seen.filter(([k]) => k === key)
    expect(of(7).map(([, , m]) => m)).toEqual(['a', 'b'])
    expect(of(8).map(([, , m]) => m)).toEqual(['c'])
    expect(of(7)[0][1]).toBe(of(7)[1][1])
    expect(of(7)[0][1]).not.toBe(of(8)[0][1])
    expect(k.stats.activations).toBe(2)
    expect(KEYED_ACTIVE_CAP).toBe(512)
  })

  it('an idle actor passivates; a send starts a new incarnation and is its first message', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const seen: Array<[number, Pid, string]> = []
    const k = counting(sys, seen)
    k.send(1, 'x')
    await clock.runUntil((PASSIVATE_IDLE_SECONDS - 1) * 1000)
    const first = k.pidOf(1) as Pid
    expect(sys.alive(first)).toBe(true)
    await clock.runUntil((2 * PASSIVATE_IDLE_SECONDS + 1) * 1000)
    expect(k.pidOf(1)).toBeUndefined()
    expect(sys.alive(first)).toBe(false)
    expect(k.stats.passivations).toBe(1)
    k.send(1, 'y')
    await clock.runUntil((2 * PASSIVATE_IDLE_SECONDS + 2) * 1000)
    expect(seen.map(([, , m]) => m)).toEqual(['x', 'y'])
    expect(seen[1][1]).not.toBe(first)
    expect(k.stats.reactivations).toBe(1)
  })

  it('an actor that watches work is never passivated', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const seen: Array<[number, Pid, string]> = []
    const k = counting(sys, seen, () => true)
    k.send(1, 'x')
    await clock.runUntil(3600_000)
    expect(k.stats.passivations).toBe(0)
    expect(sys.alive(k.pidOf(1) as Pid)).toBe(true)
  })

  it('the directory forgets a crashed incarnation, and the next send starts a new one', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const seen: Array<[number, Pid, string]> = []
    const k = counting(sys, seen)
    k.send(3, 'a')
    await clock.runUntil(1)
    const old = k.pidOf(3) as Pid
    sys.exit(old, X_CRASH)
    expect(k.pidOf(3)).toBeUndefined()
    k.send(3, 'b')
    await clock.runUntil(2)
    const fresh = k.pidOf(3) as Pid
    expect(fresh).not.toBe(old)
    // the old incarnation's late exit changes nothing
    sys.exit(old, X_CRASH)
    expect(k.pidOf(3)).toBe(fresh)
  })

  it('at the cap the longest idle actor makes room; a node of busy actors refuses', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const seen: Array<[number, Pid, string]> = []
    const k = keyedActors<number, string>(sys, {
      name: 'k',
      cap: 2,
      make: (key) => ({
        name: `k-${key}`,
        receive: (m, s) => void seen.push([key, s, m]),
      }),
    })
    k.send(1, 'a')
    await clock.runUntil(10_000)
    k.send(2, 'b')
    await clock.runUntil(20_000)
    k.send(3, 'c') // 1 has been idle longest
    await clock.runUntil(20_001)
    expect(k.keys().sort()).toEqual([2, 3])
    expect(k.stats.evictions).toBe(1)
    const busy = keyedActors<number, string>(sys, {
      name: 'busy',
      cap: 1,
      make: () => ({ name: 'b', holdsWork: () => true, receive: () => {} }),
    })
    busy.send(1, 'a')
    const before = sys.stats.deadLetters
    busy.send(2, 'b')
    expect(busy.stats.refused).toBe(1)
    expect(sys.stats.deadLetters).toBe(before + 1)
  })

  it('a send to a stopping key is held and starts it again once it has ended', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const links = linksOf(sys)
    const seen: string[] = []
    const k = keyedActors<number, string | Exit>(sys, {
      name: 'k',
      shutdownMs: 5000,
      make: () => ({
        name: 'slow',
        init: (self) => links.trapExit(self),
        receive: (m, self) => {
          if (typeof m === 'string') seen.push(`${self}:${m}`)
          // asked to stop: finish for 3 s, then end normally
          else clock.after(3000, () => sys.exit(self, X_NORMAL))
        },
      }),
    })
    k.send(5, 'a')
    await clock.runUntil(1)
    const first = k.pidOf(5) as Pid
    k.passivate(5)
    await clock.runUntil(1000)
    k.send(5, 'b')
    k.send(5, 'c')
    expect(k.stats.held).toBe(2)
    await clock.runUntil(5000)
    const second = k.pidOf(5) as Pid
    expect(second).not.toBe(first)
    expect(seen).toEqual([`${first}:a`, `${second}:b`, `${second}:c`])
  })

  it('stopAll stops every keyed actor, the last started first', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const ended: number[] = []
    const k = keyedActors<number, string>(sys, {
      name: 'k',
      make: (key) => ({ name: `k${key}`, receive: () => {} }),
    })
    for (const key of [1, 2, 3]) k.send(key, 'x')
    await clock.runUntil(1)
    const links = linksOf(sys)
    for (const key of [1, 2, 3])
      void links.exited(k.pidOf(key) as Pid).then(() => ended.push(key))
    const all = k.stopAll()
    await clock.runUntil(10)
    await all
    expect(ended).toEqual([3, 2, 1])
    expect(k.active()).toBe(0)
  })
})
