/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The agent-command conversation message, held against its
 * contract (gHashTag/trios#1569): the one export of
 * entrypoints/app/agent-command/ConversationMessage.tsx -
 * ConversationMessage - pinned as it behaves today, so the next
 * change to that file has something to fail against.
 *
 * The message is a render plan over the turn: the user text in
 * its bubble, the thinking part behind the reasoning collapsible,
 * the text parts through the streamdown-backed response renderer,
 * every tool-batch part collapsed into one task entry carrying the
 * aggregated tools in arrival order, the produced-files strip, and
 * the bouncing-dots placeholder for the streaming turn with no
 * parts yet. No module is mocked here at all: the strip's
 * turn-files fallback rides a real query client the way the
 * outputs-rail suite mounts it, and the kits stay real.
 *
 * Measured, the done thinking part answers the closed reasoning
 * trigger with its Thought-for-a-few-seconds label, the assistant
 * text draws nothing (the shared streamdown renderer's default
 * stream mode mounts empty - the same measured reality the
 * ChatMessages suite pins), the task with a running tool answers
 * the Working title with the wrench trigger and every tool row
 * with its status icon, subject and measured duration, and the
 * produced file answers the strip with its name and size; the
 * streaming empty turn answers the bot avatar with exactly three
 * bouncing dots; the strip-only mount answers the strip alone; and
 * a done turn collapses the task behind the singular Agent
 * activity title with its rows away.
 *
 * Not pinned, and why (issue User Story 2): the strip's card and
 * rail callbacks live in handlers needing a live document to
 * press. The subject is read through a query-qualified specifier
 * so this suite's graph loads as its own fresh instances.
 */

import { describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  AgentConversationTurn,
  ToolEntry,
} from '@/lib/agent-conversations/types'

const subjectUrl = './ConversationMessage?conversation-message-suite-real'
const { ConversationMessage } = (await import(
  subjectUrl
)) as typeof import('./ConversationMessage')

const queryClient = new QueryClient()

const markup = (
  turn: AgentConversationTurn,
  streaming: boolean,
  stripOnly?: boolean,
) =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ConversationMessage, { turn, streaming, stripOnly }),
    ),
  )

const tool = (over: Partial<ToolEntry> & { id: string }): ToolEntry => ({
  name: 'tool',
  label: 'Tool',
  status: 'completed',
  ...over,
})

const file = { id: 'f1', path: '/tmp/report.md', size: 1024, mtimeMs: 1 }

const turn = (over: Partial<AgentConversationTurn>): AgentConversationTurn => ({
  id: 'turn-1',
  turnId: 'turn-1',
  userText: 'USER TEXT LINE',
  parts: [],
  done: false,
  timestamp: 1,
  ...over,
})

describe('ConversationMessageTsxContract', () => {
  describe('ConversationMessage', () => {
    it('answers the live turn with the user text, the closed done-thinking trigger, the working task with every tool row, and the produced file strip, and keeps the streamdown text and the placeholder away', () => {
      const live = markup(
        turn({
          parts: [
            { kind: 'thinking', text: 'THINKING LINE', done: true },
            { kind: 'text', text: 'ASSISTANT TEXT LINE' },
            {
              kind: 'tool-batch',
              tools: [
                tool({
                  id: 'a',
                  name: 'fetch',
                  label: 'Fetch page',
                  subject: 'example.com',
                  status: 'completed',
                  durationMs: 1500,
                }),
                tool({
                  id: 'b',
                  name: 'shell',
                  label: 'Run shell',
                  status: 'running',
                }),
                tool({
                  id: 'c',
                  name: 'save',
                  label: 'Save file',
                  status: 'error',
                  durationMs: 250,
                }),
              ],
            },
          ],
          producedFiles: [file],
        }),
        true,
      )
      expect(live).toContain('USER TEXT LINE')
      expect(live).toContain('Thought for a few seconds')
      expect(live).toContain('data-state="closed"')
      expect(live).not.toContain('ASSISTANT TEXT LINE')
      expect(live).toContain('Working… (3 actions)')
      expect(live).toContain('lucide-wrench')
      expect(live).toContain('Fetch page')
      expect(live).toContain('· example.com')
      expect(live).toContain('1.5s')
      expect(live).toContain('Run shell')
      expect(live).toContain('Save file')
      expect(live).toContain('lucide-loader-circle')
      expect(live).toContain('lucide-circle-check')
      expect(live).toContain('lucide-circle-x')
      expect(live).toContain('File produced')
      expect(live).toContain('report.md')
      expect(live).toContain('1.0 KB')
      expect(live.split('animate-bounce').length - 1).toBe(0)
    })

    it('answers the streaming turn with no parts yet with the bot avatar and exactly three bouncing dots', () => {
      const waiting = markup(turn({ userText: 'q' }), true)
      expect(waiting).toContain('lucide-bot')
      expect(waiting.split('animate-bounce').length - 1).toBe(3)
      expect(waiting).toContain('>q<')
      expect(waiting).not.toContain('File produced')
    })

    it('answers the strip-only mount with the strip alone: the user text and the task stay away', () => {
      const strip = markup(
        turn({
          parts: [
            {
              kind: 'tool-batch',
              tools: [tool({ id: 'a', label: 'Fetch page' })],
            },
          ],
          producedFiles: [file],
        }),
        false,
        true,
      )
      expect(strip).toContain('File produced')
      expect(strip).toContain('report.md')
      expect(strip).not.toContain('USER TEXT LINE')
      expect(strip).not.toContain('lucide-wrench')
    })

    it('answers the done turn with the singular activity title and the task rows collapsed away', () => {
      const done = markup(
        turn({
          done: true,
          parts: [
            {
              kind: 'tool-batch',
              tools: [tool({ id: 'a', label: 'Fetch page', durationMs: 1500 })],
            },
          ],
        }),
        false,
      )
      expect(done).toContain('Agent activity (1 action)')
      expect(done).not.toContain('Fetch page')
    })
  })
})
