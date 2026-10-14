/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The agents page, held against its contract
 * (gHashTag/trios#1691): the one export of
 * entrypoints/app/agents/AgentsPage.tsx - AgentsPage - pinned as it
 * behaves today, so the next change to that file has something to
 * fail against.
 *
 * The page composes the whole agents surface: the header, the
 * gateway state cards, the merged agent list, the setup and
 * create dialogs and the terminal. The pure helpers
 * (agents-page-utils, agents-page-actions) and the child components
 * (AgentList, AgentsHeader, GatewayStateCards and the dialogs)
 * stay real - their own suites pin them - while the data hooks are
 * stubbed with idle captures: the agents and mutations modules are
 * spread-real reads that keep their value exports (agentsFetch and
 * friends) for every later-linking suite and replace only the
 * hooks, and the page-level hook module, the provider-selection
 * hooks and the llm-provider hook answer empty settled state. The
 * router hook is stubbed through the same spread-real read, and the
 * Radix dialog - a portal that never flushes statically - carries
 * the group's portal-free stand-in. Measured, the first mount
 * answers the header with its title, its description and the New
 * Agent button, and the empty list with its own description and
 * its Create your first agent button - the gateway cards and bar
 * staying away with no status, and the terminal never reached.
 *
 * Not pinned, and why (issue User Story 2): everything the
 * callbacks own - creating, deleting and pinning agents, the
 * gateway lifecycle actions, the setup and create flows, the
 * terminal handoff - lives in handlers that need a live document
 * and a connected gateway. The port env seam is seeded before any
 * import can reach the env module (its one-time snapshot - the
 * trap the agent-outputs suite documented), with the subject read
 * through a query-qualified specifier so this suite's graph loads
 * as its own fresh instances.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// biome-ignore lint/style/noProcessEnv: the env seam is the only way to reach the port helpers before the env module's one-time snapshot freezes (see suite header)
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'

const realRouterUrl = 'react-router?agents-page-real'
const realRouter = (await import(realRouterUrl)) as Record<string, unknown>

mock.module('react-router', () => ({
  ...realRouter,
  useNavigate: () => () => {},
}))

const passthrough = (props: { children?: React.ReactNode }) =>
  props.children ?? null

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({
    open,
    children,
  }: {
    open?: boolean
    children?: React.ReactNode
  }) => (open ? children : null),
  DialogClose: passthrough,
  DialogContent: passthrough,
  DialogDescription: passthrough,
  DialogFooter: passthrough,
  DialogHeader: passthrough,
  DialogOverlay: () => null,
  DialogPortal: passthrough,
  DialogTitle: passthrough,
  DialogTrigger: passthrough,
}))

mock.module('@/lib/llm-providers/useLlmProviders', () => ({
  useLlmProviders: () => ({ providers: [], defaultProviderId: '' }),
}))

const realUseAgentsUrl = '@/entrypoints/app/agents/useAgents?agents-page-real'
const realUseAgents = (await import(realUseAgentsUrl)) as Record<
  string,
  unknown
>

const idleMutation = () => ({
  mutateAsync: async () => {},
  isPending: false,
  mutate: () => {},
  reset: () => {},
})

mock.module('@/entrypoints/app/agents/useAgents', () => ({
  ...realUseAgents,
  useAgentAdapters: () => ({
    adapters: [],
    loading: false,
    error: null,
  }),
  useHarnessAgents: () => ({
    harnessAgents: [],
    gateway: undefined,
    loading: false,
    error: null,
  }),
  useCreateHarnessAgent: idleMutation,
  useUpdateHarnessAgent: idleMutation,
  useDeleteHarnessAgent: idleMutation,
}))

const realUseOpenClawUrl =
  '@/entrypoints/app/agents/useOpenClaw?agents-page-real'
const realUseOpenClaw = (await import(realUseOpenClawUrl)) as Record<
  string,
  unknown
>

mock.module('@/entrypoints/app/agents/useOpenClaw', () => ({
  ...realUseOpenClaw,
  useOpenClawAgents: () => ({
    agents: [],
    loading: false,
    error: null,
  }),
  useOpenClawMutations: () => ({
    setupOpenClaw: async () => {},
    createAgent: async () => {},
    deleteAgent: async () => {},
    startOpenClaw: async () => {},
    restartOpenClaw: async () => {},
    reconnectOpenClaw: async () => {},
    actionInProgress: false,
    settingUp: false,
    creating: false,
    deleting: false,
    reconnecting: false,
    pendingGatewayAction: null,
  }),
}))

mock.module('@/entrypoints/app/agents/agents-page-hooks', () => ({
  useDefaultAgentName: () => {},
  useHarnessAgentDefaults: () => {},
  useOpenClawProviderSelection: () => ({
    selectableOpenClawProviders: [],
    selectedCliProvider: undefined,
    selectedSetupCliProvider: undefined,
    authTerminalProvider: null,
    cliAuthStatus: undefined,
    cliAuthLoading: false,
    cliAuthError: null,
  }),
  useHermesProviderSelection: () => ({
    selectableHermesProviders: [],
  }),
}))

const subjectUrl = './AgentsPage?agents-page-suite-real'
const { AgentsPage } = (await import(
  subjectUrl
)) as typeof import('./AgentsPage')

describe('AgentsPageTsxContract', () => {
  describe('AgentsPage', () => {
    it('answers the first mount as it settles with no gateway, no adapters and no agents: the header with its title, description and New Agent button, the empty list with its own description and its create button, and neither gateway cards nor terminal', () => {
      const markup = renderToStaticMarkup(createElement(AgentsPage))
      expect(markup).toContain('OpenClaw, Claude Code, and Codex agents')
      expect(markup).toContain('New Agent')
      expect(markup).toContain('No agents yet')
      expect(markup).toContain(
        'Spin up an OpenClaw, Claude Code, or Codex agent',
      )
      expect(markup).toContain('Create your first agent')
      expect(markup).not.toContain('Container Terminal')
      expect(markup).not.toContain('Running')
    })
  })
})
