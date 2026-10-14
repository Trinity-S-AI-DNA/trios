/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The sidebar branding, held against its contract
 * (gHashTag/trios#1624): the single export of
 * components/sidebar/SidebarBranding.tsx - SidebarBranding - pinned as
 * it behaves today, so the next change to that file has something to
 * fail against.
 *
 * The tree renders inside a MemoryRouter (the menu items navigate) and
 * the seams answer logged-out and logged-in shapes through stand-ins
 * registered before anything imports: the session hook, the workspace
 * hook and the graphql query hook (its real module rides the react-query
 * machinery), and the generated graphql tag (which the Tests jobs never
 * generate). The dropdown kit stays REAL - Radix answers its trigger
 * statically and its content only when open, so the closed menu's items
 * are not pinnable here; the theme toggle is stubbed because its theme
 * hook rejects in a static render (measured: an unhandled rejection
 * killed the probe process - and no other suite imports it, so the
 * stub cannot leak into anyone's answer).
 *
 * Pinned: the logged-out answer (the product logo, the BrowserOS label,
 * the Sign in note in primary color, the chevron) in both expanded and
 * collapsed shapes; the logged-in answer (the initials fallback of the
 * display name when no avatar, the Personal note in muted color); the
 * avatar when the profile carries one; and the theme toggle slot in both
 * modes. Not pinned: the menu's items (Update Profile / Sign out / the
 * login item - they live in the closed content) and the navigation
 * itself.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'

mock.module('@/generated/graphql/gql', () => ({
  graphql: (query: string) => ({ query }),
}))
mock.module('@/lib/auth/sessionStorage', () => ({
  useSessionInfo: () => ({ sessionInfo: null }),
  sessionStorage: { getValue: async () => null, watch: () => () => {} },
}))
mock.module('@/lib/workspace/use-workspace', () => ({
  useWorkspace: () => ({ selectedFolder: null }),
}))
mock.module('@/lib/graphql/useGraphqlQuery', () => ({
  useGraphqlQuery: () => ({ data: undefined, isLoading: false }),
}))
mock.module('@/components/elements/theme-toggle', () => ({
  ThemeToggle: () =>
    createElement('button', { type: 'button', 'data-testid': 'theme-toggle' }),
}))

// The session and graphql hooks are re-registered on their PLAIN paths
// (the ones the subject imports) before each query-qualified re-import of
// the subject, so every test binds its own fresh instances against its
// own answer; the registration is the process-global one, which is why
// each re-import uses a fresh query suffix.
// Every test registers the answer it needs on the PLAIN paths the subject
// imports, then reads its own query-qualified fresh instance - an
// already-materialized instance keeps its first binding, so sharing one
// across tests would freeze the logged-out answer (measured).
const freshBranding = async (suffix: string) => {
  const subjectUrl = `./SidebarBranding?branding-${suffix}`
  const { SidebarBranding: Fresh } = (await import(
    subjectUrl
  )) as typeof import('./SidebarBranding')
  return (expanded = true) =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(Fresh as never, { expanded } as never),
      ),
    )
}

const registerLoggedOut = () => {
  mock.module('@/lib/auth/sessionStorage', () => ({
    useSessionInfo: () => ({ sessionInfo: null }),
    sessionStorage: { getValue: async () => null, watch: () => () => {} },
  }))
  mock.module('@/lib/graphql/useGraphqlQuery', () => ({
    useGraphqlQuery: () => ({ data: undefined, isLoading: false }),
  }))
}

describe('sidebarBrandingContract', () => {
  it('answers the logged-out branding: product logo, BrowserOS, Sign in, chevron', async () => {
    registerLoggedOut()
    const markup = await freshBranding('logged-out')
    const m = markup()
    expect(m).toContain('product_logo.svg')
    expect(m).toContain('alt="BrowserOS"')
    expect(m).toContain('BrowserOS')
    expect(m).toContain('Sign in')
    expect(m).toContain('lucide-chevron-down')
    expect(m).not.toContain('Personal')
    expect(m).not.toContain('mdx')
  })

  it('answers the Sign in note in primary color and the Personal note in muted color', async () => {
    registerLoggedOut()
    const markup = await freshBranding('sign-in-note')
    const loggedOut = markup()
    expect(loggedOut).toContain('font-medium text-primary')
    expect(loggedOut).not.toContain('text-muted-foreground">Personal')

    mock.module('@/lib/auth/sessionStorage', () => ({
      useSessionInfo: () => ({
        sessionInfo: { user: { id: 'u-1', name: 'Ada Lovelace' } },
      }),
      sessionStorage: { getValue: async () => null, watch: () => () => {} },
    }))
    mock.module('@/lib/graphql/useGraphqlQuery', () => ({
      useGraphqlQuery: () => ({ data: undefined, isLoading: false }),
    }))
    const render = await freshBranding('logged-in')
    const loggedIn = render()
    expect(loggedIn).toContain('Personal')
    expect(loggedIn).not.toContain('Sign in')
    expect(loggedIn).toContain('AL')
    expect(loggedIn).not.toContain('product_logo.svg')
  })

  it('answers the avatar when the profile carries one', async () => {
    mock.module('@/lib/auth/sessionStorage', () => ({
      useSessionInfo: () => ({
        sessionInfo: { user: { id: 'u-1', name: 'Ada' } },
      }),
      sessionStorage: { getValue: async () => null, watch: () => () => {} },
    }))
    mock.module('@/lib/graphql/useGraphqlQuery', () => ({
      useGraphqlQuery: () => ({
        data: { profileByUserId: { avatarUrl: 'https://img.test/a.png' } },
        isLoading: false,
      }),
    }))
    const render = await freshBranding('avatar')
    const m = render()
    expect(m).toContain('src="https://img.test/a.png"')
    expect(m).toContain('rounded-full object-cover')
  })

  it('answers the theme toggle slot in both expansion modes', async () => {
    registerLoggedOut()
    const markup = await freshBranding('toggle')
    expect(markup()).toContain('data-testid="theme-toggle"')
    expect(markup(false)).toContain('data-testid="theme-toggle"')
  })

  it('answers the collapsed branding with its label block hidden', async () => {
    registerLoggedOut()
    const markup = await freshBranding('collapsed')
    const m = markup(false)
    expect(m).toContain('product_logo.svg')
    // Collapsed swaps the label block's opacity class for a hidden class -
    // the text stays in the answer, the visibility is what changes (cn
    // writes the hidden class in its own position - measured).
    expect(m).toContain('duration-200 hidden')
    expect(m).not.toContain('opacity-100')
    expect(markup(true)).toContain('opacity-100')
  })
})
