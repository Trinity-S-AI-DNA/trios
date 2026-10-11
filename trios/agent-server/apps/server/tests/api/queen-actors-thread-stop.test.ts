/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A THREAD TURN STOPPED AT ITS START (gHashTag/trios#1865). Bun 1.3.6, the
 * version CI and the production image pin, crashes the whole process when a
 * worker is terminated while its modules are still being transpiled: a
 * transpiler job writes into the source map table of the worker that is gone
 * (SavedSourceMap.putValue, the same crash as the PgLink beat thread,
 * gHashTag/trios#1813). A thread turn loads two modules before its call runs,
 * its entry and its work. Every cycle here stops a turn 0-30 ms after its
 * start, inside that window or just past it; every terminate must come after
 * the thread said it loaded, and each thread is terminated exactly once.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { createActorSystem } from '../../src/api/services/queen-actors'
import { X_KILLED } from '../../src/api/services/queen-actors-card.gen'
import { threadWork } from '../../src/api/services/queen-actors-isolate'

const CPU = new URL('./fixtures/queen-cpu-work.ts', import.meta.url).href
const CYCLES = 200
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const Real = globalThis.Worker
afterEach(() => {
  globalThis.Worker = Real
})

/**
 * Wraps Worker: for each thread, whether it had loaded when each terminate
 * came. A thread has loaded once it says so, or once it posts a result, which
 * it can only do after its work module is in.
 */
function watchWorkers() {
  const threads: Array<{ loaded: boolean; ends: boolean[]; closed: boolean }> =
    []
  class Watched extends Real {
    private seen = { loaded: false, ends: [] as boolean[], closed: false }
    constructor(...args: ConstructorParameters<typeof Worker>) {
      super(...args)
      threads.push(this.seen)
      this.addEventListener('message', (event: MessageEvent) => {
        const m = event.data as { loaded?: boolean; ok?: boolean }
        if (m.loaded || m.ok !== undefined) this.seen.loaded = true
      })
      this.addEventListener('close', () => {
        this.seen.closed = true
      })
    }
    override terminate(): void {
      this.seen.ends.push(this.seen.loaded)
      super.terminate()
    }
  }
  globalThis.Worker = Watched
  // every thread terminated and gone, so none outlives this file: the stops
  // of threads still loading land later
  const allEnded = async () => {
    while (threads.some((t) => t.ends.length === 0 || !t.closed))
      await sleep(10)
  }
  // threads terminated before they loaded, and threads terminated twice
  const ends = () => ({
    threads: threads.length,
    beforeLoad: threads.filter((t) => t.ends.includes(false)).length,
    twice: threads.filter((t) => t.ends.length > 1).length,
  })
  return { allEnded, ends }
}

describe('a thread turn stopped as soon as it starts', () => {
  it('is terminated once, and only after its thread has loaded', async () => {
    const { allEnded, ends } = watchWorkers()
    for (let i = 0; i < CYCLES; i++) {
      const work = threadWork(CPU, 'burn', 1)
      work.result.catch(() => undefined)
      await sleep(Math.random() * 30)
      work.stop()
      // a second stop, as a fence after a kill would, ends nothing twice
      work.stop()
    }
    await allEnded()
    expect(ends()).toEqual({ threads: CYCLES, beforeLoad: 0, twice: 0 })
  }, 60_000)

  it('killed by its pid with turn stop on, is never terminated before its thread has loaded', async () => {
    // kill_effect(ISO_THREAD) is KILL_ABANDONS, so the escalation abandons the
    // work and the thread ends when its call does; this pins that no path of
    // the runtime terminates it while it loads
    const { allEnded, ends } = watchWorkers()
    const sys = createActorSystem(undefined, { turnStop: true })
    for (let i = 0; i < CYCLES; i++) {
      const pid = sys.spawn<number>({
        name: `thread-${i}`,
        isolated: {
          cpuBound: true,
          foreignCode: false,
          start: (ms) => threadWork(CPU, 'burn', ms),
        },
        receive: () => {},
      })
      sys.send(pid, 1)
      await sleep(Math.random() * 30)
      sys.exit(pid, X_KILLED)
    }
    await allEnded()
    expect(ends()).toEqual({ threads: CYCLES, beforeLoad: 0, twice: 0 })
  }, 60_000)
})
