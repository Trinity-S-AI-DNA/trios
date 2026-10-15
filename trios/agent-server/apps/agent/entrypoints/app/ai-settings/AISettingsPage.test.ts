/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The AI settings page, held against its contract
 * (gHashTag/trios#1504): the one export of
 * entrypoints/app/ai-settings/AISettingsPage.tsx - AISettingsPage -
 * pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * The page reads the provider store, the session, the agent server
 * URL and two graphql queries, so each seam is stubbed with a full
 * stand-in: the providers hook (empty list, no default), the
 * graphql query and mutation hooks (no data, idle mutation), the
 * session info (no user), the agent server URL (no base URL), the
 * metrics track (a no-op - its real module pulls the adapter graph
 * other suites stub incompletely), and the storage fake underneath
 * the graph's own items. Measured, the static render goes through
 * and shows the page as it first mounts.
 *
 * Not pinned, and why (issue User Story 2): the settings flow
 * itself - adding, editing, testing and deleting providers, the
 * remote incomplete-provider sync, the dialogs - they live in
 * handlers that need a live document and window. The port env
 * seam is seeded before any import can reach the env module (its
 * one-time snapshot - the trap the agent-outputs suite
 * documented), with the subject imported dynamically for that
 * reason.
 */

import { describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

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

mock.module('@/lib/llm-providers/useLlmProviders', () => ({
  useLlmProviders: () => ({
    providers: [],
    defaultProviderId: '',
    selectedProvider: null,
    isLoading: false,
    saveProvider: async () => {},
    setDefaultProvider: async () => {},
    deleteProvider: async () => {},
  }),
}))

// The session seam is re-registered as a spread of the real module
// (query-imported, so it never collides with the mock registry)
// with only the hook stubbed: earlier suites of this group link the
// facade with a stand-in that carries no useSessionInfo, and bun
// freezes the facade's export set at that first link - a spread of
// the real module restores the full export set for this suite's
// import.
const realSessionUrl = '@/lib/auth/sessionStorage?ai-settings-real'
const realSession = (await import(realSessionUrl)) as Record<string, unknown>
mock.module('@/lib/auth/sessionStorage', () => ({
  ...realSession,
  useSessionInfo: () => ({ sessionInfo: {}, isLoading: false }),
}))

mock.module('@/lib/browseros/useBrowserOSProviders', () => ({
  useAgentServerUrl: () => ({
    baseUrl: null,
    isLoading: false,
    error: null,
  }),
}))

mock.module('@/lib/graphql/useGraphqlQuery', () => ({
  useGraphqlQuery: () => ({ data: undefined, isLoading: false }),
}))

mock.module('@/lib/graphql/useGraphqlMutation', () => ({
  useGraphqlMutation: () => ({ mutate: () => {}, isPending: false }),
}))

mock.module('@/lib/metrics/track', () => ({
  track: () => {},
}))

// Some child of the page reads the router context - the real module
// is spread with only the hook replaced.
const realRouterUrl = 'react-router?ai-settings-real'
const realRouter = (await import(realRouterUrl)) as Record<string, unknown>
mock.module('react-router', () => ({
  ...realRouter,
  useNavigate: () => () => {},
}))

// The subject is read through a query-qualified specifier so this
// suite's page graph loads as its own fresh module instances - the
// shared session-storage seam keeps whichever mock an earlier suite
// of this group registered for ITS consumers, instead of colliding
// through a shared cache.
const subjectUrl = './AISettingsPage?ai-settings-suite-real'
const { AISettingsPage } = (await import(
  subjectUrl
)) as typeof import('./AISettingsPage')

describe('AISettingsPageTsxContract', () => {
  describe('AISettingsPage', () => {
    it('answers the settings page as it first mounts: the framed page with its providers heading', () => {
      const markup = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(AISettingsPage),
        ),
      )
      expect(markup).toContain('fade-in')
      expect(markup).toContain('LLM Providers')
    })
  })
})
