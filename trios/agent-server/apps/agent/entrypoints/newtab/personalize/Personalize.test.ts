/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The personalize page, held against its contract
 * (gHashTag/trios#1620): the single export of
 * entrypoints/newtab/personalize/Personalize.tsx - Personalize - pinned
 * as it behaves today, so the next change to that file has something to
 * fail against.
 *
 * Both storage aliases are shimmed before anything imports (the
 * personalization item rides @wxt-dev/storage directly, and the
 * MarkdownEditor's graph reaches '#imports'; the real modules refuse the
 * test process - the second is the measured lesson of the acl suite,
 * where the page's async machinery crashed the probe until both were
 * covered). The hook populates through effects, so the editor answers
 * its initial empty value. Pinned: the mounted-hidden intro frames
 * (opacity-0 before the mount effect flips them); the editor frame with
 * its placeholder and the local-only note; the three template sections
 * with their titles, descriptions and the Template/Example blocks; the
 * copy affordance with its hover title; and the first section's rotated
 * chevron (the default expansion) - Radix Collapsible answers only the
 * open section's content, so the other two sections are pinned as
 * closed. Not pinned: the clipboard write, the copied flip, the debounce
 * in the hook and the mount effect itself.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const values = new Map<string, unknown>()
const shimItem = (
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
})

mock.module('#imports', () => ({ storage: { defineItem: shimItem } }))
mock.module('@wxt-dev/storage', () => ({
  storage: { defineItem: shimItem },
}))

const { Personalize } = await import('./Personalize')

const markup = () => renderToStaticMarkup(createElement(Personalize))

describe('personalizeContract', () => {
  it('answers the editor frame with its placeholder and the local-only note', () => {
    const m = markup()
    expect(m).toContain('mdx-editor-outer')
    expect(m).toContain('Tell BrowserOS about yourself')
    expect(m).toContain('Your Information')
    expect(m).toContain(
      'Your information is saved locally and never leaves your device.',
    )
  })

  it('answers the three template sections with their titles and descriptions', () => {
    const m = markup()
    expect(m).toContain('Need help getting started?')
    for (const [title, description] of [
      ['Add more info about you', 'Help BrowserOS understand who you are'],
      ['What you expect from the browser', 'Share your preferences and needs'],
      ['Your commonly performed actions', 'Describe your daily workflows'],
    ]) {
      expect(m).toContain(title)
      expect(m).toContain(description)
    }
    // Radix Collapsible answers only the OPEN section's content (the
    // first section is the default expansion - measured: exactly one
    // Template block renders), so the other two are pinned as closed.
    expect((m.match(/Template \(click to copy\):/g) ?? []).length).toBe(1)
    expect(m).toContain('data-state="open"')
  })

  it('answers the copy affordance on the open template only (Radix answers closed sections with nothing)', () => {
    const m = markup()
    expect((m.match(/title="Copy template"/g) ?? []).length).toBe(1)
    expect(m).toContain('lucide-copy')
    expect(
      (m.match(/data-state="closed"/g) ?? []).length,
    ).toBeGreaterThanOrEqual(2)
  })

  it('answers the first section expanded and the intro frames hidden before mount', () => {
    const m = markup()
    expect(m).toContain('rotate-180')
    expect(m).toContain('opacity-0')
    expect(m).toContain('lucide-chevron-down')
  })
})
