/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The sidepanel chat refs hook, held against its contract
 * (gHashTag/trios#1660): the one export of
 * entrypoints/sidepanel/index/useChatRefs.ts - useChatRefs - pinned
 * as it behaves today, so the next change to that file has something
 * to fail against.
 *
 * The hook composes the sidepanel's data seams into refs and the
 * chat-target list, so each seam is stubbed and the hook's observable
 * answer is rendered through a probe component: the MCP store mock
 * is the live-proxy form (its item resolves the storage facade at
 * call time so later suites keep reading their own seeded values,
 * while the hook answers fixture servers), the agents and mutations
 * module is a spread-real read keeping its value exports with the
 * two listing hooks replaced, the llm-provider hook answers one
 * selected fixture provider, the personalization hook a settled
 * string, and the sidepanel chat-target helpers stay real - the
 * targets and the selected target the hook answers are their real
 * output for the stubbed inputs. Measured, the first render answers
 * the managed and custom server refs built from the fixture store,
 * the personalization ref, the selected provider ref, the llm target
 * for the fixture provider as both the built list and the resolved
 * selection, and the settled loading flag.
 *
 * Not pinned, and why (issue User Story 2): everything the effects
 * and callbacks own - the deep-compare ref refresh, the stored
 * selection load and persist, the selectChatTarget write - needs a
 * live document and effects that actually run; the static render
 * pins the initial ref values the hook seeds its refs with. The
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
    defineItem: () => ({
      getValue: async () => null,
      setValue: async () => {},
      watch: () => () => {},
    }),
  },
}))

// The MCP store mock in its live-proxy form: the item resolves the
// storage facade at call time so suites that link after this one
// keep reading their own seeded values, while the hook answers the
// fixture servers the refs are seeded from.
class McpServerStub {}

mock.module('@/lib/mcp/mcpServerStorage', () => ({
  McpServer: McpServerStub,
  mcpServerStorage: {
    getValue: async () => {
      const { storage } = await import('@wxt-dev/storage')
      return storage
        .defineItem<unknown>('local:mcpServers', { fallback: [] })
        .getValue()
    },
    setValue: async (value: unknown) => {
      const { storage } = await import('@wxt-dev/storage')
      await storage
        .defineItem<unknown>('local:mcpServers', { fallback: [] })
        .setValue(value)
    },
    watch: () => () => {},
  },
  useMcpServers: () => ({
    servers: [
      {
        id: 'm1',
        displayName: 'Search',
        type: 'managed',
        managedServerName: 'search',
      },
      {
        id: 'c1',
        displayName: 'Docs MCP',
        type: 'custom',
        config: { url: 'https://mcp.test' },
      },
    ],
    addServer: () => {},
    removeServer: () => {},
  }),
}))

const realUseAgentsUrl = '@/entrypoints/app/agents/useAgents?chat-refs-real'
const realUseAgents = (await import(realUseAgentsUrl)) as Record<
  string,
  unknown
>

mock.module('@/entrypoints/app/agents/useAgents', () => ({
  ...realUseAgents,
  useAgentAdapters: () => ({ adapters: [], loading: false }),
  useHarnessAgents: () => ({ harnessAgents: [], loading: false }),
}))

mock.module('@/lib/llm-providers/useLlmProviders', () => ({
  useLlmProviders: () => ({
    providers: [{ id: 'browseros', name: 'BrowserOS', type: 'browseros' }],
    selectedProvider: { id: 'browseros', name: 'BrowserOS', type: 'browseros' },
    setDefaultProvider: () => {},
    isLoading: false,
  }),
}))

mock.module('@/lib/personalization/personalizationStorage', () => ({
  personalizationStorage: {
    getValue: async () => {
      const { storage } = await import('@wxt-dev/storage')
      return storage
        .defineItem<unknown>('local:personalization', { fallback: '' })
        .getValue()
    },
    setValue: async (value: unknown) => {
      const { storage } = await import('@wxt-dev/storage')
      await storage
        .defineItem<unknown>('local:personalization', { fallback: '' })
        .setValue(value)
    },
    watch: () => () => {},
  },
  usePersonalization: () => ({
    personalization: 'You are concise.',
    setPersonalization: () => {},
    clearPersonalization: async () => {},
  }),
}))

const subjectUrl = './useChatRefs?chat-refs-suite-real'
const { useChatRefs } = (await import(
  subjectUrl
)) as typeof import('./useChatRefs')

const Probe: FC = () => {
  const refs = useChatRefs()
  return createElement(
    'pre',
    null,
    JSON.stringify({
      enabledMcpServers: refs.enabledMcpServersRef.current,
      enabledCustomServers: refs.enabledCustomServersRef.current,
      personalization: refs.personalizationRef.current,
      selectedProviderId: refs.selectedLlmProviderRef.current?.id,
      chatTargets: refs.chatTargets,
      selectedTarget: refs.selectedChatTarget,
      loading: refs.isLoadingProviders,
    }),
  )
}

describe('useChatRefsContract', () => {
  describe('useChatRefs', () => {
    it('answers the first render with the managed and custom server refs built from the store, the personalization ref, the selected provider ref, the llm target as both the built list and the resolved selection, and the settled loading flag', () => {
      const markup = renderToStaticMarkup(createElement(Probe))
      // static markup escapes the quotes of the rendered JSON, so the
      // pins stick to the escaped-proof keys and bare values
      expect(markup).toContain('enabledMcpServers')
      expect(markup).toContain('search')
      expect(markup).toContain('enabledCustomServers')
      expect(markup).toContain('Docs MCP')
      expect(markup).toContain('https://mcp.test')
      expect(markup).toContain('personalization')
      expect(markup).toContain('You are concise.')
      expect(markup).toContain('selectedProviderId')
      expect(markup).toContain('browseros')
      expect(markup).toContain('chatTargets')
      expect(markup).toContain('llm')
      expect(markup).toContain('BrowserOS')
      expect(markup).toContain('selectedTarget')
      expect(markup).toContain('loading')
      expect(markup).toContain(':false')
    })
  })
})
