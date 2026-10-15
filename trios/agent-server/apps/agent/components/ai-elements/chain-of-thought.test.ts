/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The chain-of-thought block, held against its contract
 * (gHashTag/trios#1573): the seven exports of
 * components/ai-elements/chain-of-thought.tsx - ChainOfThought,
 * ChainOfThoughtHeader, ChainOfThoughtStep,
 * ChainOfThoughtSearchResults, ChainOfThoughtSearchResult,
 * ChainOfThoughtContent, ChainOfThoughtImage - pinned as they behave
 * today, so the next change to that file has something to fail
 * against.
 *
 * Every export is a memo component - not a plain function - so the
 * suite renders each one with renderToStaticMarkup: four are free of
 * hooks and context and render on their own; the root and the two
 * context consumers render inside the root that provides it, whose
 * open state rides Radix useControllableState and gates the
 * collapsible content - closed by default the content renders
 * nothing, opened by default the parts and their state classes all
 * show. Not pinned: the interactive toggling itself - a click needs
 * a mounted document; the static pins read what each piece renders
 * in either state.
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtImage,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from './chain-of-thought'

const staticMarkup = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(element)

describe('chainOfThoughtTsxContract', () => {
  describe('ChainOfThought', () => {
    it('wraps the children in the prose-width block it draws, carrying the rest of the props', () => {
      const markup = staticMarkup(
        createElement(
          ChainOfThought,
          { id: 'cot-root', className: 'extra-cot' },
          'BLOCK-CONTENT',
        ),
      )
      expect(markup).toContain('not-prose')
      expect(markup).toContain('extra-cot')
      expect(markup).toContain('id="cot-root"')
      expect(markup).toContain('BLOCK-CONTENT')
    })
  })

  describe('ChainOfThoughtHeader', () => {
    it('shows the Chain-of-Thought label and the open chevron while the root is open, and the closed chevron with its own label otherwise', () => {
      const open = staticMarkup(
        createElement(
          ChainOfThought,
          { defaultOpen: true },
          createElement(ChainOfThoughtHeader),
        ),
      )
      expect(open).toContain('Chain of Thought')
      expect(open).toContain('rotate-180')

      const custom = staticMarkup(
        createElement(
          ChainOfThought,
          { defaultOpen: true },
          createElement(ChainOfThoughtHeader, null, 'Reasoning steps'),
        ),
      )
      expect(custom).toContain('Reasoning steps')

      const closed = staticMarkup(
        createElement(
          ChainOfThought,
          { defaultOpen: false },
          createElement(ChainOfThoughtHeader),
        ),
      )
      expect(closed).toContain('rotate-0')
    })
  })

  describe('ChainOfThoughtStep', () => {
    it('shows the label, the description and the status colour it was given', () => {
      const markup = staticMarkup(
        createElement(ChainOfThoughtStep, {
          label: 'Searching the web',
          description: 'Ran three queries',
          status: 'active',
        }),
      )
      expect(markup).toContain('Searching the web')
      expect(markup).toContain('Ran three queries')
      expect(markup).toContain('text-foreground')

      const pending = staticMarkup(
        createElement(ChainOfThoughtStep, {
          label: 'Waiting for input',
          status: 'pending',
        }),
      )
      expect(pending).toContain('text-muted-foreground/50')
      expect(pending).not.toContain('text-xs')
    })
  })

  describe('ChainOfThoughtSearchResults', () => {
    it('answers the row the search chips sit in', () => {
      const markup = staticMarkup(
        createElement(
          ChainOfThoughtSearchResults,
          { id: 'results-row' },
          'RESULT-CHIP',
        ),
      )
      expect(markup).toContain('flex items-center gap-2')
      expect(markup).toContain('id="results-row"')
      expect(markup).toContain('RESULT-CHIP')
    })
  })

  describe('ChainOfThoughtSearchResult', () => {
    it('answers the secondary badge carrying its text', () => {
      const markup = staticMarkup(
        createElement(ChainOfThoughtSearchResult, null, 'docs.example.com'),
      )
      expect(markup).toContain('docs.example.com')
      expect(markup).toContain('bg-secondary')
    })
  })

  describe('ChainOfThoughtContent', () => {
    it('renders the steps while the root is open and nothing while it is closed', () => {
      const open = staticMarkup(
        createElement(
          ChainOfThought,
          { defaultOpen: true },
          createElement(ChainOfThoughtContent, null, 'STEP-INSIDE-CONTENT'),
        ),
      )
      expect(open).toContain('STEP-INSIDE-CONTENT')
      expect(open).toContain('mt-2 space-y-3')

      const closed = staticMarkup(
        createElement(
          ChainOfThought,
          { defaultOpen: false },
          createElement(ChainOfThoughtContent, null, 'STEP-INSIDE-CONTENT'),
        ),
      )
      expect(closed).not.toContain('STEP-INSIDE-CONTENT')
    })
  })

  describe('ChainOfThoughtImage', () => {
    it('frames what it is handed and shows the caption when one is given', () => {
      const markup = staticMarkup(
        createElement(
          ChainOfThoughtImage,
          { caption: 'The rendered page' },
          'IMG-PLACEHOLDER',
        ),
      )
      expect(markup).toContain('IMG-PLACEHOLDER')
      expect(markup).toContain('The rendered page')
      expect(markup).toContain('rounded-lg')

      const bare = staticMarkup(
        createElement(ChainOfThoughtImage, null, 'IMG-PLACEHOLDER'),
      )
      expect(bare).not.toContain('text-xs')
    })
  })
})
