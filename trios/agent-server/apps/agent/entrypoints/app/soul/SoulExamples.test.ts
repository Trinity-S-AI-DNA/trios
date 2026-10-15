/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The soul examples, held against their contract
 * (gHashTag/trios#1553): the one export of
 * entrypoints/app/soul/SoulExamples.tsx - SoulExamples - pinned as
 * it behaves today, so the next change to that file has something to
 * fail against.
 *
 * The component reads an RPC client through its provider and sends
 * a sidepanel message, so both seams are stubbed with full
 * stand-ins (every value export each module carries, checked
 * against the tree: the provider renders its children and the hook
 * answers a stub client; the messaging module - whose real load
 * pulls the extension polyfill, which refuses outside an extension -
 * answers two no-op functions). No other suite of this job imports
 * these modules. The component renders with renderToStaticMarkup
 * inside a fresh QueryClientProvider (its react-query client is read
 * at render time). The port env seam is seeded before any import
 * reaches the env module (the sentry pull of lib/env.ts and its
 * one-time snapshot - the trap the agent-outputs suite of this
 * wave documented).
 *
 * Not pinned, and why: the click paths - trying an example into the
 * edit dialog, sending the message, resetting the soul through the
 * RPC client and the preset grid it opens - they need a live
 * document and window; the static pins read what the component
 * renders: the three example rows with their prompts and Try-it
 * buttons, the reset row, and both dialogs closed (their contents
 * absent).
 */

import { describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// biome-ignore lint/style/noProcessEnv: the env seam is the only way to reach the port helpers before the env module's one-time snapshot freezes (see suite header)
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'

mock.module('@/lib/rpc/RpcClientProvider', () => ({
  RpcClientProvider: ({ children }: { children: React.ReactNode }) => children,
  useRpcClient: () => ({
    soul: { $put: async () => {} },
  }),
}))

mock.module('@/lib/messaging/sidepanel/openSidepanelWithSearch', () => ({
  onOpenSidePanelWithSearch: () => () => {},
  openSidePanelWithSearch: () => {},
}))

const { SoulExamples } = await import('./SoulExamples')

describe('SoulExamplesTsxContract', () => {
  describe('SoulExamples', () => {
    it('renders the three example rows with their prompts and Try-it buttons, the reset row, and both dialogs closed', () => {
      const markup = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(SoulExamples),
        ),
      )
      expect(markup).toContain('Shape your agent')
      expect(markup).toContain('Set your tone')
      expect(markup).toContain('Be more casual and direct with me')
      expect(markup).toContain('Add a boundary')
      expect(markup).toContain('Never auto-close my tabs without asking')
      expect(markup).toContain('Change personality')
      expect(markup.match(/>Try it<\/button>/g)?.length).toBe(3)
      expect(markup).toContain('Reset your soul')
      expect(markup).toContain('Start fresh with one of the preset')
      expect(markup).toContain('>Reset</button>')
      expect(markup).not.toContain('Pick a personality preset')
      expect(markup).not.toContain('Customize the prompt before sending')
    })
  })
})
