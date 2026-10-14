/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The first onboarding step, held against its contract
 * (gHashTag/trios#1542): the one export of
 * entrypoints/onboarding/steps/StepOne.tsx - StepOne - pinned as it
 * behaves today, so the next change to that file has something to
 * fail against.
 *
 * The step draws the form machinery (react-hook-form with its zod
 * resolver, the shadcn form and command kits, the buttons and
 * inputs) for real - it survives a static render untouched - and
 * stubs the rest: the metrics track (a no-op - its real module
 * pulls the adapter graph other suites stub incompletely), the
 * storage fake underneath, and a portal-free popover stand-in that
 * keeps the real kit's contract (the trigger always renders, the
 * content only while open) and carries every value export the real
 * kit has. The onboarding and personalization item modules are
 * mocked with live proxies instead of stand-ins: mock.module
 * registrations persist for every file that links after this one,
 * and the suites downstream read those items through their own
 * storage fakes - a proxy resolving the storage facade at call time
 * serves their values, a closed-over fake would starve them.
 * Measured, the static render answers the step as it first mounts:
 * the heading with its intro, the four labelled fields with their
 * placeholders, the role picker's closed trigger, and the continue
 * button - none of the picker's content leaking.
 *
 * Not pinned, and why (issue User Story 2): the submit flow - the
 * profile and personalization writes, the two tracked events, the
 * continue callback - lives in the form's submit handler, and the
 * role picker's open list - the search box and the role entries -
 * sits behind an open state the step owns internally, so both need
 * a live document to reach. The port env seam is seeded before any
 * import can reach the env module (its one-time snapshot - the trap
 * the agent-outputs suite documented), with the subject read
 * through a query-qualified specifier so this suite's graph loads
 * as its own fresh instances under this file's registrations.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// biome-ignore lint/style/noProcessEnv: the env seam is the only way to reach the port helpers before the env module's one-time snapshot freezes (see suite header)
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'

const values = new Map<string, unknown>()

const fakeItem = (key: string, opts: unknown) => ({
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
})

mock.module('@wxt-dev/storage', () => ({
  storage: {
    defineItem: (key: string, opts?: unknown) => fakeItem(key, opts),
  },
}))

mock.module('@/lib/metrics/track', () => ({
  track: () => {},
}))

// A storage item that resolves the storage facade at call time, so
// whichever suite links after this one and registers its own fake
// serves the reads of the module this mock replaces.
const proxyItem = (key: `local:${string}`, opts: { fallback: unknown }) => ({
  getValue: async () => {
    const { storage } = await import('@wxt-dev/storage')
    return storage.defineItem<unknown>(key, opts).getValue()
  },
  setValue: async (value: unknown) => {
    const { storage } = await import('@wxt-dev/storage')
    await storage.defineItem<unknown>(key, opts).setValue(value)
  },
  watch: () => () => {},
})

mock.module('@/lib/personalization/personalizationStorage', () => ({
  personalizationStorage: proxyItem('local:personalization', {
    fallback: '',
  }),
  usePersonalization: () => ({
    personalization: '',
    setPersonalization: () => {},
    clearPersonalization: async () => {},
  }),
}))

mock.module('@/lib/onboarding/onboardingStorage', () => ({
  onboardingCompletedStorage: proxyItem('local:onboardingCompleted', {
    fallback: false,
  }),
  onboardingProfileStorage: proxyItem('local:onboardingProfile', {
    fallback: null,
  }),
  importHintDismissedAtStorage: proxyItem('local:importHintDismissedAt', {
    fallback: null,
  }),
  signInHintDismissedAtStorage: proxyItem('local:signInHintDismissedAt', {
    fallback: null,
  }),
  authRedirectPathStorage: proxyItem('local:authRedirectPath', {
    fallback: null,
  }),
  firstRunConfettiShownStorage: proxyItem('local:firstRunConfettiShown', {
    fallback: false,
  }),
}))

// Radix portals never flush through a static render, so the popover
// kit is stubbed with a portal-free stand-in - every value export
// the module carries, the content rendering its children inline and
// the root honouring the open flag, so closed pickers stay hidden
// for every other suite of this group, exactly as the real one
// behaves outside a live document.
let popoverOpen = false
mock.module('@/components/ui/popover', () => ({
  Popover: ({
    open,
    children,
  }: {
    open?: boolean
    children?: React.ReactNode
  }) => {
    popoverOpen = !!open
    return children ?? null
  },
  PopoverAnchor: () => null,
  PopoverContent: ({ children }: { children?: React.ReactNode }) =>
    popoverOpen ? children : null,
  PopoverTrigger: ({ children }: { children?: React.ReactNode }) =>
    children ?? null,
}))

const subjectUrl = './StepOne?step-one-suite-real'
const { StepOne } = (await import(subjectUrl)) as typeof import('./StepOne')

describe('StepOneTsxContract', () => {
  describe('StepOne', () => {
    it('answers the step as it first mounts: the heading with its intro, the four labelled fields with their placeholders, the closed role picker trigger, and the continue button - none of the picker content leaking', () => {
      const markup = renderToStaticMarkup(
        createElement(StepOne, {
          direction: 1,
          onContinue: () => {},
        }),
      )
      expect(markup).toContain('Tell us about yourself')
      expect(markup).toContain('Help us personalize your experience')
      expect(markup).toContain('Your name')
      expect(markup).toContain('What should we call you?')
      expect(markup).toContain('Your role')
      expect(markup).toContain('Select or type a role')
      expect(markup).toContain('Company')
      expect(markup).toContain('Acme Inc.')
      expect(markup).toContain('What does a typical day look like for you?')
      expect(markup).toContain('Continue')
      expect(markup).not.toContain('Search roles...')
      expect(markup).not.toContain('Software Engineer')
    })
  })
})
