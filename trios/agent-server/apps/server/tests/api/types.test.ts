/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The API request schemas, held against their contract
 * (gHashTag/trios#1649): the two exports of src/api/types.ts -
 * AgentLLMConfigSchema and ChatRequestSchema - pinned as they behave
 * today, so the next change to that file has something to fail
 * against.
 *
 * AgentLLMConfigSchema: a provider from the shared enum plus a
 * non-empty model name; the shared LLM fields pass through and the
 * model extension refuses an empty string with its own message.
 * ChatRequestSchema: a UUID conversation id, the defaults spelled out
 * (empty message, agent mode, sidepanel entrypoint, not a scheduled
 * task, images supported), and previousConversation accepted either
 * as a role-tagged array or as a plain string lifted into one user
 * turn - a blank string means no history at all.
 *
 * No network, no database, no container: the schemas are pure zod
 * objects over the shared workspace schemas.
 */

import { describe, expect, it } from 'bun:test'
import {
  AgentLLMConfigSchema,
  ChatRequestSchema,
} from '../../src/api/types'

const UUID = '123e4567-e89b-12d3-a456-426614174000'

describe('AgentLLMConfigSchema', () => {
  it('accepts a provider with a model and keeps both', () => {
    const r = AgentLLMConfigSchema.safeParse({
      provider: 'anthropic',
      model: 'claude-x',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.provider).toBe('anthropic')
      expect(r.data.model).toBe('claude-x')
    }
  })

  it('refuses a request without a model', () => {
    expect(
      AgentLLMConfigSchema.safeParse({ provider: 'anthropic' }).success,
    ).toBe(false)
  })

  it('refuses an empty model name with its own message', () => {
    const r = AgentLLMConfigSchema.safeParse({
      provider: 'anthropic',
      model: '',
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues[0].message).toBe('Model name is required')
    }
  })

  it('refuses a provider outside the shared enum', () => {
    expect(
      AgentLLMConfigSchema.safeParse({ provider: 'nope', model: 'm' })
        .success,
    ).toBe(false)
  })
})

describe('ChatRequestSchema', () => {
  it('fills the spelled-out defaults on a minimal request', () => {
    const r = ChatRequestSchema.safeParse({
      provider: 'anthropic',
      model: 'm',
      conversationId: UUID,
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.message).toBe('')
      expect(r.data.mode).toBe('agent')
      expect(r.data.origin).toBe('sidepanel')
      expect(r.data.isScheduledTask).toBe(false)
      expect(r.data.supportsImages).toBe(true)
    }
  })

  it('refuses a conversation id that is not a UUID', () => {
    expect(
      ChatRequestSchema.safeParse({
        provider: 'anthropic',
        model: 'm',
        conversationId: 'not-a-uuid',
      }).success,
    ).toBe(false)
  })

  it('lifts a plain-string history into one user turn, untrimmed', () => {
    const r = ChatRequestSchema.safeParse({
      provider: 'anthropic',
      model: 'm',
      conversationId: UUID,
      previousConversation: '  hello  ',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.previousConversation).toEqual([
        { role: 'user', content: '  hello  ' },
      ])
    }
  })

  it('treats a blank history string as no history', () => {
    const r = ChatRequestSchema.safeParse({
      provider: 'anthropic',
      model: 'm',
      conversationId: UUID,
      previousConversation: '   ',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.previousConversation).toBeUndefined()
    }
  })

  it('passes a role-tagged history array through unchanged', () => {
    const history = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]
    const r = ChatRequestSchema.safeParse({
      provider: 'anthropic',
      model: 'm',
      conversationId: UUID,
      previousConversation: history,
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.previousConversation).toEqual(history)
    }
  })
})
