/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The chat header, held against its contract
 * (gHashTag/trios#1638): the single export of
 * entrypoints/sidepanel/index/ChatHeader.tsx - ChatHeader - pinned as
 * it behaves today, so the next change to that file has something to
 * fail against.
 *
 * The header reads the router location, so the tree renders inside a
 * MemoryRouter with seeded entries, which makes the history-page
 * variant statically reachable. The credits hook answers an unanswered
 * query (data undefined), so the credits badge renders nothing - that
 * branch and its live answer are not pinned. The storage seam is the
 * repository's in-memory item shim (the real @wxt-dev/storage refuses
 * the test process; every store suite asserts only on its own map).
 * Not pinned: the theme toggle's click, the provider dropdown's open
 * list, and the credits badge.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'

const values = new Map<string, unknown>()

mock.module('@wxt-dev/storage', () => ({
  storage: {
    defineItem: (
      key: string,
      options?: { fallback?: unknown } & Record<string, unknown>,
    ) => ({
      getValue: async () => {
        if (values.has(key)) return values.get(key)
        return options && 'fallback' in options ? options.fallback : null
      },
      setValue: async (value: unknown) => {
        values.set(key, value)
      },
      watch: () => () => {},
    }),
  },
}))

mock.module('@/lib/credits/useCredits', () => ({
  useCredits: () => ({ data: undefined }),
}))

const { ChatHeader } = await import('./ChatHeader')
const { productRepositoryUrl } = await import('@/lib/constants/productUrls')

type HeaderProps = Record<string, unknown>

const browserosProvider = {
  kind: 'browser',
  type: 'browseros',
  name: 'BrowserOS',
}

const markup = (props: HeaderProps, pathname = '/'): string =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [pathname] },
      createElement(
        ChatHeader as never,
        {
          selectedProvider: browserosProvider,
          providers: [],
          onSelectProvider: () => {},
          onNewConversation: () => {},
          hasMessages: true,
          ...props,
        } as never,
      ),
    ),
  )

describe('chatHeaderContract', () => {
  it('answers the provider button, the github star and the settings link', () => {
    const m = markup({})
    expect(m).toContain('title="Change AI Provider"')
    expect(m).toContain('BrowserOS')
    expect(m).toContain(`href="${productRepositoryUrl}"`)
    expect(m).toContain('title="Star on Github"')
    expect(m).toContain('href="/app.html#/settings"')
    expect(m).toContain('title="Settings"')
    expect(m).toContain('lucide-github')
  })

  it('answers the new-conversation button only when the chat has messages', () => {
    expect(markup({})).toContain('title="New conversation"')
    expect(markup({ hasMessages: false })).not.toContain(
      'title="New conversation"',
    )
  })

  it('answers the history link off the history page and the plus button on it', () => {
    expect(markup({})).toContain('title="Chat history"')
    expect(markup({})).toContain('lucide-history')
    const onHistory = markup({}, '/history')
    expect(onHistory).toContain('title="New conversation"')
    expect(onHistory).not.toContain('title="Chat history"')
  })

  it('answers no history controls when history is hidden', () => {
    const m = markup({ hideHistory: true })
    expect(m).not.toContain('title="Chat history"')
    const onHistory = markup({ hideHistory: true }, '/history')
    expect(onHistory).not.toContain('title="New conversation"')
  })

  it('answers the icon dispatch by provider kind and type', () => {
    const acp = markup({
      selectedProvider: { kind: 'acp', type: 'claude', name: 'Claude' },
    })
    expect(acp).toContain('lucide-bot')
    expect(acp).toContain('Claude')

    const custom = markup({
      selectedProvider: { kind: 'model', type: 'openai', name: 'My GPT' },
    })
    expect(custom).not.toContain('lucide-bot')
    expect(custom).toContain('My GPT')
  })
})
