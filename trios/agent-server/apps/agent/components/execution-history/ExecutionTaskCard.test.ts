/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The execution task card, held against its contract
 * (gHashTag/trios#1617): the one export of
 * components/execution-history/ExecutionTaskCard.tsx -
 * ExecutionTaskCard - pinned as it behaves today, so the next change
 * to that file has something to fail against.
 *
 * The card draws the collapsible kit, the badges, the buttons and
 * the dayjs relative-time machinery for real - everything it answers
 * rides its task record - so the suite needs no stubs at all.
 * Measured, the opened completed card answers its prompt under the
 * Completed badge with the action count, the real duration the
 * timestamps give, the error badge, the response preview and the
 * empty-steps note; the closed running card answers its prompt under
 * the Running badge with the relative start the fresh timestamp
 * gives, while its content stays hidden; and the delete button
 * answers the aria label naming the prompt.
 *
 * Not pinned, and why (issue User Story 2): the flows the callbacks
 * own - the delete wiring, the manual open toggle, the step rows'
 * own expansion - need a live document to press; the step rows are
 * the step item's own contract, pinned by their own module. The
 * subject is read through a query-qualified specifier so this
 * suite's graph loads as its own fresh instances.
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ExecutionTaskRecord } from '@/lib/execution-history/types'
import { ExecutionTaskCard } from './ExecutionTaskCard'

const completedTask: ExecutionTaskRecord = {
  id: 'task-1',
  conversationId: 'conversation-1',
  promptText: 'Ship the release notes',
  startedAt: new Date(Date.now() - 90_000).toISOString(),
  completedAt: new Date().toISOString(),
  status: 'completed',
  responsePreview: 'Release notes published.',
  actionCount: 2,
  approvalCount: 0,
  deniedCount: 0,
  errorCount: 1,
  steps: [],
}

const runningTask: ExecutionTaskRecord = {
  id: 'task-2',
  conversationId: 'conversation-1',
  promptText: 'Draft the quarterly plan',
  startedAt: new Date().toISOString(),
  status: 'running',
  actionCount: 1,
  approvalCount: 0,
  deniedCount: 0,
  errorCount: 0,
  steps: [],
}

describe('ExecutionTaskCardTsxContract', () => {
  describe('ExecutionTaskCard', () => {
    it('answers the opened completed card with its prompt, badges, action count, duration, preview and empty-steps note, the closed running card with its prompt and relative start while its content stays hidden, and the delete button naming the prompt', () => {
      const completed = renderToStaticMarkup(
        createElement(ExecutionTaskCard, {
          task: completedTask,
          defaultOpen: true,
          onDelete: () => {},
        }),
      )
      expect(completed).toContain('Ship the release notes')
      expect(completed).toContain('Completed')
      expect(completed).toContain('2 actions')
      expect(completed).toContain('1m 30s')
      expect(completed).toContain('1 error')
      expect(completed).toContain('Release notes published.')
      expect(completed).toContain(
        'No tool actions were recorded for this task.',
      )
      expect(completed).toContain('Delete Ship the release notes')

      const running = renderToStaticMarkup(
        createElement(ExecutionTaskCard, { task: runningTask }),
      )
      expect(running).toContain('Draft the quarterly plan')
      expect(running).toContain('Running')
      expect(running).toContain('a few seconds ago')
      expect(running).toContain('1 action')
      expect(running).not.toContain(
        'No tool actions were recorded for this task.',
      )
    })
  })
})
