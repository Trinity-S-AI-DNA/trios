/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The connect-app nudge card, held against its contract
 * (gHashTag/trios#1582): the one export of
 * entrypoints/sidepanel/index/ConnectAppCard.tsx - ConnectAppCard -
 * pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * The card dispatches on its position: a last-message nudge opens
 * the choosing card, anything earlier resolves on the spot with the
 * suggested note. The seams it reads are stubbed in the forms this
 * group already carries - the chat-session context answers its
 * message sender, the MCP store its hook in the live-proxy module
 * form (the item resolving the storage facade at call time so later
 * suites keep reading their own seeded values), the managed-server
 * and api-key mutations idle, the declined-apps item (which rides
 * WXT's `#imports` virtual module no bun-test run resolves) a
 * plain stand-in, and the metrics track a no-op. The api-key dialog
 * the choosing card mounts stays real, closed as it first renders.
 * Measured, the choosing card answers the connect heading with its
 * reason, the connect button naming the app, and the manual button,
 * and the resolved card answers the suggested note with the app's
 * name.
 *
 * Not pinned, and why (issue User Story 2): the flows the handlers
 * own - the oauth round trip and its pending state, the api-key
 * submission, the manual decline with its declined-apps write, the
 * completion messages - live in callbacks needing a live document
 * to press. The subject is read through a query-qualified specifier
 * so this suite's graph loads as its own fresh instances.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('@/entrypoints/sidepanel/layout/ChatSessionContext', () => ({
  ChatSessionProvider: ({ children }: { children?: React.ReactNode }) =>
    children ?? null,
  useChatSessionContext: () => ({
    conversationId: 'conv-1',
    sendMessage: () => {},
  }),
}))

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

mock.module('@/entrypoints/app/connect-mcp/useAddManagedServer', () => ({
  useAddManagedServer: () => ({
    trigger: async () => ({ oauthUrl: null, apiKeyUrl: null }),
  }),
}))

mock.module('@/entrypoints/app/connect-mcp/useSubmitApiKey', () => ({
  useSubmitApiKey: () => ({
    trigger: async () => ({ success: true }),
    isMutating: false,
  }),
}))

mock.module('@/lib/declined-apps/storage', () => ({
  declinedAppsStorage: {
    getValue: async () => [],
    setValue: async () => {},
    watch: () => () => {},
  },
}))

mock.module('@/lib/metrics/track', () => ({
  track: () => {},
}))

const subjectUrl = './ConnectAppCard?connect-app-card-suite-real'
const { ConnectAppCard } = (await import(
  subjectUrl
)) as typeof import('./ConnectAppCard')

const renderCard = (isLastMessage: boolean) =>
  renderToStaticMarkup(
    createElement(ConnectAppCard, {
      data: {
        type: 'app_connection',
        appName: 'Notion',
        reason: 'Track your docs',
      },
      isLastMessage,
    }),
  )

describe('ConnectAppCardTsxContract', () => {
  describe('ConnectAppCard', () => {
    it('answers the last-message nudge with the connect heading, its reason, the connect button naming the app and the manual button, and the earlier nudge with the suggested note', () => {
      const choosing = renderCard(true)
      expect(choosing).toContain('Connect Notion for better results')
      expect(choosing).toContain('Track your docs')
      expect(choosing).toContain('Connect Notion')
      expect(choosing).toContain('Do it manually')

      const resolved = renderCard(false)
      expect(resolved).toContain('Notion suggested')
      expect(resolved).not.toContain('Connect Notion for better results')
    })
  })
})
