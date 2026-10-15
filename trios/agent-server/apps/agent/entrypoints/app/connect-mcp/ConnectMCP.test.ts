/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The connect-MCP page, held against its contract
 * (gHashTag/trios#1519): the one export of
 * entrypoints/app/connect-mcp/ConnectMCP.tsx - ConnectMCP - pinned
 * as it behaves today, so the next change to that file has something
 * to fail against.
 *
 * The page reads the MCP server store, the managed-server mutations,
 * the servers list, the user integrations and the remote sync, so
 * each seam is stubbed with a full stand-in: the store with an
 * empty server list and its mutators, the four mutation/list hooks
 * with idle captures, the integrations hook with no data, the sync
 * with a settled status, the metrics track (a no-op - its real module
 * pulls the adapter graph other suites stub incompletely), and the
 * storage fake underneath the graph's own items. Measured, the
 * static render goes through and shows the page as it first mounts:
 * the Connected Apps heading with its add controls.
 *
 * Not pinned, and why (issue User Story 2): the connect flow itself -
 * the auth navigation (window.open), the api-key submission, the
 * add/remove wiring and its toasts - they live in handlers that need
 * a live document and window. The port env seam is seeded before any
 * import can reach the env module (its one-time snapshot - the trap
 * the agent-outputs suite documented), with the subject imported
 * dynamically for that reason.
 */

import { describe, expect, it, mock } from 'bun:test'
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

mock.module('@/lib/metrics/track', () => ({
  track: () => {},
}))

mock.module('./useAddManagedServer', () => ({
  useAddManagedServer: () => ({
    trigger: async () => ({ oauthUrl: null, apiKeyUrl: null }),
  }),
}))

mock.module('./useRemoveManagedServer', () => ({
  useRemoveManagedServer: () => ({
    trigger: async () => ({ success: true }),
  }),
}))

mock.module('./useSubmitApiKey', () => ({
  useSubmitApiKey: () => ({
    trigger: async () => ({ success: true }),
    isMutating: false,
  }),
}))

mock.module('./useGetMCPServersList', () => ({
  useGetMCPServersList: () => ({
    data: { servers: [] },
    isLoading: false,
    refetch: async () => ({ data: { servers: [] } }),
  }),
}))

mock.module('./useGetUserMCPIntegrations', () => ({
  INTEGRATIONS_QUERY_KEY: 'klavis-user-integrations',
  useGetUserMCPIntegrations: () => ({
    data: undefined,
    isLoading: false,
    isFetching: false,
    isSuccess: true,
    mutate: () => {},
  }),
}))

const { ConnectMCP } = await import('./ConnectMCP')

describe('ConnectMCPTsxContract', () => {
  describe('ConnectMCP', () => {
    it('answers the page as it first mounts: the Connected Apps heading with its two add controls', () => {
      const markup = renderToStaticMarkup(createElement(ConnectMCP))
      expect(markup).toContain('Connected Apps')
      expect(markup).toContain('Add built-in app')
      expect(markup).toContain('Add custom app')
    })
  })
})
