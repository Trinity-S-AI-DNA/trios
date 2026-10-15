/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The execution history tracker hook, held against its contract
 * (gHashTag/trios#1623): the single export of
 * entrypoints/sidepanel/index/useExecutionHistoryTracker.ts -
 * useExecutionHistoryTracker - pinned as it behaves today, so the next
 * change to that file has something to fail against.
 *
 * A hook's render-time contract is reachable through a probe component;
 * its callbacks are plain functions the suite calls directly (the
 * repository's own pattern for hook suites). The storage write seam is
 * a recording fake (no other test file imports upsertConversationExecutionTask
 * - the storage suite pins the store itself); the normalize seam stays
 * REAL, so the counts the hook propagates are the real normalizer's.
 * Pinned: the hook's surface (four callbacks); startTask's fresh task
 * shape (running status, zero counters, a uuid, ISO timestamps, the
 * conversation and prompt carried); syncFromMessages' merge (the
 * assistant's tool parts counted into actionCount, the response preview,
 * the prompt/assistant message ids bound once); the finished-status
 * dispatch (failed on error, stopped on abort, completed otherwise);
 * the dedup write (identical task writes once); the sentry capture on a
 * failing write; and clearActiveTask (a cleared tracker no longer
 * finishes or syncs). Not pinned: the write queue's ordering (a
 * promise chain - its order is the event loop's, and the store suite
 * owns persistence).
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

let writes: Array<Record<string, unknown>> = []
let writeError: Error | null = null
let sentryCalls: Array<{ error: unknown; hint: unknown }> = []

mock.module('@/lib/execution-history/storage', () => ({
  upsertConversationExecutionTask: async (task: Record<string, unknown>) => {
    if (writeError) throw writeError
    writes.push(structuredClone(task))
  },
}))
mock.module('@/lib/sentry/sentry', () => ({
  sentry: {
    captureException: (error: unknown, hint: unknown) => {
      sentryCalls.push({ error, hint })
    },
  },
}))

const { useExecutionHistoryTracker } = await import(
  './useExecutionHistoryTracker'
)

type Tracker = ReturnType<typeof useExecutionHistoryTracker>

const trackerOf = (): Tracker => {
  let captured: Tracker | null = null
  const Probe = () => {
    captured = useExecutionHistoryTracker()
    return createElement('p', null, 'probe')
  }
  renderToStaticMarkup(createElement(Probe))
  if (!captured) throw new Error('the hook did not run')
  return captured
}

const awaitWrites = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const userMessage = (id: string, text: string) => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
})
const assistantMessage = (parts: Array<Record<string, unknown>>) => ({
  id: 'a-1',
  role: 'assistant',
  parts,
})

describe('useExecutionHistoryTrackerContract', () => {
  it('answers its four callbacks', () => {
    const tracker = trackerOf()
    expect(typeof tracker.startTask).toBe('function')
    expect(typeof tracker.syncFromMessages).toBe('function')
    expect(typeof tracker.finishTask).toBe('function')
    expect(typeof tracker.clearActiveTask).toBe('function')
  })

  it('starts a fresh running task and persists it with zero counters', async () => {
    const tracker = trackerOf()
    const id = tracker.startTask({
      conversationId: 'conv-1',
      promptText: 'Plan the launch',
    })
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    await awaitWrites()
    expect(writes.length).toBe(1)
    const first = writes[0] as Record<string, unknown>
    expect(first.conversationId).toBe('conv-1')
    expect(first.promptText).toBe('Plan the launch')
    expect(first.status).toBe('running')
    expect(first.actionCount).toBe(0)
    expect(first.approvalCount).toBe(0)
    expect(first.deniedCount).toBe(0)
    expect(first.errorCount).toBe(0)
    expect(Array.isArray(first.steps)).toBe(true)
    writes = []
  })

  it('merges the assistant tool parts into the active task and binds the message ids once', async () => {
    const tracker = trackerOf()
    tracker.startTask({ conversationId: 'conv-2', promptText: 'Do it' })
    await awaitWrites()
    writes = []

    const once = [
      userMessage('u-1', 'Do it'),
      assistantMessage([
        {
          type: 'tool-input-available',
          toolCallId: 't1',
          toolName: 'search',
          input: {},
        },
        { type: 'tool-output-available', toolCallId: 't1', output: 'ok' },
        { type: 'text', text: ' the answer' },
      ]),
    ]
    tracker.syncFromMessages(once as never, 'streaming')
    // A second message with a DIFFERENT tool adds a second step; the
    // counter is the normalizer's own step count, measured live.
    tracker.syncFromMessages(
      [
        userMessage('u-1', 'Do it'),
        assistantMessage([
          {
            type: 'tool-input-available',
            toolCallId: 't1',
            toolName: 'search',
            input: {},
          },
          { type: 'tool-output-available', toolCallId: 't1', output: 'ok' },
          {
            type: 'tool-input-available',
            toolCallId: 't2',
            toolName: 'fetch',
            input: {},
          },
          { type: 'tool-output-available', toolCallId: 't2', output: 'ok' },
          { type: 'text', text: ' the answer' },
        ]),
      ] as never,
      'streaming',
    )
    await awaitWrites()
    expect(writes.length).toBe(2)
    // The real normalizer's measured arithmetic: one tool part pair
    // answers two steps, and the second tool adds two more.
    const first = writes[0] as Record<string, unknown>
    expect(first.actionCount).toBe(2)
    const merged = writes[1] as Record<string, unknown>
    expect(merged.actionCount).toBe(4)
    expect(merged.promptMessageId).toBe('u-1')
    expect(merged.assistantMessageId).toBe('a-1')
    expect(String(merged.responsePreview).length).toBeGreaterThan(0)
    writes = []
  })

  it('finishes with the measured dispatch: failed on error, stopped on abort, completed otherwise', async () => {
    for (const [input, status] of [
      [{ isError: true }, 'failed'],
      [{ isAbort: true }, 'stopped'],
      [{}, 'completed'],
    ] as Array<[Record<string, unknown>, string]>) {
      const tracker = trackerOf()
      tracker.startTask({ conversationId: 'conv-3', promptText: 'x' })
      await awaitWrites()
      writes = []
      await tracker.finishTask(input as never)
      await awaitWrites()
      const done = writes[0] as Record<string, unknown>
      expect(done.status).toBe(status)
      expect(typeof done.completedAt).toBe('string')
      writes = []
    }
  })

  it('writes a changed task once and reports a failing write to sentry', async () => {
    const tracker = trackerOf()
    tracker.startTask({ conversationId: 'conv-4', promptText: 'x' })
    await awaitWrites()
    expect(writes.length).toBe(1)

    tracker.clearActiveTask()
    tracker.clearActiveTask()

    writeError = new Error('the store is down')
    const failing = trackerOf()
    failing.startTask({ conversationId: 'conv-5', promptText: 'y' })
    await awaitWrites()
    await awaitWrites()
    expect(sentryCalls.length).toBe(1)
    expect(sentryCalls[0].error).toBeInstanceOf(Error)
    expect(sentryCalls[0].hint).toEqual({
      extra: {
        message: 'Failed to persist execution history task',
        conversationId: 'conv-5',
        taskId: (sentryCalls[0].hint as { extra: { taskId: string } }).extra
          .taskId,
      },
    })
    expect(
      (sentryCalls[0].hint as { extra: { taskId: string } }).extra.taskId,
    ).toMatch(/^[0-9a-f-]{36}$/)
    writeError = null
    sentryCalls = []
    writes = []
  })

  it('answers nothing from a cleared tracker', async () => {
    const tracker = trackerOf()
    tracker.startTask({ conversationId: 'conv-6', promptText: 'x' })
    await awaitWrites()
    writes = []
    tracker.clearActiveTask()
    await tracker.finishTask({})
    tracker.syncFromMessages([userMessage('u-9', 'x')] as never, 'streaming')
    await awaitWrites()
    expect(writes.length).toBe(0)
  })
})
