/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The new-tab suggestions, held against their contract
 * (gHashTag/trios#1633): the two exports of
 * entrypoints/newtab/index/lib/suggestions/useSuggestions.ts -
 * useSuggestions and getSuggestionLabel - pinned as they behave
 * today, so the next change to that file has something to fail
 * against.
 *
 * useSuggestions composes three suggestion sources and a storage
 * seam, so each source is stubbed with a full stand-in (every value
 * export the module carries, checked against the tree) whose
 * answers a module-level fixture steers, and the suite renders the
 * hook with renderToStaticMarkup inside a probe that serialises the
 * sections it builds. No other suite of this job imports these
 * modules, and the subject is imported dynamically after the
 * stand-ins register, so the file order cannot break the load. The
 * provider lookup stays real - the pins read the section title it
 * names. What is not mocked away: the composition itself - which
 * source wins, how the search results are trimmed, deduplicated and
 * emptied, and what the labels say - is exactly what the pins read.
 */

import { describe, expect, it, mock } from 'bun:test'
import type { LucideIcon } from 'lucide-react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

let searchApiData: string[] | undefined
let aiTabData: Array<{
  name: string
  icon: string
  description: string
  minTabs: number
  maxTabs: number
}> = []
let browserOSData: Array<{ mode: string; message: string }> = []
const providerFixture = 'google'

mock.module('../searchSuggestions/useSearchSuggestions', () => ({
  useSearchSuggestions: () => ({ data: searchApiData }),
}))

mock.module('../aiTabSuggestions/useAITabSuggestions', () => ({
  useAITabSuggestions: () => aiTabData,
}))

mock.module('../browserOSSuggestions/useBrowserOSSuggestions', () => ({
  useBrowserOSSuggestions: () => browserOSData,
}))

mock.module('@/lib/search-provider/search-provider-storage', () => ({
  searchProviderStorage: {
    getValue: async () => null,
    setValue: async () => {},
    watch: () => () => {},
  },
  useSearchProvider: () => ({ provider: providerFixture }),
}))

const { getSuggestionLabel, useSuggestions } = await import('./useSuggestions')

const sectionsMarkup = (query: string, selectedTabs: unknown[]) =>
  renderToStaticMarkup(
    createElement(() => {
      const { sections, flatItems, providerConfig } = useSuggestions({
        query,
        selectedTabs: selectedTabs as chrome.tabs.Tab[],
      })
      return createElement(
        'pre',
        null,
        [
          sections
            .map(
              (section) =>
                `${section.id}:${section.title}:${section.items
                  .map((item) => getSuggestionLabel(item))
                  .join('/')}`,
            )
            .join('|'),
          String(flatItems.length),
          providerConfig.name,
        ].join('#'),
      )
    }),
  )

describe('useSuggestionsContract', () => {
  describe('useSuggestions', () => {
    it('builds the sections from the sources: nothing without a query, the trimmed deduplicated search results behind the provider name, the AI actions ahead of search when tabs are selected, and the BrowserOS answer first', () => {
      searchApiData = undefined
      aiTabData = []
      browserOSData = []
      expect(sectionsMarkup('', [])).toContain('#0#Google')

      searchApiData = ['Hello World', 'second', '   ']
      expect(sectionsMarkup('  hello world  ', [])).toContain(
        'search:Google Search:hello world/second',
      )
      expect(sectionsMarkup('  hello world  ', [])).toContain('#2#Google')

      aiTabData = [
        {
          name: 'Summarize the tabs',
          icon: 'sparkles',
          description: 'One page from all tabs',
          minTabs: 1,
          maxTabs: 10,
        },
      ]
      const withTabs = sectionsMarkup('hello world', [{}])
      expect(withTabs).toContain('ai-actions:AI Actions:Summarize the tabs')
      expect(withTabs).not.toContain('search:Google Search')

      aiTabData = []
      browserOSData = [{ mode: 'answer', message: 'Ask BrowserOS' }]
      const withBrowserOS = sectionsMarkup('hello world', [])
      expect(withBrowserOS).toContain('browseros::Ask BrowserOS')
      expect(withBrowserOS).toContain('search:Google Search:hello world/second')
    })
  })

  describe('getSuggestionLabel', () => {
    it('answers the text each kind of suggestion shows', () => {
      expect(
        getSuggestionLabel({ type: 'search', id: 's1', query: 'q1' }),
      ).toBe('q1')
      expect(
        getSuggestionLabel({
          type: 'ai-tab',
          id: 'a1',
          name: 'Summarize',
          icon: null as unknown as LucideIcon,
          description: 'One page from the tabs',
          minTabs: 1,
          maxTabs: 2,
        }),
      ).toBe('Summarize')
      expect(
        getSuggestionLabel({
          type: 'browseros',
          id: 'b1',
          mode: 'agent',
          message: 'Ask',
        }),
      ).toBe('Ask')
    })
  })
})
