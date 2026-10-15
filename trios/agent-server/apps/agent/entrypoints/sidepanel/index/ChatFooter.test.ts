/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The sidepanel chat footer, held against its contract
 * (gHashTag/trios#1563): the one export of
 * entrypoints/sidepanel/index/ChatFooter.tsx - ChatFooter - pinned
 * as it behaves today, so the next change to that file has something
 * to fail against.
 *
 * The footer reads five seams, so each is stubbed with a full
 * stand-in (every field the consumers destructure - the workspace
 * hook with its folders and mutators, the capabilities hook, the
 * MCP server store and the user integrations behind the app
 * selector, and the @wxt-dev/storage fake underneath the chat
 * graph's own storage items, the fake every storage suite of this
 * wave runs with in this very process). The child components stay
 * real. Measured, the static render goes through - the effects that
 * touch chrome.tabs, document focus and the selected-text store
 * never run in a static render, so the footer answers as it first
 * mounts.
 *
 * Not pinned, and why (issue User Story 2): the input's own
 * behaviour, the tab-mention and the dismiss paths - they live in
 * the child input and in effects that need a live document and
 * window. The port env seam is seeded before any import can reach
 * the env module (its one-time snapshot - the trap the
 * agent-outputs suite documented), with the subject imported
 * dynamically for that reason.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { VoiceInputState } from '@/lib/voice/useVoiceInput'

// biome-ignore lint/style/noProcessEnv: the env seam is the only way to reach the port helpers before the env module's one-time snapshot freezes (see suite header)
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'

const values = new Map<string, unknown>()

const fakeItem = (key: string, opts: unknown) => ({
  getValue: async () => {
    if (values.has(key)) {
      return values.get(key)
    }
    const fallback = (opts as { fallback?: unknown } | undefined)?.fallback
    return fallback ?? null
  },
  setValue: async (value: unknown) => {
    values.set(key, value)
  },
  watch: () => () => {},
})

mock.module('@wxt-dev/storage', () => ({
  storage: {
    defineItem: (key: string, opts?: unknown) => fakeItem(key, opts),
  },
}))

let serversFixture: Array<{
  id: string
  displayName: string
  type: string
  managedServerName?: string
  managedServerDescription?: string
}> = []
let integrationsFixture: {
  integrations: Array<{ name: string; is_authenticated: boolean }>
} | null = null

mock.module('@/lib/workspace/use-workspace', () => ({
  useWorkspace: () => ({
    recentFolders: [],
    selectedFolder: null,
    selectFolder: () => {},
    addFolder: () => {},
    removeFolder: () => {},
    clearSelection: () => {},
  }),
}))

mock.module('@/lib/browseros/useCapabilities', () => ({
  useCapabilities: () => ({ supports: () => true }),
}))

mock.module('@/lib/mcp/mcpServerStorage', () => ({
  McpServer: class {},
  mcpServerStorage: fakeItem('local:mcp-servers', { fallback: [] }),
  useMcpServers: () => ({
    servers: serversFixture,
    addServer: () => {},
    removeServer: () => {},
  }),
}))

mock.module('@/entrypoints/app/connect-mcp/useGetUserMCPIntegrations', () => ({
  INTEGRATIONS_QUERY_KEY: 'klavis-user-integrations',
  useGetUserMCPIntegrations: () => ({
    data: integrationsFixture,
    isLoading: false,
    isFetching: false,
    isSuccess: true,
    mutate: () => {},
  }),
}))

const { ChatFooter } = await import('./ChatFooter')

const voiceErrorFixture: VoiceInputState = {
  isRecording: false,
  isTranscribing: false,
  audioLevels: [],
  error: 'Mic blocked',
  onStartRecording: () => {},
  onStopRecording: () => {},
}

const markup = (
  over: { attachedTabs?: chrome.tabs.Tab[]; voice?: boolean } = {},
) =>
  renderToStaticMarkup(
    createElement(ChatFooter, {
      mode: 'agent',
      onModeChange: () => {},
      input: 'hello',
      onInputChange: () => {},
      onSubmit: () => {},
      status: 'ready',
      onStop: () => {},
      attachedTabs: over.attachedTabs ?? [],
      onToggleTab: () => {},
      onRemoveTab: () => {},
      voice: over.voice ? voiceErrorFixture : undefined,
    }),
  )

describe('ChatFooterTsxContract', () => {
  describe('ChatFooter', () => {
    it('answers the footer with its controls: the attach-tabs trigger with its count, the workspace and app selectors, the connected-app icons with their overflow, and the voice error when there is one', () => {
      serversFixture = []
      integrationsFixture = null
      const bare = markup()
      expect(bare).toContain('Attach tabs (@)')
      expect(bare).toContain('Select workspace folder')
      expect(bare).toContain('Connect apps')

      const withTabs = markup({
        attachedTabs: [
          { id: 1 } as chrome.tabs.Tab,
          { id: 2 } as chrome.tabs.Tab,
        ],
      })
      expect(withTabs).toContain('>2<')

      serversFixture = ['Gmail', 'Slack', 'Notion', 'GitHub'].map(
        (name, index) => ({
          id: `server-${index}`,
          displayName: name,
          type: 'managed',
          managedServerName: name,
          managedServerDescription: `${name} integration`,
        }),
      )
      integrationsFixture = {
        integrations: ['Gmail', 'Slack', 'Notion', 'GitHub'].map((name) => ({
          name,
          is_authenticated: true,
        })),
      }
      const connected = markup()
      expect(connected).toContain('+1')

      const withVoiceError = markup({ voice: true })
      expect(withVoiceError).toContain('Mic blocked')
    })
  })
})
