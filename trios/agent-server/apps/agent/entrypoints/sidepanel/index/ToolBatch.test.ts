/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The tool batch card, held against its contract
 * (gHashTag/trios#1618): the one export of
 * entrypoints/sidepanel/index/ToolBatch.tsx - ToolBatch - pinned as
 * it behaves today, so the next change to that file has something to
 * fail against.
 *
 * The card draws the collapsible task kit and the button machinery
 * for real - the collapsible keeps its own open contract, the icons
 * and buttons render inline - so the suite needs no stubs at all:
 * everything the card answers rides its props. Measured, the
 * approval-pending batch answers its waiting title with the approval
 * buttons under the formatted tool name; the streaming last batch
 * answers its completed count with both tools' formatted names, the
 * camel-case one split into words; and a mid-history batch answers
 * its count while keeping its items hidden as it first mounts.
 *
 * Not pinned, and why (issue User Story 2): the flows the callbacks
 * own - the approve and deny wiring and the manual open toggle -
 * need a live document to press. The subject is read through a
 * query-qualified specifier so this suite's graph loads as its own
 * fresh instances.
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ToolInvocationInfo } from './getMessageSegments'
import { ToolBatch } from './ToolBatch'

const tool = (overrides: Partial<ToolInvocationInfo>): ToolInvocationInfo => ({
  state: 'result',
  toolCallId: 'call-1',
  toolName: 'fetch_page',
  input: {},
  output: [],
  ...overrides,
})

describe('ToolBatchTsxContract', () => {
  describe('ToolBatch', () => {
    it('answers the approval-pending batch with its waiting title and the approve and deny buttons, the streaming last batch with its completed count and the formatted tool names, and a mid-history batch with its count while its items stay hidden', () => {
      const approvalPending = renderToStaticMarkup(
        createElement(ToolBatch, {
          tools: [
            tool({
              state: 'approval-requested',
              toolName: 'web_search',
              approval: { id: 'approval-1' },
            }),
          ],
          isLastBatch: true,
          isLastMessage: true,
          isStreaming: false,
          onApprove: () => {},
          onDeny: () => {},
        }),
      )
      expect(approvalPending).toContain('Waiting for approval...')
      expect(approvalPending).toContain('Web search')
      expect(approvalPending).toContain('Approve')
      expect(approvalPending).toContain('Deny')

      const streamingLast = renderToStaticMarkup(
        createElement(ToolBatch, {
          tools: [
            tool({ state: 'result', toolName: 'fetch_page' }),
            tool({ state: 'call', toolName: 'checkDeploymentStatus' }),
          ],
          isLastBatch: true,
          isLastMessage: true,
          isStreaming: true,
        }),
      )
      expect(streamingLast).toContain('1/2 actions completed')
      expect(streamingLast).toContain('Fetch page')
      expect(streamingLast).toContain('Check Deployment Status')

      const midHistory = renderToStaticMarkup(
        createElement(ToolBatch, {
          tools: [
            tool({ state: 'result', toolName: 'fetch_page' }),
            tool({ state: 'output-available', toolName: 'read_file' }),
          ],
          isLastBatch: false,
          isLastMessage: false,
          isStreaming: false,
        }),
      )
      expect(midHistory).toContain('2/2 actions completed')
      expect(midHistory).not.toContain('Fetch page')
    })
  })
})
