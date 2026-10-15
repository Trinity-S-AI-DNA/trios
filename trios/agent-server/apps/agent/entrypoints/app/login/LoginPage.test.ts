/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The app login page, held against its contract
 * (gHashTag/trios#1576): the one export of
 * entrypoints/app/login/LoginPage.tsx - LoginPage - pinned as it
 * behaves today, so the next change to that file has something to
 * fail against.
 *
 * The page is a state machine over the session hook: the pending
 * session answers the full-screen spinner alone, and the settled
 * session answers the welcome card with its back button, email
 * field, the magic-link submit gated on a non-empty address, the
 * separator line and the Google button with its drawn logo. The
 * magic-link-sent card and the error alert live in handlers a
 * static render never presses.
 *
 * Two stub sets ride modules no static render resolves safely: the
 * router (spread from the real module read through a
 * query-qualified specifier, with the navigate hook answering a
 * plain callback) and the auth client in the sibling suites' own
 * shape - both stand-ins answer the settled no-session state, so
 * whichever suite links last, this card renders the same. The
 * pending branch is pinned as a source check for the same reason:
 * a later suite's auth stand-in would answer its own fixed
 * session, not this file's fixture.
 *
 * Not pinned, and why (issue User Story 2): the magic-link and
 * Google sign-in flows, the sent-card reset and the session
 * redirect's navigation itself live in callbacks and effects
 * needing a live document and a real router to press. The subject
 * is read through a query-qualified specifier so this suite's
 * graph loads as its own fresh instances.
 */

import { describe, expect, it, mock } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const realRouterUrl = 'react-router?login-page-real'
const realRouter = (await import(realRouterUrl)) as Record<string, unknown>

mock.module('react-router', () => ({
  ...realRouter,
  useParams: () => ({ stepId: '1' }),
  useNavigate: () => () => {},
  NavLink: ({ to, children }: { to: string; children?: React.ReactNode }) =>
    createElement('a', { href: to }, children),
}))

mock.module('@/lib/auth/auth-client', () => ({
  signIn: {
    magicLink: async () => ({ error: null }),
    social: async () => ({ error: null }),
  },
  signUp: async () => ({ error: null }),
  signOut: async () => ({ error: null }),
  useSession: () => ({ data: null, isPending: false }),
}))

const subjectUrl = './LoginPage?login-page-suite-real'
const { LoginPage } = (await import(subjectUrl)) as typeof import('./LoginPage')

const loginCode = () =>
  fs
    .readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        './LoginPage.tsx',
      ),
      'utf8',
    )
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')

const markup = () => renderToStaticMarkup(createElement(LoginPage))

describe('LoginPageTsxContract', () => {
  describe('LoginPage', () => {
    it('answers the settled no-session mount with the welcome card: the back button and title, the email field with its label and placeholder, the magic-link submit disabled on the empty address, the separator line, and the Google button with its drawn logo, and keeps the error alert away', () => {
      const idle = markup()
      expect(idle).toContain('lucide-arrow-left')
      expect(idle).toContain('Welcome to BrowserOS')
      expect(idle).toContain('Sign in to your account to continue')
      expect(idle).toContain('for="email">Email</label>')
      expect(idle).toContain('placeholder="you@example.com"')
      expect(idle).toContain('lucide-mail')
      expect(idle).toContain('Send Magic Link')
      expect(idle).toContain('Or continue with')
      expect(idle).toContain('Continue with Google')
      expect(idle).toContain('aria-label="Google"')
      expect(idle.split('disabled=""').length - 1).toBe(1)
      expect(idle).not.toContain('role="alert"')
      expect(idle).not.toContain('lucide-loader-circle')
    })

    it('keeps the spinner branch on the pending session, the redirect effect-gated behind a live session, the submit gated on a non-empty address, the sent and error cards where they are, and both loading disables measured', () => {
      const src = loginCode()
      if (!/if \(isPending\) \{/.test(src))
        throw new Error('the pending session must answer the spinner branch')
      if (!/session && !isPending/.test(src))
        throw new Error('the redirect must wait for a settled session')
      if (!/navigate\('\/home', \{ replace: true \}\)/.test(src))
        throw new Error('the redirect must keep its destination')
      if (!/state === 'loading' \|\| !email\.trim\(\)/.test(src))
        throw new Error('the submit must stay gated on a non-empty address')
      if (src.split("disabled={state === 'loading'}").length - 1 !== 2)
        throw new Error(
          'the input and the Google button must keep the load disable',
        )
      if (!/\{error && \(/.test(src))
        throw new Error('the error alert must stay gated on an error')
      if (!/variant="destructive"/.test(src))
        throw new Error('the error alert must stay destructive')
      if (!/Check your email/.test(src))
        throw new Error('the sent card must keep its title')
      if (!/Use a different email/.test(src))
        throw new Error('the sent card must keep its reset action')
    })
  })
})
