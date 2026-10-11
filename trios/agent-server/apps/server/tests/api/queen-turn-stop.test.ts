/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE STOP OF A TURN (gHashTag/t27 specs/queen/turn_stop.t27, trios#1713,
 * epic trios#1712). The card as the wasm answers it, then the runtime with
 * `turnStop`: a turn that ignores its abort is escalated and killed, a process
 * turn leaves no grandchild, a stopped review's model call, commands and
 * verdict all stop, and a reviewer whose reviews stall never runs more than
 * its bound at once. Real processes and a real clock where the OS is what is
 * tested; the virtual clock where the arithmetic is.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import {
  type Clock,
  createActorSystem,
} from '../../src/api/services/queen-actors'
import { X_SHUTDOWN } from '../../src/api/services/queen-actors-card.gen'
import { processWork } from '../../src/api/services/queen-actors-isolate'
import {
  defaultExec,
  type Exec,
  measureCriteria,
} from '../../src/api/services/queen-criteria-run'
import {
  gitAt,
  type WorkerProvider,
} from '../../src/api/services/queen-dispatch'
import { reviewerTree } from '../../src/api/services/queen-review-actors'
import {
  defaultReviewerLlm,
  forgetReviewerLaneFailures,
  type ReviewDeps,
  reviewerLaneBackedOff,
} from '../../src/api/services/queen-reviewer'
import {
  REVIEW_ROW_SECONDS,
  REVIEWER_CONCURRENCY,
} from '../../src/api/services/queen-reviewer-card.gen'
import { reviewFinishedDispatches } from '../../src/api/services/queen-tick'
import {
  asStep,
  escalation,
  inFlight,
  stepOnAbort,
  withTurnSignal,
} from '../../src/api/services/queen-turn-stop'
import {
  ESC_ABANDON,
  ESC_KILL_GROUP,
  ESC_NOTHING,
  LANE_FREE_MS,
  STEP_CUT,
  STEP_RUN,
  TURN_STOP_GRACE_MS,
  U32_MAX,
} from '../../src/api/services/queen-turn-stop-card.gen'
import { DEFAULT_SPECS_ROOT } from '../../src/inngest/spec-catalog'
import { VirtualClock } from './queen-virtual-clock'

const sha = (file: string) =>
  createHash('sha256')
    .update(readFileSync(join(DEFAULT_SPECS_ROOT, file)))
    .digest('hex')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const HOUR = 3_600_000
const stopReason = () =>
  new DOMException('aborted: the turn was stopped', 'AbortError')

/** Whether a pid is still a process. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Wait until `cond` holds, up to `ms`. The real-process tests poll instead of
 * sleeping a fixed time: on a loaded host a signal can take a while to land.
 */
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms
  while (!cond()) {
    if (performance.now() > end) return false
    await sleep(10)
  }
  return true
}

/** The pid a test shell wrote to `file`, once it is there. */
async function pidFrom(file: string): Promise<number> {
  let pid = 0
  await until(() => {
    try {
      pid = Number(readFileSync(file, 'utf8').trim())
    } catch {
      // not written yet
    }
    return pid > 0
  }, 10_000)
  if (!(pid > 0)) throw new Error(`no pid in ${file}`)
  return pid
}

const dirs: string[] = []
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'queen-turn-stop-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('the vendored turn_stop card is the one PIN names', () => {
  it('turn_stop.t27 and turn_stop.wasm match', () => {
    const pin = readFileSync(join(DEFAULT_SPECS_ROOT, 'PIN'), 'utf8')
    expect(pin).toContain(
      `queen/turn_stop.t27 sha256 ${sha('queen/turn_stop.t27')}`,
    )
    expect(pin).toContain(
      `queen/turn_stop.wasm sha256 ${sha('queen/turn_stop.wasm')}`,
    )
  })
})

describe('the card, as the wasm answers', () => {
  it('step_on_abort: a finalizer runs, a shared write under way finishes, the rest is cut', () => {
    const table: Array<[boolean, boolean, boolean, number]> = [
      // started, writes_shared, finalizer -> answer
      [false, false, false, STEP_CUT],
      [true, false, false, STEP_CUT],
      [false, true, false, STEP_CUT],
      [true, true, false, STEP_RUN],
      [false, false, true, STEP_RUN],
      [true, false, true, STEP_RUN],
      [false, true, true, STEP_RUN],
      [true, true, true, STEP_RUN],
    ]
    for (const [started, shared, finalizer, want] of table)
      expect(stepOnAbort(started, shared, finalizer)).toBe(want)
  })

  it('escalation: the group for a process, an abandon otherwise, nothing once ended', () => {
    expect(escalation(true, false)).toBe(ESC_KILL_GROUP)
    expect(escalation(false, false)).toBe(ESC_ABANDON)
    expect(escalation(true, true)).toBe(ESC_NOTHING)
    expect(escalation(false, true)).toBe(ESC_NOTHING)
  })

  it('in_flight: a held turn counts, and the count saturates', () => {
    expect(inFlight(3, 2)).toBe(5)
    expect(inFlight(4, 0)).toBe(4)
    expect(inFlight(U32_MAX, 1)).toBe(U32_MAX)
    expect(inFlight(1, U32_MAX)).toBe(U32_MAX)
  })

  it('the grace and its promise are what the spec says', () => {
    expect(TURN_STOP_GRACE_MS).toBe(3000)
    expect(LANE_FREE_MS).toBe(5000)
  })
})

describe('a stopped turn on the loop (virtual clock)', () => {
  const hangs = (
    clock: VirtualClock,
    ms: number,
    signal: AbortSignal | undefined,
  ) =>
    new Promise<void>((resolve, reject) => {
      clock.after(ms, resolve)
      signal?.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      })
    })

  it('one that hears its abort ends at once and gives back what it held', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { turnStop: true })
    let endedAt = -1
    const pid = sys.spawn<string>({
      name: 'hears',
      turnMaxSeconds: 30,
      receive: async (_m, _self, _r, signal) => {
        try {
          await hangs(clock, HOUR, signal)
        } finally {
          endedAt = clock.now()
        }
      },
    })
    sys.send(pid, 'go')
    await clock.runUntil(30_000)
    expect(sys.alive(pid)).toBe(false)
    expect(sys.stats.killed).toBe(1)
    expect(endedAt).toBe(30_000)
    expect(sys.stats.stopped).toBe(1)
    expect(sys.stats.held).toBe(0)
    await clock.runUntil(30_000 + TURN_STOP_GRACE_MS)
    expect(sys.stats.escalated).toBe(0)
    expect(sys.stats.abandoned).toBe(0)
  })

  it('one that ignores its abort is abandoned at the grace, and holds until its work ends', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { turnStop: true })
    let heard = false
    const pid = sys.spawn<string>({
      name: 'deaf',
      turnMaxSeconds: 30,
      receive: async (_m, _self, _r, signal) => {
        signal.addEventListener('abort', () => {
          heard = true
        })
        await hangs(clock, HOUR, undefined)
      },
    })
    sys.send(pid, 'go')
    await clock.runUntil(30_000)
    expect(sys.alive(pid)).toBe(false)
    expect(heard).toBe(true)
    expect(sys.stats.held).toBe(1)
    await clock.runUntil(30_000 + TURN_STOP_GRACE_MS - 1)
    expect(sys.stats.abandoned).toBe(0)
    await clock.runUntil(30_000 + TURN_STOP_GRACE_MS)
    // kill_effect(ISO_LOOP) abandons: nothing is claimed stopped
    expect(sys.stats.abandoned).toBe(1)
    expect(sys.stats.escalated).toBe(0)
    expect(sys.stats.stopped).toBe(0)
    expect(sys.stats.held).toBe(1)
    await clock.runUntil(HOUR + 1)
    expect(sys.stats.held).toBe(0)
    expect(sys.stats.stopped).toBe(1)
  })

  it('without turnStop a kill abandons the turn, as before: no abort', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock)
    let seen: AbortSignal | undefined
    let endedAt = -1
    const pid = sys.spawn<string>({
      name: 'old',
      turnMaxSeconds: 30,
      receive: async (_m, _self, _r, signal) => {
        seen = signal
        await hangs(clock, HOUR, signal)
        endedAt = clock.now()
      },
    })
    sys.send(pid, 'go')
    await clock.runUntil(30_000 + TURN_STOP_GRACE_MS)
    expect(sys.alive(pid)).toBe(false)
    expect(seen?.aborted).toBe(false)
    expect(sys.stats.held).toBe(0)
    await clock.runUntil(HOUR + 1)
    expect(endedAt).toBe(HOUR)
    expect(sys.stats.stopped).toBe(0)
  })

  it('a supervisor stop (exit with X_SHUTDOWN) aborts the running turn too', async () => {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { turnStop: true })
    let aborted = false
    const pid = sys.spawn<string>({
      name: 'stopped',
      receive: async (_m, _self, _r, signal) => {
        await hangs(clock, HOUR, signal).catch(() => {
          aborted = true
        })
      },
    })
    sys.send(pid, 'go')
    await clock.runUntil(1_000)
    sys.exit(pid, X_SHUTDOWN, true)
    await clock.runUntil(1_001)
    expect(aborted).toBe(true)
    expect(sys.stats.held).toBe(0)
  })
})

describe('a stopped process turn (real processes, real clock)', () => {
  it('ignores its SIGTERM, so the escalation kills its whole group at the grace: nothing survives', async () => {
    const file = join(scratch(), 'grandchild')
    const sys = createActorSystem(undefined, { turnStop: true })
    let killedAt = 0
    let endedAt = 0
    const pid = sys.spawn<string>(
      {
        name: 'deaf-process',
        turnMaxSeconds: 1,
        isolated: {
          cpuBound: false,
          foreignCode: true,
          start: (f, signal) => {
            const w = processWork(
              [
                'sh',
                '-c',
                `trap '' TERM; sleep 30 & echo $! > "$1"; wait`,
                'sh',
                f,
              ],
              undefined,
              signal,
            )
            w.result.catch(() => {
              endedAt = performance.now()
            })
            return w
          },
        },
        receive: () => {},
      },
      () => {
        killedAt = performance.now()
      },
    )
    sys.send(pid, file)
    const grandchild = await pidFrom(file)
    expect(await until(() => killedAt > 0, 10_000)).toBe(true)
    // killed and aborted, but the group ignores SIGTERM: still there
    await sleep(200)
    expect(sys.alive(pid)).toBe(false)
    expect(alive(grandchild)).toBe(true)
    expect(sys.stats.held).toBe(1)
    expect(sys.stats.escalated).toBe(0)
    expect(await until(() => endedAt > 0, TURN_STOP_GRACE_MS + 10_000)).toBe(
      true,
    )
    expect(sys.stats.escalated).toBe(1)
    expect(sys.stats.stopped).toBe(1)
    expect(sys.stats.held).toBe(0)
    expect(await until(() => !alive(grandchild), 5_000)).toBe(true)
    const freedMs = endedAt - killedAt
    console.log(
      `\n## a deaf process turn: killed, then its group killed by the escalation ${Math.round(freedMs)} ms later; grandchild alive: ${alive(grandchild)}`,
    )
    expect(freedMs).toBeGreaterThanOrEqual(TURN_STOP_GRACE_MS - 50)
    expect(freedMs).toBeLessThanOrEqual(LANE_FREE_MS)
  }, 30_000)

  it('hears its SIGTERM: the group ends inside the grace, with no escalation', async () => {
    const file = join(scratch(), 'grandchild')
    const sys = createActorSystem(undefined, { turnStop: true })
    let killedAt = 0
    let endedAt = 0
    const pid = sys.spawn<string>(
      {
        name: 'hearing-process',
        turnMaxSeconds: 1,
        isolated: {
          cpuBound: false,
          foreignCode: true,
          start: (f, signal) => {
            const w = processWork(
              ['sh', '-c', `sleep 30 & echo $! > "$1"; wait`, 'sh', f],
              undefined,
              signal,
            )
            w.result.catch(() => {
              endedAt = performance.now()
            })
            return w
          },
        },
        receive: () => {},
      },
      () => {
        killedAt = performance.now()
      },
    )
    sys.send(pid, file)
    const grandchild = await pidFrom(file)
    expect(await until(() => endedAt > 0, 10_000)).toBe(true)
    expect(sys.alive(pid)).toBe(false)
    expect(endedAt - killedAt).toBeLessThan(LANE_FREE_MS)
    expect(sys.stats.stopped).toBe(1)
    expect(sys.stats.held).toBe(0)
    expect(await until(() => !alive(grandchild), 5_000)).toBe(true)
    await sleep(TURN_STOP_GRACE_MS + 200)
    expect(sys.stats.escalated).toBe(0)
  }, 30_000)

  it('without turnStop the kill reaches the whole group too: a process isolate leaves no grandchild', async () => {
    const file = join(scratch(), 'grandchild')
    const sys = createActorSystem()
    const pid = sys.spawn<string>({
      name: 'old-kill',
      turnMaxSeconds: 1,
      isolated: {
        cpuBound: false,
        foreignCode: true,
        start: (f) => {
          const w = processWork([
            'sh',
            '-c',
            `sleep 30 & echo $! > "$1"; wait`,
            'sh',
            f,
          ])
          w.result.catch(() => {})
          return w
        },
      },
      receive: () => {},
    })
    sys.send(pid, file)
    const grandchild = await pidFrom(file)
    expect(await until(() => !sys.alive(pid), 10_000)).toBe(true)
    expect(sys.stats.stopped).toBe(1)
    expect(await until(() => !alive(grandchild), 5_000)).toBe(true)
  }, 30_000)
})

/**
 * THE GRACE TIMER CAN COME BACK EARLY (trios#1766). A timer keeps a clock of
 * its own: Bun's setTimeout runs on a coarse or raw monotonic clock, the
 * runtime's `now` is Date.now. So the grace's timer can fire when `now` says
 * 2999 of 3000 ms. stop_signal then answers X_NONE, "not yet", and the
 * runtime used to take that as "never": the escalation was lost and a turn
 * deaf to SIGTERM kept its whole process group (CI run 38094454978: the deaf
 * turns of turn-stop-bench B were freed only by the bench's own cleanup, at
 * 9996 ms). This clock's timers come back 1 ms early, every time but the last
 * millisecond, so the case is the same on every run.
 */
describe('a grace timer that comes back early (virtual clock, trios#1766)', () => {
  const early = (v: VirtualClock): Clock => ({
    now: v.now,
    after: (ms, fn) => v.after(ms > 1 ? ms - 1 : ms, fn),
  })

  it('still escalates a process turn deaf to its abort, at the grace and not before', async () => {
    const v = new VirtualClock()
    const sys = createActorSystem(early(v), { turnStop: true })
    let killedAt = -1
    let endedAt = -1
    let heard = false
    const pid = sys.spawn<string>(
      {
        name: 'deaf-process',
        turnMaxSeconds: 30,
        isolated: {
          cpuBound: false,
          foreignCode: true,
          start: (_m, signal) => {
            signal.addEventListener('abort', () => {
              heard = true
            })
            // deaf: only the escalation's kill ends it
            let stop = () => {}
            const result = new Promise<never>((_, reject) => {
              stop = () => reject(new Error('killed'))
            })
            result.catch(() => {
              endedAt = v.now()
            })
            return { result, stop }
          },
        },
        receive: () => {},
      },
      () => {
        killedAt = v.now()
      },
    )
    sys.send(pid, 'go')
    await v.runUntil(30_000)
    expect(killedAt).toBeGreaterThan(0)
    expect(heard).toBe(true)
    expect(sys.stats.held).toBe(1)
    await v.runUntil(killedAt + TURN_STOP_GRACE_MS - 1)
    expect(sys.stats.escalated).toBe(0)
    expect(endedAt).toBe(-1)
    await v.runUntil(killedAt + TURN_STOP_GRACE_MS + 1_000)
    expect(sys.stats.escalated).toBe(1)
    expect(endedAt - killedAt).toBe(TURN_STOP_GRACE_MS)
    expect(sys.stats.stopped).toBe(1)
    expect(sys.stats.held).toBe(0)
    expect(sys.stats.abandoned).toBe(0)
  })

  it('still abandons a loop turn deaf to its abort, at the grace and not before', async () => {
    // the other answer of escalation: ESC_ABANDON, on the same early timer
    const v = new VirtualClock()
    const sys = createActorSystem(early(v), { turnStop: true })
    const pid = sys.spawn<string>({
      name: 'deaf-loop',
      turnMaxSeconds: 30,
      receive: () => new Promise<void>((r) => v.after(HOUR, r)),
    })
    sys.send(pid, 'go')
    // the kill timer comes back at 29 999: ceil(29.999 s) is the 30 s bound
    await v.runUntil(29_999)
    expect(sys.alive(pid)).toBe(false)
    expect(sys.stats.held).toBe(1)
    await v.runUntil(29_999 + TURN_STOP_GRACE_MS - 1)
    expect(sys.stats.abandoned).toBe(0)
    await v.runUntil(29_999 + TURN_STOP_GRACE_MS)
    expect(sys.stats.abandoned).toBe(1)
    expect(sys.stats.escalated).toBe(0)
    expect(sys.stats.held).toBe(1)
  })
})

describe('commands of a stopped turn', () => {
  const req = (argv: string[]) => ({
    argv,
    cwd: tmpdir(),
    timeoutMs: 60_000,
    maxBytes: 4_096,
  })

  it('a command is cut at once; a shared write under way finishes; a finalizer still runs', async () => {
    const ac = new AbortController()
    await withTurnSignal(ac.signal, async () => {
      const t0 = performance.now()
      const cut = defaultExec(req(['sleep', '30']))
      const shared = asStep({ writesShared: true }, () =>
        defaultExec(req(['sh', '-c', 'sleep 0.3; echo wrote'])),
      )
      await sleep(50)
      ac.abort(stopReason())
      const c = await cut
      expect(c.error).toContain('aborted')
      expect(performance.now() - t0).toBeLessThan(LANE_FREE_MS)
      const s = await shared
      expect(s.code).toBe(0)
      expect(s.stdout.trim()).toBe('wrote')
      // after the abort: nothing new starts, but a finalizer does
      expect(() => asStep({ writesShared: true }, () => 1)).toThrow('aborted')
      const late = await defaultExec(req(['echo', 'late']))
      expect(late.error).toContain('aborted')
      expect(late.stdout).toBe('')
      const fin = await asStep({ finalizer: true }, () =>
        defaultExec(req(['echo', 'cleaned'])),
      )
      expect(fin.code).toBe(0)
      expect(fin.stdout.trim()).toBe('cleaned')
    })
  })

  it('a git command and its grandchild die with the turn (gitAt, through run in queen-dispatch.ts)', async () => {
    const dir = scratch()
    const file = join(dir, 'grandchild')
    const ac = new AbortController()
    const t0 = performance.now()
    const git = withTurnSignal(ac.signal, () =>
      gitAt(dir, ['-c', `alias.zz=!sleep 30 & echo $! > ${file}; wait`, 'zz']),
    )
    const grandchild = await pidFrom(file)
    expect(alive(grandchild)).toBe(true)
    const k = performance.now()
    ac.abort(stopReason())
    const out = await git
    const ms = performance.now() - k
    const gone = await until(() => !alive(grandchild), 5_000)
    console.log(
      `\n## a git command whose turn stopped: its result ${Math.round(ms)} ms after the abort, grandchild alive: ${!gone}`,
    )
    expect(out.code).not.toBe(0)
    expect(ms).toBeLessThan(LANE_FREE_MS)
    expect(performance.now() - t0).toBeLessThan(20_000)
    expect(gone).toBe(true)
  }, 30_000)

  it('a region inside a shared write under way is a part of it, even after the abort', async () => {
    const ac = new AbortController()
    await withTurnSignal(ac.signal, () =>
      asStep({ writesShared: true }, async () => {
        ac.abort(stopReason())
        const inner = await asStep({ writesShared: true }, () =>
          defaultExec(req(['echo', 'inner'])),
        )
        expect(inner.code).toBe(0)
        expect(inner.stdout.trim()).toBe('inner')
      }),
    )
  })

  it('a stopped measurement kills its command, and its finalizer still removes the worktree and the directory', async () => {
    const git = (cwd: string, ...args: string[]) => {
      const out = spawnSync('git', args, { cwd, encoding: 'utf8' })
      if (out.status !== 0) throw new Error(`git ${args.join(' ')}`)
      return out.stdout.trim()
    }
    const root = scratch()
    git(root, 'init', '-q', '-b', 'master')
    git(root, 'config', 'user.email', 'queen@example.invalid')
    git(root, 'config', 'user.name', 'queen')
    writeFileSync(join(root, 'a.t27'), 'fn a() {}\n')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'base')
    const head = git(root, 'rev-parse', 'HEAD')
    const tmpRoot = scratch()
    // the plumbing runs as it is; the criterion command becomes a 30 s sleep
    let commandStarted = false
    const exec: Exec = (request) => {
      const plumbing = ['git', 'mkdir', 'mktemp', 'rm'].includes(
        request.argv[0],
      )
      if (!plumbing) commandStarted = true
      return defaultExec(
        plumbing ? request : { ...request, argv: ['sleep', '30'] },
      )
    }
    const ac = new AbortController()
    const t0 = performance.now()
    const measuring = withTurnSignal(ac.signal, () =>
      measureCriteria(9301, head, ['1. `grep -c fn a.t27` prints `1`'], {
        repoRoot: root,
        tmpRoot,
        exec,
      }),
    )
    for (let i = 0; i < 200 && !commandStarted; i++) await sleep(10)
    expect(commandStarted).toBe(true)
    // the criteria worktree exists while the command runs
    expect(git(root, 'worktree', 'list').split('\n')).toHaveLength(2)
    ac.abort(stopReason())
    await measuring
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(10_000)
    expect(git(root, 'worktree', 'list').split('\n')).toHaveLength(1)
    expect(readdirSync(tmpRoot)).toEqual([])
  }, 30_000)

  it('outside a turn nothing changes: a command runs to its end', async () => {
    const out = await defaultExec(req(['sh', '-c', 'sleep 0.1; echo ok']))
    expect(out.code).toBe(0)
    expect(out.stdout.trim()).toBe('ok')
  })
})

describe("a stopped review's model call (the real AI SDK, a local server that never answers)", () => {
  beforeEach(() => forgetReviewerLaneFailures())

  it('is aborted with its turn: the lane is free in milliseconds, not at the 120 s timeout', async () => {
    let requests = 0
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => {
        requests++
        return new Promise<Response>(() => {})
      },
    })
    try {
      const lane: WorkerProvider = {
        provider: 'openai-compatible',
        model: 'never-answers',
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: 'test-key-not-real',
        keyIndex: 1,
        poolNumber: 1,
        laneIndex: 0,
        laneCount: 1,
      }
      const ac = new AbortController()
      const call = withTurnSignal(ac.signal, () =>
        defaultReviewerLlm(lane, 'system', 'message'),
      )
      for (let i = 0; i < 100 && requests === 0; i++) await sleep(20)
      expect(requests).toBe(1)
      const k = performance.now()
      ac.abort(stopReason())
      const answer = await call
      const ms = performance.now() - k
      console.log(
        `\n## a stopped review's model call: answered ${ms.toFixed(1)} ms after the abort (the timeout is 120000 ms)`,
      )
      expect(answer.ok).toBe(false)
      if (!answer.ok) expect(answer.transient).toBe(true)
      expect(ms).toBeLessThan(LANE_FREE_MS)
    } finally {
      server.stop(true)
    }
  }, 30_000)
})

describe('a stopped review writes nothing (the sweep, reviewFinishedDispatches)', () => {
  const ISSUE = 7101
  const LANE: WorkerProvider = {
    provider: 'zai',
    model: 'glm-test',
    baseUrl: 'https://z.example.invalid',
    apiKey: 'not-a-real-key',
    keyIndex: 1,
    poolNumber: 1,
    laneIndex: 0,
    laneCount: 1,
  }
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    forgetReviewerLaneFailures()
    saved.WORKSPACE_DIR = process.env.WORKSPACE_DIR
    process.env.WORKSPACE_DIR = join(tmpdir(), 'queen-turn-stop-no-workspace')
  })
  afterEach(() => {
    if (saved.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
    else process.env.WORKSPACE_DIR = saved.WORKSPACE_DIR
  })

  it('its model call gets the signal; once aborted: no verdict, no cache, no lane backed off', async () => {
    const queries: string[] = []
    const row: Record<string, unknown> = {
      issue: ISSUE,
      conversation_id: '00000000-0000-0000-0000-000000001bbd',
      review_state: null,
      criteria: ['The handler scrolls', 'A test covers it'],
      criteria_source: 'stated',
      send_backs: 0,
      owned_paths: [],
      free_attempts: 0,
      key_index: 1,
      provider: 'zai',
      model: 'glm-test',
      said: '',
    }
    const pool = {
      query: async (sql: string) => {
        queries.push(String(sql))
        if (String(sql).includes('FROM queen_dispatch d'))
          return { rowCount: 1, rows: [row] }
        return { rowCount: 0, rows: [] }
      },
    } as unknown as Pool
    const ac = new AbortController()
    let heard: AbortSignal | undefined
    const deps: Partial<ReviewDeps> = {
      committedFilesResult: async () => ({ ok: true, files: ['src/a.ts'] }),
      branchHeadSha: async () => 'a'.repeat(40),
      mergeBaseSha: async () => 'b'.repeat(40),
      branchPatch: async () => 'diff --git a/src/a.ts b/src/a.ts\n+x',
      worktreeDirtCount: async () => null,
      witness: async () => ({ kind: 'witnessed', t27c: 'fake', specs: [] }),
      laneCandidates: () => [LANE],
      reviewsPerRound: () => 3,
      // a client that reports the abort as a plain failure: were the sweep
      // to go on, it would back the lane off and write a verdict
      llm: (_lane, _system, _message, signal) =>
        new Promise((resolve) => {
          heard = signal
          signal?.addEventListener('abort', () =>
            resolve({ ok: false, error: 'socket closed', transient: false }),
          )
          queueMicrotask(() => ac.abort(stopReason()))
        }),
    }
    await expect(
      reviewFinishedDispatches(pool, deps, {
        issues: [ISSUE],
        signal: ac.signal,
      }),
    ).rejects.toThrow('aborted')
    expect(heard).toBe(ac.signal)
    expect(queries.some((q) => q.includes('review_state = $2'))).toBe(false)
    expect(queries.some((q) => q.includes('SET reviewer_fingerprint'))).toBe(
      false,
    )
    expect(reviewerLaneBackedOff(LANE)).toBe(false)
  })
})

describe('a reviewer whose reviews stall (virtual clock)', () => {
  const judged = () => ({ acted: [], strays: [], tally: [] })

  /**
   * 24 rows on 4 workers. A row's first attempt stalls when issue % 6 is 0
   * (a step that never hears its abort, 2 h) or 3 (a model call that hangs to
   * its own timeout and hears the abort). Every other attempt takes 60 s.
   */
  async function run(turnStop: boolean) {
    const clock = new VirtualClock()
    const sys = createActorSystem(clock, { turnStop })
    const waiting = new Set(Array.from({ length: 24 }, (_, i) => i + 1))
    const attempts = new Map<number, number>()
    let live = 0
    let most = 0
    const r = reviewerTree(sys, {
      holdsLease: async () => true,
      waiting: async () => [...waiting],
      reviewOne: async (issue, _keys, onLane, signal) => {
        const n = (attempts.get(issue) ?? 0) + 1
        attempts.set(issue, n)
        const deaf = issue % 6 === 0 && n === 1
        const hears = issue % 6 === 3 && n === 1
        live++
        most = Math.max(most, live)
        try {
          onLane(issue)
          await new Promise<void>((resolve, reject) => {
            const ms = deaf
              ? 2 * HOUR
              : hears
                ? (REVIEW_ROW_SECONDS + 120) * 1000
                : 60_000
            clock.after(ms, resolve)
            if (!deaf)
              signal?.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              })
          })
          if (!deaf && !hears) waiting.delete(issue)
          return judged()
        } finally {
          live--
        }
      },
    })
    r.tree.start(() => {})
    r.wake()
    await clock.runUntil(4 * HOUR)
    return { most, left: waiting.size, killed: sys.stats.killed }
  }

  it('with turnStop never runs more than REVIEWER_CONCURRENCY reviews at once, stalled ones included', async () => {
    const after = await run(true)
    const before = await run(false)
    console.log(
      `\n## stalled reviews on ${REVIEWER_CONCURRENCY} workers: most at once ${before.most} without turnStop, ${after.most} with it`,
    )
    expect(after.killed).toBeGreaterThan(0)
    expect(after.most).toBeLessThanOrEqual(REVIEWER_CONCURRENCY)
    expect(after.left).toBe(0)
    // the control: the same input without turnStop goes past the bound
    expect(before.most).toBeGreaterThan(REVIEWER_CONCURRENCY)
    expect(before.left).toBe(0)
  }, 60_000)
})
