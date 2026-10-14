/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * gHashTag/trios#2005: a claim that cannot start (a blocked resource) must not
 * be asked again through the immediate scheduler - that spun the runner on one
 * refusal. The loop is driven for real (createTaker, the card's
 * claims_again_at_once through the wasm); only the claim and the scheduler are
 * fakes. The card's wasm must be built (see docs/worktree-keep-card.md).
 */

import { describe, expect, it } from 'bun:test'
import type { Pool } from 'pg'
import {
  type BeeOrder,
  createTaker,
  markNotStarted,
  runOneOrder,
} from '../../src/api/services/queen-runner'

const order = (issue: number): BeeOrder => ({
  issue,
  branch: `queen-${issue}`,
  brief: '',
  ownedPaths: [],
  conversationId: `c${issue}`,
  keyIndex: 0,
})

/** Lets every pending promise callback run. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** A scheduler that holds what was scheduled, to be run by the test. */
function scheduler() {
  const queue: Array<() => void> = []
  return {
    schedule: (next: () => void) => queue.push(next),
    pending: () => queue.length,
    run: async () => {
      const batch = queue.splice(0)
      for (const next of batch) next()
      await settle()
    },
  }
}

describe('createTaker', () => {
  it('does not claim again at once when the order could not start', async () => {
    const room = { open: false }
    let calls = 0
    const sched = scheduler()
    const taker = createTaker({
      slots: 1,
      runOne: async () => {
        calls++
        const o = order(calls)
        if (!room.open) markNotStarted(o)
        return o
      },
      schedule: sched.schedule,
      stopped: () => false,
      onError: () => {},
    })
    taker.take()
    await settle()
    expect(calls).toBe(1)
    expect(sched.pending()).toBe(0)
    expect(taker.busy()).toBe(0)

    // the poll timer wakes the blocked runner; still blocked: still one claim
    taker.take()
    await settle()
    expect(calls).toBe(2)
    expect(sched.pending()).toBe(0)

    // the resource recovers; the next poll starts a bee and it asks again
    room.open = true
    taker.take()
    await settle()
    expect(calls).toBe(3)
    expect(sched.pending()).toBe(1)
  })

  it('lets a healthy runner progress while a blocked one waits, and recover', async () => {
    const room = { open: false }
    const sched = scheduler()
    let blockedCalls = 0
    let healthyCalls = 0
    const blocked = createTaker({
      slots: 1,
      runOne: async () => {
        blockedCalls++
        const o = order(100 + blockedCalls)
        if (!room.open) markNotStarted(o)
        return o
      },
      schedule: sched.schedule,
      stopped: () => false,
      onError: () => {},
    })
    const healthy = createTaker({
      slots: 1,
      runOne: async () => {
        healthyCalls++
        return healthyCalls <= 3 ? order(healthyCalls) : null
      },
      schedule: sched.schedule,
      stopped: () => false,
      onError: () => {},
    })
    blocked.take()
    healthy.take()
    await settle()
    for (let i = 0; i < 5; i++) await sched.run()
    expect(healthyCalls).toBe(4) // three orders, then the queue is empty
    expect(blockedCalls).toBe(1) // no spin

    room.open = true
    blocked.take() // its poll timer
    await settle()
    expect(blockedCalls).toBe(2)
    expect(sched.pending()).toBe(1) // started: it asks again at once
  })

  it('two runners over one queue: blocked cools down, healthy progresses, blocked recovers', async () => {
    // The real wiring: createTaker -> runOneOrder -> claimQueuedBee (its SQL
    // text, over a fake pool that behaves like the queue) -> the card. Only
    // the room (runClaimed) is faked: a blocked runner "gives back" the order
    // as the Queen's next round re-dispatches it.
    const queue: number[] = [1, 2, 3, 4]
    const claims: Record<string, number> = { blocked: 0, healthy: 0 }
    const started: Record<string, number[]> = { blocked: [], healthy: [] }
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        if (String(sql).includes('SET claimed_by = $1')) {
          const who = String(params[0])
          claims[who] = (claims[who] ?? 0) + 1
          const issue = queue.shift()
          if (issue === undefined) return { rows: [] }
          return {
            rows: [
              {
                issue,
                branch: `queen-${issue}`,
                brief: '',
                owned_paths: [],
                conversation_id: `c${issue}`,
                key_index: 0,
                domain: null,
              },
            ],
          }
        }
        return { rows: [] } // leases, ending renewals: nothing matches
      },
    } as unknown as Pool
    const room = { open: false }
    const runner = (name: string, hasRoom: () => boolean) => {
      const deps = {
        endingEveryMs: 1,
        runClaimed: (async (_pool: Pool, claimed: BeeOrder) => {
          if (!hasRoom()) {
            queue.push(claimed.issue) // given back, re-dispatched later
            return { started: false, issue: claimed.issue } as never
          }
          started[name]?.push(claimed.issue)
          return { started: true, issue: claimed.issue } as never
        }) as never,
      }
      return createTaker({
        slots: 1,
        runOne: () => runOneOrder(pool, name, deps),
        schedule: (next) => setImmediate(next),
        stopped: () => false,
        onError: (error) => {
          throw error
        },
      })
    }
    const blocked = runner('blocked', () => room.open)
    const healthy = runner('healthy', () => true)
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 400 && !done(); i++)
        await new Promise((r) => setTimeout(r, 5))
      expect(done()).toBe(true)
    }

    blocked.take()
    await until(() => claims.blocked === 1 && blocked.busy() === 0)
    await new Promise((r) => setTimeout(r, 50))
    expect(claims.blocked).toBe(1) // cooled down: no immediate re-claim

    healthy.take()
    await until(() => started.healthy?.length === 4 && healthy.busy() === 0)
    expect([...(started.healthy ?? [])].sort()).toEqual([1, 2, 3, 4])
    expect(claims.blocked).toBe(1) // still waiting for its own poll

    room.open = true
    queue.push(5)
    blocked.take() // the poll timer wakes it
    await until(
      () => started.blocked?.includes(5) === true && blocked.busy() === 0,
    )
    expect(started.blocked).toEqual([5])
  })

  it('claims nothing once stopped', async () => {
    let calls = 0
    const taker = createTaker({
      slots: 2,
      runOne: async () => {
        calls++
        return null
      },
      schedule: () => {},
      stopped: () => true,
      onError: () => {},
    })
    taker.take()
    await settle()
    expect(calls).toBe(0)
  })
})
