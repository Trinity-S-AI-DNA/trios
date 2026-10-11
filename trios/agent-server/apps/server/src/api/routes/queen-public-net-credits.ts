/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * GET /queen/public-net-credits?since=<ISO time>&limit=<n> - the test credits
 * the network job earned (gHashTag/t27 specs/jobs/network_job.t27,
 * queen-network-job.ts), PENDING until the challenge window passes and FINAL
 * after, oldest change first. Each row is a hosting/statement.t27 leaf's
 * fields (host key id, kind, mtri, receipt ids) plus how it was judged: the
 * ledger outcome and the quorum (verdict, independent votes, keys, N, F, M).
 * Everything here is already public: commits, key ids and the labs' receipt
 * URLs. Where the hosting ledger is on (TRIOS_HOSTING), a credited row names
 * its line there (`ledger`: epoch, job, proof path), so this route reads the
 * one ledger rather than keeping its own. Test credits are not money and are
 * not transferable.
 */

import { Hono } from 'hono'
import type { Pool } from 'pg'
import { createQueenPool } from '../../lib/db/queen-pool'
import { logger } from '../../lib/logger'
import { queenLeaseDatabaseUrl } from '../services/queen-lease'
import {
  type CreditRow,
  creditsSince,
  ensureNetworkTables,
} from '../services/queen-network-job'

let sharedPool: Pool | null = null
const defaultPool = (): Pool | null => {
  const url = queenLeaseDatabaseUrl()
  if (!url) return null
  sharedPool ??= createQueenPool(url)
  return sharedPool
}

const shown = (r: CreditRow) => ({
  job_sha: r.job_sha,
  host: r.host,
  kind: r.kind,
  mtri: Number(r.mtri),
  receipts: r.receipts,
  outcome: r.outcome,
  state: r.state,
  quorum: r.quorum,
  test: r.test,
  settled_at: r.settled_at,
  final_at: r.final_at,
  updated_at: r.updated_at,
  // the hosting ledger's line (trios#1761); its proof answers once the epoch is closed and signed
  ledger: r.ledger
    ? {
        ...r.ledger,
        proof: `/hosting/ledger/epochs/${r.ledger.epoch}/proof?key=${r.host}`,
      }
    : null,
})

export function createQueenPublicNetCreditsRoute(
  pool: () => Pool | null = defaultPool,
) {
  return new Hono().get('/', async (c) => {
    const p = pool()
    if (!p) return c.json({ error: 'No database configured' }, 503)
    const raw = c.req.query('since')
    const since = raw ? new Date(raw) : new Date(0)
    if (Number.isNaN(since.getTime()))
      return c.json({ error: 'since is not a time' }, 400)
    const limit = Math.min(
      500,
      Math.max(1, Number(c.req.query('limit') ?? 100) || 100),
    )
    try {
      await ensureNetworkTables(p)
      const rows = await creditsSince(p, since, limit)
      return c.json(
        {
          credits: rows.map(shown),
          test_credits_only: true,
          note: 'test credits, not money; one operator holds every registered key, so each job is one independent vote',
        },
        200,
        { 'Cache-Control': 'public, max-age=30' },
      )
    } catch (error) {
      logger.warn('Queen network credits could not be read', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: 'The network credits are unavailable' }, 503)
    }
  })
}
