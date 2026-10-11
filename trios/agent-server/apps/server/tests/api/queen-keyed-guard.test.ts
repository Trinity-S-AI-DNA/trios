/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * KEYED ACTORS THAT HOLD UP (gHashTag/t27 specs/queen/keyed_guard.t27,
 * gHashTag/trios#1729 item 7). The three gaps the keyed actors' MVP reported
 * (trios#1723), each run here against the card:
 *   1. the claim's holder is the issue actor, inside its process's boot, and
 *      the round renews and releases for the process and its actors;
 *   2. the admission is supervised, and its lanes and waiting issues live on
 *      a board its crash cannot take;
 *   3. a call cycle is caught at any slot, not only slots 0..63.
 * Fake bees under a virtual clock, as in queen-bee-actors.test.ts.
 */

import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Pool } from 'pg'
import {
  ACTORS_CARD,
  createActorSystem,
  type Pid,
  slotOf,
} from '../../src/api/services/queen-actors'
import {
  CALL_CYCLE,
  CALL_PENDING,
  CALL_REPLY,
  CALL_TIMEOUT,
  CALL_TOO_DEEP,
  X_CRASH,
} from '../../src/api/services/queen-actors-card.gen'
import {
  type CallRequest,
  KEYED_GUARD_CARD,
  linksOf,
} from '../../src/api/services/queen-actors-links'
import {
  type BeeDispatchDeps,
  type BeeEnd,
  type BeeEvent,
  type BeeStart,
  beeDispatcher,
} from '../../src/api/services/queen-bee-actors'
import { loadCardWasm } from '../../src/api/services/queen-card-wasm'
import {
  releaseTaskLease,
  renewRunningLeases,
} from '../../src/api/services/queen-control'
import { dispatchBee } from '../../src/api/services/queen-dispatch'
import { EF_NONE } from '../../src/api/services/queen-dispatch-exit-card.gen'
import {
  ADMISSION_MAX_RESTARTS,
  CHAIN_CALLERS,
} from '../../src/api/services/queen-keyed-guard-card.gen'
import {
  queenActorHolderPrefix,
  queenHolderName,
} from '../../src/api/services/queen-lease'
import { DEFAULT_SPECS_ROOT } from '../../src/inngest/spec-catalog'
import { VirtualClock } from './queen-virtual-clock'

const sha = (file: string) =>
  createHash('sha256')
    .update(readFileSync(join(DEFAULT_SPECS_ROOT, file)))
    .digest('hex')

const OK: BeeEnd = {
  completion: true,
  errorFrame: EF_NONE,
  http: 200,
  heartbeatAge: 0,
  leaseHeld: true,
}

/**
 * Fake bees, each ended by the test. `running` counts the bees whose work has
 * not ended, from the bees themselves, and `maxRunning` the most at once.
 */
function harness(lanes: number, over: Partial<BeeDispatchDeps> = {}) {
  const clock = new VirtualClock()
  const sys = createActorSystem(clock, { slices: false })
  const bees: Array<{ issue: number; holder: string; end: () => void }> = []
  const events: BeeEvent[] = []
  const live = new Map<number, number>()
  const world = { running: 0, maxRunning: 0, duplicates: 0 }
  const d = beeDispatcher(sys, {
    lanes: () => lanes,
    admit: async () => true,
    observe: (e) => void events.push(e),
    start: async (issue, holder): Promise<BeeStart> => {
      let resolve: (e: BeeEnd) => void = () => {}
      const ended = new Promise<BeeEnd>((r) => {
        resolve = r
      })
      if ((live.get(issue) ?? 0) > 0) world.duplicates++
      live.set(issue, (live.get(issue) ?? 0) + 1)
      world.running++
      world.maxRunning = Math.max(world.maxRunning, world.running)
      let done = false
      bees.push({
        issue,
        holder,
        end: () => {
          if (done) return
          done = true
          live.set(issue, (live.get(issue) ?? 1) - 1)
          world.running--
          resolve(OK)
        },
      })
      return { claim: true, work: { ended, cancel: () => {} } }
    },
    ...over,
  })
  const started = () => bees.map((b) => b.issue)
  const end = (issue: number) =>
    bees.find((b) => b.issue === issue)?.end() ?? undefined
  return { clock, sys, d, bees, events, world, started, end }
}

describe('the vendored keyed_guard card is the one PIN names', () => {
  it('keyed_guard.t27 and keyed_guard.wasm match', () => {
    const pin = readFileSync(join(DEFAULT_SPECS_ROOT, 'PIN'), 'utf8')
    for (const f of ['queen/keyed_guard.t27', 'queen/keyed_guard.wasm'])
      expect(pin).toContain(`${f} sha256 ${sha(f)}`)
  })
})

describe('1. the claim holder is the actor in its process boot', () => {
  it('names the process, its boot and the pid; a new incarnation is a new holder', async () => {
    const prefix = queenActorHolderPrefix()
    expect(prefix.startsWith(`${queenHolderName()}/`)).toBe(true)
    expect(prefix).toMatch(/\/[0-9a-f]{8}$/)
    expect(queenActorHolderPrefix()).toBe(prefix)
    const { clock, d, bees, end } = harness(1, { holderPrefix: prefix })
    d.ready(41)
    await clock.runUntil(10)
    expect(bees[0].holder).toBe(`${prefix}:${d.issues.pidOf(41)}`)
    // the bee ends, the issue passivates, and a send-back starts it again:
    // another incarnation, another holder
    end(41)
    await clock.runUntil(10 * 60_000)
    expect(d.issues.pidOf(41)).toBeUndefined()
    d.sentBack(41)
    await clock.runUntil(10 * 60_000 + 10)
    expect(bees.length).toBe(2)
    expect(bees[1].holder).not.toBe(bees[0].holder)
    expect(bees[1].holder.startsWith(`${prefix}:`)).toBe(true)
  })

  it("the store's claim, string equality on the holder, is claim_lands_for", () => {
    const guard = loadCardWasm('queen/keyed_guard.wasm')
    const P = 'replica-a:1'
    const Q = 'replica-b:1'
    const holders = [
      P,
      Q,
      `${P}/0a0b0c0d:21474836481`,
      `${P}/0a0b0c0d:21474836482`,
      `${P}/0a0b0c0d:25769803777`,
      `${P}/ffffffff:21474836481`,
      `${Q}/0a0b0c0d:21474836481`,
    ]
    // an actor's holder carries a boot after a slash; the process's does not
    const parts = (h: string) =>
      h.includes('/')
        ? {
            process: h.slice(0, h.lastIndexOf(':')),
            pid: BigInt(h.slice(h.lastIndexOf(':') + 1)),
          }
        : { process: h, pid: 0n }
    let pairs = 0
    for (const held of holders)
      for (const claimer of holders) {
        const a = parts(held)
        const b = parts(claimer)
        const card =
          guard.call64(
            'claim_lands_for',
            1,
            a.process === b.process ? 1 : 0,
            a.pid,
            b.pid,
          ) !== 0
        expect(card).toBe(held === claimer)
        pairs++
      }
    expect(pairs).toBe(49)
  })

  it('dispatchBee claims for the holder it is given, and for the process without one', async () => {
    const asked: string[] = []
    const claimTaskLease = async (_p: Pool, _issue: number, holder: string) => {
      asked.push(holder)
      return { landed: false, holder: 'someone', fence: 1, expiresAt: '' }
    }
    const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as never
    const actor = `${queenActorHolderPrefix()}:21474836481`
    const out = await dispatchBee(
      pool,
      4100,
      'b',
      [],
      [],
      undefined,
      [],
      'none',
      {
        claimTaskLease,
        releaseTaskLease: null,
        publishEvent: null,
        holder: actor,
      },
    )
    await dispatchBee(pool, 4100, 'b', [], [], undefined, [], 'none', {
      claimTaskLease,
      releaseTaskLease: null,
      publishEvent: null,
    })
    expect(out.started).toBe(false)
    expect(asked).toEqual([actor, queenHolderName()])
  })

  it("the round renews and an end releases its actors' leases with its own", async () => {
    const calls: Array<[string, unknown[]]> = []
    const pool = {
      query: async (sql: string, args: unknown[]) => {
        calls.push([sql, args])
        return { rows: [], rowCount: 1 }
      },
    } as unknown as Pool
    const prefix = queenActorHolderPrefix()
    await renewRunningLeases(pool, queenHolderName(), 180, prefix)
    await releaseTaskLease(pool, 7, queenHolderName(), prefix)
    await releaseTaskLease(pool, 7, 'me')
    expect(calls[0][1]).toEqual([queenHolderName(), 180, prefix])
    expect(calls[0][0]).toContain(
      "left(t.holder, length($3::text) + 1) = $3::text || ':'",
    )
    expect(calls[1][1]).toEqual([7, queenHolderName(), prefix])
    expect(calls[1][0]).toContain("left(holder, length($3) + 1) = $3 || ':'")
    // without the actors' prefix, the statement is the one it was
    expect(calls[2][1]).toEqual([7, 'me'])
    expect(calls[2][0]).toContain('WHERE issue = $1 AND holder = $2')
  })
})

describe('2. the admission is supervised and its lanes are on the board', () => {
  it('crashed mid-round, it comes back: the lanes in use are still counted, the waiting issues start, and no issue starts twice', async () => {
    const { clock, sys, d, world, started, end } = harness(2)
    for (const i of [1, 2, 3, 4]) d.ready(i)
    await clock.runUntil(10)
    expect(started()).toEqual([1, 2])
    expect(d.waiting()).toEqual([3, 4])
    const first = d.admission()
    sys.exit(first, X_CRASH)
    // while it is down: a bee ends, and a new issue finds no admission
    end(1)
    d.ready(5)
    await clock.runUntil(20)
    expect(sys.alive(first)).toBe(false)
    expect(d.lanesInUse()).toBe(1)
    expect(d.waiting()).toEqual([3, 4, 5])
    expect(d.stats.admissionMissed).toBe(1)
    // the supervisor restarts it within its backoff (BACKOFF_BASE_SECONDS)
    await clock.runUntil(60_000)
    expect(d.admission()).not.toBe(first)
    expect(d.stats.admissionStarts).toBe(2)
    expect(started()).toEqual([1, 2, 3])
    expect(d.lanesInUse()).toBe(2)
    expect(d.waiting()).toEqual([4, 5])
    end(2)
    end(3)
    await clock.runUntil(61_000)
    expect(started()).toEqual([1, 2, 3, 4, 5])
    expect(world.duplicates).toBe(0)
    expect(world.maxRunning).toBeLessThanOrEqual(2)
  })

  it('crashed by its own turn (the lane count throws), it is restarted the same way', async () => {
    let fail = false
    const { clock, d, world, started, end } = harness(1, {
      lanes: () => {
        if (fail) {
          fail = false
          throw new Error('the lane count could not be read')
        }
        return 1
      },
    })
    d.ready(1)
    await clock.runUntil(10)
    fail = true
    d.ready(2)
    await clock.runUntil(20)
    expect(d.stats.admissionMissed).toBe(1)
    expect(d.waiting()).toEqual([2])
    await clock.runUntil(60_000)
    expect(d.stats.admissionStarts).toBe(2)
    expect(started()).toEqual([1])
    end(1)
    await clock.runUntil(61_000)
    expect(started()).toEqual([1, 2])
    expect(world.maxRunning).toBe(1)
  })

  it('a grant whose answer reaches nobody goes back at once (it stayed in use for good before)', async () => {
    let slow = true
    const { clock, d, started, events } = harness(1, {
      admitAfterMs: 1000,
      admit: async () => {
        if (slow) {
          slow = false
          await new Promise<void>((r) => clock.after(5000, r))
        }
        return true
      },
    })
    d.ready(7)
    await clock.runUntil(2000)
    // the call timed out: the issue waits on the board, nothing started
    expect(started()).toEqual([])
    expect(d.waiting()).toEqual([7])
    await clock.runUntil(6000)
    // the late grant reached nobody and was taken back; the wake asked again
    expect(d.stats.grantsTakenBack).toBe(1)
    expect(started()).toEqual([7])
    expect(d.lanesInUse()).toBe(1)
    expect(events.filter((e) => e.kind === 'started').length).toBe(1)
  })

  it('an issue actor that crashes between its grant and its start gives its lane back', async () => {
    const { clock, sys, d, started } = harness(1, {
      start: (issue) =>
        issue === 8
          ? new Promise<BeeStart>(() => {})
          : Promise.resolve({
              claim: true,
              work: { ended: new Promise<BeeEnd>(() => {}), cancel: () => {} },
            }),
    })
    d.ready(8)
    d.ready(9)
    await clock.runUntil(10)
    expect(d.lanesInUse()).toBe(1)
    expect(d.waiting()).toEqual([9])
    sys.exit(d.issues.pidOf(8) as Pid, X_CRASH)
    await clock.runUntil(20)
    expect(d.stats.lanesFreedOnExit).toBe(1)
    expect(d.board.lanes.has(8)).toBe(false)
    expect(d.board.lanes.has(9)).toBe(true)
    expect(started()).toEqual([])
  })

  it('a claim that lands after its actor died starts no bee on the lane its death gave back (trios#1763)', async () => {
    // the simulation gate's keyed world, seed 1072413183: the death gave the
    // lane back, another issue took it, and the claim then started a bee on
    // no lane - 5 bees on 4 lanes
    const starts: number[] = []
    const cancelled: number[] = []
    const { clock, sys, d } = harness(1, {
      start: (issue) =>
        new Promise<BeeStart>((r) =>
          clock.after(1000, () => {
            starts.push(issue)
            r({
              claim: true,
              work: {
                ended: new Promise<BeeEnd>(() => {}),
                cancel: () => void cancelled.push(issue),
              },
            })
          }),
        ),
    })
    d.ready(8)
    await clock.runUntil(10)
    expect(d.lanesInUse()).toBe(1)
    sys.exit(d.issues.pidOf(8) as Pid, X_CRASH)
    await clock.runUntil(20)
    // no bee runs yet: the lane goes back, and 9 takes it
    expect(d.stats.lanesFreedOnExit).toBe(1)
    d.ready(9)
    await clock.runUntil(30)
    expect(d.board.lanes.has(9)).toBe(true)
    // 8's claim lands with no lane under it: its bee is stopped at once
    await clock.runUntil(1005)
    expect(starts).toEqual([8])
    expect(cancelled).toEqual([8])
    // 9's lands on its lane and runs
    await clock.runUntil(2000)
    expect(starts).toEqual([8, 9])
    expect(cancelled).toEqual([8])
    expect(d.lanesInUse()).toBe(1)
    expect(d.stats.standDowns).toBe(0)
  })

  it('a supervisor that gives up says so, and leaves the board as it was', async () => {
    const { clock, sys, d, events, started } = harness(1)
    d.ready(1)
    await clock.runUntil(10)
    // one crash more than the intensity allows inside the period: each one
    // waits for the restart before it (10, 20, 40 s of backoff)
    for (let k = 0; k <= ADMISSION_MAX_RESTARTS; k++) {
      const pid = d.admission()
      sys.exit(pid, X_CRASH)
      for (let s = 0; s < 120 && d.admission() === pid; s++)
        await clock.runUntil(clock.now() + 1000)
    }
    expect(d.stats.admissionStarts).toBe(ADMISSION_MAX_RESTARTS + 1)
    expect(sys.alive(d.admission())).toBe(false)
    expect(events.some((e) => e.kind === 'admission-gave-up')).toBe(true)
    d.ready(2)
    await clock.runUntil(clock.now() + 10)
    expect(started()).toEqual([1])
    expect(d.lanesInUse()).toBe(1)
    expect(d.waiting()).toEqual([2])
  })
})

describe('3. a call cycle is caught at any slot', () => {
  it('A -> B -> A past slot 63 is refused at once; the slot chain let it wait out its timeout', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const links = linksOf(sys)
    // 70 processes first: the runtime never reuses a slot
    for (let i = 0; i < 70; i++) sys.spawn({ name: 'x', receive: () => {} })
    const seen: number[] = []
    let a: Pid = 0n
    const b = sys.spawn<CallRequest>({
      name: 'b',
      receive: async (req, self) => {
        const back = await links.call({ self, serving: req }, a, 'back', 5000)
        seen.push(back.outcome)
        links.reply(req, 'done', self)
      },
    })
    a = sys.spawn<string>({ name: 'a', receive: () => {} })
    expect(slotOf(a)).toBeGreaterThan(63n)
    expect(slotOf(b)).toBeGreaterThan(63n)
    const top = links.call<string>({ self: a }, b, 'go', 5000)
    await clock.runUntil(10)
    expect(seen).toEqual([CALL_CYCLE])
    expect((await top).outcome).toBe(CALL_REPLY)
    // actors.t27's slot chain on the same two processes: no cycle seen
    const actors = loadCardWasm(ACTORS_CARD)
    const slotChain = actors.call64(
      'chain_add',
      actors.call64('chain_add', 0n, slotOf(a)),
      slotOf(b),
    )
    expect(Number(actors.call64('call_admit', slotChain, 2, slotOf(a)))).toBe(
      CALL_PENDING,
    )
  })

  it('a call to itself past slot 63 is refused at once', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const links = linksOf(sys)
    for (let i = 0; i < 70; i++) sys.spawn({ name: 'x', receive: () => {} })
    const me = sys.spawn<string>({ name: 'me', receive: () => {} })
    const got = await links.call({ self: me }, me, 'hi', 5000)
    expect(got.outcome).toBe(CALL_CYCLE)
  })

  it('the chain carries every caller: a cycle eight calls deep is named, and the ninth call is too deep', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const links = linksOf(sys)
    for (let i = 0; i < 100; i++) sys.spawn({ name: 'x', receive: () => {} })
    const outcomes: number[] = []
    const ring: Pid[] = []
    // each process calls the next; the last one calls the first back
    const hop = (k: number) =>
      sys.spawn<CallRequest>({
        name: `p${k}`,
        receive: async (req, self) => {
          const to = k + 1 < 8 ? ring[k + 1] : ring[0]
          const got = await links.call({ self, serving: req }, to, k, 5000)
          if (k + 1 >= 8) outcomes.push(got.outcome)
          links.reply(req, k, self)
        },
      })
    for (let k = 0; k < 8; k++) ring.push(hop(k))
    const origin = sys.spawn<string>({ name: 'o', receive: () => {} })
    const top = links.call({ self: origin }, ring[0], 'go', 60_000)
    await clock.runUntil(100)
    expect(outcomes).toEqual([CALL_CYCLE])
    expect((await top).outcome).toBe(CALL_REPLY)
    // nine callers blocked: refused for depth, the chain is full
    const callers = Array.from({ length: CHAIN_CALLERS - 1 }, (_, i) =>
      BigInt(ring[i % 8]),
    )
    const deep = await links.call(
      {
        self: origin,
        serving: { kind: 'call', body: 0, alias: 0n, callers, depth: 8 },
      },
      sys.spawn({ name: 'y', receive: () => {} }),
      'x',
      5000,
    )
    expect(deep.outcome).toBe(CALL_TOO_DEEP)
  })

  it('a caller that died is not on the chain once its slot comes back as another pid', async () => {
    const guard = loadCardWasm(KEYED_GUARD_CARD)
    const old = (5n << 32n) | 1n
    const next = (5n << 32n) | 2n
    const pad = Array.from({ length: CHAIN_CALLERS - 1 }, () => 0n)
    expect(Number(guard.call64('call_admit_chain', 1, next, old, ...pad))).toBe(
      CALL_PENDING,
    )
    expect(Number(guard.call64('call_admit_chain', 1, old, old, ...pad))).toBe(
      CALL_CYCLE,
    )
    // a timeout still ends a call nobody answers
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { slices: false })
    const links = linksOf(sys)
    const silent = sys.spawn({ name: 's', receive: () => {} })
    const caller = sys.spawn({ name: 'c', receive: () => {} })
    const p = links.call({ self: caller }, silent, 1, 1000)
    await clock.runUntil(2000)
    expect((await p).outcome).toBe(CALL_TIMEOUT)
  })
})
