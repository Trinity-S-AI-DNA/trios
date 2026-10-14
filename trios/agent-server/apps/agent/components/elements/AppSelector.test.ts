/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The app selector, held against its contract
 * (gHashTag/trios#1536): the one export of
 * components/elements/AppSelector.tsx - AppSelector - pinned as it
 * behaves today, so the next change to that file has something to
 * fail against.
 *
 * The selector reads the MCP server store, the managed-server
 * mutations, the servers list, the user integrations and the remote
 * sync. The mutation and list hooks are stubbed with idle captures,
 * the integrations hook with no data, the sync with a settled
 * status, the metrics track (a no-op - its real module pulls the
 * adapter graph other suites stub incompletely), and the storage
 * fake underneath the graph's own items; the server store's hook
 * answers the empty list the closed mount renders, while its item
 * proxies the storage facade at call time - mock.module
 * registrations persist for every file that links after this one,
 * and the schedules suite seeds the enabled servers through this
 * very module via its OWN storage fake. Radix portals never flush
 * through a static render, so the popover kit is stubbed with a
 * portal-free stand-in that keeps the real kit's contract: the
 * trigger always renders, the content only while open. Measured,
 * the static render goes through and answers the trigger with the
 * children handed in, while the popover stays closed as the
 * selector first mounts and leaks none of its content.
 *
 * Not pinned, and why (issue User Story 2): the open popover - the
 * search box, the app list and the manage-apps control - sits behind
 * an open state the selector owns internally (no controlled prop), so
 * reaching it needs a click on a live document; the connect flow
 * itself - the api-key submission, the add wiring and its toasts -
 * lives in handlers that need the same. The port env seam is seeded
 * before any import can reach the env module (its one-time snapshot
 * - the trap the agent-outputs suite documented), with the subject
 * imported dynamically for that reason.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement, type FC, type ReactNode } from 'react'
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

// The MCP server store is mocked with a live proxy. mock.module
// registrations persist and serve every file that links after this
// one, and the schedules suite reads the enabled servers through
// this very module while seeding them via its OWN storage fake -
// so a stand-in closing over this file's own fake would starve it.
// The proxy resolves the storage facade at call time instead, and
// a later suite's own storage registration serves the reads, while
// the hook itself answers the empty list the closed mount renders.
const mcpServersStub = {
  servers: [] as never[],
  addServer: () => {},
  removeServer: () => {},
}

class McpServerStub {}

mock.module('@/lib/mcp/mcpServerStorage', () => ({
  McpServer: McpServerStub,
  mcpServerStorage: {
    getValue: async () => {
      const { storage } = await import('@wxt-dev/storage')
      return storage.defineItem('local:mcpServers', { fallback: [] }).getValue()
    },
    setValue: async (value: unknown) => {
      const { storage } = await import('@wxt-dev/storage')
      await storage
        .defineItem<unknown>('local:mcpServers', { fallback: [] })
        .setValue(value)
    },
    watch: () => () => {},
  },
  useMcpServers: () => mcpServersStub,
}))

mock.module('@/lib/mcp/useSyncRemoteIntegrations', () => ({
  useSyncRemoteIntegrations: () => ({ isSyncing: false, hasSynced: true }),
}))

mock.module('@/lib/metrics/track', () => ({
  track: () => {},
}))

mock.module('@/entrypoints/app/connect-mcp/useAddManagedServer', () => ({
  useAddManagedServer: () => ({
    trigger: async () => ({ oauthUrl: null, apiKeyUrl: null }),
  }),
}))

mock.module('@/entrypoints/app/connect-mcp/useGetMCPServersList', () => ({
  useGetMCPServersList: () => ({
    data: { servers: [] },
    isLoading: false,
    refetch: async () => ({ data: { servers: [] } }),
  }),
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

mock.module('@/entrypoints/app/connect-mcp/useSubmitApiKey', () => ({
  useSubmitApiKey: () => ({
    trigger: async () => ({ success: true }),
    isMutating: false,
  }),
}))

let popoverOpen = false
mock.module('@/components/ui/popover', () => ({
  Popover: ({
    open,
    children,
  }: {
    open?: boolean
    children?: React.ReactNode
  }) => {
    popoverOpen = !!open
    return children ?? null
  },
  // every value export the real kit carries - the facade freezes at
  // the first link, and later suites' subjects import PopoverAnchor
  PopoverAnchor: () => null,
  PopoverContent: ({ children }: { children?: React.ReactNode }) =>
    popoverOpen ? children : null,
  PopoverTrigger: ({ children }: { children?: React.ReactNode }) =>
    children ?? null,
}))

// The subject is read through a query-qualified specifier so this
// suite's graph loads as its own fresh module instances instead of
// through the shared cache the earlier files of the group already
// populated: the shared seams below bind to this file's own
// registrations for this render, whatever the files before it left
// live.
const subjectUrl = './AppSelector?app-selector-suite-real'
const { AppSelector } = (await import(
  subjectUrl
)) as typeof import('./AppSelector')

// The subject's props make children required, and createElement's
// typing only accepts children as its third argument when the props
// type leaves them optional - so the alias loosens exactly that,
// while the render below still hands the children the way React
// canonically takes them.
const Subject = AppSelector as FC<{
  side?: 'top' | 'bottom' | 'left' | 'right'
  children?: ReactNode
}>

describe('AppSelectorTsxContract', () => {
  describe('AppSelector', () => {
    it('answers the trigger with the children handed in, while the closed selector hides its content', () => {
      const markup = renderToStaticMarkup(
        createElement(Subject, { side: 'top' }, 'OPEN-APPS-TRIGGER'),
      )
      expect(markup).toContain('OPEN-APPS-TRIGGER')
      expect(markup).not.toContain('Search apps...')
      expect(markup).not.toContain('Connect apps')
    })
  })
})
