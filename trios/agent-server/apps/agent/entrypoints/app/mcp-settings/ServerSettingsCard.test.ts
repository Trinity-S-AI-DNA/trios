/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The MCP server settings card, held against its contract
 * (gHashTag/trios#1529): the one export of
 * entrypoints/app/mcp-settings/ServerSettingsCard.tsx -
 * ServerSettingsCard - pinned as it behaves today, so the next change
 * to that file has something to fail against.
 *
 * The card reads the BrowserOS adapter prefs, the server messaging
 * and the metrics track, so each seam is stubbed with a full
 * stand-in: the adapter (whose real module cannot initialize outside
 * a browser - the complete stand-in this wave's storage suites run
 * with, every consumer-facing method rejecting the way the real one
 * does outside the shell), the server messaging module (whose real
 * load pulls the extension polyfill, which refuses outside an
 * extension) answering both exports, and the metrics track (a no-op -
 * its real module pulls the adapter graph other suites stub
 * incompletely). Measured, the static render goes through and shows
 * the card as it first mounts: the MCP Server Settings heading with
 * its description, while the loading state answers the skeleton
 * spinner.
 *
 * Not pinned, and why (issue User Story 2): the settings flow itself
 * - the remote-access toggle with its confirm dialogs, the server
 * restart wait loop, the pref writes - they live in effects and
 * handlers that need a live document and window. The port env seam
 * is seeded before any import can reach the env module (its one-time
 * snapshot - the trap the agent-outputs suite documented), with the
 * subject imported dynamically for that reason.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// biome-ignore lint/style/noProcessEnv: the env seam is the only way to reach the port helpers before the env module's one-time snapshot freezes (see suite header)
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'

class BrowserOSAdapterStub {
  static getInstance() {
    return new BrowserOSAdapterStub()
  }
  async getPref(): Promise<never> {
    throw new Error('BrowserOS API not available')
  }
  async setPref(): Promise<never> {
    throw new Error('BrowserOS API not available')
  }
  async getVersion(): Promise<never> {
    throw new Error('BrowserOS API not available')
  }
  async getBrowserosVersion(): Promise<never> {
    throw new Error('BrowserOS API not available')
  }
  async logMetric(): Promise<never> {
    throw new Error('BrowserOS API not available')
  }
}

mock.module('@/lib/browseros/adapter', () => ({
  SCREENSHOT_SIZES: { small: 512, medium: 768, large: 1028 },
  BrowserOSAdapter: BrowserOSAdapterStub,
  getBrowserOSAdapter: () => null as never,
}))

mock.module('@/lib/messaging/server/serverMessages', () => ({
  onServerMessage: () => () => {},
  sendServerMessage: async () => ({ healthy: true }),
}))

mock.module('@/lib/metrics/track', () => ({
  track: () => {},
}))

const { ServerSettingsCard } = await import('./ServerSettingsCard')

describe('ServerSettingsCardTsxContract', () => {
  describe('ServerSettingsCard', () => {
    it('answers the card as it first mounts: the MCP Server Settings heading, the external-access switch with its label, and the restart control', () => {
      const markup = renderToStaticMarkup(
        createElement(ServerSettingsCard, {
          onServerRestart: () => {},
          onRemoteAccessChange: () => {},
        }),
      )
      expect(markup).toContain('MCP Server Settings')
      expect(markup).toContain('Configure local MCP server options')
      expect(markup).toContain('Allow External Access')
      expect(markup).toContain('Restart MCP Server')
    })
  })
})
