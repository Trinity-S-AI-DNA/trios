/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The new-tab chat, held against its contract
 * (gHashTag/trios#1593): the one export of
 * entrypoints/newtab/index/NewTabChat.tsx - NewTabChat - pinned as
 * it behaves today, so the next change to that file has something to
 * fail against.
 *
 * The page is a composition: the chat-actions hook feeds it, and it
 * hands everything to the real header, empty state, message list,
 * error card and footer - each pinned by its own suite, so this file
 * stubs only the seams. The hook answers the full destructure its
 * render reads, with a selected provider so the page mounts; the
 * message list's graph brings the WXT `#imports` items (declined
 * apps, ACL rules) and the MCP store, stubbed in the live-proxy
 * forms this group already carries; the render sits inside a real
 * MemoryRouter so the router's own search-params hook works
 * untouched (this file links before the message-list suite, whose
 * registrations must not be relied on here). Measured, the settled
 * mount answers the agent empty state with its heading, intro and
 * suggestion; a failed mount answers the error card's plain title;
 * and a restoring mount keeps the empty state away behind its
 * spinner.
 *
 * Not pinned, and why (issue User Story 2): every flow the
 * callbacks own - sending, mode changes, tab attaching, voice, the
 * URL-seeded initial send, the reset - needs a live document and
 * effects that run; the suggestion strings are the chat-types
 * module's own data. The subject is read through a query-qualified
 * specifier so this suite's graph loads as its own fresh instances.
 */

import { describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'

const provider = { id: 'browseros', name: 'BrowserOS', type: 'browseros' }

const actionsState: {
  messages: unknown[]
  chatError: Error | null
  isRestoringConversation: boolean
} = {
  messages: [],
  chatError: null,
  isRestoringConversation: false,
}

const voiceState = {
  isRecording: false,
  isTranscribing: false,
  audioLevels: [],
  error: null,
  onStartRecording: () => {},
  onStopRecording: () => {},
}

mock.module('@/lib/chat-actions/useChatActions', () => ({
  useChatActions: () => ({
    mode: 'agent',
    setMode: () => {},
    messages: actionsState.messages,
    sendMessage: async () => {},
    status: 'ready',
    agentUrlError: null,
    chatError: actionsState.chatError,
    getActionForMessage: undefined,
    liked: {},
    onClickLike: () => {},
    disliked: {},
    onClickDislike: () => {},
    isRestoringConversation: actionsState.isRestoringConversation,
    providers: [provider],
    selectedProvider: provider,
    handleSelectProvider: () => {},
    resetConversation: () => {},
    input: '',
    setInput: () => {},
    attachedTabs: [],
    mounted: true,
    voiceState,
    handleModeChange: () => {},
    handleStop: () => {},
    toggleTabSelection: () => {},
    removeTab: () => {},
    handleSubmit: () => {},
    handleSuggestionClick: () => {},
  }),
}))

mock.module('@/lib/metrics/track', () => ({
  track: () => {},
}))

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

// The MCP store in its live-proxy form: the item resolves the
// storage facade at call time so suites that link after this one
// keep reading their own seeded values.
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

// The declined-apps and ACL rule items ride WXT's `#imports`
// virtual module, which no bun-test run in this repo resolves (the
// CI test job runs no wxt prepare) - stubbed outright, their
// readers touching them only in handlers a static render never
// presses.
mock.module('@/lib/declined-apps/storage', () => ({
  declinedAppsStorage: {
    getValue: async () => [],
    setValue: async () => {},
    watch: () => () => {},
  },
}))

mock.module('@/lib/acl/storage', () => ({
  aclRulesStorage: {
    getValue: async () => null,
    setValue: async () => {},
    watch: () => () => {},
  },
}))

const subjectUrl = './NewTabChat?newtab-chat-suite-real'
const { NewTabChat } = (await import(
  subjectUrl
)) as typeof import('./NewTabChat')

const renderChat = () =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(
        MemoryRouter,
        { initialEntries: ['/chat'] },
        createElement(NewTabChat),
      ),
    ),
  )

describe('NewTabChatTsxContract', () => {
  describe('NewTabChat', () => {
    it('answers the settled mount with the agent empty state and its suggestion, the failed mount with the error card title, and the restoring mount with the empty state away behind its spinner', () => {
      const settled = renderChat()
      expect(settled).toContain('Agent at your service')
      expect(settled).toContain('Let AI automate tasks and browse for you')
      expect(settled).toContain('Read about our vision and upvote')
      expect(settled).not.toContain('Something went wrong')

      actionsState.chatError = new Error('boom')
      const failed = renderChat()
      expect(failed).toContain('Something went wrong')

      actionsState.chatError = null
      actionsState.isRestoringConversation = true
      const restoring = renderChat()
      expect(restoring).not.toContain('Agent at your service')
    })
  })
})
