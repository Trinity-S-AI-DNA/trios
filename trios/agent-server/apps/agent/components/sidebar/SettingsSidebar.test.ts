/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The settings sidebar, held against its contract
 * (gHashTag/trios#1595): the one export of
 * components/sidebar/SettingsSidebar.tsx - SettingsSidebar -
 * pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * The sidebar draws its whole nav from inline data, so with the
 * capabilities seam answering full support every section and item
 * shows: the suite stubs that hook (supports always true - the
 * filtering the real hook drives is the capabilities module's own
 * contract) and the router's NavLink (the real one needs a live
 * router context a static render cannot provide; it answers a
 * plain anchor through a spread-real read keeping every other
 * export). The theme toggle stays real. Measured, the first mount
 * answers the back link, the settings heading, both provider
 * sections with all their items, and the help section with its
 * three entries - the docs one as an external link.
 *
 * Not pinned, and why (issue User Story 2): the navigation itself
 * - which route each entry opens, the active-state styling the
 * router drives, the theme toggle's own flow - needs a live
 * document with a real router; the feature-gated items render here
 * because the stub answers full support, the gating logic being
 * the capabilities hook's own contract. The subject is read
 * through a query-qualified specifier so this suite's graph loads
 * as its own fresh instances.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const realRouterUrl = 'react-router?settings-sidebar-real'
const realRouter = (await import(realRouterUrl)) as Record<string, unknown>

mock.module('react-router', () => ({
  ...realRouter,
  NavLink: ({ to, children }: { to: string; children?: React.ReactNode }) =>
    createElement('a', { href: to }, children),
}))

mock.module('@/lib/browseros/useCapabilities', () => ({
  useCapabilities: () => ({ supports: () => true }),
}))

mock.module('@wxt-dev/storage', () => ({
  storage: {
    defineItem: (_key: string, opts?: unknown) => ({
      getValue: async () => {
        const fallback = (opts as { fallback?: unknown } | undefined)?.fallback
        return fallback ?? null
      },
      setValue: async () => {},
      watch: () => () => {},
    }),
  },
}))

// The theme item in its live-proxy form: it resolves the storage
// facade at call time, so suites that link after this one keep
// reading their own seeded values.
mock.module('@/lib/theme/theme-storage', () => ({
  themeStorage: {
    getValue: async () => {
      const { storage } = await import('@wxt-dev/storage')
      return storage
        .defineItem<unknown>('local:theme', { fallback: 'system' })
        .getValue()
    },
    setValue: async (value: unknown) => {
      const { storage } = await import('@wxt-dev/storage')
      await storage
        .defineItem<unknown>('local:theme', { fallback: 'system' })
        .setValue(value)
    },
    watch: () => () => {},
  },
}))

const subjectUrl = './SettingsSidebar?settings-sidebar-suite-real'
const { SettingsSidebar } = (await import(
  subjectUrl
)) as typeof import('./SettingsSidebar')

describe('SettingsSidebarTsxContract', () => {
  describe('SettingsSidebar', () => {
    it('answers the first mount with the back link, the settings heading, both nav sections with all their items, and the help section with its three entries', () => {
      const markup = renderToStaticMarkup(createElement(SettingsSidebar))
      expect(markup).toContain('Back')
      expect(markup).toContain('Settings')
      expect(markup).toContain('Provider Settings')
      expect(markup).toContain('BrowserOS AI')
      // the ampersand escapes in static markup, so the pin skips it
      expect(markup).toContain('Council Provider')
      expect(markup).toContain('Search Provider')
      expect(markup).toContain('Other')
      expect(markup).toContain('Customize BrowserOS')
      expect(markup).toContain('Tool Approvals')
      expect(markup).toContain('BrowserOS as MCP')
      expect(markup).toContain('ACL Rules')
      expect(markup).toContain('Billing')
      expect(markup).toContain('Help')
      expect(markup).toContain('Docs')
      expect(markup).toContain('Features')
      expect(markup).toContain('Revisit Onboarding')
    })
  })
})
