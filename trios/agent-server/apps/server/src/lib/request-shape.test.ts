/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Runs against the real card wasm (specs/queen/worktree_keep.wasm).
 */

import { describe, it } from 'bun:test'
import assert from 'node:assert'
import {
  describeRequestShape,
  providerErrorCode,
  readBodyHead,
} from './request-shape'

const LEAK = 'sk-LEAK-/Users/x/.ssh/id_rsa'

describe('describeRequestShape', () => {
  const body = JSON.stringify({
    model: 'glm-x',
    tools: [{}, {}],
    messages: [
      { role: 'system', content: 'SECRET-SYSTEM-TEXT' },
      { role: 'user', content: [{ type: 'text', text: 'SECRET-USER-TEXT' }] },
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'SECRET-THOUGHT',
        tool_calls: [
          { id: 'c1', function: { name: 'n', arguments: '/etc/x' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'SECRET-RESULT' },
    ],
  })

  it('reports roles, part types and counts', () => {
    const shape = describeRequestShape(body)
    assert.ok(shape)
    assert.strictEqual(shape.messages, 4)
    assert.strictEqual(shape.tools, 2)
    assert.strictEqual(shape.toolCalls, 1)
    assert.strictEqual(shape.toolResults, 1)
    assert.strictEqual(shape.hasReasoning, true)
    assert.deepStrictEqual(shape.sequence, [
      'system:text',
      'user:text',
      'assistant:empty+tool_call+reasoning',
      'tool:text+tool_result',
    ])
    assert.strictEqual(shape.roleCounts.system, 1)
    assert.strictEqual(shape.roleCounts.tool, 1)
  })

  it('carries no message content, arguments, paths or model', () => {
    const text = JSON.stringify(describeRequestShape(body))
    assert.doesNotMatch(text, /SECRET|\/etc\/x|arguments|glm/)
  })

  it('never echoes an untrusted role, part type or model', () => {
    const poisoned = JSON.stringify({
      model: LEAK,
      messages: [
        { role: LEAK, content: [{ type: LEAK, text: LEAK }] },
        { role: '__proto__', content: [{ type: '__proto__' }] },
        { role: 'constructor', content: [{ type: 'constructor' }] },
        { role: { toString: LEAK }, content: 5 },
      ],
    })
    const shape = describeRequestShape(poisoned)
    assert.ok(shape)
    const text = JSON.stringify(shape)
    assert.doesNotMatch(text, /LEAK|ssh|Users|__proto__|constructor|toString/)
    assert.strictEqual(shape.roleCounts.unknown, 4)
    assert.strictEqual(shape.partTypeCounts.unknown >= 3, true)
  })

  it('keeps counters free of prototype pollution', () => {
    const shape = describeRequestShape(
      '{"messages":[{"role":"__proto__"}],"__proto__":{"polluted":1}}',
    )
    assert.ok(shape)
    assert.strictEqual(Object.getPrototypeOf(shape.roleCounts), null)
    assert.strictEqual(Object.getPrototypeOf(shape.partTypeCounts), null)
    assert.strictEqual(({} as Record<string, unknown>).polluted, undefined)
  })

  it('is bounded and deterministic for a huge request', () => {
    const messages = Array.from({ length: 5000 }, () => ({
      role: 'user',
      content: Array.from({ length: 50 }, () => ({ type: 'text' })),
    }))
    const huge = JSON.stringify({ messages })
    const a = describeRequestShape(huge)
    const b = describeRequestShape(huge)
    assert.ok(a)
    assert.deepStrictEqual(a, b)
    assert.strictEqual(a.sequence.length, 200)
    assert.strictEqual(a.messages, 5000)
    assert.ok(JSON.stringify(a).length < 20_000)
  })

  it('returns undefined for a body it cannot read', () => {
    assert.strictEqual(describeRequestShape(undefined), undefined)
    assert.strictEqual(describeRequestShape('not json'), undefined)
    assert.strictEqual(describeRequestShape('{"a":1}'), undefined)
  })
})

describe('providerErrorCode', () => {
  it('keeps a short numeric code and drops the message', () => {
    assert.strictEqual(
      providerErrorCode('{"error":{"code":"1214","message":"leaky text"}}'),
      '1214',
    )
    assert.strictEqual(providerErrorCode('{"code":1214,"msg":"x"}'), '1214')
  })

  it('never echoes a non-numeric, long or arbitrary code', () => {
    for (const code of [
      JSON.stringify(LEAK),
      '"has spaces and text"',
      '"1214abc"',
      '"1234567890123"',
      '1e21',
      '-5',
      '1.5',
      'true',
      '{"x":1}',
      '"__proto__"',
    ]) {
      const got = providerErrorCode(`{"error":{"code":${code}}}`)
      assert.strictEqual(got, undefined, code)
    }
    assert.strictEqual(providerErrorCode('<html>'), undefined)
    assert.strictEqual(providerErrorCode('null'), undefined)
  })
})

describe('readBodyHead', () => {
  it('reads at most the first bytes of a large body', async () => {
    const big = new Response('x'.repeat(1_000_000))
    const head = await readBodyHead(big, 100)
    assert.strictEqual(head.length, 100)
  })
})
