/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The Open-in-chat menu, held against its contract
 * (gHashTag/trios#1515): the twelve exports of
 * components/ai-elements/open-in-chat.tsx - OpenIn, OpenInContent,
 * OpenInItem, OpenInLabel, OpenInSeparator, OpenInTrigger,
 * OpenInChatGPT, OpenInClaude, OpenInT3, OpenInScira, OpenInv0,
 * OpenInCursor - pinned as they behave today, so the next change to
 * that file has something to fail against.
 *
 * Six exports are hook-free render functions of their props, so the
 * suite calls each one directly and pins the element tree it
 * answers: the context value the root provides, the defaults the
 * content and trigger apply, and the passthrough the item, label
 * and separator do. A React element is a plain object - no DOM
 * renderer is involved.
 *
 * Not pinned, and why (issue User Story 2): OpenInChatGPT,
 * OpenInClaude, OpenInT3, OpenInScira, OpenInv0 and OpenInCursor.
 * Each reads the query through the React context the root provides
 * and renders through the Radix menu internals - measured, a direct
 * call refuses with "MenuItem must be used within MenuContent", and
 * renderToStaticMarkup with the menu opened by default renders only
 * the closed shell, because the content lives in a portal that needs
 * a mounted document. Exercising them needs a DOM renderer, which
 * this group does not have.
 */

import { describe, expect, it } from 'bun:test'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  OpenIn,
  OpenInContent,
  OpenInItem,
  OpenInLabel,
  OpenInSeparator,
  OpenInTrigger,
} from './open-in-chat'

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

describe('openInChatTsxContract', () => {
  describe('OpenIn', () => {
    it('provides the query through its context and hands the rest of the props to the menu root', () => {
      const root = OpenIn({ query: 'hello world', modal: false }) as AnyElement
      expect(root.props.value).toEqual({ query: 'hello world' })
      const menu = elementsOf(root, DropdownMenu)
      expect(menu.length).toBe(1)
      expect(menu[0]?.props.modal).toBe(false)
    })
  })

  describe('OpenInContent', () => {
    it('aligns the content to the start and merges the width class it adds with the one handed in', () => {
      const content = OpenInContent({ className: 'my-extra' })
      const element = elementsOf(content, DropdownMenuContent)[0]
      expect(element?.props.align).toBe('start')
      expect(element?.props.className).toBe('w-[240px] my-extra')
    })
  })

  describe('OpenInItem', () => {
    it('passes its props straight through to the menu item', () => {
      const item = OpenInItem({ variant: 'destructive', disabled: true })
      const element = elementsOf(item, DropdownMenuItem)[0]
      expect(element?.props.variant).toBe('destructive')
      expect(element?.props.disabled).toBe(true)
    })
  })

  describe('OpenInLabel', () => {
    it('passes its children straight through to the menu label', () => {
      const label = OpenInLabel({ children: 'Send elsewhere' })
      const element = elementsOf(label, DropdownMenuLabel)[0]
      expect(textOf(element)).toBe('Send elsewhere')
    })
  })

  describe('OpenInSeparator', () => {
    it('answers a menu separator', () => {
      const separator = OpenInSeparator({})
      expect(elementsOf(separator, DropdownMenuSeparator).length).toBe(1)
    })
  })

  describe('OpenInTrigger', () => {
    it('opens as a child of what it wraps and answers the outlined Open-in-chat button unless children are handed in', () => {
      const defaultTrigger = OpenInTrigger({})
      const wrapper = elementsOf(defaultTrigger, DropdownMenuTrigger)[0]
      expect(wrapper?.props.asChild).toBe(true)
      const button = elementsOf(defaultTrigger, Button)
      expect(button.length).toBe(1)
      expect(textOf(button[0])).toContain('Open in chat')

      const custom = OpenInTrigger({
        children: OpenInSeparator({}),
      })
      expect(elementsOf(custom, Button).length).toBe(0)
      expect(elementsOf(custom, DropdownMenuSeparator).length).toBe(1)
    })
  })
})
