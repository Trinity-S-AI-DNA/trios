/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The agents page actions, held against its contract
 * (gHashTag/trios#1596): the exported factory of
 * entrypoints/app/agents/agents-page-actions.ts - createAgentPageActions
 * - pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * The factory is a plain function bag over an injected input object, so
 * the suite drives it with recording fakes and no React at all. The
 * metrics seam is stubbed (the group's shape; the real module is
 * inert here but the stub keeps the analytics calls recordable). The
 * CLI provider finder stays REAL, so the CLI/LLM dispatch is the real
 * provider table's. Pinned: the returned surface; the page-error
 * wrapper (error cleared before the run, message captured on failure,
 * untouched on success); the runtime dispatch of handleCreate (all four
 * runtimes); the openclaw create flow (name normalization to kebab,
 * the create payload, the dialog closes, the name resets, the
 * navigation to the new agent, the analytics event with the provider
 * type; a blank name answered with nothing); the harness create flow
 * (the hermes override pulling every field from the selected provider,
 * the model/effort fallbacks, the navigation by agent id); the setup
 * flow (the CLI branch opening the auth modal, the LLM branch not,
 * the dialog closing after success); and the delete dispatch by source
 * with the deleting key set and cleared. Not pinned: the react-router
 * navigate internals.
 */
import { describe, expect, it, mock } from 'bun:test'

const trackCalls: Array<[string, Record<string, unknown>]> = []
mock.module('@/lib/metrics/track', () => ({
  track: (event: string, data: Record<string, unknown>) => {
    trackCalls.push([event, data])
  },
}))

const { createAgentPageActions } = await import('./agents-page-actions')
const { findOpenClawCliProviderById } = await import('./openclaw-cli-providers')

type Input = Parameters<typeof createAgentPageActions>[0]

type Call = unknown[]
const calls: Record<string, Call[]> = {}
const record = (name: string) => {
  if (!calls[name]) calls[name] = []
  return (...args: unknown[]) => {
    calls[name].push(args)
  }
}

const makeInput = (over: Record<string, unknown> = {}): Input =>
  ({
    createProviderId: 'openai',
    createRuntime: 'openclaw',
    createHermesProviderId: 'hermes-main',
    harnessModelId: '',
    harnessReasoningEffort: '',
    navigate: record('navigate'),
    newName: 'My New Agent',
    selectableOpenClawProviders: [
      { id: 'openai', name: 'OpenAI', type: 'openai', modelId: 'gpt-x' },
    ],
    selectableHermesProviders: [
      {
        id: 'hermes-main',
        name: 'Hermes Main',
        type: 'openrouter',
        modelId: 'auto',
        apiKey: 'hk-1',
        baseUrl: 'https://hr.test/v1',
      },
    ],
    setupProviderId: 'openai',
    createHarnessAgent: async (input: Record<string, unknown>) => {
      record('createHarnessAgent')(input)
      return { id: 'agent-h-1' }
    },
    createOpenClawAgent: async (input: Record<string, unknown>) => {
      record('createOpenClawAgent')(input)
      return { agent: { agentId: 'agent-oc-1' } }
    },
    deleteHarnessAgent: async (id: string) => {
      record('deleteHarnessAgent')(id)
    },
    deleteOpenClawAgent: async (id: string) => {
      record('deleteOpenClawAgent')(id)
    },
    setCliAuthModalOpen: record('setCliAuthModalOpen'),
    setCreateError: record('setCreateError'),
    setCreateOpen: record('setCreateOpen'),
    setDeletingAgentKey: record('setDeletingAgentKey'),
    setNewName: record('setNewName'),
    setPageError: record('setPageError'),
    setSetupOpen: record('setSetupOpen'),
    setupOpenClaw: async (input: Record<string, unknown>) => {
      record('setupOpenClaw')(input)
    },
    ...over,
  }) as unknown as Input

const actions = (over: Record<string, unknown> = {}) =>
  createAgentPageActions(makeInput(over))

describe('agentsPageActionsContract', () => {
  it('answers its four handlers', () => {
    const bag = actions()
    expect(typeof bag.handleCreate).toBe('function')
    expect(typeof bag.handleDelete).toBe('function')
    expect(typeof bag.handleSetup).toBe('function')
    expect(typeof bag.runWithPageErrorHandling).toBe('function')
  })

  it('runs with page error handling: cleared before, message on failure, silent on success', async () => {
    const bag = actions()
    await bag.runWithPageErrorHandling(async () => {
      throw new Error('backend down')
    })
    expect(calls.setPageError[0]).toEqual([null])
    expect(calls.setPageError[1]).toEqual(['backend down'])

    await bag.runWithPageErrorHandling(async () => 'ok')
    expect(calls.setPageError.length).toBe(3)
    expect(calls.setPageError[2]).toEqual([null])
  })

  it('creates an openclaw agent: kebab name, payload, dialog closed, name reset, navigation, analytics', async () => {
    const bag = actions()
    await bag.handleCreate()
    expect(calls.createOpenClawAgent.length).toBe(1)
    expect(calls.createOpenClawAgent[0][0]).toEqual({
      name: 'my-new-agent',
      providerType: 'openai',
      providerName: 'OpenAI',
      baseUrl: undefined,
      apiKey: undefined,
      modelId: 'gpt-x',
    })
    expect(calls.setCreateOpen.at(-1)).toEqual([false])
    expect(calls.setNewName.at(-1)).toEqual([''])
    expect(calls.navigate.at(-1)).toEqual(['/agents/agent-oc-1'])
    expect(trackCalls[0][0]).toBe('agents.agent.created')
    expect(trackCalls[0][1]).toEqual({
      runtime: 'openclaw',
      provider_type: 'openai',
    })
  })

  it('answers a blank openclaw name with nothing (no new create call)', async () => {
    const before = (calls.createOpenClawAgent ?? []).length
    const bag = actions({ newName: '   ' })
    await bag.handleCreate()
    expect((calls.createOpenClawAgent ?? []).length).toBe(before)
  })

  it('creates a harness agent with the hermes override pulling every provider field', async () => {
    const bag = actions({
      createRuntime: 'hermes',
      harnessReasoningEffort: 'high',
    })
    await bag.handleCreate()
    expect(JSON.stringify((calls.createHarnessAgent.at(-1) as Call[])[0])).toBe(
      JSON.stringify({
        name: 'My New Agent',
        adapter: 'hermes',
        modelId: 'auto',
        reasoningEffort: 'high',
        providerType: 'openrouter',
        apiKey: 'hk-1',
        baseUrl: 'https://hr.test/v1',
      }),
    )
    expect(calls.navigate.at(-1)).toEqual(['/agents/agent-h-1'])
    expect((trackCalls.at(-1) as Call)[0]).toBe('agents.agent.created')
    expect(
      (trackCalls.at(-1) as [string, Record<string, unknown>])[1],
    ).toMatchObject({
      runtime: 'hermes',
      reasoning_effort: 'high',
    })
  })

  it('dispatches the delete by source, tracking the deleting key around it', async () => {
    const bag = actions()
    await bag.handleDelete({
      key: 'agent-harness:agent-h-1',
      source: 'agent-harness',
      agentId: 'agent-h-1',
    } as never)
    expect(calls.deleteHarnessAgent.at(-1)).toEqual(['agent-h-1'])
    expect(calls.setDeletingAgentKey.at(-2)).toEqual([
      'agent-harness:agent-h-1',
    ])
    const clears = (calls.setDeletingAgentKey ?? []).filter(
      (args) => args[0] === null,
    )
    expect(clears.length).toBeGreaterThanOrEqual(1)
    expect(
      (trackCalls.at(-1) as [string, Record<string, unknown>])[1],
    ).toMatchObject({
      runtime: 'agent-harness',
      agent_id: 'agent-h-1',
    })

    await bag.handleDelete({
      key: 'openclaw:agent-oc-1',
      source: 'openclaw',
      agentId: 'agent-oc-1',
    } as never)
    expect(calls.deleteOpenClawAgent.at(-1)).toEqual(['agent-oc-1'])
  })

  it('runs the setup flow: the dialog closes, and only a CLI provider opens the auth modal', async () => {
    const bag = actions()
    await bag.handleSetup()
    expect((calls.setupOpenClaw.at(-1) as Call[])[0]).toMatchObject({
      providerType: 'openai',
      providerName: 'OpenAI',
      modelId: 'gpt-x',
    })
    expect(calls.setSetupOpen.at(-1)).toEqual([false])
    // Measured: the openai entry in the fixture is an LLM provider, not a
    // CLI one, so the setup flow does NOT open the CLI auth modal.
    expect(Boolean(findOpenClawCliProviderById('openai'))).toBe(false)
    expect((calls.setCliAuthModalOpen ?? []).length).toBe(0)
  })
})
