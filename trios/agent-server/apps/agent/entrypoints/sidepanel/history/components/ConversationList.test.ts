/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The conversation list, held against its contract
 * (gHashTag/trios#1671): the single export of
 * entrypoints/sidepanel/history/components/ConversationList.tsx -
 * ConversationList - pinned as it behaves today, so the next change to
 * that file has something to fail against.
 *
 * renderToStaticMarkup never runs effects, so the IntersectionObserver
 * load-more path is not exercised here (and IntersectionObserver does not
 * exist under bun); what is pinned is the static answer: the empty state,
 * one labelled group per time bucket that carries conversations and none
 * for empty buckets, the conversation rows with their conversationId
 * links, the refresh banner, and the load-more sentinel. The tree renders
 * inside a MemoryRouter: the list links through react-router, and a Link
 * outside a router throws instead of answering.
 */
import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'

import type { GroupedConversations, HistoryConversation } from './types'

const { ConversationList } = await import('./ConversationList')

const conversation = (
  id: string,
  lastUserMessage: string,
): HistoryConversation => ({
  id,
  lastMessagedAt: Date.now(),
  lastUserMessage,
})

const groups = (
  over: Partial<GroupedConversations> = {},
): GroupedConversations => ({
  today: [],
  thisWeek: [],
  thisMonth: [],
  older: [],
  ...over,
})

const markup = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(ConversationList as never, props as never),
    ),
  )

describe('conversationListContract', () => {
  it('answers the empty state when no bucket carries a conversation', () => {
    const m = markup({
      groupedConversations: groups(),
      activeConversationId: '',
    })
    expect(m).toContain('No conversations yet')
    expect(m).toContain('Start a new chat')
    expect(m).toContain('href="/"')
    expect(m).toContain('lucide-message-square')
    expect(m).not.toContain('Today')
  })

  it('answers one labelled group per bucket that carries conversations, none for empty buckets', () => {
    const m = markup({
      groupedConversations: groups({
        today: [conversation('c-1', 'Fix the login page')],
        older: [conversation('c-2', 'Plan the week')],
      }),
      activeConversationId: 'c-1',
    })
    expect(m).toContain('Today')
    expect(m).toContain('Older')
    expect(m).not.toContain('This Week')
    expect(m).not.toContain('This Month')
    expect(m).toContain('Fix the login page')
    expect(m).toContain('Plan the week')
  })

  it('answers every conversation row as a conversationId link', () => {
    const m = markup({
      groupedConversations: groups({
        today: [conversation('c-1', 'First'), conversation('c-2', 'Second')],
      }),
      activeConversationId: 'c-1',
    })
    expect(m).toContain('href="/?conversationId=c-1"')
    expect(m).toContain('href="/?conversationId=c-2"')
  })

  it('answers the refresh banner while refreshing', () => {
    const m = markup({
      groupedConversations: groups(),
      activeConversationId: '',
      isRefreshing: true,
    })
    expect(m).toContain('Fetching latest conversations')
    expect(m).toContain('lucide-loader-circle')
  })

  it('answers the load-more sentinel only when a next page exists', () => {
    const withNext = markup({
      groupedConversations: groups({
        today: [conversation('c-1', 'First')],
      }),
      activeConversationId: '',
      hasNextPage: true,
      isFetchingNextPage: true,
    })
    expect(withNext).toContain('flex items-center justify-center py-4')
    expect(withNext).toContain('lucide-loader-circle')

    const withoutNext = markup({
      groupedConversations: groups({
        today: [conversation('c-1', 'First')],
      }),
      activeConversationId: '',
    })
    expect(withoutNext).not.toContain('flex items-center justify-center py-4')
  })
})
