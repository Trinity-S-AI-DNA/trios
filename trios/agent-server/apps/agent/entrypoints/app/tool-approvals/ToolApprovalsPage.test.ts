/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The tool approvals page, held against its contract
 * (gHashTag/trios#1669): the single export of
 * entrypoints/app/tool-approvals/ToolApprovalsPage.tsx - ToolApprovalsPage -
 * pinned as it behaves today, so the next change to that file has something
 * to fail against.
 *
 * renderToStaticMarkup never runs effects, so the page renders in its
 * initial state: an empty config, every switch unchecked, the toggle-all
 * switch unchecked. That is exactly the shape pinned here. Not pinned: the
 * storage watch and the toggle write paths - effects and event handlers do
 * not run in a static render, and pinning them would mean re-implementing
 * the store.
 *
 * The @wxt-dev/storage seam is an in-memory shim: the real module refuses to
 * load outside a web extension, and the subject's import chain reaches it.
 * The shim is the same shape the repository's other store suites use; every
 * suite asserts only on its own map.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const values = new Map<string, unknown>()

mock.module('@wxt-dev/storage', () => ({
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

const { ToolApprovalsPage } = await import('./ToolApprovalsPage')
const { TOOL_CATEGORIES } = await import('@/lib/tool-approvals/types')

const CATEGORY_ICON_CLASSES: Record<string, string> = {
  input: 'lucide-mouse-pointer-click',
  navigation: 'lucide-navigation',
  observation: 'lucide-eye',
  screenshots: 'lucide-camera',
  scripts: 'lucide-code',
  'data-modification': 'lucide-database',
  assistant: 'lucide-bot',
}

const markup = () => renderToStaticMarkup(createElement(ToolApprovalsPage))

describe('toolApprovalsPageContract', () => {
  it('answers the page frame with its heading and the immediate-apply note', () => {
    const m = markup()
    expect(m).toContain('Tool Approvals')
    expect(m).toContain('Changes apply immediately')
  })

  it('answers the toggle-all row, unchecked while no category is enabled', () => {
    const m = markup()
    expect(m).toContain('Require approval for all')
    expect(m).toContain('Toggle all categories at once')
    expect(m).toContain('data-state="unchecked"')
    expect(m).not.toContain('data-state="checked"')
    expect(m).not.toContain('aria-checked="true"')
  })

  it('answers one row per known category, each with its name, description and an unchecked switch', () => {
    const m = markup()
    const escaped = (text: string) =>
      text
        .replace(/&/g, '&' + 'amp;')
        .replace(/</g, '&' + 'lt;')
        .replace(/>/g, '&' + 'gt;')
    for (const category of TOOL_CATEGORIES) {
      expect(m).toContain(escaped(category.name))
      expect(m).toContain(escaped(category.description))
    }
    const switches = m.match(/role="switch"/g) ?? []
    expect(switches.length).toBe(TOOL_CATEGORIES.length + 1)
  })

  it('answers the fixed category icon set', () => {
    const m = markup()
    for (const iconClass of Object.values(CATEGORY_ICON_CLASSES)) {
      expect(m).toContain(iconClass)
      expect(m).toContain(`lucide ${iconClass}`)
    }
    const icons = m.match(/class="lucide /g) ?? []
    expect(icons.length).toBe(TOOL_CATEGORIES.length)
  })
})
