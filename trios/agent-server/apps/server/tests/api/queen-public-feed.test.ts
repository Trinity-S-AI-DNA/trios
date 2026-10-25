/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * GET /queen/public-feed (gHashTag/t27#12146): the same public projection
 * /queen/public-actors serves, re-shaped for the t27f live page. What is
 * pinned here:
 *   - the format string and the seed contract: with the flag off (the
 *     default) or the bus empty, the answer is the card's stand-in trace
 *     with "seed": true; one real bus event and the seed is gone;
 *   - the shape of one event: kind (the bare word the replay engine draws),
 *     tick (seq - 1), task, spec, ts - and never a message or a title;
 *   - the at-most-200 bound and the no-store header.
 */

import { describe, expect, it } from 'bun:test'

import {
  createQueenPublicFeedRoute,
  T27F_FEED_MAX,
  t27fEvent,
} from '../../src/api/routes/queen-public-feed'
import {
  type ActorRow,
  replayRows,
  replaySource,
} from '../../src/api/services/queen-actor-events'
import { pidOf } from '../../src/api/services/queen-actors'
import { EV_ACTOR_SPAWN, EV_ACTOR_DELIVER } from '../../src/api/services/queen-events.gen'

const ask = async (
  path: string,
  env: NodeJS.ProcessEnv,
  rows: ActorRow[] | null = null,
) => {
  const app = createQueenPublicFeedRoute({
    env,
    // A null rows means "no source injected": the flag-off path, which must
    // not touch any pool. An empty array is a bus that is on but empty.
    ...(rows === null ? {} : { source: () => replaySource(rows) }),
  })
  const res = await app.request(path)
  return {
    status: res.status,
    cacheControl: res.headers.get('cache-control'),
    body: (await res.json()) as Record<string, unknown>,
  }
}

describe('GET /queen/public-feed', () => {
  it('seeds from the card stand-in trace with the flag off, and says so', async () => {
    const r = await ask('/?since=0', {})
    expect(r.status).toBe(200)
    expect(r.cacheControl).toBe('no-store')
    expect(r.body.format).toBe('t27f-queen-feed-v1')
    expect(r.body.seed).toBe(true)
    const events = r.body.events as Array<Record<string, unknown>>
    // the card's REPLAY_* columns, which the t27f fixture's first events pin
    expect(events.length).toBeGreaterThan(0)
    expect(events.length).toBeLessThanOrEqual(T27F_FEED_MAX)
    expect(events[0]).toMatchObject({ seq: 1, kind: 'spawn', tick: 0 })
  })

  it('seeds too when the bus is on but still empty', async () => {
    const r = await ask('/?since=0', { TRIOS_QUEEN_ACTOR_EVENTS: 'on' }, [])
    expect(r.status).toBe(200)
    expect(r.body.seed).toBe(true)
    expect((r.body.events as unknown[]).length).toBeGreaterThan(0)
  })

  it('serves the bus, not the seed, once the bus holds one event', async () => {
    const rows: ActorRow[] = [
      {
        seq: 7,
        kind: EV_ACTOR_SPAWN,
        payload: { at_ms: 1_761_000_000_000, actor: 'reviewer' },
        at: '',
      },
      {
        seq: 8,
        kind: EV_ACTOR_DELIVER,
        payload: {
          at_ms: 1_761_000_001_000,
          task_kind: 0,
          task_repo: 'gHashTag/t27',
          task_number: 12146,
          msg_seq: 1,
          depth: 1,
          dropped: 0,
          title: 'not public',
        },
        at: '',
      },
    ]
    // A cursor older than the bus keeps answers resync + where reading
    // resumes (events.t27 cursor_read); the page then asks again from there.
    const behind = await ask('/?since=0', { TRIOS_QUEEN_ACTOR_EVENTS: 'on' }, rows)
    expect(behind.status).toBe(200)
    expect(behind.body.seed).toBe(false)
    expect(behind.body.resync).toBe(true)
    expect(behind.body.cursor).toBe(6)
    expect(behind.body.events).toEqual([])

    const r = await ask('/?since=6', { TRIOS_QUEEN_ACTOR_EVENTS: 'on' }, rows)
    expect(r.status).toBe(200)
    expect(r.body.seed).toBe(false)
    expect(r.body.cursor).toBe(8)
    const events = r.body.events as Array<Record<string, unknown>>
    expect(events.map((e) => e.kind)).toEqual(['spawn', 'deliver'])
    expect(events[0]).toMatchObject({
      seq: 7,
      tick: 6,
      spec: 'reviewer',
      ts: new Date(1_761_000_000_000).toISOString(),
    })
    expect(events[1]).toMatchObject({ seq: 8, tick: 7, task: 12146 })
    // never a payload, never a title (FR-004)
    expect(JSON.stringify(r.body)).not.toContain('not public')
  })

  it('maps an unknown kind to the one kind the page can always draw', () => {
    const e = t27fEvent({
      seq: 3,
      name: 'actor.nonsense',
      at: '2026-10-25T00:00:00.000Z',
      task_ref: null,
    })
    expect(e.kind).toBe('deliver')
    expect(e.tick).toBe(2)
    expect(e.task).toBeNull()
    expect(e.spec).toBeNull()
  })

  it('caps the answer at the contract bound even if the page size regresses', async () => {
    const many: ActorRow[] = Array.from({ length: 500 }, (_, i) => ({
      seq: i + 1,
      kind: EV_ACTOR_DELIVER,
      payload: { at_ms: 1_761_000_000_000 + i },
      at: '',
    }))
    const r = await ask('/?since=0&limit=500', { TRIOS_QUEEN_ACTOR_EVENTS: 'on' }, many)
    expect(r.status).toBe(200)
    expect((r.body.events as unknown[]).length).toBeLessThanOrEqual(
      T27F_FEED_MAX,
    )
  })

  it('answers 503 when the bus throws', async () => {
    const app = createQueenPublicFeedRoute({
      env: { TRIOS_QUEEN_ACTOR_EVENTS: 'on' },
      source: () => ({
        bounds: async () => {
          throw new Error('store down')
        },
        after: async () => [],
      }),
    })
    const res = await app.request('/?since=0')
    expect(res.status).toBe(503)
  })

  it('replay seed rows carry the same kinds the page draws', async () => {
    const rows = replayRows(pidOf)
    const kinds = new Set(rows.map((r) => r.kind))
    // the seed comes from the card, and the card holds actor kinds only
    expect(kinds.has(EV_ACTOR_SPAWN)).toBe(true)
    expect(kinds.has(EV_ACTOR_DELIVER)).toBe(true)
  })
})
