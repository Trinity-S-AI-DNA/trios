/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The memory examples, held against its contract
 * (gHashTag/trios#1645): the single export of
 * entrypoints/app/memory/MemoryExamples.tsx - MemoryExamples - pinned as
 * it behaves today, so the next change to that file has something to
 * fail against.
 *
 * The sidepanel messaging seam is stubbed with the same two-export
 * stand-in the SoulExamples and OnboardingDemo suites use (the real
 * module rides webextension-polyfill, which refuses to load outside a
 * browser extension; every registration is equivalent, so the file
 * order cannot matter). The dialog starts closed, and a closed Radix
 * dialog renders nothing - which is the second pin. Not pinned: the
 * dialog's editing flow and the send click (state changes need a live
 * DOM).
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('@/lib/messaging/sidepanel/openSidepanelWithSearch', () => ({
  onOpenSidePanelWithSearch: () => () => {},
  openSidePanelWithSearch: () => {},
}))

const { MemoryExamples } = await import('./MemoryExamples')

const markup = () => renderToStaticMarkup(createElement(MemoryExamples))

const EXAMPLES: Array<[string, string]> = [
  ['Introduce yourself', 'Save this to your core memory.'],
  [
    'Learn from my bookmarks',
    'figure out what topics and interests matter to me',
  ],
  ['Learn my habits', 'what my day-to-day looks like'],
  ['Know my open tabs', 'Look at my open tabs right now and'],
  ['Review memories', 'tell me what you know about me. Is anything outdated?'],
]

describe('memoryExamplesContract', () => {
  it('answers the intro heading and its note', () => {
    const m = markup()
    expect(m).toContain('Teach your agent about you')
    expect(m).toContain(
      'Use these prompts to help your agent learn. Edit the message before sending.',
    )
  })

  it('answers every example with its label, its query and a Try it button', () => {
    const m = markup()
    for (const [label, query] of EXAMPLES) {
      expect(m).toContain(label)
      expect(m).toContain(query)
    }
    expect((m.match(/Try it/g) ?? []).length).toBe(EXAMPLES.length)
    expect((m.match(/lucide-message-square/g) ?? []).length).toBe(
      EXAMPLES.length,
    )
  })

  it('answers the closed dialog with nothing', () => {
    const m = markup()
    expect(m).not.toContain('Edit message')
    expect(m).not.toContain('Customize the prompt before sending')
    expect(m).not.toContain('lucide-send')
  })
})
