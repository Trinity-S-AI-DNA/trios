/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The LLM provider hook, held against its contract
 * (gHashTag/trios#1611): the one export of
 * lib/llm-providers/useLlmProviders.ts - useLlmProviders - pinned
 * as it behaves today, so the next change to that file has something
 * to fail against.
 *
 * The hook loads its provider list inside one effect a static render
 * never runs, so the first mount answers the initial state: an empty
 * provider list, the built-in default provider id, no selection,
 * the loading flag up, and the three mutators as functions. The
 * suite renders that answer through a probe component and needs only
 * the storage fake underneath - the provider storage module, its
 * graphql upload partner and the adapter seam all load for real in
 * this group and nothing calls them before a live mount.
 *
 * Not pinned, and why (issue User Story 2): every flow the
 * mutators and the load effect own - saving, re-defaulting and
 * deleting providers, the empty-storage bootstrap, the stale
 * default repair, the storage watchers - lives in async handlers
 * that need a live document and effects that actually run. The
 * port env seam is seeded before any import can reach the env
 * module (its one-time snapshot - the trap the agent-outputs suite
 * documented), with the subject read through a query-qualified
 * specifier so this suite's graph loads as its own fresh instances.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement, type FC } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// biome-ignore lint/style/noProcessEnv: the env seam is the only way to reach the port helpers before the env module's one-time snapshot freezes (see suite header)
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'

mock.module('@wxt-dev/storage', () => ({
  storage: {
    defineItem: (_key: string, opts?: unknown) => ({
      getValue: async () => {
        const fallback = (opts as { fallback?: unknown } | undefined)?.fallback
        return fallback ?? null
      },
      setValue: async () => {},
      watch: () => () => {},
    }),
  },
}))

const subjectUrl = './useLlmProviders?llm-providers-suite-real'
const { useLlmProviders } = (await import(
  subjectUrl
)) as typeof import('./useLlmProviders')

const Probe: FC = () => {
  const answer = useLlmProviders()
  return createElement(
    'pre',
    null,
    JSON.stringify({
      providers: answer.providers,
      defaultProviderId: answer.defaultProviderId,
      selectedProvider: answer.selectedProvider,
      isLoading: answer.isLoading,
      saveProvider: typeof answer.saveProvider,
      setDefaultProvider: typeof answer.setDefaultProvider,
      deleteProvider: typeof answer.deleteProvider,
    }),
  )
}

describe('useLlmProvidersContract', () => {
  describe('useLlmProviders', () => {
    it('answers the first mount with the empty provider list, the built-in default id, no selection, the loading flag up, and the three mutators as functions', () => {
      const markup = renderToStaticMarkup(createElement(Probe))
      // static markup escapes the quotes of the rendered JSON, so
      // the pins stick to the escaped-proof keys and bare values
      expect(markup).toContain('providers')
      expect(markup).toContain('defaultProviderId')
      expect(markup).toContain('browseros')
      expect(markup).toContain('selectedProvider')
      expect(markup).toContain(':null')
      expect(markup).toContain('isLoading')
      expect(markup).toContain(':true')
      expect(markup).toContain('function')
    })
  })
})
