import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import {
  createQueenContributorProxyRoute,
  proxyCapFits,
  proxyFlagOn,
  proxyMayOpen,
} from '../../src/api/routes/queen-contributor-proxy'
import {
  fingerprint,
  type KeyRow,
  sealCredential,
} from '../../src/api/services/queen-contributor-keys'
import { CONTRIBUTOR_POLICY as P } from '../../src/api/services/queen-contributor-policy'

const subject = 'telegram:111222333'
const stranger = 'telegram:999000111'
const token = 'test-proxy-capability-at-least-32-bytes'
// Fake values only: nothing here is a real credential.
const SECRET = 'fake-provider-secret-for-tests-0001'
const OTHER_SECRET = 'fake-provider-secret-for-tests-0002'
const auth = {
  Authorization: `Bearer ${token}`,
  'X-Queen-Contributor-Id': subject,
}
const names = [
  'QUEEN_CONTRIBUTOR_PROXY_TOKEN',
  'QUEEN_CONTRIBUTOR_ENCRYPTION_KEY',
  P.PROXY_FLAG_ENV,
]
const before = new Map<string, string | undefined>()
beforeEach(() => {
  for (const name of names) before.set(name, process.env[name])
  process.env.QUEEN_CONTRIBUTOR_PROXY_TOKEN = token
  process.env.QUEEN_CONTRIBUTOR_ENCRYPTION_KEY = Buffer.alloc(32, 41).toString(
    'base64',
  )
  process.env[P.PROXY_FLAG_ENV] = 'on'
})
afterEach(() => {
  for (const name of names) {
    const value = before.get(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function managed(
  id: number,
  owner: string,
  provider: 'zai' | 'nvidia',
  secret: string,
  enabled = true,
): KeyRow {
  const digest = fingerprint(secret)
  return {
    key_index: id,
    source: 'managed',
    fingerprint: digest,
    owner_subject: owner,
    owner_name: 'contributor',
    provider,
    model: provider === 'zai' ? 'glm-4.5-flash' : 'nvidia/some-model',
    label: `${provider} #${Math.abs(id)}`,
    sealed: sealCredential(secret, owner, digest),
    enabled,
    revision: 0,
    probe_status: 'ok',
    probe_at: null,
    probe_ms: null,
    created_at: '2026-10-20T00:00:00Z',
  }
}

function fakePool(rows: KeyRow[], log: string[] = []): Pool {
  return {
    async query(sql: string, params: unknown[] = []) {
      const q = sql.replace(/\s+/g, ' ').trim()
      log.push(q.slice(0, 40))
      if (q.startsWith('CREATE SEQUENCE')) return { rows: [], rowCount: 0 }
      if (q.endsWith('WHERE owner_subject=$1 ORDER BY key_index'))
        return { rows: rows.filter((r) => r.owner_subject === params[0]) }
      if (q.includes("WHERE source='environment'")) return { rows: [] }
      if (q.endsWith('WHERE key_index=$1 AND owner_subject=$2'))
        return {
          rows: rows.filter(
            (r) => r.key_index === params[0] && r.owner_subject === params[1],
          ),
        }
      throw new Error(`fake pool does not know: ${q.slice(0, 80)}`)
    },
  } as unknown as Pool
}

type Seen = { url: string; headers: Headers; body: string }
function provider(
  answer: (seen: Seen) => Response | Promise<Response>,
  seen: Seen[] = [],
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const one = {
      url: String(url),
      headers: new Headers(init?.headers),
      body: Buffer.from(init?.body as Uint8Array).toString('utf8'),
    }
    seen.push(one)
    return answer(one)
  }) as typeof fetch
}

function build(rows: KeyRow[], fetcher?: typeof fetch, log: string[] = []) {
  const pool = fakePool(rows, log)
  return new Hono().route(
    '/queen/contributor-keys/proxy',
    createQueenContributorProxyRoute({
      pool: () => pool,
      environment: () => [],
      owners: () => ({}),
      fetcher,
    }),
  )
}

const call = (a: Hono, id: number, init: RequestInit = {}) =>
  a.request(`/queen/contributor-keys/proxy/${id}/messages`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: '{"model":"glm-4.5-flash","max_tokens":8,"messages":[]}',
    ...init,
  })

describe('the proxied call is off, gated and bounded before it touches storage', () => {
  it('answers 503 on every path while the flag is not on, and reads nothing', async () => {
    const log: string[] = []
    const a = build([managed(-1, subject, 'zai', SECRET)], undefined, log)
    for (const value of [undefined, '', 'off', 'ON', 'true']) {
      if (value === undefined) delete process.env[P.PROXY_FLAG_ENV]
      else process.env[P.PROXY_FLAG_ENV] = value
      const keys = await a.request('/queen/contributor-keys/proxy/keys', {
        headers: auth,
      })
      expect(keys.status).toBe(503)
      expect(await keys.json()).toEqual({ error: 'proxy_disabled' })
      expect((await call(a, -1)).status).toBe(503)
    }
    expect(log).toEqual([])
  })

  it('refuses a missing capability or subject before storage', async () => {
    const log: string[] = []
    const a = build([managed(-1, subject, 'zai', SECRET)], undefined, log)
    const url = '/queen/contributor-keys/proxy/keys'
    expect((await a.request(url)).status).toBe(403)
    expect(
      (
        await a.request(url, {
          headers: {
            Authorization: 'Bearer wrong-token-wrong-token-wrong-token',
          },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await a.request(url, {
          headers: { ...auth, 'X-Queen-Contributor-Id': 'telegram:0' },
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await a.request(url, {
          headers: { ...auth, 'X-Queen-Contributor-Id': '@someone' },
        })
      ).status,
    ).toBe(400)
    expect(log).toEqual([])
  })

  it('refuses a malformed key id, an empty body and an oversize body', async () => {
    const seen: Seen[] = []
    const a = build(
      [managed(-1, subject, 'zai', SECRET)],
      provider(() => new Response('{}'), seen),
    )
    for (const id of ['1e3', '-0', '01', 'x', '2147483648'])
      expect(
        (
          await a.request(`/queen/contributor-keys/proxy/${id}/messages`, {
            method: 'POST',
            headers: auth,
            body: '{}',
          })
        ).status,
      ).toBe(400)
    expect((await call(a, -1, { body: '' })).status).toBe(400)
    const big = await call(a, -1, {
      body: 'a'.repeat(P.PROXY_BODY_MAX_BYTES + 1),
    })
    expect(big.status).toBe(413)
    expect(await big.json()).toEqual({ error: 'request_too_large' })
    expect(seen).toEqual([])
  })
})

describe('the owner key list', () => {
  it('lists only id, provider, model and enabled, and only the subject own keys', async () => {
    const a = build([
      managed(-1, subject, 'zai', SECRET),
      managed(-2, subject, 'nvidia', OTHER_SECRET, false),
      managed(-3, stranger, 'zai', 'fake-provider-secret-for-tests-0003'),
    ])
    const res = await a.request('/queen/contributor-keys/proxy/keys', {
      headers: auth,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      keys: [
        { id: -1, provider: 'zai', model: 'glm-4.5-flash', enabled: true },
        {
          id: -2,
          provider: 'nvidia',
          model: 'nvidia/some-model',
          enabled: false,
        },
      ],
    })
    const text = JSON.stringify(body)
    for (const leak of [SECRET, OTHER_SECRET, 'fingerprint', 'sealed'])
      expect(text).not.toContain(leak)
  })
})

describe('one stored key, opened for one call', () => {
  it('opens the owner key, sends the body unchanged and streams the answer back', async () => {
    const seen: Seen[] = []
    const stream =
      'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
    const a = build(
      [managed(-1, subject, 'zai', SECRET)],
      provider(
        () =>
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        seen,
      ),
    )
    const sent = '{"model":"glm-4.5-flash","stream":true,"messages":[]}'
    const res = await call(a, -1, {
      body: sent,
      headers: {
        ...auth,
        'Content-Type': 'application/json',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get(P.PROXY_UPSTREAM_HEADER)).toBe('200')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toBe(stream)
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe(`${P.ZAI_ANTHROPIC_URL}/v1/messages`)
    expect(seen[0].body).toBe(sent)
    expect(seen[0].headers.get('authorization')).toBe(`Bearer ${SECRET}`)
    expect(seen[0].headers.get('x-api-key')).toBe(SECRET)
    expect(seen[0].headers.get('anthropic-version')).toBe('2023-06-01')
    expect(seen[0].headers.get('anthropic-beta')).toBe(
      'prompt-caching-2024-07-31',
    )
  })

  it('opens nothing for another owner, a disabled key or a provider without an Anthropic endpoint', async () => {
    const seen: Seen[] = []
    const a = build(
      [
        managed(-1, stranger, 'zai', SECRET),
        managed(-2, subject, 'zai', OTHER_SECRET, false),
        managed(-3, subject, 'nvidia', 'fake-provider-secret-for-tests-0004'),
      ],
      provider(() => new Response('{}'), seen),
    )
    const stranger_key = await call(a, -1)
    expect(stranger_key.status).toBe(404)
    expect(await stranger_key.json()).toEqual({ error: 'key_not_found' })
    const disabled = await call(a, -2)
    expect(disabled.status).toBe(404)
    expect(await disabled.json()).toEqual({ error: 'key_not_found' })
    const nvidia = await call(a, -3)
    expect(nvidia.status).toBe(404)
    expect(await nvidia.json()).toEqual({ error: 'provider_needs_translation' })
    expect((await call(a, -9)).status).toBe(404)
    expect(seen).toEqual([])
  })

  it('names the provider status in a header and echoes no provider refusal body', async () => {
    const refusal = `{"error":{"message":"invalid key ${SECRET}"}}`
    for (const status of [401, 402, 429, 500, 529]) {
      const a = build(
        [managed(-1, subject, 'zai', SECRET)],
        provider(
          () =>
            new Response(refusal, {
              status,
              headers: status === 429 ? { 'Retry-After': '17' } : {},
            }),
        ),
      )
      const res = await call(a, -1)
      expect(res.status).toBe(status)
      expect(res.headers.get(P.PROXY_UPSTREAM_HEADER)).toBe(String(status))
      expect(res.headers.get('retry-after')).toBe(status === 429 ? '17' : null)
      const text = await res.text()
      expect(text).toBe('')
      expect(text).not.toContain(SECRET)
    }
  })

  it('answers 502 without the secret or the provider error when the provider cannot be reached', async () => {
    const a = build([managed(-1, subject, 'zai', SECRET)], (async () => {
      throw new Error(`connect failed using ${SECRET}`)
    }) as unknown as typeof fetch)
    const res = await call(a, -1)
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: 'upstream_unavailable' })
    expect(text).not.toContain(SECRET)
  })

  it('drops an unprintable anthropic header instead of forwarding it', async () => {
    const seen: Seen[] = []
    const a = build(
      [managed(-1, subject, 'zai', SECRET)],
      provider(() => new Response('{}'), seen),
    )
    await call(a, -1, {
      headers: {
        ...auth,
        'Content-Type': 'application/json',
        'anthropic-beta': 'x'.repeat(513),
      },
    })
    expect(seen[0].headers.get('anthropic-beta')).toBeNull()
  })
})

describe('mounted inside the key route, ahead of its 8 KiB body cap', () => {
  it('the first registered sub-app answers and the later middleware never runs', async () => {
    let reached = false
    const parent = new Hono()
    parent.route(
      '/proxy',
      createQueenContributorProxyRoute({
        pool: () => fakePool([managed(-1, subject, 'zai', SECRET)]),
        environment: () => [],
        owners: () => ({}),
        fetcher: provider(() => new Response('{}')),
      }),
    )
    parent.use('/*', async (c, next) => {
      reached = true
      if (c.req.method === 'POST')
        return c.json({ error: 'request_too_large' }, 413)
      return next()
    })
    parent.post('/:id/:action', (c) => c.json({ error: 'invalid_action' }, 400))
    parent.onError((_error, c) => c.json({ error: 'parent_handler' }, 503))
    const res = await parent.request('/proxy/-1/messages', {
      method: 'POST',
      headers: auth,
      body: 'x'.repeat(20000),
    })
    expect(res.status).not.toBe(413)
    expect(reached).toBe(false)
    expect((await parent.request('/other', { method: 'POST' })).status).toBe(
      413,
    )
    expect(reached).toBe(true)
    // The proxy's own error handler still answers for its paths.
    const refused = await parent.request('/proxy/keys')
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'forbidden' })
  })
})

describe('the host mirrors of the spec rules, against the spec vectors', () => {
  it('proxy_flag_on, proxy_may_open and proxy_cap_fits agree with queen-contributor-keys.t27', () => {
    expect(proxyFlagOn('on')).toBe(true)
    for (const v of [undefined, '', 'off', 'ON', 'true'])
      expect(proxyFlagOn(v)).toBe(false)
    expect(proxyMayOpen(true, true)).toBe(true)
    expect(proxyMayOpen(false, true)).toBe(false)
    expect(proxyMayOpen(true, false)).toBe(false)
    expect(proxyMayOpen(false, false)).toBe(false)
    expect(proxyCapFits(0)).toBe(false)
    expect(proxyCapFits(1)).toBe(true)
    expect(proxyCapFits(4194304)).toBe(true)
    expect(proxyCapFits(4259840)).toBe(true)
    expect(proxyCapFits(4259841)).toBe(false)
    expect(P.PROXY_TIMEOUT_MS).toBeGreaterThan(P.PROBE_TIMEOUT_MS)
    expect(P.PROXY_FLAG_ENV).toBe('TRIOS_KEY_PROXY')
    expect(P.PROXY_UPSTREAM_HEADER).toBe('x-hive-upstream-status')
  })
})
