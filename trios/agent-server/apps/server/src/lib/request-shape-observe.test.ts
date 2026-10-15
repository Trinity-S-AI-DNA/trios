/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The Z.ai path of gHashTag/trios#2005: the fetch createZaiFactory builds
 * (observeClientErrors around createOpenRouterCompatibleFetch) reaches the
 * diagnostic hook with a code and a shape only, and leaves the SDK-facing
 * behaviour - a thrown APICallError, terminal quota not retryable - as it was.
 */

import { afterEach, describe, it } from 'bun:test'
import assert from 'node:assert'
import { clientErrorLogger } from '../agent/provider-factory'
import { createOpenRouterCompatibleFetch } from './openrouter-fetch'
import { observeClientErrors } from './request-shape'

const KEY = 'sk-zai-SECRET-KEY-123'
const real = globalThis.fetch

afterEach(() => {
  globalThis.fetch = real
})

function stub(status: number, body: string) {
  globalThis.fetch = (async () =>
    new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

const request = {
  method: 'POST',
  headers: { authorization: `Bearer ${KEY}` },
  body: JSON.stringify({
    model: 'glm-secret-model',
    messages: [
      { role: 'user', content: 'PRIVATE-PROMPT' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a' }] },
    ],
  }),
}

describe('observeClientErrors on the Z.ai fetch', () => {
  it('reports a 400 by code and shape, and still throws the same error', async () => {
    stub(400, `{"error":{"code":"1214","message":"bad ${KEY} /home/u/x"}}`)
    const lines: Array<Record<string, unknown>> = []
    const f = observeClientErrors(
      createOpenRouterCompatibleFetch(),
      clientErrorLogger(
        'zai',
        () => 0,
        (_m, fields) => lines.push(fields),
      ),
    )
    await assert.rejects(
      () => f('https://zai.example/v1/chat/completions', request),
      (error: Error & { statusCode?: number }) => error.statusCode === 400,
    )
    assert.strictEqual(lines.length, 1)
    const text = JSON.stringify(lines)
    assert.match(text, /"code":"1214"/)
    assert.match(text, /"status":400/)
    assert.doesNotMatch(
      text,
      /SECRET|PRIVATE|glm-secret|home|authorization|Bearer/i,
    )
  })

  it('leaves a terminal 429 not retryable and does not retry', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response(
        '{"error":{"code":"1113","message":"Insufficient balance"}}',
        { status: 429, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const f = observeClientErrors(createOpenRouterCompatibleFetch(), () => {})
    await assert.rejects(
      () => f('https://zai.example/v1/chat/completions', request),
      (error: Error & { isRetryable?: boolean }) => error.isRetryable === false,
    )
    assert.strictEqual(calls, 1)
  })

  it('bounds the lines per window', () => {
    let t = 0
    let emitted = 0
    const log = clientErrorLogger(
      'zai',
      () => t,
      () => emitted++,
    )
    for (let i = 0; i < 100; i++) log({ status: 400 })
    assert.strictEqual(emitted, 20)
    t = 61_000
    log({ status: 400 })
    assert.strictEqual(emitted, 21)
  })
})
