/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The profile page, held against its contract
 * (gHashTag/trios#1523): the one export of
 * entrypoints/app/profile/ProfilePage.tsx - ProfilePage - pinned
 * as it behaves today, so the next change to that file has something
 * to fail against.
 *
 * This was the second subject the frozen session facade blocked: the
 * page statically imports useSessionInfo, and until the session
 * seam's earliest registrar carried the full named-export set (the
 * #1980 repair, proven by #2025), the page could not even link in
 * the group. The suite drives the two hooks the page reads - the
 * session seam through a mutable holder answering signed-out and
 * signed-in states, the profile query through a holder answering
 * the loaded profile - inside a real memory router and query client
 * provider, with the update mutation stubbed idle. Everything else
 * stays real: the form machinery with its zod resolver, the card and
 * button kits. Measured, the signed-out mount answers only its
 * spinner - no profile card; and the signed-in loaded mount answers
 * the update-profile card with its title and description - the
 * profile's names reach the form fields through a reset effect a
 * static render never runs, so they are not part of the mount.
 *
 * Not pinned, and why (issue User Story 2): the update flow itself
 * - the mutation and its success note, the avatar upload with its
 * size guard, the validation messages, and the profile-names reset
 * into the form fields - lives in handlers and effects needing a
 * live document to press. The port env seam is seeded before any
 * import can reach the env module (its one-time snapshot - the trap
 * the agent-outputs suite documented), with the subject read
 * through a query-qualified specifier so this suite's graph loads
 * as its own fresh instances.
 */

import { describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'

// biome-ignore lint/style/noProcessEnv: the env seam is the only way to reach the port helpers before the env module's one-time snapshot freezes (see suite header)
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'

const sessionState: {
  sessionInfo: { user?: { id: string } }
} = {
  sessionInfo: {},
}

const profileState: {
  profileByUserId?: {
    rowId: string
    firstName: string
    lastName: string
    avatarUrl?: string
  }
} = {}

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

mock.module('@/lib/graphql/useGraphqlQuery', () => ({
  useGraphqlQuery: () => ({
    data: profileState.profileByUserId,
    isLoading: false,
  }),
}))

mock.module('@/lib/graphql/useGraphqlMutation', () => ({
  useGraphqlMutation: () => ({
    mutate: () => {},
  }),
}))

const subjectUrl = './ProfilePage?profile-page-suite-real'
const { ProfilePage } = (await import(
  subjectUrl
)) as typeof import('./ProfilePage')

const renderPage = () =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(
        MemoryRouter,
        { initialEntries: ['/profile'] },
        createElement(ProfilePage),
      ),
    ),
  )

describe('ProfilePageTsxContract', () => {
  describe('ProfilePage', () => {
    it('answers the signed-out mount with only its spinner, and the signed-in loaded mount with the update-profile card carrying its title and description', () => {
      const signedOut = renderPage()
      expect(signedOut).not.toContain('Update Profile')
      expect(signedOut).toContain('animate-spin')

      sessionState.sessionInfo = { user: { id: 'user-1' } }
      profileState.profileByUserId = {
        rowId: 'profile-9',
        firstName: 'Ada',
        lastName: 'Lovelace',
      }
      const loaded = renderPage()
      expect(loaded).toContain('Update Profile')
      expect(loaded).toContain('Update your profile information')
    })
  })
})
