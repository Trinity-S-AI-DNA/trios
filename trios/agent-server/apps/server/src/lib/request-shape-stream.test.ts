/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The diagnostic read of a 4xx body must never hold the original answer:
 * not by waiting for the original branch of a tee (the cancel of a clone
 * completes only after the other branch is consumed), and not by waiting for
 * a body that stalls. These tests use real streamed responses.
 */

import { describe, it } from 'bun:test'
import assert from 'node:assert'
import { observeClientErrors, readBodyHead } from './request-shape'

const BODY = '{"error":{"code":"1214","message":"LEAKY-TEXT"}}'
const REQUEST = {
  method: 'POST',
  body: JSON.stringify({ messages: [{ role: 'user', content: 'SECRET' }] }),
}
const encoder = new TextEncoder()

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

function answering(stream: ReadableStream<Uint8Array>, status = 400) {
  return (async () =>
    new Response(stream, {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

/** A body that sends one chunk and closes. */
function oneChunk(text: string) {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
  return { stream }
}

describe('readBodyHead on a tee clone', () => {
  it('returns without the original being consumed, which stays readable', async () => {
    const { stream } = oneChunk(BODY)
    const original = new Response(stream, { status: 400 })
    const head = await readBodyHead(original.clone(), 4096, 500)
    assert.strictEqual(head, BODY)
    assert.strictEqual(await original.text(), BODY)
  })

  it('gives up at its deadline on a body that stalls', async () => {
    const stalled = new ReadableStream<Uint8Array>({ pull: () => sleep(5000) })
    const original = new Response(stalled, { status: 400 })
    const started = Date.now()
    const head = await readBodyHead(original.clone(), 4096, 40)
    assert.strictEqual(head, '')
    assert.ok(Date.now() - started < 1000, 'the deadline bounds the read')
    await original.body?.cancel()
  })

  it('keeps the bytes that arrived before the deadline', async () => {
    let sent = false
    const slow = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(encoder.encode('{"code":"1214"'))
          return
        }
        await sleep(5000)
      },
    })
    const original = new Response(slow, { status: 400 })
    const head = await readBodyHead(original.clone(), 4096, 60)
    assert.strictEqual(head, '{"code":"1214"')
    await original.body?.cancel()
  })
})

describe('observeClientErrors with a streamed 400', () => {
  it('resolves before the original is consumed, reports code and shape, and the body stays whole', async () => {
    const { stream } = oneChunk(BODY)
    const seen: Array<Record<string, unknown>> = []
    let consumed = false
    const f = observeClientErrors(answering(stream), (info) => {
      seen.push(info as unknown as Record<string, unknown>)
    })
    const res = await f('https://example.test/', REQUEST)
    // the wrapper has returned; nobody has read the original yet
    assert.strictEqual(res.status, 400)
    assert.strictEqual(consumed, false)
    assert.strictEqual(seen.length, 1)
    assert.strictEqual(seen[0]?.code, '1214')
    assert.doesNotMatch(JSON.stringify(seen), /LEAKY|SECRET/)
    consumed = true
    assert.strictEqual(await res.text(), BODY)
  })

  it('returns the original even when the body stalls past the deadline', async () => {
    const stalled = new ReadableStream<Uint8Array>({ pull: () => sleep(5000) })
    const seen: Array<{ code?: string }> = []
    const f = observeClientErrors(
      answering(stalled),
      (info) => seen.push(info),
      30,
    )
    const started = Date.now()
    const res = await f('https://example.test/', REQUEST)
    assert.ok(Date.now() - started < 1000)
    assert.strictEqual(res.status, 400)
    assert.strictEqual(seen.length, 1)
    assert.strictEqual(seen[0]?.code, undefined)
    await res.body?.cancel()
  })

  it('a stream that errors after the deadline leaves no unhandled rejection and no hang', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      let fail: (error: Error) => void = () => {}
      const late = new ReadableStream<Uint8Array>({
        start(controller) {
          fail = (error) => controller.error(error)
        },
      })
      const f = observeClientErrors(answering(late), () => {}, 20)
      const res = await f('https://example.test/', REQUEST)
      assert.strictEqual(res.status, 400)
      fail(new Error('socket reset'))
      await sleep(100)
      // the original sees the failure; the diagnostic branch is long gone
      await assert.rejects(() => res.text(), /socket reset/)
      await sleep(50)
      assert.deepStrictEqual(unhandled, [])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('does not touch the answer of a non-4xx response', async () => {
    const { stream } = oneChunk('{"ok":true}')
    const f = observeClientErrors(answering(stream, 200), () => {
      throw new Error('must not be called')
    })
    const res = await f('https://example.test/', REQUEST)
    assert.strictEqual(res.status, 200)
    assert.strictEqual(await res.text(), '{"ok":true}')
  })
})
