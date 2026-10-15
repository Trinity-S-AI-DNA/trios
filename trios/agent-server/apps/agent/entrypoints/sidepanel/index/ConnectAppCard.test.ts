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
 * The card is a phase machine: the last message's nudge opens the
 * choosing card (plug icon, connect title, reason line, Connect and
 * Do-it-manually buttons) while every earlier nudge stands resolved
 * (check mark and the "suggested" line); the oauth-pending phase, the
 * api-key dialog and every handler live in callbacks a static render
 * never presses. Three stub sets ride modules no bun-test run
 * resolves or renders safely: the WXT storage facade with the
 * declined-apps and MCP store items in their live-proxy form, and
 * the chat session context whose real provider throws outside a
 * live session. The dialog kit, the SWR mutation hooks, the toast,
 * metrics and sentry callers all stay real - a closed Radix dialog
 * mounts nothing in a static render and the hooks are never fired.
 *
 * Measured, the choosing card answers the app name and reason in its
 * title line, both action buttons without the connecting disable, and
 * the plug icon; the resolved card answers the check mark with the
 * "suggested" line and keeps the choosing buttons away; and a nudge
 * without an app name falls back to App in title and button.
 *
 * Not pinned, and why (issue User Story 2): the connect flow's
 * oauth/api-key dispatch, the manual decline writing the declined
 * list, and the api-key submit live in button handlers needing a
 * live document to press - the static mount is this file's own
 * observable answer. The subject is read through a query-qualified
 * specifier so this suite's graph loads as its own fresh instances.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { NudgeData } from './getMessageSegments'

// The declined-apps and MCP store items ride WXT's storage facade,
// which no bun-test run in this repo resolves (the CI test job runs
// no wxt prepare) - so the facade is stubbed with a fallback-honoring
// item and both stores in their live-proxy form, their readers
// touching them only in handlers a static render never presses.
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

// The chat session context: its real provider runs the live chat
// session and its real reader throws outside a provider, so the
// reader answers the sibling suites' session shape - the card only
// stores sendMessage for handlers a static render never presses.
mock.module('../layout/ChatSessionContext', () => ({
  ChatSessionProvider: ({ children }: { children?: React.ReactNode }) =>
    children ?? null,
  useChatSessionContext: () => ({
    conversationId: 'conv-1',
    sendMessage: () => {},
  }),
}))

const subjectUrl = './ConnectAppCard?connect-app-card-suite-real'
const { ConnectAppCard } = (await import(
  subjectUrl
)) as typeof import('./ConnectAppCard')

const nudge = (fields: Record<string, unknown>): NudgeData =>
  ({ type: 'app_connection', ...fields }) as NudgeData

const markup = (data: NudgeData, isLastMessage: boolean) =>
  renderToStaticMarkup(createElement(ConnectAppCard, { data, isLastMessage }))

describe('ConnectAppCardTsxContract', () => {
  describe('ConnectAppCard', () => {
    it('answers the last message nudge with the choosing card: title and reason line, plug icon, and the Connect and Do it manually buttons without the connecting disable', () => {
      const choosing = markup(
        nudge({ appName: 'GitHub', reason: 'Reason line' }),
        true,
      )
      expect(choosing).toContain('Connect GitHub for better results')
      expect(choosing).toContain('Reason line')
      expect(choosing).toContain('lucide-plug')
      expect(choosing).toContain('>Connect GitHub<')
      expect(choosing).toContain('>Do it manually<')
      expect(choosing).not.toContain('disabled=')
      expect(choosing).not.toContain('suggested')
    })

    it('answers an earlier message nudge with the resolved card: check mark and the suggested line, and keeps the choosing buttons away', () => {
      const resolved = markup(nudge({ appName: 'Notion' }), false)
      expect(resolved).toContain('lucide-check')
      expect(resolved).toContain('Notion suggested')
      expect(resolved).not.toContain('Connect Notion for better results')
      expect(resolved).not.toContain('>Do it manually<')
    })

    it('falls back to App in title and button when the nudge carries no app name, and draws no reason line', () => {
      const bare = markup(nudge({}), true)
      expect(bare).toContain('Connect App for better results')
      expect(bare).toContain('>Connect App<')
      expect(bare).not.toContain('Reason line')
    })
  })
})
