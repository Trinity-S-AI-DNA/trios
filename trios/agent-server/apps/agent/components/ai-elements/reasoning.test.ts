/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The reasoning block, held against its contract
 * (gHashTag/trios#1609): the three exports of
 * components/ai-elements/reasoning.tsx - Reasoning, ReasoningTrigger,
 * ReasoningContent - pinned as they behave today, so the next change
 * to that file has something to fail against.
 *
 * Every export is a memo component reading the subject's own context,
 * so the suite renders each one inside the root that provides it,
 * with renderToStaticMarkup (a React element tree needs no DOM). The
 * root's open state rides Radix useControllableState and gates the
 * collapsible - measured, the content renders while open and nothing
 * while closed - and the trigger answers the thinking message for
 * the state it reads: streaming or a zero duration says Thinking...,
 * an unset duration says Thought for a few seconds, and a measured
 * one names its seconds; the chevron follows the open state. Not
 * pinned: the streaming duration itself and the auto-close timer -
 * both live in effects that need a live document.
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Reasoning, ReasoningContent, ReasoningTrigger } from './reasoning'

const insideRoot = (
  props: { defaultOpen?: boolean; duration?: number; isStreaming?: boolean },
  ...children: Array<ReturnType<typeof createElement>>
) => renderToStaticMarkup(createElement(Reasoning, { ...props }, ...children))

describe('reasoningTsxContract', () => {
  describe('Reasoning', () => {
    it('gates its collapsible: the parts render while open and vanish while closed', () => {
      const open = insideRoot(
        { defaultOpen: true },
        createElement(ReasoningTrigger),
        createElement(ReasoningContent, null, 'The model compared the drafts'),
      )
      expect(open).toContain('data-state="open"')

      const closed = insideRoot(
        { defaultOpen: false },
        createElement(ReasoningTrigger),
        createElement(ReasoningContent, null, 'The model compared the drafts'),
      )
      expect(closed).toContain('hidden=""')
      expect(closed).not.toContain('whitespace-normal')
      expect(closed).toContain('not-prose')
    })
  })

  describe('ReasoningTrigger', () => {
    it('answers the thinking message for the state it reads, the chevron following the open state, and its own label when children are handed in', () => {
      const open = insideRoot(
        { defaultOpen: true },
        createElement(ReasoningTrigger),
      )
      expect(open).toContain('Thought for a few seconds')
      expect(open).toContain('rotate-180')

      const timed = insideRoot(
        { defaultOpen: true, duration: 5 },
        createElement(ReasoningTrigger),
      )
      expect(timed).toContain('Thought for 5 seconds')

      const streaming = insideRoot(
        { defaultOpen: true, isStreaming: true },
        createElement(ReasoningTrigger),
      )
      expect(streaming).toContain('Thinking...')

      const closed = insideRoot(
        { defaultOpen: false },
        createElement(ReasoningTrigger),
      )
      expect(closed).toContain('rotate-0')

      const custom = insideRoot(
        { defaultOpen: true },
        createElement(ReasoningTrigger, null, 'Why this answer'),
      )
      expect(custom).toContain('Why this answer')
      expect(custom).not.toContain('Thought for')
    })
  })

  describe('ReasoningContent', () => {
    it('carries the reasoning text while the root is open, and nothing while it is closed', () => {
      const open = insideRoot(
        { defaultOpen: true },
        createElement(ReasoningContent, null, 'Step one: restate the claim'),
      )
      expect(open).toContain('whitespace-normal')
      expect(open).toContain('mt-4 text-sm')

      const closed = insideRoot(
        { defaultOpen: false },
        createElement(ReasoningContent, null, 'Step one: restate the claim'),
      )
      expect(closed).toContain('hidden=""')
      expect(closed).not.toContain('whitespace-normal')
    })
  })
})
