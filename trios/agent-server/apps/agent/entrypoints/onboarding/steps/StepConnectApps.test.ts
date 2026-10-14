/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The connect-apps onboarding step, held against its contract
 * (gHashTag/trios#1551): the one export of
 * entrypoints/onboarding/steps/StepConnectApps.tsx - StepConnectApps -
 * pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * The step reads three data seams, so each is stubbed with a full
 * stand-in (every value export the module carries, checked against
 * the tree) whose answers a module-level fixture steers, and the
 * step renders with renderToStaticMarkup through its motion wrapper
 * (measured, the static render goes through). No other suite of this
 * job imports these modules, and the subject is imported dynamically
 * after the stand-ins register, so the file order cannot break the
 * load. The port env seam is seeded before any import reaches the
 * env module (the sentry pull of lib/env.ts and its one-time
 * import.meta.env snapshot - the trap the agent-outputs suite of
 * this wave documented).
 *
 * Not pinned, and why: the click paths (connecting an app through
 * the managed-server mutation, the oauth polling loop, the skip
 * telemetry) - they need a live document and window; the static pins
 * read what the step renders in each state the data seam answers:
 * the empty step with both recommended apps and the compact grid
 * behind them, the connected badge replacing the connect button for
 * an authenticated app, and the spinner while the integrations load.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// biome-ignore lint/style/noProcessEnv: the env seam is the only way to reach the port helpers before the env module's one-time snapshot freezes (see suite header)
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'

let serversFixture: Array<{ managedServerName: string }> = []
let integrationsFixture:
  | { integrations: Array<{ name: string; is_authenticated: boolean }> }
  | undefined
let loadingFixture = false

mock.module('@/lib/mcp/mcpServerStorage', () => ({
  mcpServerStorage: {
    getValue: async () => null,
    setValue: async () => {},
    watch: () => () => {},
  },
  useMcpServers: () => ({
    servers: serversFixture,
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
    data: integrationsFixture,
    isLoading: loadingFixture,
    isFetching: false,
    isSuccess: true,
    mutate: () => {},
  }),
}))

const { StepConnectApps } = await import('./StepConnectApps')

const markup = () =>
  renderToStaticMarkup(
    createElement(StepConnectApps, { direction: 1, onContinue: () => {} }),
  )

describe('StepConnectAppsTsxContract', () => {
  describe('StepConnectApps', () => {
    it('renders the step for each state the data seam answers: the apps with their connect buttons, the connected badge for an authenticated app, and the spinner while the integrations load', () => {
      serversFixture = []
      integrationsFixture = undefined
      loadingFixture = false
      const empty = markup()
      expect(empty).toContain('Connect your apps')
      expect(empty).toContain('Recommended')
      expect(empty).toContain('Gmail')
      expect(empty).toContain('Read and send emails')
      expect(empty).toContain('Google Calendar')
      expect(empty).toContain('View and manage events')
      expect(empty).toContain('More apps')
      expect(empty).toContain('40+ apps available in Settings')
      expect(empty).toContain('Skip for now')
      expect(empty.match(/>Connect<\/button>/g)?.length).toBe(2)
      expect(empty).not.toContain('Connected')

      integrationsFixture = {
        integrations: [{ name: 'Gmail', is_authenticated: true }],
      }
      const connected = markup()
      expect(connected).toContain('Connected')
      expect(connected.match(/>Connect<\/button>/g)?.length).toBe(1)

      integrationsFixture = undefined
      loadingFixture = true
      const loading = markup()
      expect(loading.match(/animate-spin/g)?.length).toBe(2)
      expect(loading).not.toContain('>Connect</button>')
    })
  })
})
