/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A virtual clock for the actor tests and the benchmark (t27#7851). Timers
 * fire in time order. Between two timers every pending promise settles, and
 * every callback already queued for the loop runs (`settle`). So hours of
 * Queen time run in milliseconds, and two runs over the same input see the
 * same order.
 */

import type { Clock } from '../../src/api/services/queen-actors'

interface Timer {
  at: number
  seq: number
  fn: () => void
  dead: boolean
}

/**
 * TWO TURNS OF THE LOOP, NOT ONE. The runtime ends a slice on setImmediate
 * (queen-actors.ts turnStarted). With one turn here, a slice opened by the
 * turns a settle let run was still open when the next timer fired, because
 * its closing callback was queued after the settle's own: the slice then
 * spanned a jump of virtual time. On a busy host its real microseconds could
 * pass SLICE_MICROS, the next turn waited for setImmediate, and runUntil
 * moved on without it: 'a process takes its messages in order' saw [1]
 * instead of [1, 2, 3] in 16 runs of 30 at a load average of 9-10
 * (gHashTag/trios#1729 item 8). A second turn runs every callback queued
 * before the first, as a real host does before a later timer is due.
 */
const settle = () =>
  new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)))

export class VirtualClock implements Clock {
  private t = 0
  private seq = 0
  private q: Timer[] = []

  now = (): number => this.t

  after = (ms: number, fn: () => void): (() => void) => {
    const timer: Timer = {
      at: this.t + Math.max(0, ms),
      seq: this.seq++,
      fn,
      dead: false,
    }
    let lo = 0
    let hi = this.q.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const m = this.q[mid]
      if (m.at < timer.at || (m.at === timer.at && m.seq < timer.seq))
        lo = mid + 1
      else hi = mid
    }
    this.q.splice(lo, 0, timer)
    return () => {
      timer.dead = true
    }
  }

  /** Run every timer due up to `end`, settling promises after each. */
  async runUntil(end: number): Promise<void> {
    await settle()
    while (this.q.length > 0 && this.q[0].at <= end) {
      const timer = this.q.shift() as Timer
      if (timer.dead) continue
      this.t = timer.at
      timer.fn()
      await settle()
    }
    this.t = end
    await settle()
  }
}

/**
 * A virtual clock whose timers fire 1 ms before their time, as the host's do:
 * Bun's setTimeout(fn, 3000) can run when Date.now() says 2997-2999 ms have
 * passed (trios#1766, 27 of 100 grace timers in one run under a CPU burner).
 * A 1 ms timer still waits its 1 ms, so time always moves on.
 */
export class EarlyClock extends VirtualClock {
  constructor() {
    super()
    const on = this.after
    this.after = (ms, fn) => on(ms > 1 ? ms - 1 : ms, fn)
  }
}
