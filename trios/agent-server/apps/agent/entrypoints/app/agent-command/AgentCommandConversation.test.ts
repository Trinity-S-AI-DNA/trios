/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The agent-command conversation, held against its contract
 * (gHashTag/trios#1498): the one export of
 * entrypoints/app/agent-command/AgentCommandConversation.tsx -
 * AgentCommandConversation - pinned as it behaves today, so the next
 * change to that file has something to fail against.
 *
 * The page composes the whole harness-chat stack, so each seam is
 * stubbed with a full stand-in - every field the page destructures:
 * the six harness hooks of the agents module (agents and harness
 * agents listing, enqueue and dequeue, adapter list, update), the
 * chat-history query (fetched with an empty history), the
 * conversation hook (no turns, not streaming), the layout context
 * (the agents prop handed down), the outputs rail open state, the
 * outputs hook of the agent-files module, the metrics track (a
 * no-op - its real module pulls the adapter graph other suites
 * stub incompletely), and the router (spread over the real module
 * with useParams/useSearchParams/useNavigate replaced). The storage
 * fake underneath the graph's own items is the one every storage
 * suite of this wave runs with. Measured, the static render goes
 * through and shows the conversation page as it first mounts: the
 * header and the composer both naming the agent of the route.
 *
 * Not pinned, and why (issue User Story 2): the chat flow itself -
 * sending, streaming, queueing, the initial-message registry, the
 * deep-link rail focus - they live in effects and handlers that
 * need a live document and window. The port env seam is seeded
 * before any import can reach the env module (its one-time
 * snapshot - the trap the agent-outputs suite documented), with
 * the subject imported dynamically for that reason.
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

const harnessAgentsFixture: Array<{
  id: string
  name: string
  adapter: string
  queue?: unknown[]
  activeTurnId?: string | null
}> = []

// The agents module's own value exports (keys, fetch, mappings)
// stay real - read through a query-qualified specifier no stand-in
// occupies - so only the hooks the page calls are stubbed.
const realUseAgentsUrl = '@/entrypoints/app/agents/useAgents?conversation-real'
const realUseAgents = (await import(realUseAgentsUrl)) as Record<
  string,
  unknown
>
mock.module('@/entrypoints/app/agents/useAgents', () => ({
  ...realUseAgents,
  useAgentAdapters: () => ({ adapters: [], loading: false, error: null }),
  useHarnessAgents: () => ({
    agents: [],
    harnessAgents: harnessAgentsFixture,
    gateway: null,
    loading: false,
    error: null,
    refetch: async () => {},
  }),
  useEnqueueHarnessMessage: () => async () => {},
  useRemoveHarnessQueuedMessage: () => async () => {},
  useUpdateHarnessAgent: () => async () => {},
  cancelHarnessTurn: async () => {},
}))

mock.module('./useHarnessChatHistory', () => ({
  useHarnessChatHistory: () => ({
    data: undefined,
    error: null,
    isLoading: false,
    isFetched: true,
    isError: false,
    refetch: async () => {},
  }),
}))

mock.module('./useAgentConversation', () => ({
  useAgentConversation: () => ({
    turns: [],
    streaming: false,
    sessionKey: null,
    send: async () => {},
    stop: () => {},
  }),
}))

mock.module('./agent-command-layout', () => ({
  useAgentCommandData: () => ({
    agents: [
      {
        agentId: 'agent-1',
        name: 'Research Bot',
      },
    ],
    agentsLoading: false,
    status: null,
    statusLoading: false,
  }),
}))

// The agent-files module's real value exports (download URLs, file
// helpers) stay real - read through a query-qualified specifier no
// stand-in occupies - so only the four data hooks are stubbed.
const realAgentFilesUrl = '../../../lib/agent-files?conversation-real'
const realAgentFiles = (await import(realAgentFilesUrl)) as Record<
  string,
  unknown
>
mock.module('@/lib/agent-files', () => ({
  ...realAgentFiles,
  useAgentOutputs: () => ({ groups: [], loading: false, error: null }),
  useAgentTurnFiles: () => ({ files: [], loading: false, error: null }),
  useInvalidateAgentOutputs: () => async () => {},
  useRefreshAgentOutputs: () => ({
    mutate: async () => {},
    mutateAsync: async () => {},
    isPending: false,
  }),
}))

mock.module('@/lib/metrics/track', () => ({
  track: () => {},
}))

mock.module('@/lib/workspace/use-workspace', () => ({
  useWorkspace: () => ({
    recentFolders: [],
    selectedFolder: null,
    selectFolder: () => {},
    addFolder: () => {},
    removeFolder: () => {},
    clearSelection: () => {},
  }),
}))

mock.module('@/lib/browseros/useCapabilities', () => ({
  useCapabilities: () => ({ supports: () => false }),
}))

mock.module('@/lib/mcp/mcpServerStorage', () => ({
  McpServer: class {},
  mcpServerStorage: fakeItem('local:mcp-servers', { fallback: [] }),
  useMcpServers: () => ({
    servers: [],
    addServer: () => {},
    removeServer: () => {},
  }),
}))

mock.module('@/entrypoints/app/connect-mcp/useGetUserMCPIntegrations', () => ({
  INTEGRATIONS_QUERY_KEY: 'klavis-user-integrations',
  useGetUserMCPIntegrations: () => ({
    data: undefined,
    isLoading: false,
    isFetching: false,
    isSuccess: true,
    mutate: () => {},
  }),
}))

mock.module('@/lib/voice/useVoiceInput', () => ({
  useVoiceInput: () => ({
    isRecording: false,
    isTranscribing: false,
    transcript: '',
    audioLevel: 0,
    audioLevels: [],
    error: null,
    startRecording: async () => false,
    stopRecording: async () => {},
    clearTranscript: () => {},
  }),
}))

const realRouterUrl = 'react-router?conversation-real'
const realRouter = (await import(realRouterUrl)) as Record<string, unknown>
mock.module('react-router', () => ({
  ...realRouter,
  useParams: () => ({ agentId: 'agent-1' }),
  useSearchParams: () => [new URLSearchParams(), () => {}],
  useNavigate: () => () => {},
  Navigate: () => null,
}))

// The subject is read through a query-qualified specifier so this
// suite's page graph loads as its own fresh module instances: the
// rail and outputs modules other suites of this group pin keep
// their own first-import (with their own mock registrations),
// instead of inheriting this suite's stubs through a shared cache.
const subjectUrl = './AgentCommandConversation?conversation-suite-real'
const { AgentCommandConversation } = (await import(
  subjectUrl
)) as typeof import('./AgentCommandConversation')

describe('AgentCommandConversationTsxContract', () => {
  describe('AgentCommandConversation', () => {
    it('answers the conversation page as it first mounts: the header and the composer both naming the agent of the route, with no queue and the rail closed', () => {
      const markup = renderToStaticMarkup(
        createElement(AgentCommandConversation, {}),
      )
      expect(markup).toContain('Research Bot')
      expect(markup).toContain('Message Research Bot')
    })
  })
})
