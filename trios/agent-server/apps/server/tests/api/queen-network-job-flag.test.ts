/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE NETWORK JOB IS OFF UNLESS TRIOS_QUEEN_NETWORK_JOBS=on (gHashTag/trios
 * #1773). Both start paths refuse the card while the flag is off, a rehearsal
 * included: POST /queen/jobs and an owner's `queen-job` issue. No row is
 * written, so the card's one slot is never held by a job that cannot run.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Pool } from 'pg'
import { createQueenJobsRoute } from '../../src/api/routes/queen-jobs'
import { startJobsFromIssues } from '../../src/api/services/queen-jobs'

const SHA = 'eb88ff84a0b26d77fe8a9df216d2abe1af8a5f45'

/** A pool that records every statement and answers with no rows. */
const recordingPool = () => {
  const sql: string[] = []
  const pool = {
    query: async (text: string) => {
      sql.push(text)
      return { rowCount: 0, rows: [] }
    },
  } as unknown as Pool
  return { pool, sql }
}

describe('with TRIOS_QUEEN_NETWORK_JOBS off', () => {
  const previous = process.env.TRIOS_QUEEN_NETWORK_JOBS
  beforeEach(() => {
    delete process.env.TRIOS_QUEEN_NETWORK_JOBS
  })
  afterEach(() => {
    if (previous === undefined) delete process.env.TRIOS_QUEEN_NETWORK_JOBS
    else process.env.TRIOS_QUEEN_NETWORK_JOBS = previous
  })

  it('POST /queen/jobs refuses the network-job card, a rehearsal too, and writes nothing', async () => {
    const { pool, sql } = recordingPool()
    let published = 0
    const app = createQueenJobsRoute({
      pool: () => pool,
      ensureTables: async () => undefined,
      publishEvent: async () => {
        published += 1
        return 0
      },
    })
    for (const rehearsal of [false, true]) {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card: 'network-job',
          params: { sha: SHA },
          rehearsal,
        }),
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('TRIOS_QUEEN_NETWORK_JOBS')
    }
    expect(sql.filter((s) => s.includes('INSERT'))).toEqual([])
    expect(published).toBe(0)
  })

  it('an owner-authored queen-job issue, mode publish or not, starts no network job', async () => {
    const { pool, sql } = recordingPool()
    const issue = (number: number, mode: string) => ({
      number,
      author: 'gHashTag',
      labels: ['queen-job'],
      body: `## Job\ncard: network-job\nsha: ${SHA}\n${mode}`,
    })
    const started = await startJobsFromIssues(
      pool,
      [issue(1, 'mode: publish'), issue(2, '')],
      'gHashTag',
    )
    expect(started).toEqual([])
    expect(sql.filter((s) => s.includes('INSERT'))).toEqual([])
  })

  it('the flag on lets the request reach the card', async () => {
    process.env.TRIOS_QUEEN_NETWORK_JOBS = 'on'
    const { pool, sql } = recordingPool()
    const started = await startJobsFromIssues(
      pool,
      [
        {
          number: 3,
          author: 'gHashTag',
          labels: ['queen-job'],
          body: `## Job\ncard: network-job\nsha: ${SHA}\n`,
        },
      ],
      'gHashTag',
    )
    // the recording pool answers the INSERT with no row, so nothing starts, but the card was reached
    expect(started).toEqual([])
    expect(sql.some((s) => s.includes('INSERT INTO queen_job'))).toBe(true)
  })
})
