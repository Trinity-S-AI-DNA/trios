/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The sign-in onboarding step, held against its contract
 * (gHashTag/trios#1570): the one export of
 * entrypoints/onboarding/steps/StepTwo.tsx - StepTwo - pinned as it
 * behaves today, so the next change to that file has something to
 * fail against.
 *
 * The step signs in through the auth client and reads the onboarding
 * storage, so both are stubbed with full stand-ins: the auth client
 * (whose real module pulls better-auth and the env module into the
 * graph) answers capturing no-op sign-ins, and the metrics track is
 * a no-op (its real module pulls the adapter graph, which earlier
 * suites of this job stub incompletely - the process-global trap
 * this wave has documented twice). The @wxt-dev/storage fake
 * underneath the onboarding storage item is the one every storage
 * suite of this wave runs with. Measured, the static render goes
 * through the step's motion wrapper and shows the sign-in screen the
 * step first answers.
 *
 * Not pinned, and why (issue User Story 2): the sign-in flows
 * themselves - the magic link and the Google button live in submit
 * handlers that need a live document, and their outcomes (the
 * sent-confirmation screen, the error alert) arrive through state
 * transitions the static render cannot reach. The port env seam is
 * seeded before any import can reach the env module (its one-time
 * snapshot - the trap the agent-outputs suite documented), with the
 * subject imported dynamically for that reason.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// biome-ignore lint/style/noProcessEnv: the env seam is the only way to reach the port helpers before the env module's one-time snapshot freezes (see suite header)
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'

const values = new Map<string, unknown>()

mock.module('@wxt-dev/storage', () => ({
  storage: {
    defineItem: (key: string, opts?: unknown) => ({
      getValue: async () => {
        if (values.has(key)) {
          return values.get(key)
        }
        const fallback = (opts as { fallback?: unknown } | undefined)?.fallback
        return fallback ?? null
      },
      setValue: async (value: unknown) => {
        values.set(key, value)
      },
      watch: () => () => {},
    }),
  },
}))

const magicLinkCalls: Array<{ email: string }> = []

mock.module('@/lib/auth/auth-client', () => ({
  signIn: {
    magicLink: async (input: { email: string }) => {
      magicLinkCalls.push(input)
      return { error: null }
    },
    social: async () => ({ error: null }),
  },
  signUp: async () => ({ error: null }),
  signOut: async () => ({ error: null }),
  useSession: () => ({ data: null, isPending: false }),
}))

mock.module('@/lib/metrics/track', () => ({
  track: () => {},
}))

const { StepTwo } = await import('./StepTwo')

describe('StepTwoTsxContract', () => {
  describe('StepTwo', () => {
    it('answers the sign-in screen: the heading, the Google button, the email field with its placeholder, the disabled magic-link button without an address, and the skip control', () => {
      const markup = renderToStaticMarkup(
        createElement(StepTwo, { direction: 1, onContinue: () => {} }),
      )
      expect(markup).toContain('Sign in to BrowserOS')
      expect(markup).toContain('Continue with Google')
      expect(markup).toContain('Or continue with email')
      expect(markup).toContain('you@example.com')
      expect(markup).toContain('Send Magic Link')
      expect(markup).toContain('Skip for now')
      expect(markup).toContain('disabled')
    })
  })
})
