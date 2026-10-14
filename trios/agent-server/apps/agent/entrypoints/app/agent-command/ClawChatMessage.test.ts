/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The Claw chat message, held against its contract
 * (gHashTag/trios#1557): the one export of
 * entrypoints/app/agent-command/ClawChatMessage.tsx - ClawChatMessage -
 * pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * The component is a pure render function of the message it is
 * handed (its hooks only memoise), so the suite renders it with
 * renderToStaticMarkup - measured, the static render goes through
 * the memo components it draws (the reasoning block and the task
 * collapsible of the ai-elements family) - and the pins read the
 * plan it builds from the parts: every tool call grouped into one
 * Agent-activity card titled with its action and failure counts,
 * the text parts in place, the meta line as written, the reasoning
 * trigger naming its measured seconds, and the assistant toolbar
 * with the cost formatted by its own rules (four decimals under a
 * cent, two above) - absent for the user role.
 *
 * Not pinned, and why: the contents of the closed task collapsible
 * (the tool labels, subjects, errors and durations) and the
 * attachment card's filename - both render only when opened or
 * mounted, which needs a live document; the grouping itself is what
 * the title counts pin. No mocks at all; no suite of this job mocks
 * any module in this subject's import graph.
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ClawChatMessage } from './ClawChatMessage'

const messageFixture = (
  parts: Parameters<typeof ClawChatMessage>[0]['message']['parts'],
  over: { role?: 'assistant' | 'user'; costUsd?: number } = {},
) =>
  ({
    id: 'm1',
    role: 'assistant',
    sessionKey: 's1',
    parts,
    ...over,
  }) as Parameters<typeof ClawChatMessage>[0]['message']

const markup = (message: Parameters<typeof ClawChatMessage>[0]['message']) =>
  renderToStaticMarkup(createElement(ClawChatMessage, { message }))

describe('ClawChatMessageTsxContract', () => {
  describe('ClawChatMessage', () => {
    it('builds the render plan from the parts: tool calls grouped into one activity card with their counts, text and meta in place, the reasoning trigger naming its seconds, and the assistant cost formatted by its rules - with no toolbar for the user role', () => {
      const assistant = markup(
        messageFixture(
          [
            { type: 'text', text: 'Hello there' },
            {
              type: 'tool-call',
              name: 'web_search',
              label: 'Search the web',
              subject: 'trios docs',
              status: 'completed',
              durationMs: 1500,
            },
            {
              type: 'tool-call',
              name: 'read_file',
              label: 'Read the file',
              status: 'failed',
              error: 'not found',
            },
            {
              type: 'tool-call',
              name: 'list_dir',
              label: 'List the directory',
              status: 'completed',
            },
            { type: 'meta', label: 'Tokens', value: '128' },
            { type: 'reasoning', text: 'Thought about it', duration: 3 },
          ],
          { costUsd: 0.004 },
        ),
      )
      expect(assistant).toContain('Hello there')
      expect(
        assistant.match(/Agent activity \(3 actions, 1 failed\)/g)?.length,
      ).toBe(1)
      expect(assistant).toContain('Tokens: 128')
      expect(assistant).toContain('Thought for 3 seconds')
      expect(assistant).toContain('$0.0040')
      expect(assistant).toContain('Copy')

      const twoCents = markup(
        messageFixture([{ type: 'text', text: 'Cheap one' }], {
          costUsd: 0.02,
        }),
      )
      expect(twoCents).toContain('$0.02')

      const user = markup(
        messageFixture([{ type: 'text', text: 'User line' }], {
          role: 'user',
        }),
      )
      expect(user).toContain('User line')
      expect(user).not.toContain('Copy')
    })
  })
})
