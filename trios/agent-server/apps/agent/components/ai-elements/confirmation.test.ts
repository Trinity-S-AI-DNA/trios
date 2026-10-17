/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The tool confirmation block, held against its contract
 * (gHashTag/trios#1600): the seven exports of
 * components/ai-elements/confirmation.tsx - Confirmation,
 * ConfirmationTitle, ConfirmationRequest, ConfirmationAccepted,
 * ConfirmationRejected, ConfirmationActions, ConfirmationAction -
 * pinned as they behave today, so the next change to that file has
 * something to fail against.
 *
 * Three exports are hook-free render functions, so the suite calls
 * them directly and pins the element trees they answer - including
 * the root's refusals: without an approval, or while the part is
 * still streaming input, it renders nothing at all. The four
 * context consumers render with renderToStaticMarkup inside the
 * root that provides it: each one gates its children on the
 * approval state it reads, and the pins drive both sides of every
 * gate - approval requested, accepted, rejected, and the input
 * states - so the branching is read from what actually renders.
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  type ConfirmationProps,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from './confirmation'

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

const insideRoot = (
  approval: ConfirmationProps['approval'],
  state: ConfirmationProps['state'],
  ...children: Array<ReturnType<typeof createElement>>
) =>
  renderToStaticMarkup(
    createElement(Confirmation, { approval, state }, ...children),
  )

describe('confirmationTsxContract', () => {
  describe('Confirmation', () => {
    it('refuses to render without an approval or while the input is still streaming, and otherwise frames the alert with the state it was given', () => {
      expect(Confirmation({ state: 'approval-requested' })).toBeNull()
      expect(
        Confirmation({
          approval: { id: 't1', approved: true },
          state: 'input-streaming',
        }),
      ).toBeNull()
      expect(
        Confirmation({
          approval: { id: 't1', approved: true },
          state: 'input-available',
        }),
      ).toBeNull()

      const root = Confirmation({
        approval: { id: 't1', approved: true },
        state: 'approval-responded',
        className: 'extra-conf',
      }) as AnyElement
      expect(root.props.value).toEqual({
        approval: { id: 't1', approved: true },
        state: 'approval-responded',
      })
      const alert = elementsOf(root, Alert)[0]
      expect(alert?.props.className).toContain('flex flex-col gap-2')
      expect(alert?.props.className).toContain('extra-conf')
    })
  })

  describe('ConfirmationTitle', () => {
    it('answers the inline description carrying its children', () => {
      const tree = ConfirmationTitle({
        className: 'my-extra',
        children: 'Approve the transfer?',
      })
      const description = elementsOf(tree, AlertDescription)[0]
      expect(description?.props.className).toContain('inline')
      expect(description?.props.className).toContain('my-extra')
    })
  })

  describe('ConfirmationRequest', () => {
    it('shows its children only while approval is requested', () => {
      const requested = insideRoot(
        { id: 't1' },
        'approval-requested',
        createElement(ConfirmationRequest, null, 'REQUEST-CONTENT'),
      )
      expect(requested).toContain('REQUEST-CONTENT')

      const responded = insideRoot(
        { id: 't1', approved: true },
        'approval-responded',
        createElement(ConfirmationRequest, null, 'REQUEST-CONTENT'),
      )
      expect(responded).not.toContain('REQUEST-CONTENT')
    })
  })

  describe('ConfirmationAccepted', () => {
    it('shows its children for an approved part once the response states arrive, and hides them while the request is still open', () => {
      const shown = insideRoot(
        { id: 't1', approved: true },
        'output-available',
        createElement(ConfirmationAccepted, null, 'ACCEPTED-CONTENT'),
      )
      expect(shown).toContain('ACCEPTED-CONTENT')

      const stillOpen = insideRoot(
        { id: 't1' },
        'approval-requested',
        createElement(ConfirmationAccepted, null, 'ACCEPTED-CONTENT'),
      )
      expect(stillOpen).not.toContain('ACCEPTED-CONTENT')

      const rejected = insideRoot(
        { id: 't1', approved: false },
        'output-available',
        createElement(ConfirmationAccepted, null, 'ACCEPTED-CONTENT'),
      )
      expect(rejected).not.toContain('ACCEPTED-CONTENT')
    })
  })

  describe('ConfirmationRejected', () => {
    it('shows its children for a rejected part once the response states arrive, and hides them for an approved one', () => {
      const shown = insideRoot(
        { id: 't1', approved: false },
        'output-denied',
        createElement(ConfirmationRejected, null, 'REJECTED-CONTENT'),
      )
      expect(shown).toContain('REJECTED-CONTENT')

      const approved = insideRoot(
        { id: 't1', approved: true },
        'output-denied',
        createElement(ConfirmationRejected, null, 'REJECTED-CONTENT'),
      )
      expect(approved).not.toContain('REJECTED-CONTENT')
    })
  })

  describe('ConfirmationActions', () => {
    it('answers the action row only while approval is requested', () => {
      const requested = insideRoot(
        { id: 't1' },
        'approval-requested',
        createElement(ConfirmationActions, null, 'BUTTONS'),
      )
      expect(requested).toContain('gap-2 self-end')
      expect(requested).toContain('BUTTONS')

      const responded = insideRoot(
        { id: 't1', approved: true },
        'approval-responded',
        createElement(ConfirmationActions, null, 'BUTTONS'),
      )
      expect(responded).not.toContain('BUTTONS')
    })
  })

  describe('ConfirmationAction', () => {
    it('answers the compact button carrying the rest of its props', () => {
      const tree = ConfirmationAction({
        variant: 'destructive',
        children: 'Deny',
      })
      const button = elementsOf(tree, Button)[0]
      expect(button?.props.className).toContain('h-8 px-3 text-sm')
      expect(button?.props.type).toBe('button')
      expect(button?.props.variant).toBe('destructive')
    })
  })
})
