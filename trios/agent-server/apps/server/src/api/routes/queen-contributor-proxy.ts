import { Hono } from 'hono'
import type { Pool } from 'pg'
import { logger } from '../../lib/logger'
import {
  ContributorError,
  type EnvironmentKey,
  listContributorKeys,
  ownedRow,
  trustedContributor,
} from '../services/queen-contributor-keys'
import { CONTRIBUTOR_POLICY as P } from '../services/queen-contributor-policy'

/**
 * One stored key, opened for one call of the Anthropic Messages protocol
 * (specs/automation/queen-contributor-keys.t27 v3; the render side is
 * hive-proxy.t27, gHashTag/999-multibots-telegraf#4024).
 *
 * The render has already judged the session and picked the key id; this door
 * trusts only the shared capability token and the subject it attests, then
 * re-checks what only the Queen can: the key is that subject's own, is
 * enabled, and its provider has an Anthropic endpoint. The secret is opened
 * inside the request, sent to the provider, and never returned, logged or
 * kept. A provider refusal is not echoed (its body can carry a credential);
 * the status travels in a marker header and the render writes the reply.
 *
 * Off unless TRIOS_KEY_PROXY=on: every path answers 503 and touches nothing.
 */
export interface ContributorProxyDeps {
  pool: () => Pool
  environment: () => EnvironmentKey[]
  owners: () => Record<number, string>
  fetcher?: typeof fetch
}

// Mirrors proxy_flag_on, proxy_may_open and proxy_cap_fits in the spec; the
// test pins each to the spec's own vectors.
export const proxyFlagOn = (value: string | undefined) => value === 'on'
export const proxyMayOpen = (enabled: boolean, anthropicNative: boolean) =>
  enabled && anthropicNative
export const proxyCapFits = (bytes: number) =>
  bytes > 0 && bytes <= P.PROXY_BODY_MAX_BYTES

async function boundedBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > P.PROXY_BODY_MAX_BYTES) {
          await reader.cancel()
          throw new ContributorError('request_too_large', 413)
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  if (!proxyCapFits(bytes)) throw new ContributorError('invalid_body')
  return new Uint8Array(Buffer.concat(chunks))
}

const PRINTABLE = /^[\x20-\x7e]{1,512}$/

export function createQueenContributorProxyRoute(deps: ContributorProxyDeps) {
  const app = new Hono<{ Variables: { contributor: string } }>()
  app.use('/*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (!proxyFlagOn(process.env[P.PROXY_FLAG_ENV]))
      return c.json({ error: 'proxy_disabled' }, 503)
    c.set(
      'contributor',
      trustedContributor(
        c.req.header('authorization'),
        c.req.header('x-queen-contributor-id'),
      ),
    )
    return next()
  })
  // The owner's keys, metadata only: what the render needs to pick one.
  app.get('/keys', async (c) => {
    const keys = await listContributorKeys(
      deps.pool(),
      c.get('contributor'),
      deps.environment(),
      deps.owners(),
    )
    return c.json({
      keys: keys.map(({ id, provider, model, enabled }) => ({
        id,
        provider,
        model,
        enabled,
      })),
    })
  })
  app.post('/:id/messages', async (c) => {
    const raw = c.req.param('id')
    const id = Number(raw)
    if (
      raw !== String(id) ||
      !Number.isSafeInteger(id) ||
      id < -2147483647 ||
      id > 2147483647
    )
      throw new ContributorError('invalid_key_id')
    const body = await boundedBody(c.req.raw)
    const { row, secret } = await ownedRow(
      deps.pool(),
      c.get('contributor'),
      id,
      deps.environment(),
      deps.owners(),
      true,
    )
    const native = row.provider === 'zai'
    if (!proxyMayOpen(row.enabled, native))
      throw new ContributorError(
        native ? 'key_not_found' : 'provider_needs_translation',
        404,
      )
    const headers: Record<string, string> = {
      authorization: `Bearer ${secret}`,
      'x-api-key': secret,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    for (const name of ['anthropic-version', 'anthropic-beta']) {
      const sent = c.req.header(name)
      if (sent && PRINTABLE.test(sent)) headers[name] = sent
    }
    let upstream: Response
    try {
      upstream = await (deps.fetcher ?? fetch)(
        `${P.ZAI_ANTHROPIC_URL}/v1/messages`,
        {
          method: 'POST',
          redirect: 'error',
          headers,
          body,
          signal: AbortSignal.any([
            AbortSignal.timeout(P.PROXY_TIMEOUT_MS),
            c.req.raw.signal,
          ]),
        },
      )
    } catch (error) {
      logger.warn('contributor proxy: provider unreachable', {
        keyId: id,
        error: error instanceof Error ? error.name : 'unknown',
      })
      throw new ContributorError('upstream_unavailable', 502)
    }
    const out: Record<string, string> = {
      'Cache-Control': 'no-store',
      [P.PROXY_UPSTREAM_HEADER]: String(upstream.status),
    }
    const wait = upstream.headers.get('retry-after')
    if (wait) out['Retry-After'] = wait
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {})
      return new Response(null, { status: upstream.status, headers: out })
    }
    out['Content-Type'] =
      upstream.headers.get('content-type') ?? 'application/json'
    return new Response(upstream.body, {
      status: upstream.status,
      headers: out,
    })
  })
  app.onError((error, c) => {
    const known =
      error instanceof ContributorError
        ? error
        : new ContributorError('contributor_keys_unavailable', 503)
    return c.json({ error: known.code }, known.status as 400)
  })
  return app
}
