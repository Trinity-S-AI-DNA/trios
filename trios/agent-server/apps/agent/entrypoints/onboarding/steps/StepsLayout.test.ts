/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The onboarding steps layout, held against its contract
 * (gHashTag/trios#1648): the one export of
 * entrypoints/onboarding/steps/StepsLayout.tsx - StepsLayout - pinned
 * as it behaves today, so the next change to that file has something
 * to fail against.
 *
 * The layout draws the step registry's progress bar and hands the
 * active step its props, so the registry, the step components and
 * the motion wrapper stay real - the first step's own heading shows
 * up through the real registry handoff. The stubs cover every seam
 * the layout and its step registry touch: the router (useParams
 * answers the first step, useNavigate a no-op, and NavLink renders a
 * plain anchor - the real one needs a live router context a static
 * render cannot provide), the metrics track, the RPC provider (a
 * passthrough with the hook stubbed), the auth client, and the
 * storage-backed item modules in their live-proxy form - mock.module
 * registrations persist for every file that links after this one,
 * so the onboarding, personalization and MCP-server items resolve
 * the storage facade at call time and later suites keep reading
 * their own seeded values. Measured, the first mount answers the
 * progress bar with all four step names and the active ring with
 * its pulse on the first step, the first step's own heading through
 * the registry handoff, and the back link.
 *
 * Not pinned, and why (issue User Story 2): the navigation itself -
 * the continue routing to the next step, the back routing, the
 * direction flip, the viewed-event tracking - lives in callbacks
 * and effects that need a live document and a real router. The
 * subject is read through a query-qualified specifier so this
 * suite's graph loads as its own fresh instances.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const realRouterUrl = 'react-router?steps-layout-real'
const realRouter = (await import(realRouterUrl)) as Record<string, unknown>

mock.module('react-router', () => ({
  ...realRouter,
  useParams: () => ({ stepId: '1' }),
  useNavigate: () => () => {},
  NavLink: ({ to, children }: { to: string; children?: React.ReactNode }) =>
    createElement('a', { href: to }, children),
}))

mock.module('@/lib/metrics/track', () => ({
  track: () => {},
}))

mock.module('@/lib/rpc/RpcClientProvider', () => ({
  RpcClientProvider: ({ children }: { children?: React.ReactNode }) =>
    children ?? null,
  useRpcClient: () => ({
    soul: { $put: async () => {} },
  }),
}))

mock.module('@/lib/auth/auth-client', () => ({
  signIn: {
    magicLink: async () => ({ error: null }),
    social: async () => ({ error: null }),
  },
  signUp: async () => ({ error: null }),
  signOut: async () => ({ error: null }),
  useSession: () => ({ data: null, isPending: false }),
}))

mock.module('@wxt-dev/storage', () => ({
  storage: {
    defineItem: () => ({
      getValue: async () => null,
      setValue: async () => {},
      watch: () => () => {},
    }),
  },
}))

// A storage item that resolves the storage facade at call time, so
// whichever suite links after this one and registers its own fake
// serves the reads of the module this mock replaces.
const proxyItem = (key: `local:${string}`, opts: { fallback: unknown }) => ({
  getValue: async () => {
    const { storage } = await import('@wxt-dev/storage')
    return storage.defineItem<unknown>(key, opts).getValue()
  },
  setValue: async (value: unknown) => {
    const { storage } = await import('@wxt-dev/storage')
    await storage.defineItem<unknown>(key, opts).setValue(value)
  },
  watch: () => () => {},
})

mock.module('@/lib/personalization/personalizationStorage', () => ({
  personalizationStorage: proxyItem('local:personalization', {
    fallback: '',
  }),
  usePersonalization: () => ({
    personalization: '',
    setPersonalization: () => {},
    clearPersonalization: async () => {},
  }),
}))

mock.module('@/lib/onboarding/onboardingStorage', () => ({
  onboardingCompletedStorage: proxyItem('local:onboardingCompleted', {
    fallback: false,
  }),
  onboardingProfileStorage: proxyItem('local:onboardingProfile', {
    fallback: null,
  }),
  importHintDismissedAtStorage: proxyItem('local:importHintDismissedAt', {
    fallback: null,
  }),
  signInHintDismissedAtStorage: proxyItem('local:signInHintDismissedAt', {
    fallback: null,
  }),
  authRedirectPathStorage: proxyItem('local:authRedirectPath', {
    fallback: null,
  }),
  firstRunConfettiShownStorage: proxyItem('local:firstRunConfettiShown', {
    fallback: false,
  }),
}))

class McpServerStub {}

mock.module('@/lib/mcp/mcpServerStorage', () => ({
  McpServer: McpServerStub,
  mcpServerStorage: proxyItem('local:mcpServers', { fallback: [] }),
  useMcpServers: () => ({
    servers: [],
    addServer: () => {},
    removeServer: () => {},
  }),
}))

mock.module('@/entrypoints/app/connect-mcp/useAddManagedServer', () => ({
  useAddManagedServer: () => ({
    trigger: async () => ({ oauthUrl: null }),
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

const subjectUrl = './StepsLayout?steps-layout-suite-real'
const { StepsLayout } = (await import(
  subjectUrl
)) as typeof import('./StepsLayout')

describe('StepsLayoutTsxContract', () => {
  describe('StepsLayout', () => {
    it('answers the first mount with the four step names on the progress bar, the active ring and pulse on the first step, the first step heading through the real registry handoff, and the back link', () => {
      const markup = renderToStaticMarkup(createElement(StepsLayout))
      expect(markup).toContain('About You')
      expect(markup).toContain('Personality')
      expect(markup).toContain('Connect Apps')
      expect(markup).toContain('Sign In')
      expect(markup).toContain('ring-4')
      expect(markup).toContain('animate-ping')
      expect(markup).toContain('Tell us about yourself')
      expect(markup).toContain('Back')
    })
  })
})
