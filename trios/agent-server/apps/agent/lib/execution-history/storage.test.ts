/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The execution history store, held against its contract
 * (gHashTag/trios#1636): the eight exports of
 * lib/execution-history/storage.ts - executionHistoryStorage,
 * upsertConversationExecutionTask, getConversationExecutionHistory,
 * getExecutionHistoryByConversation, removeConversationExecutionHistory,
 * removeConversationExecutionTask, useConversationExecutionHistory,
 * useExecutionHistoryByConversation - pinned as they behave today, so
 * the next change to that file has something to fail against.
 *
 * The storage seam is an in-memory stub via `mock.module` (the
 * pattern of entrypoints/app/skills/SkillsPage.test.ts), so this
 * suite needs no network, no database, no container - and no
 * web-extension storage either. mock.module is process-global in
 * bun; no other suite of this job imports @wxt-dev/storage (that is
 * exactly why this module was untested), so the stub cannot leak
 * into a suite that wants the real one.
 *
 * Not pinned, and why: the two hooks
 * (useConversationExecutionHistory, useExecutionHistoryByConversation)
 * need a React renderer to observe their state; this project's bun
 * test environment has no DOM and no renderer (the same limitation
 * named in SkillsPage.test.ts). The six storage functions below are
 * fully pinned, and the storage item's declared key and version are
 * asserted through the stub's recorded defineItem call.
 */

import { describe, expect, it, mock } from 'bun:test'

const defines: Array<{ key: string; opts: unknown }> = []
const values = new Map<string, unknown>()

mock.module('@wxt-dev/storage', () => ({
  storage: {
    defineItem: (key: string, opts?: unknown) => {
      defines.push({ key, opts })
      return {
        getValue: async () => values.get(key) ?? null,
        setValue: async (value: unknown) => {
          values.set(key, value)
        },
        watch: () => () => {},
      }
    },
  },
}))

const {
  executionHistoryStorage,
  getConversationExecutionHistory,
  getExecutionHistoryByConversation,
  removeConversationExecutionHistory,
  removeConversationExecutionTask,
  upsertConversationExecutionTask,
} = await import('./storage')

const task = (conversationId: string, id: string) => ({
  conversationId,
  id,
  status: 'completed' as const,
  startedAt: 1,
  completedAt: 2,
})

describe('executionHistoryStorage', () => {
  it('declares the per-conversation record under its key with version 1', () => {
    expect(executionHistoryStorage).toBeDefined()
    expect(defines).toContainEqual({
      key: 'local:executionHistoryByConversation',
      opts: expect.objectContaining({ version: 1, fallback: {} }),
    })
  })
})

describe('upsertConversationExecutionTask', () => {
  it('creates the conversation history with the task in it', async () => {
    await upsertConversationExecutionTask(task('c1', 't1'))
    const history = await getConversationExecutionHistory('c1')
    expect(history?.tasks.map((t) => t.id)).toEqual(['t1'])
    expect(history?.conversationId).toBe('c1')
    expect(history?.updatedAt).toBeGreaterThan(0)
  })

  it('replaces an existing task by id instead of appending a twin', async () => {
    await upsertConversationExecutionTask(task('c2', 't1'))
    await upsertConversationExecutionTask(task('c2', 't1'))
    const history = await getConversationExecutionHistory('c2')
    expect(history?.tasks.length).toBe(1)
    expect(history?.tasks[0].id).toBe('t1')
  })
})

describe('getConversationExecutionHistory', () => {
  it('says null for a conversation it has never seen', async () => {
    expect(await getConversationExecutionHistory('nope')).toBeNull()
  })
})

describe('getExecutionHistoryByConversation', () => {
  it('answers the whole record keyed by conversation', async () => {
    await upsertConversationExecutionTask(task('c3', 't1'))
    const all = await getExecutionHistoryByConversation()
    expect(Object.keys(all).sort()).toEqual(['c1', 'c2', 'c3'])
  })
})

describe('removeConversationExecutionHistory', () => {
  it('drops one conversation and keeps the others', async () => {
    await removeConversationExecutionHistory('c1')
    expect(await getConversationExecutionHistory('c1')).toBeNull()
    expect(await getConversationExecutionHistory('c2')).not.toBeNull()
  })
})

describe('removeConversationExecutionTask', () => {
  it('removes the task and keeps the conversation when others remain', async () => {
    await upsertConversationExecutionTask(task('c2', 't2'))
    await removeConversationExecutionTask({ conversationId: 'c2', taskId: 't1' })
    const history = await getConversationExecutionHistory('c2')
    expect(history?.tasks.map((t) => t.id)).toEqual(['t2'])
  })

  it('drops the whole conversation when its last task goes', async () => {
    await removeConversationExecutionTask({ conversationId: 'c2', taskId: 't2' })
    expect(await getConversationExecutionHistory('c2')).toBeNull()
  })

  it('is a no-op for an unknown task or conversation', async () => {
    await removeConversationExecutionTask({
      conversationId: 'ghost',
      taskId: 't9',
    })
    await removeConversationExecutionTask({
      conversationId: 'c3',
      taskId: 't9',
    })
    expect((await getConversationExecutionHistory('c3'))?.tasks.length).toBe(1)
  })
})
