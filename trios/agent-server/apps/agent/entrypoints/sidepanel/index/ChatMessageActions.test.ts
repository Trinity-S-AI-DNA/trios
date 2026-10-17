/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The chat message actions, held against its contract
 * (gHashTag/trios#1637): the single export of
 * entrypoints/sidepanel/index/ChatMessageActions.tsx -
 * ChatMessageActions - pinned as it behaves today, so the next change
 * to that file has something to fail against.
 *
 * The dislike dialog opens through state a static render never changes,
 * so it stays closed here and is pinned as absent; the dialog kit is
 * stubbed with the group's stand-in shape (the root honours the open
 * flag, everything else a passthrough) for that one branch. Pinned: the
 * fresh answer (Copy, Like, Dislike with their measured icons, the
 * thumbs unfilled), and the submitted answer (Feedback submitted with
 * its check, Like and Dislike gone, Copy staying). Not pinned: the
 * clipboard write, the metrics track, the dislike dialog's editing
 * flow, the clicks - effects and handlers a static render never runs -
 * and the tooltip titles, which the tooltip kit answers only on hover.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement, type FC, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const passChildren =
  (): FC<{ children?: ReactNode }> =>
  ({ children }) =>
    createElement('div', null, children)

mock.module('@/components/ui/dialog', () => {
  const pass = passChildren()
  return {
    Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? children : null,
    DialogClose: pass,
    DialogContent: pass,
    DialogDescription: pass,
    DialogFooter: pass,
    DialogHeader: pass,
    DialogTitle: pass,
    DialogTrigger: pass,
  }
})

const { ChatMessageActions } = await import('./ChatMessageActions')

const markup = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(
      ChatMessageActions as never,
      {
        messageId: 'm-1',
        messageText: 'hello',
        liked: false,
        disliked: false,
        onClickLike: () => {},
        onClickDislike: () => {},
        ...over,
      } as never,
    ),
  )

describe('chatMessageActionsContract', () => {
  it('answers copy, like and dislike with the measured icons, unfilled', () => {
    const m = markup()
    expect(m).toContain('Copy')
    expect(m).toContain('Like')
    expect(m).toContain('Dislike')
    expect(m).toContain('lucide-copy')
    expect(m).toContain('lucide-thumbs-up')
    expect(m).toContain('lucide-thumbs-down')
    expect(m).toContain('fill="none"')
    expect(m).not.toContain('fill="currentColor"')
    expect(m).not.toContain('Feedback submitted')
  })

  it('answers the submitted note instead of the verdict once given', () => {
    for (const over of [{ liked: true }, { disliked: true }]) {
      const m = markup(over)
      expect(m).toContain('Feedback submitted')
      expect(m).toContain('lucide-check')
      expect(m).not.toContain('lucide-thumbs-up')
      expect(m).not.toContain('lucide-thumbs-down')
      expect(m).toContain('Copy')
    }
  })

  it('answers the dislike dialog closed', () => {
    const m = markup()
    expect(m).not.toContain('What went wrong?')
    expect(m).not.toContain('Add a comment (optional)')
  })
})
