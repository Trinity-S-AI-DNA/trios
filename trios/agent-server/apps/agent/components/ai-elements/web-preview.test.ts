/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The web preview, held against its contract (gHashTag/trios#1547):
 * the six exports of components/ai-elements/web-preview.tsx -
 * WebPreview, WebPreviewNavigation, WebPreviewNavigationButton,
 * WebPreviewUrl, WebPreviewBody, WebPreviewConsole - pinned as they
 * behave today, so the next change to that file has something to
 * fail against.
 *
 * Two exports are hook-free render functions, so the suite calls
 * them directly and pins the element trees they answer. The root and
 * the three context consumers render through renderToStaticMarkup -
 * the context here is the subject's own createContext and the root
 * itself holds state, so a static render inside the root goes
 * through without a DOM. What is not pinned: the
 * interactive side of the URL bar (Enter commits the typed value)
 * and the console's open state - both live in effects and state
 * transitions that need a mounted document; the static pins read
 * what each piece renders from the context it is given.
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  WebPreview,
  WebPreviewBody,
  WebPreviewConsole,
  WebPreviewNavigation,
  WebPreviewNavigationButton,
  WebPreviewUrl,
} from './web-preview'

type AnyElement = {
  type: unknown
  props: Record<string, unknown>
}

const isElement = (node: unknown): node is AnyElement =>
  typeof node === 'object' && node !== null && 'type' in node

function* walk(node: unknown): Generator<AnyElement> {
  if (Array.isArray(node)) {
    for (const child of node) {
      yield* walk(child)
    }
    return
  }
  if (!isElement(node)) {
    return
  }
  yield node
  const children = node.props.children
  if (children !== null && children !== undefined) {
    yield* walk(children)
  }
}

const elementsOf = (node: unknown, type: unknown): AnyElement[] =>
  [...walk(node)].filter((element) => element.type === type)

const textOf = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join('')
  }
  if (isElement(node)) {
    return textOf(node.props.children)
  }
  return ''
}

const insideRoot = (...children: Array<ReturnType<typeof createElement>>) =>
  renderToStaticMarkup(
    createElement(WebPreview, { defaultUrl: 'https://page.test' }, ...children),
  )

describe('webPreviewTsxContract', () => {
  describe('WebPreview', () => {
    it('wraps the children in the framed card and provides the URL its parts read', () => {
      const markup = renderToStaticMarkup(
        createElement(
          WebPreview,
          { defaultUrl: 'https://start.test', className: 'extra-frame' },
          'FRAME-CONTENT',
        ),
      )
      expect(markup).toContain('rounded-lg')
      expect(markup).toContain('extra-frame')
      expect(markup).toContain('FRAME-CONTENT')
    })
  })

  describe('WebPreviewNavigation', () => {
    it('answers the bordered bar its children sit in', () => {
      const bar = WebPreviewNavigation({
        id: 'nav-bar',
        children: 'Refresh',
      })
      expect(textOf(bar)).toContain('Refresh')
      const div = elementsOf(bar, 'div')[0]
      expect(div?.props.className).toContain('border-b')
      expect(div?.props.id).toBe('nav-bar')
    })
  })

  describe('WebPreviewNavigationButton', () => {
    it('wraps a small ghost button and carries the tooltip text handed in', () => {
      const noop = () => {}
      const tree = WebPreviewNavigationButton({
        onClick: noop,
        disabled: true,
        tooltip: 'Reload the page',
        children: 'Refresh',
      })
      const button = elementsOf(tree, Button)[0]
      expect(button?.props.disabled).toBe(true)
      expect(button?.props.onClick).toBe(noop)
      expect(textOf(elementsOf(tree, TooltipTrigger)[0])).toContain('Refresh')
      expect(textOf(elementsOf(tree, TooltipContent)[0])).toContain(
        'Reload the page',
      )
    })
  })

  describe('WebPreviewUrl', () => {
    it('shows the URL the root provides in the address input', () => {
      const markup = insideRoot(createElement(WebPreviewUrl))
      expect(markup).toContain('https://page.test')
      expect(markup).toContain('Enter URL...')
    })
  })

  describe('WebPreviewBody', () => {
    it('points the sandboxed frame at the URL the root provides, or at the src handed in', () => {
      const markup = insideRoot(createElement(WebPreviewBody))
      expect(markup).toContain('src="https://page.test"')
      expect(markup).toContain('sandbox="allow-scripts')
      expect(markup).toContain('title="Preview"')

      const overridden = insideRoot(
        createElement(WebPreviewBody, { src: 'https://override.test' }),
      )
      expect(overridden).toContain('src="https://override.test"')
      expect(overridden).not.toContain('src="https://page.test"')
    })
  })

  describe('WebPreviewConsole', () => {
    it('answers the console bar the root keeps closed at first', () => {
      const markup = insideRoot(createElement(WebPreviewConsole))
      expect(markup).toContain('Console')
      expect(markup).toContain('border-t')
    })
  })
})
