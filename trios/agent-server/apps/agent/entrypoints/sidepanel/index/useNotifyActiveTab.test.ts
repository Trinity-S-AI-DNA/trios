/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The active-tab glow notification hook, held against its contract
 * (gHashTag/trios#1646): the one export of
 * entrypoints/sidepanel/index/useNotifyActiveTab.tsx -
 * useNotifyActiveTab - pinned as it behaves today, so the next
 * change to that file has something to fail against.
 *
 * The hook's whole observable life is its render-time handling of
 * the props - picking the latest tool part from the last message -
 * and its void answer: everything else, the glow lifecycle itself,
 * lives inside one effect a static render never runs. So the suite
 * renders the hook through probe components in both prop shapes the
 * render-time path dispatches on - an empty stream-ready history,
 * and a streaming turn whose last message carries a tool part with
 * a tab id - and pins that both answer nothing, the onboarding
 * confetti item the effect reads stubbed with the group's
 * live-proxy form (mock.module registrations persist for every
 * later-linking file, so the item resolves the storage facade at
 * call time and later suites keep reading their own seeded values).
 *
 * Not pinned, and why (issue User Story 2): the glow lifecycle -
 * the activate and deactivate tab messages, the active-tab fallback
 * query, the first-run confetti write - lives in the effect and
 * the chrome tab APIs it calls, and reaching it needs a live
 * document with effects that actually run. The subject is read
 * through a query-qualified specifier so this suite's graph loads
 * as its own fresh instances.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement, type FC } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// biome-ignore lint/style/noProcessEnv: the env seam is the only way to reach the port helpers before the env module's one-time snapshot freezes (see suite header)
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'

mock.module('@wxt-dev/storage', () => ({
  storage: {
    defineItem: () => ({
      getValue: async () => null,
      setValue: async () => {},
      watch: () => () => {},
    }),
  },
}))

// The onboarding item module in its live-proxy form: the items
// resolve the storage facade at call time, so whichever suite links
// after this one and registers its own fake serves the reads.
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

const subjectUrl = './useNotifyActiveTab?notify-tab-suite-real'
const { useNotifyActiveTab } = (await import(
  subjectUrl
)) as typeof import('./useNotifyActiveTab')

const Probe: FC<{
  messages: Parameters<typeof useNotifyActiveTab>[0]['messages']
  status: Parameters<typeof useNotifyActiveTab>[0]['status']
}> = ({ messages, status }) => {
  const answer = useNotifyActiveTab({
    messages,
    status,
    conversationId: 'conversation-1',
  })
  return createElement('span', null, String(answer))
}

describe('useNotifyActiveTabTsxContract', () => {
  describe('useNotifyActiveTab', () => {
    it('answers nothing for both prop shapes the render-time path handles: the empty stream-ready history, and the streaming turn whose last message carries a tool part with a tab id', () => {
      const settled = renderToStaticMarkup(
        createElement(Probe, { messages: [], status: 'ready' }),
      )
      expect(settled).toContain('undefined')

      const streaming = renderToStaticMarkup(
        createElement(Probe, {
          status: 'streaming',
          messages: [
            {
              id: 'm1',
              role: 'assistant',
              parts: [
                {
                  type: 'tool-browser',
                  toolCallId: 'call-1',
                  state: 'output-available' as const,
                  input: { tabId: 7 },
                  output: { metadata: { tabId: 7 } },
                },
              ],
            },
          ],
        }),
      )
      expect(streaming).toContain('undefined')
    })
  })
})
