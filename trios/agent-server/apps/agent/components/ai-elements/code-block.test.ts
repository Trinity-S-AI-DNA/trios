/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The code block, held against its contract
 * (gHashTag/trios#1608): the three exports of
 * components/ai-elements/code-block.tsx - highlightCode, CodeBlock,
 * CodeBlockCopyButton - pinned as they behave today, so the next
 * change to that file has something to fail against.
 *
 * highlightCode is a pure async function, so the suite calls it
 * directly and pins the pair it answers: both themes carrying the
 * code with the shiki markup, the light one under one-light, and
 * the line numbers only asked for (the gutter span with its width
 * classes and the line number itself). The two components render
 * with renderToStaticMarkup - the block's frame with its two theme
 * panes and the corner slot the children sit in (the highlighted
 * html itself arrives through an effect, and is what highlightCode
 * above pins), and the copy button as the ghost icon button it is
 * inside a block. Not pinned: the clipboard path - it guards on
 * window, which this group does not have.
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CodeBlock, CodeBlockCopyButton, highlightCode } from './code-block'

describe('codeBlockTsxContract', () => {
  describe('highlightCode', () => {
    it('answers both themes carrying the code, with the line numbers only asked for', async () => {
      const [light, dark] = await highlightCode('const answer = 42', 'ts', true)
      expect(light).toContain('shiki one-light')
      expect(light).toContain('const')
      expect(light).toContain('42')
      expect(light).toContain('min-w-10')
      expect(light).toContain('>1</span>')
      expect(dark).not.toBe(light)
      expect(dark).toContain('shiki')
      expect(dark).toContain('const')

      const [plain] = await highlightCode('x = 1', 'python')
      expect(plain).toContain('shiki')
      expect(plain).not.toContain('min-w-10')
    })
  })

  describe('CodeBlock', () => {
    it('answers the framed block with both theme panes and the corner slot its children sit in', () => {
      const markup = renderToStaticMarkup(
        createElement(
          CodeBlock,
          { code: 'const answer = 42', language: 'ts' },
          createElement('span', null, 'CUSTOM-TOOL'),
        ),
      )
      expect(markup).toContain('group relative w-full')
      expect(markup).toContain('dark:hidden')
      expect(markup).toContain('dark:block')
      expect(markup).toContain('CUSTOM-TOOL')
      expect(markup).toContain('absolute top-2 right-2')
    })
  })

  describe('CodeBlockCopyButton', () => {
    it('answers the ghost icon button with the copy icon inside a block', () => {
      const markup = renderToStaticMarkup(
        createElement(
          CodeBlock,
          { code: 'const answer = 42', language: 'ts' },
          createElement(CodeBlockCopyButton),
        ),
      )
      expect(markup).toContain('shrink-0')
      expect(markup).toContain('lucide-copy')
    })
  })
})
