/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The PostgreSQL agent store, held against its contract
 * (gHashTag/trios#1658): the single export of
 * pg-agent-store.ts - PgAgentStore - pinned as it behaves today,
 * so the next change to that file has something to fail against.
 *
 * The store answers "PgAgentStore not connected" before connect();
 * connect() builds exactly one pool for its DSN (a second connect
 * is a no-op) and disconnect() ends it. Every method goes through
 * the pool with the pinned statement shapes: upsertAgent sends the
 * INSERT ... ON CONFLICT (id) DO UPDATE with the card fields and
 * the JSON metadata; heartbeat answers whether a row was touched;
 * markOffline and removeAgent send their UPDATE/DELETE;
 * listAgents maps rows back to cards with the online filter in the
 * WHERE clause (measured); listMatrix reads the view;
 * pruneOffline returns the ids it took offline.
 *
 * The pool seam is a mock.module stand-in for createQueenPool - a
 * complete recording fake of the pool interface the store uses
 * (query, end, on), snapshotted-and-restored around this file with
 * the repo's proven queen-roadmap pattern (the real module copied
 * before the mock, re-installed in afterAll; measured: without the
 * restore the shared CI process shows 55 failures in the later
 * queen, task-queue and vault suites). No database, no network, no
 * container.
 */

import { afterAll, describe, expect, it, mock } from 'bun:test'

interface PoolCall {
  sql: string
  params?: unknown[]
}

interface PoolRecord {
  dsn: string
  calls: PoolCall[]
  ended: boolean
  onHandlers: Array<{ event: string }>
}

const pools: PoolRecord[] = []
let nextResult: {
  rows: Array<Record<string, unknown>>
  rowCount: number
} = { rows: [], rowCount: 0 }

// The real module, snapshotted before the mock and put back by hand in
// afterAll - the repo's proven pattern from queen-roadmap.test.ts: bun's
// mock.restore() does not undo mock.module, and the import namespace is
// live, so only a plain-object copy taken before the mock survives.
// Without the restore, every later file in this job's shared process
// (the queen roadmap contract, the task-queue pool contract, the vault
// suites) would hold this fake - measured: 55 failures without it.
const realQueenPool = {
  ...(await import('../../src/lib/db/queen-pool')),
} as typeof import('../../src/lib/db/queen-pool')

mock.module('../../src/lib/db/queen-pool', () => ({
  ...realQueenPool,
  createQueenPool: (dsn: string, config?: unknown) => {
    void config
    const record: PoolRecord = {
      dsn,
      calls: [],
      ended: false,
      onHandlers: [],
    }
    pools.push(record)
    return {
      query: async (sql: string, params?: unknown[]) => {
        record.calls.push({ sql, params })
        return nextResult
      },
      end: async () => {
        record.ended = true
      },
      on: (event: string) => {
        record.onHandlers.push({ event })
      },
    }
  },
}))

afterAll(() => {
  mock.module('../../src/lib/db/queen-pool', () => ({ ...realQueenPool }))
})

const { PgAgentStore } = await import(
  '../../src/api/services/a2a/pg-agent-store'
)

const theCard = {
  id: 'agent-1',
  name: 'Worker',
  capabilities: ['code', 'review'],
  description: 'The worker agent',
  version: '1.2.0',
  endpoint: 'https://worker.example/agent',
}

const rowOf = (overrides: Record<string, unknown> = {}) => ({
  id: 'agent-1',
  name: 'Worker',
  capabilities: ['code'],
  status: 'online',
  metadata: {
    description: 'd',
    version: '2',
    endpoint: 'e',
  },
  last_heartbeat: new Date(),
  created_at: new Date(),
  updated_at: new Date(),
  ...overrides,
})

describe('PgAgentStore - connection lifecycle', () => {
  it('refuses queries before connect and builds exactly one pool', async () => {
    const store = new PgAgentStore('postgres://example.invalid/db')
    let caught: unknown
    try {
      await store.listAgents()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('PgAgentStore not connected')

    await store.connect()
    await store.connect()
    expect(pools.length).toBe(1)
    expect(pools[0].dsn).toBe('postgres://example.invalid/db')
  })

  it('disconnect ends the pool and further queries are refused', async () => {
    const store = new PgAgentStore('postgres://example.invalid/db')
    await store.connect()
    await store.disconnect()
    expect(pools[pools.length - 1].ended).toBe(true)
    let caught: unknown
    try {
      await store.listAgents()
    } catch (e) {
      caught = e
    }
    expect((caught as Error).message).toBe('PgAgentStore not connected')
  })
})

describe('PgAgentStore - statements', () => {
  it('upserts a card with ON CONFLICT (id) and the JSON metadata', async () => {
    const store = new PgAgentStore('postgres://example.invalid/db')
    await store.connect()
    const pool = pools[pools.length - 1]
    await store.upsertAgent(theCard)
    const call = pool.calls.find((c) => c.sql.includes('ON CONFLICT (id)'))
    expect(call).toBeDefined()
    expect(call?.params).toEqual([
      'agent-1',
      'Worker',
      ['code', 'review'],
      'online',
      JSON.stringify({
        description: 'The worker agent',
        version: '1.2.0',
        endpoint: 'https://worker.example/agent',
      }),
    ])
  })

  it('answers heartbeat by whether a row was touched', async () => {
    const store = new PgAgentStore('postgres://example.invalid/db')
    await store.connect()
    const pool = pools[pools.length - 1]

    nextResult = { rows: [], rowCount: 1 }
    expect(await store.heartbeat('agent-1')).toBe(true)
    const beat = pool.calls.find((c) =>
      c.sql.includes('UPDATE agents SET last_heartbeat'),
    )
    expect(beat?.params).toEqual(['agent-1'])

    nextResult = { rows: [], rowCount: 0 }
    expect(await store.heartbeat('ghost')).toBe(false)
  })

  it('sends the offline update and the delete for an agent id', async () => {
    const store = new PgAgentStore('postgres://example.invalid/db')
    await store.connect()
    const pool = pools[pools.length - 1]
    await store.markOffline('agent-1')
    await store.removeAgent('agent-1')
    const offline = pool.calls.find((c) =>
      c.sql.includes("SET status = 'offline'"),
    )
    const removed = pool.calls.find((c) => c.sql.includes('DELETE FROM agents'))
    expect(offline?.params).toEqual(['agent-1'])
    expect(removed?.params).toEqual(['agent-1'])
  })

  it('maps rows back to cards and filters online only in the WHERE clause', async () => {
    const store = new PgAgentStore('postgres://example.invalid/db')
    await store.connect()
    const pool = pools[pools.length - 1]

    nextResult = { rows: [rowOf()], rowCount: 1 }
    const cards = await store.listAgents()
    expect(cards).toEqual([
      {
        id: 'agent-1',
        name: 'Worker',
        capabilities: ['code'],
        description: 'd',
        version: '2',
        endpoint: 'e',
      },
    ])
    // Measured: the online filter lives in the SQL WHERE clause.
    expect(pool.calls[pool.calls.length - 1].sql).toContain(
      "WHERE status = 'online'",
    )

    const all = await store.listAgents(false)
    expect(all.length).toBe(1)
    expect(pool.calls[pool.calls.length - 1].sql).not.toContain('WHERE')
  })

  it('reads the matrix view and answers the pruned ids', async () => {
    const store = new PgAgentStore('postgres://example.invalid/db')
    await store.connect()
    const pool = pools[pools.length - 1]

    nextResult = {
      rows: [rowOf({ seconds_since_heartbeat: 100 })],
      rowCount: 1,
    }
    const matrix = await store.listMatrix()
    expect(matrix.length).toBe(1)
    expect(pool.calls[pool.calls.length - 1].sql).toContain('agent_matrix')

    nextResult = { rows: [{ id: 'stale-1' }, { id: 'stale-2' }], rowCount: 2 }
    const pruned = await store.pruneOffline(90)
    expect(pruned).toEqual(['stale-1', 'stale-2'])
    const pruneCall = pool.calls[pool.calls.length - 1]
    expect(pruneCall.sql).toContain("SET status = 'offline'")
    expect(pruneCall.sql).toContain('INTERVAL')
    expect(pruneCall.sql).toContain('90')
  })
})
