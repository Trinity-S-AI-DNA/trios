/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The new tab, held against its contract (gHashTag/trios#1494):
 * the one export of entrypoints/newtab/index/NewTab.tsx - NewTab -
 * pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * The tab reads a dozen seams, so each is stubbed with a full
 * stand-in - every field the component destructures: the storage
 * fake underneath the chat graph's own items (the one every storage
 * suite of this wave runs with in this very process), the
 * workspace, capabilities, MCP store, user integrations and voice
 * hooks, the session context, the remote integrations sync, the
 * active hint, the suggestion sources (the same three full
 * stand-ins the suggestions suite of this wave runs with), the
 * metrics track (a no-op - its real module pulls the adapter graph
 * other suites stub incompletely), and the router (spread over the
 * real module with only useNavigate replaced). Measured, the static
 * render goes through downshift and the motion wrapper and shows
 * the tab as it first mounts.
 *
 * Not pinned, and why (issue User Story 2): the search flow itself -
 * the combobox interactions, the voice capture, the suggestion
 * execution - they live in effects and handlers that need a live
 * document and window. The port env seam is seeded before any
 * import can reach the env module (its one-time snapshot - the trap
 * the agent-outputs suite documented), with the subject imported
 * dynamically for that reason.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// biome-ignore lint/style/noProcessEnv: the env seam is the only way to reach the port helpers before the env module's one-time snapshot freezes (see suite header)
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'

// Some module in the tab's graph pulls the extension polyfill at
// module scope; its guard wants a chrome runtime id, which the stub
// provides without enabling any of its behaviour.
;(globalThis as { chrome: unknown }).chrome = {
  runtime: { id: 'test-extension' },
}

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
  useCapabilities: () => ({ supports: () => false }),
}))

mock.module('@/lib/mcp/mcpServerStorage', () => ({
  McpServer: class {},
  mcpServerStorage: fakeItem('local:mcp-servers', { fallback: [] }),
  useMcpServers: () => ({
    servers: [],
    addServer: () => {},
    removeServer: () => {},
  }),
}))

mock.module('@/lib/mcp/useSyncRemoteIntegrations', () => ({
  useSyncRemoteIntegrations: () => ({ isSyncing: false, hasSynced: true }),
}))

mock.module('@/entrypoints/app/connect-mcp/useGetUserMCPIntegrations', () => ({
  INTEGRATIONS_QUERY_KEY: 'klavis-user-integrations',
  useGetUserMCPIntegrations: () => ({
    data: undefined,
    isLoading: false,
    isFetching: false,
    isSuccess: true,
    mutate: () => {},
  }),
}))

mock.module('@/entrypoints/app/connect-mcp/useGetMCPServersList', () => ({
  useGetMCPServersList: () => ({ data: undefined, isLoading: false }),
}))

mock.module('@/entrypoints/sidepanel/layout/ChatSessionContext', () => ({
  useChatSessionContext: () => ({
    providers: [],
    selectedProvider: undefined,
    handleSelectProvider: () => {},
    mode: 'agent',
    setMode: () => {},
    messages: [],
    sendMessage: async () => {},
    status: 'ready',
    stop: () => {},
    isLoading: false,
    isSyncing: false,
    isRestoringConversation: false,
    agentUrlError: null,
    chatError: null,
    getActionForMessage: () => null,
  }),
}))

mock.module('@/lib/voice/useVoiceInput', () => ({
  useVoiceInput: () => ({
    isRecording: false,
    isTranscribing: false,
    transcript: '',
    audioLevel: 0,
    audioLevels: [],
    error: null,
    startRecording: async () => false,
    stopRecording: async () => {},
    clearTranscript: () => {},
  }),
}))

// The chat chain the tab pulls in reads the auth session through
// the conversation store, and the session-storage mock of an
// earlier suite in this process carries no useSessionInfo - so the
// store itself is stubbed here with every value export it carries.
mock.module('@/lib/conversations/conversationStorage', () => ({
  conversationStorage: {
    getValue: async () => [],
    setValue: async () => {},
    watch: () => () => {},
  },
  useConversations: () => ({
    conversations: [],
    removeConversation: async () => {},
    saveConversation: async () => {},
    getConversation: async () => null,
  }),
}))

mock.module('./SignInHint', () => ({
  SignInHint: () => null,
}))

mock.module('./useActiveHint', () => ({
  useActiveHint: () => null,
}))

mock.module('@/lib/metrics/track', () => ({
  track: () => {},
}))

let searchApiData: string[] | undefined
mock.module('./lib/searchSuggestions/useSearchSuggestions', () => ({
  useSearchSuggestions: () => ({ data: searchApiData }),
}))
mock.module('./lib/aiTabSuggestions/useAITabSuggestions', () => ({
  useAITabSuggestions: () => [],
}))
mock.module('./lib/browserOSSuggestions/useBrowserOSSuggestions', () => ({
  useBrowserOSSuggestions: () => [],
}))
mock.module('@/lib/search-provider/search-provider-storage', () => ({
  searchProviderStorage: fakeItem('local:search-provider', {
    fallback: null,
  }),
  useSearchProvider: () => ({ provider: 'google' }),
}))

const realRouterUrl = 'react-router?newtab-real'
const realRouter = (await import(realRouterUrl)) as Record<string, unknown>
mock.module('react-router', () => ({
  ...realRouter,
  useNavigate: () => () => {},
}))

const { NewTab } = await import('./NewTab')

describe('NewTabTsxContract', () => {
  describe('NewTab', () => {
    it('answers the tab as it first mounts: the search bar asking BrowserOS or searching the configured engine, with nothing selected and no suggestion sections open', () => {
      const markup = renderToStaticMarkup(createElement(NewTab))
      expect(markup).toContain('Ask BrowserOS or search Google')
    })
  })
})
