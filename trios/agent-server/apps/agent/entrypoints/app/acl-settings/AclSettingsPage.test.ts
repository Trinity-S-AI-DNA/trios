/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The ACL settings page, held against its contract
 * (gHashTag/trios#1644): the single export of
 * entrypoints/app/acl-settings/AclSettingsPage.tsx - AclSettingsPage -
 * pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * renderToStaticMarkup never runs effects, so the page answers in its
 * initial state - an empty rule list - and that is the whole static
 * surface: the header, the Add Rule button, and the empty state with
 * its guidance and the first-rule button. Not pinned: the rule list
 * (it arrives through the storage watch the effect installs), the
 * server bootstrap, the save/toggle/delete handlers, and the toast -
 * effects and event handlers do not run in a static render.
 *
 * The seams: the virtual `#imports` module (WXT's bundler alias, which
 * bun does not resolve) is stubbed with the storage item factory the
 * repository's other store shims use; the agent-server URL hook answers
 * the same null base the NewProviderDialog and file-preview-sheet
 * suites stub it with (isLoading false is falsy the same way their
 * absent field is).
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const values = new Map<string, unknown>()

mock.module('#imports', () => ({
  storage: {
    defineItem: (
      key: string,
      options?: { fallback?: unknown } & Record<string, unknown>,
    ) => ({
      getValue: async () => {
        if (values.has(key)) return values.get(key)
        return options && 'fallback' in options ? options.fallback : null
      },
      setValue: async (value: unknown) => {
        values.set(key, value)
      },
      watch: () => () => {},
    }),
  },
}))

mock.module('@/lib/browseros/useBrowserOSProviders', () => ({
  useAgentServerUrl: () => ({ baseUrl: null, isLoading: false }),
}))

const { AclSettingsPage } = await import('./AclSettingsPage')

const markup = () => renderToStaticMarkup(createElement(AclSettingsPage))

describe('aclSettingsPageContract', () => {
  it('answers the page header with its description', () => {
    const m = markup()
    expect(m).toContain('ACL Rules')
    expect(m).toContain(
      'Describe what the agent should avoid on a site and BrowserOS will block matching actions.',
    )
  })

  it('answers the empty state with its guidance and both add buttons', () => {
    const m = markup()
    expect(m).toContain('No ACL rules defined')
    expect(m).toContain('payments and checkout')
    expect(m).toContain('send email')
    expect(m).toContain('Add your first rule')
    expect(m).toContain('lucide-shield-alert')
    expect((m.match(/lucide-plus/g) ?? []).length).toBe(2)
  })

  it('answers the empty state in its dashed frame', () => {
    const m = markup()
    expect(m).toContain('rounded-xl border border-dashed p-12 text-center')
  })
})
