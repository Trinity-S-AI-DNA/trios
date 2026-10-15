/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The sidepanel chat history, held against its contract
 * (gHashTag/trios#1647): the one export of
 * entrypoints/sidepanel/history/ChatHistory.tsx - ChatHistory -
 * pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * The history dispatches on the session: a signed-in user gets the
 * remote list, everyone else the local one. The session hook is
 * stubbed through a mutable holder the test drives across both
 * states, the conversation store hook answers empty local history,
 * the chat-session context answers an active conversation id, and
 * the three graphql hooks answer holder-driven fixtures - the
 * profile id and the conversations page the remote branch maps and
 * groups. Everything else stays real: the grouping and
 * message-extraction utils, the time-group labels, and the
 * conversation list both branches render - so the pins read the
 * real utils' output for the fixture pages. Measured, the signed-out
 * mount answers the local list with its empty note, and the
 * signed-in mount answers the today group with the fixture
 * conversations - the user message one, and the one whose history
 * holds no user message falling back to the new-conversation label.
 *
 * Not pinned, and why (issue User Story 2): the flows the callbacks
 * own - the delete mutation and its cache invalidation, the
 * load-more paging, the refresh indicator - need a live document
 * and a query client beyond a static render's reach (the wrapper
 * here supplies the client the mount itself asks for). The subject
 * is read through a query-qualified specifier so this suite's graph
 * loads as its own fresh instances.
 */

import { describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const sessionState: {
  sessionInfo: { user?: { id: string } }
} = {
  sessionInfo: {},
}

// The history rows link to conversations; the real Link needs a live
// router context (it destructures the context's basename), which a
// static render cannot provide - so the router module keeps its real
// exports and only Link answers a plain anchor.
const realRouterUrl = 'react-router?chat-history-real'
const realRouter = (await import(realRouterUrl)) as Record<string, unknown>

mock.module('react-router', () => ({
  ...realRouter,
  Link: ({ to, children }: { to: string; children?: React.ReactNode }) =>
    createElement('a', { href: to }, children),
}))

mock.module('@/lib/auth/sessionStorage', () => ({
  sessionStorage: {
    getValue: async () => sessionState.sessionInfo,
    setValue: async () => {},
    watch: () => () => {},
  },
  useSessionInfo: () => ({
    sessionInfo: sessionState.sessionInfo,
    isLoading: false,
    updateSessionInfo: async () => {},
  }),
}))

mock.module('@/lib/conversations/conversationStorage', () => ({
  conversationStorage: {
    getValue: async () => [],
    setValue: async () => {},
    watch: () => () => {},
  },
  useConversations: () => ({
    conversations: [],
    removeConversation: () => {},
    saveConversation: () => {},
    getConversation: () => undefined,
  }),
}))

mock.module('@/entrypoints/sidepanel/layout/ChatSessionContext', () => ({
  ChatSessionProvider: ({ children }: { children?: React.ReactNode }) =>
    children ?? null,
  useChatSessionContext: () => ({ conversationId: 'conv-1' }),
}))

const profileState: {
  profileByUserId?: { rowId: string }
} = {}

mock.module('@/lib/graphql/useGraphqlQuery', () => ({
  useGraphqlQuery: () => ({
    data: Object.keys(profileState).length ? profileState : undefined,
  }),
}))

const pagesFixture = [
  {
    conversations: {
      nodes: [
        {
          rowId: 'conv-1',
          lastMessagedAt: new Date().toISOString(),
          conversationMessages: {
            nodes: [
              {
                message: {
                  role: 'user',
                  parts: [{ type: 'text', text: 'Draft the launch plan' }],
                },
              },
            ],
          },
        },
        {
          rowId: 'conv-2',
          lastMessagedAt: new Date().toISOString(),
          conversationMessages: {
            nodes: [
              {
                message: {
                  role: 'assistant',
                  parts: [{ type: 'text', text: 'On it' }],
                },
              },
            ],
          },
        },
      ],
    },
  },
]

mock.module('@/lib/graphql/useGraphqlInfiniteQuery', () => ({
  useGraphqlInfiniteQuery: () => ({
    data: { pages: pagesFixture },
    isLoading: false,
    isFetching: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: () => {},
  }),
}))

mock.module('@/lib/graphql/useGraphqlMutation', () => ({
  useGraphqlMutation: () => ({
    mutate: () => {},
  }),
}))

const subjectUrl = './ChatHistory?chat-history-suite-real'
const { ChatHistory } = (await import(
  subjectUrl
)) as typeof import('./ChatHistory')

const renderHistory = () =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(ChatHistory),
    ),
  )

describe('ChatHistoryTsxContract', () => {
  describe('ChatHistory', () => {
    it('answers the signed-out mount with the local list and its empty note, and the signed-in mount with the today group holding the fixture conversations - the user message one and the new-conversation fallback', () => {
      sessionState.sessionInfo = {}
      const signedOut = renderHistory()
      expect(signedOut).toContain('No conversations yet')

      sessionState.sessionInfo = { user: { id: 'user-1' } }
      profileState.profileByUserId = { rowId: 'profile-9' }
      const signedIn = renderHistory()
      expect(signedIn).toContain('Today')
      expect(signedIn).toContain('Draft the launch plan')
      expect(signedIn).toContain('New conversation')
    })
  })
})
