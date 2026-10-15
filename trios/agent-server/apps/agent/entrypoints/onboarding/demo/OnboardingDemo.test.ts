/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The onboarding demo, held against its contract
 * (gHashTag/trios#1528): the one export of
 * entrypoints/onboarding/demo/OnboardingDemo.tsx - OnboardingDemo -
 * pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * The demo reads the user MCP integrations, the onboarding storage
 * and the sidepanel messaging, so each seam is stubbed with a full
 * stand-in: the integrations hook with no data, the storage fake
 * underneath the graph's own items, the metrics track (a no-op - its
 * real module pulls the adapter graph other suites stub
 * incompletely), and the messaging module (whose real load pulls the
 * extension polyfill, which refuses outside an extension) answering a
 * no-op. Measured, the static render goes through and shows the demo
 * as it first mounts: the heading, the suggestion rows, the
 * custom-task field and the skip control.
 *
 * Not pinned, and why (issue User Story 2): the task flow itself -
 * opening the sidepanel with the chosen task, the chrome tab swap,
 * the onboarding-completed write - they live in handlers that need
 * a live document and window. The port env seam is seeded before
 * any import can reach the env module (its one-time snapshot - the
 * trap the agent-outputs suite documented), with the subject
 * imported dynamically for that reason.
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

mock.module('@/lib/metrics/track', () => ({
  track: () => {},
}))

mock.module('@/lib/messaging/sidepanel/openSidepanelWithSearch', () => ({
  onOpenSidePanelWithSearch: () => () => {},
  openSidePanelWithSearch: () => {},
}))

const { OnboardingDemo } = await import('./OnboardingDemo')

describe('OnboardingDemoTsxContract', () => {
  describe('OnboardingDemo', () => {
    it('answers the demo as it first mounts: the heading, the suggestion rows with their labels, the custom-task field and the skip control', () => {
      const markup = renderToStaticMarkup(createElement(OnboardingDemo))
      expect(markup).toContain('Try your first task')
      expect(markup).toContain('top tech news today')
      expect(markup).toContain('Or type your own task')
      expect(markup).toContain('Skip and go to homepage')
    })
  })
})
