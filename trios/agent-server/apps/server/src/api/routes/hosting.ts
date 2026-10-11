/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Self-hosting, slice 1 (gHashTag/trios#1756): users' computers run shards of
 * the t27 corpus, the Queen believes a result when k hosts agree on it, and
 * the agreeing hosts are credited TRI off-chain.
 *
 *   POST /hosting/hosts             register: a public key, a tier claim, slots,
 *                                   signed with that key (proof of possession)
 *   POST /hosting/hosts/:id/beat    a signed beat (netlink's lease)
 *   POST /hosting/lease             a signed request for one replica of one job
 *   POST /hosting/receipts          a signed receipt (the receipt is its own signature)
 *   POST /hosting/jobs              a signed request from an owner-tier host: a new shard
 *   GET  /hosting/ledger            the public ledger: key ids, tiers, mTRI, strikes
 *   GET  /hosting/ledger/epochs     slice 1b: every closed epoch's signed statement
 *   GET  /hosting/ledger/epochs/:n/proof?key=<host key id>
 *                                   slice 1b: that statement, and the key's leaves
 *                                   with their RFC 6962 paths (statement.t27)
 *   GET  /hosting/verdicts          agreed shards in the t27b lab's row shape
 *   GET  /hosting/jobs/:id          one job, its leases and its verdict
 *
 * WHY NO TRUSTED-ORIGIN GUARD: a host is a process on someone's computer, with
 * no browser Origin. Every write is refused unless it verifies under the
 * Ed25519 key its host registered (or, for a registration, the key it
 * registers), within the freshness window, from the incarnation the Queen
 * holds; the reads hold no secret. Reasons in tools/route-guard-audit.mjs.
 *
 * Off unless TRIOS_HOSTING=on: every path answers 503 and touches nothing.
 * Slice 1b (trios#1761): TRIOS_HOSTING_SYBIL=on turns on sybil.t27's rules;
 * TRIOS_HOSTING_ATTESTED lists the key ids the owner marks attested; and
 * statement.t27 LEDGER_KEY_VARIABLE (TRIOS_HOSTING_LEDGER_KEY) holds the
 * Queen's Ed25519 ledger seed, 64 hex characters. Without it every epoch stays
 * open and unsigned, and one log line says so. Its value is never printed.
 */

import { Hono } from 'hono'
import type { Pool } from 'pg'
import { createQueenPool } from '../../lib/db/queen-pool'
import { logger } from '../../lib/logger'
import { epochsClose, ledgerKeyState } from '../services/hosting-cards'
import {
  createHostingQueen,
  type HostingEconomics,
  HostingError,
  type HostingQueen,
  LEDGER_KEY_WORDS,
  parseAllowlist,
} from '../services/hosting-queen'
import { createPgHostingStore, hostingOn } from '../services/hosting-store'
import { privatePemOfSeed, sha256Hex } from '../services/hosting-wire'
import {
  ORIGIN_V4_PREFIX_BITS,
  ORIGIN_V6_PREFIX_BITS,
} from '../services/queen-hosting-placement-card.gen'
import { LEDGER_KEY_VARIABLE } from '../services/queen-hosting-statement-card.gen'
import { queenLeaseDatabaseUrl } from '../services/queen-lease'

export interface HostingRouteDeps {
  enabled?: () => boolean
  queen?: () => HostingQueen | null
}

export function hostingEnabled(env = process.env): boolean {
  return hostingOn(env)
}

/**
 * Slice 1b's switches, from the environment (see the header). The ledger key
 * is judged by statement.t27 ledger_key_state; a key that is missing or
 * malformed is logged by its variable's name and state, never its value.
 */
export function hostingEconomicsOf(
  env = process.env,
  log: (line: string) => void = (line) => logger.warn(line),
): Partial<HostingEconomics> {
  const raw = env[LEDGER_KEY_VARIABLE]
  const seed = (raw ?? '').trim()
  const state = ledgerKeyState(
    raw !== undefined,
    seed.length,
    /^[0-9a-f]*$/.test(seed),
  )
  if (!epochsClose(state))
    log(
      `hosting: ${LEDGER_KEY_VARIABLE} is ${LEDGER_KEY_WORDS[state] ?? 'missing'}; every epoch stays open and unsigned`,
    )
  return {
    sybil: (env.TRIOS_HOSTING_SYBIL ?? 'off').trim().toLowerCase() === 'on',
    attested: new Set(
      (env.TRIOS_HOSTING_ATTESTED ?? '')
        .split(',')
        .map((k) => k.trim())
        .filter((k) => /^[0-9a-f]{16}$/.test(k)),
    ),
    ledgerKeyPem: epochsClose(state) ? privatePemOfSeed(seed) : null,
    ledgerKeyState: state,
  }
}

let sharedPool: Pool | null = null
let sharedQueen: HostingQueen | null = null

function defaultQueen(): HostingQueen | null {
  if (sharedQueen) return sharedQueen
  const url = queenLeaseDatabaseUrl()
  if (!url) return null
  sharedPool ??= createQueenPool(url)
  sharedQueen = createHostingQueen({
    store: createPgHostingStore(sharedPool),
    now: Date.now,
    allowlist: parseAllowlist(process.env.TRIOS_HOSTING_ALLOWLIST),
    economics: hostingEconomicsOf(),
  })
  return sharedQueen
}

/**
 * The process's one hosting Queen, the routes' own, for a source in this
 * process that records work in the same ledger (queen-network-job.ts, through
 * recordWork): one epoch closer per process, never a second instance over the
 * same store. null without a database.
 */
export function hostingQueen(): HostingQueen | null {
  return defaultQueen()
}

/**
 * The network a request came from, hashed: the last X-Forwarded-For entry
 * (the one the platform's proxy appended), cut to its prefix (placement.t27
 * ORIGIN_*_PREFIX_BITS). The address itself is personal data and never kept.
 */
export function originOf(forwarded: string | undefined): string {
  const last = (forwarded ?? '').split(',').pop()?.trim() ?? ''
  let prefix = 'unknown'
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(last)) {
    prefix = last
      .split('.')
      .slice(0, ORIGIN_V4_PREFIX_BITS / 8)
      .join('.')
  } else if (last.includes(':')) {
    const [head = '', tail = ''] = last.split('::')
    const left = head ? head.split(':') : []
    const right = tail ? tail.split(':') : []
    const groups = last.includes('::')
      ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
      : left
    prefix = groups
      .slice(0, ORIGIN_V6_PREFIX_BITS / 16)
      .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
      .join(':')
  }
  return sha256Hex(`trios-hosting-origin-v1\n${prefix}`).slice(0, 16)
}

export function createHostingRoute(deps: HostingRouteDeps = {}) {
  const enabled = deps.enabled ?? (() => hostingEnabled())
  const queenOf = deps.queen ?? defaultQueen

  const run = async (
    c: {
      json: (body: unknown, status?: number) => Response
    },
    fn: (queen: HostingQueen) => Promise<unknown>,
  ) => {
    if (!enabled()) return c.json({ error: 'hosting_off' }, 503)
    const queen = queenOf()
    if (!queen) return c.json({ error: 'hosting_no_store' }, 503)
    try {
      return c.json(await fn(queen))
    } catch (err) {
      if (err instanceof HostingError)
        return c.json({ error: err.code }, err.status)
      throw err
    }
  }

  return new Hono()
    .post('/hosts', async (c) => {
      const body = await c.req.json().catch(() => null)
      return run(c, (q) =>
        q.register(body, originOf(c.req.header('x-forwarded-for'))),
      )
    })
    .post('/hosts/:id/beat', async (c) => {
      const body = await c.req.text()
      return run(c, (q) =>
        q.beat(
          {
            method: 'POST',
            path: `/hosting/hosts/${c.req.param('id')}/beat`,
            header: (n) => c.req.header(n),
            body,
          },
          c.req.param('id'),
        ),
      )
    })
    .post('/lease', async (c) => {
      const body = await c.req.text()
      return run(c, (q) =>
        q.lease({
          method: 'POST',
          path: '/hosting/lease',
          header: (n) => c.req.header(n),
          body,
        }),
      )
    })
    .post('/receipts', async (c) => {
      const body = await c.req.json().catch(() => null)
      return run(c, (q) => q.receipt(body))
    })
    .post('/jobs', async (c) => {
      const body = await c.req.text()
      return run(c, (q) =>
        q.createJob({
          method: 'POST',
          path: '/hosting/jobs',
          header: (n) => c.req.header(n),
          body,
        }),
      )
    })
    .get('/ledger', (c) => run(c, (q) => q.ledger()))
    .get('/ledger/epochs', (c) => run(c, (q) => q.epochs()))
    .get('/ledger/epochs/:n/proof', (c) =>
      run(c, (q) => q.epochProof(c.req.param('n'), c.req.query('key'))),
    )
    .get('/verdicts', (c) =>
      run(c, (q) => q.verdicts(c.req.query('commit') || undefined)),
    )
    .get('/jobs/:id', (c) => run(c, (q) => q.job(c.req.param('id'))))
}
