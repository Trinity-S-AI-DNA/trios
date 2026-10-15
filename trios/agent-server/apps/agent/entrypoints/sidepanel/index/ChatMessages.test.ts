/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The sidepanel chat messages list, held against its contract
 * (gHashTag/trios#1603): the one export of
 * entrypoints/sidepanel/index/ChatMessages.tsx - ChatMessages -
 * pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * The list is a dispatcher: it segments each message through the
 * real getMessageSegments and hands every segment to the child its
 * type names - the tool batch card, the action row, the reasoning
 * and response renderers - all of which stay real with their own
 * suites. Two stub sets: the declined-apps and ACL rule items,
 * which ride WXT's `#imports` virtual module no bun-test run
 * resolves, and the MCP store in its live-proxy form. Measured,
 * the streaming list answers the assistant's approval-pending
 * batch with its waiting title, formatted tool name and approve
 * and deny buttons (through the real segmentation into the real
 * batch card), the action row for the non-last assistant message
 * with its copy, like and dislike labels, and the streaming
 * indicator with its bouncing dots; with the stream settled the
 * indicator stays away.
 *
 * Not pinned, and why (issue User Story 2): the like and copy
 * flows, the tool approval wiring and the JTBD popup interactions
 * live in callbacks needing a live document to press - the text
 * bodies ride the shared streamdown renderer, whose default stream
 * mode draws nothing in a static mount, so the batch card and the
 * action row are this file's own observable answer. The subject is
 * read through a query-qualified specifier so this suite's graph
 * loads as its own fresh instances.
 */

import { describe, expect, it, mock } from 'bun:test'
import type { UIMessage } from 'ai'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// The declined-apps and ACL rule items ride WXT's `#imports`
// virtual module, which no bun-test run in this repo resolves (the
// CI test job runs no wxt prepare) - so both items are stubbed
// outright, their readers touching them only in handlers a static
// render never presses.
mock.module('@wxt-dev/storage', () => ({
  storage: {
    defineItem: (_key: string, opts?: unknown) => ({
      getValue: async () => {
        const fallback = (opts as { fallback?: unknown } | undefined)?.fallback
        return fallback ?? null
      },
      setValue: async () => {},
      watch: () => () => {},
    }),
  },
}))

// The MCP server store in its live-proxy form: the item resolves
// the storage facade at call time so suites that link after this
// one keep reading their own seeded values.
class McpServerStub {}

mock.module('@/lib/mcp/mcpServerStorage', () => ({
  McpServer: McpServerStub,
  mcpServerStorage: {
    getValue: async () => {
      const { storage } = await import('@wxt-dev/storage')
      return storage
        .defineItem<unknown>('local:mcpServers', { fallback: [] })
        .getValue()
    },
    setValue: async (value: unknown) => {
      const { storage } = await import('@wxt-dev/storage')
      await storage
        .defineItem<unknown>('local:mcpServers', { fallback: [] })
        .setValue(value)
    },
    watch: () => () => {},
  },
  useMcpServers: () => ({
    servers: [],
    addServer: () => {},
    removeServer: () => {},
  }),
}))

const wxtVirtualItem = () => ({
  getValue: async () => null,
  setValue: async () => {},
  watch: () => () => {},
})

mock.module('@/lib/declined-apps/storage', () => ({
  declinedAppsStorage: wxtVirtualItem(),
}))

mock.module('@/lib/acl/storage', () => ({
  aclRulesStorage: wxtVirtualItem(),
}))

const subjectUrl = './ChatMessages?chat-messages-suite-real'
const { ChatMessages } = (await import(
  subjectUrl
)) as typeof import('./ChatMessages')

const messages: UIMessage[] = [
  {
    id: 'assistant-1',
    role: 'assistant',
    parts: [
      {
        type: 'tool-fetch_page',
        toolCallId: 'call-fetch',
        state: 'approval-requested',
        input: {},
        output: { metadata: {} },
        approval: { id: 'approval-1' },
      },
    ],
  } as unknown as UIMessage,
  {
    id: 'user-1',
    role: 'user',
    parts: [{ type: 'text', text: 'please continue' }],
  } as unknown as UIMessage,
]

const renderList = (status: 'streaming' | 'ready') =>
  renderToStaticMarkup(
    createElement(ChatMessages, {
      messages,
      status,
      liked: {},
      disliked: {},
      onClickLike: () => {},
      onClickDislike: () => {},
      showJtbdPopup: false,
      showDontShowAgain: false,
      onTakeSurvey: () => {},
      onDismissJtbdPopup: () => {},
    }),
  )

describe('ChatMessagesTsxContract', () => {
  describe('ChatMessages', () => {
    it('answers the streaming list with the assistant approval-pending batch card and its buttons, the action row for the non-last assistant message, and the bouncing-dots indicator, and the settled list without the indicator', () => {
      const streaming = renderList('streaming')
      expect(streaming).toContain('Waiting for approval...')
      expect(streaming).toContain('Fetch page')
      expect(streaming).toContain('Approve')
      expect(streaming).toContain('Deny')
      expect(streaming).toContain('Copy')
      expect(streaming).toContain('Like')
      expect(streaming).toContain('Dislike')
      expect(streaming).toContain('animate-bounce')

      const settled = renderList('ready')
      expect(settled).toContain('Waiting for approval...')
      expect(settled).not.toContain('animate-bounce')
    })
  })
})
