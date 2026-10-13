/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The OpenClaw CLI providers, held against their contract
 * (gHashTag/trios#1605): the five exports of
 * entrypoints/app/agents/openclaw-cli-providers.tsx -
 * OPENCLAW_CLI_PROVIDERS, findOpenClawCliProviderById,
 * buildOpenClawCliProviderOptions, useOpenClawCliProviderAuthStatus,
 * OpenClawCliProviderStatusPanel - pinned as they behave today, so
 * the next change to that file has something to fail against.
 *
 * The registry, the lookup and the option builder are pure, so the
 * suite calls them directly. The auth-status hook is a React Query
 * hook, so it runs inside a fresh QueryClientProvider with
 * renderToStaticMarkup - outside the BrowserOS shell there is no
 * base URL, the query stays disabled and no fetch happens, and a
 * disabled query still reads the cache: seeding the declared key
 * drives the data path without any network. The status panel is a
 * hook-free render function of its props, so the suite calls it
 * directly and pins every branch it answers: the initial check, the
 * fetch failure, the nothing-without-a-status, the
 * not-installed notice, the connected identity, and the not-set-up
 * card with its Connect button wired to the callback handed in.
 *
 * The port env seam is seeded before any import that can reach the
 * env module (lib/env.ts parses import.meta.env once at load, and
 * this suite's graph loads it ahead of the helpers suite in the CI
 * file order), exactly as the agent-outputs suite of this wave
 * seeds it; the subject is imported dynamically for that reason.
 */

import { describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button } from '@/components/ui/button'

// biome-ignore lint/style/noProcessEnv: the env seam is the only way to reach the port helpers before the env module's one-time snapshot freezes (see suite header)
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'

const {
  OPENCLAW_CLI_PROVIDERS,
  OpenClawCliProviderStatusPanel,
  buildOpenClawCliProviderOptions,
  findOpenClawCliProviderById,
  useOpenClawCliProviderAuthStatus,
} = await import('./openclaw-cli-providers')

type AnyElement = {
  type: unknown
  props: Record<string, unknown>
}

const isElement = (node: unknown): node is AnyElement =>
  typeof node === 'object' && node !== null && 'type' in node

function* walk(node: unknown): Generator<AnyElement> {
  if (Array.isArray(node)) {
    for (const child of node) {
      yield* walk(child)
    }
    return
  }
  if (!isElement(node)) {
    return
  }
  yield node
  const children = node.props.children
  if (children !== null && children !== undefined) {
    yield* walk(children)
  }
}

const elementsOf = (node: unknown, type: unknown): AnyElement[] =>
  [...walk(node)].filter((element) => element.type === type)

const textOf = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join('')
  }
  if (isElement(node)) {
    return textOf(node.props.children)
  }
  return ''
}

const claudeProvider = {
  id: 'claude-cli',
  displayName: 'Anthropic Claude CLI',
  description: 'Uses your Claude.ai subscription via the Claude Code CLI',
  models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'],
  authLoginCommand: 'claude /login',
}

describe('openclawCliProvidersTsxContract', () => {
  describe('OPENCLAW_CLI_PROVIDERS', () => {
    it('carries the Claude CLI provider with its three models and login command', () => {
      expect(OPENCLAW_CLI_PROVIDERS.length).toBe(1)
      expect(OPENCLAW_CLI_PROVIDERS[0]).toEqual(claudeProvider)
    })
  })

  describe('findOpenClawCliProviderById', () => {
    it('answers the provider for its id and nothing for an unknown one', () => {
      expect(findOpenClawCliProviderById('claude-cli')?.displayName).toBe(
        'Anthropic Claude CLI',
      )
      expect(findOpenClawCliProviderById('unknown-cli')).toBeUndefined()
    })
  })

  describe('buildOpenClawCliProviderOptions', () => {
    it('answers one option per model, keyed provider and model together', () => {
      const options = buildOpenClawCliProviderOptions()
      expect(options.length).toBe(3)
      expect(options[0]).toEqual({
        id: 'claude-cli/claude-sonnet-4-6',
        type: 'claude-cli',
        name: 'Anthropic Claude CLI',
        modelId: 'claude-sonnet-4-6',
      })
      expect(options[2]?.modelId).toBe('claude-haiku-4-5')
    })
  })

  describe('useOpenClawCliProviderAuthStatus', () => {
    it('answers no status without a base URL, and flows the cached status through once the cache holds it', () => {
      const client = new QueryClient()
      const probe = () => {
        const { data } = useOpenClawCliProviderAuthStatus('claude-cli', true)
        return createElement(
          'pre',
          null,
          data
            ? `auth:${String(data.loggedIn)}:${String(data.accountLabel)}`
            : 'no-status',
        )
      }
      const render = () =>
        renderToStaticMarkup(
          createElement(QueryClientProvider, { client }, createElement(probe)),
        )
      expect(render()).toContain('no-status')

      client.setQueryData(['openclaw-cli-auth', null, 'claude-cli'], {
        installed: true,
        loggedIn: true,
        accountLabel: 'dev@example.com',
      })
      expect(render()).toContain('auth:true:dev@example.com')
    })
  })

  describe('OpenClawCliProviderStatusPanel', () => {
    it('answers the panel for every state it is handed: the check, the failure, nothing, not installed, connected with the identity, and the not-set-up card with its Connect button wired to the callback', () => {
      const provider = claudeProvider as unknown as Parameters<
        typeof OpenClawCliProviderStatusPanel
      >[0]['provider']
      const onConnect = () => {}

      const checking = OpenClawCliProviderStatusPanel({
        provider,
        status: undefined,
        loading: true,
        fetchError: null,
        onConnect,
      })
      expect(textOf(checking)).toContain('Checking Anthropic Claude CLI status')

      const failed = OpenClawCliProviderStatusPanel({
        provider,
        status: undefined,
        loading: false,
        fetchError: new Error('gateway refused'),
        onConnect,
      })
      expect(textOf(failed)).toContain(
        'Could not read Anthropic Claude CLI status',
      )
      expect(textOf(failed)).toContain('gateway refused')

      expect(
        OpenClawCliProviderStatusPanel({
          provider,
          status: undefined,
          loading: false,
          fetchError: null,
          onConnect,
        }),
      ).toBeNull()

      const missing = OpenClawCliProviderStatusPanel({
        provider,
        status: { installed: false, loggedIn: false },
        loading: false,
        fetchError: null,
        onConnect,
      })
      expect(textOf(missing)).toContain('Anthropic Claude CLI not installed')

      const connected = OpenClawCliProviderStatusPanel({
        provider,
        status: {
          installed: true,
          loggedIn: true,
          accountLabel: 'dev@example.com',
          subscriptionLabel: 'Pro plan',
        },
        loading: false,
        fetchError: null,
        onConnect,
      })
      expect(textOf(connected)).toContain('Connected to Anthropic Claude CLI')
      expect(textOf(connected)).toContain('dev@example.com (Pro plan)')

      const ready = OpenClawCliProviderStatusPanel({
        provider,
        status: { installed: true, loggedIn: true },
        loading: false,
        fetchError: null,
        onConnect,
      })
      expect(textOf(ready)).toContain('Ready')

      const notSetUp = OpenClawCliProviderStatusPanel({
        provider,
        status: {
          installed: true,
          loggedIn: false,
          error: 'token expired',
        },
        loading: false,
        fetchError: null,
        onConnect,
      })
      expect(textOf(notSetUp)).toContain('Anthropic Claude CLI not set up')
      expect(textOf(notSetUp)).toContain('token expired')
      const connect = elementsOf(notSetUp, Button)[0]
      expect(connect?.props.onClick).toBe(onConnect)
      expect(textOf(connect)).toContain('Connect Anthropic Claude CLI')
    })
  })
})
