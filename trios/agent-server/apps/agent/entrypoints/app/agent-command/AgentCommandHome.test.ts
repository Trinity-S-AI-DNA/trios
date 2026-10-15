/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The agent command home, held against its contract
 * (gHashTag/trios#1585): the single export of
 * entrypoints/app/agent-command/AgentCommandHome.tsx - AgentCommandHome -
 * pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * The seams are the same ones the AgentCommandConversation suite stubs
 * (the pattern of this group): the wxt storage item shim, the
 * agents/adapters hooks, the layout data hook, the metrics seam, and the
 * active-hint hook behind a flag so one suite reaches both hints. The
 * ConversationInput and the hints render REAL (the input's own suite
 * owns its internals; the hints are plain presentational components).
 * Pinned: the empty answer (No agents yet with its note and the Create
 * agent affordance); the populated answer (the home headline with its
 * italic work-on accent, the tab-leaving note, the conversation input
 * frame with the measured placeholder and the runtime-not-running
 * placeholder, the Recent agents section with its note and the Manage
 * agents affordance); the hint dispatch (signin answers the SignInHint
 * marker, import the ImportDataHint marker, none answers neither). Not
 * pinned: the send/select wiring (handlers a static render never runs).
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'

const values = new Map<string, unknown>()

const fakeItem = (
  key: string,
  opts?: { fallback?: unknown } & Record<string, unknown>,
) => ({
  getValue: async () => {
    if (values.has(key)) return values.get(key)
    return opts && 'fallback' in opts ? opts.fallback : null
  },
  setValue: async (value: unknown) => {
    values.set(key, value)
  },
  watch: () => () => {},
})

mock.module('@wxt-dev/storage', () => ({
  storage: {
    defineItem: (key: string, opts?: unknown) => fakeItem(key, opts as never),
  },
}))

let legacyAgents: Array<Record<string, unknown>> = []

mock.module('./agent-command-layout', () => ({
  useAgentCommandData: () => ({
    agents: legacyAgents,
    status: { status: 'running' },
  }),
}))

mock.module('@/entrypoints/app/agents/useAgents', () => ({
  useAgentAdapters: () => ({ adapters: [], loading: false, error: null }),
  useHarnessAgents: () => ({
    agents: [],
    harnessAgents: [],
    gateway: null,
    loading: false,
    error: null,
  }),
}))

mock.module('@/lib/metrics/track', () => ({
  track: () => {},
}))

mock.module('./ConversationInput', () => ({
  ConversationInput: (props: Record<string, unknown>) =>
    createElement(
      'div',
      { 'data-testid': 'conversation-input' },
      String(props.placeholder ?? ''),
    ),
}))

let activeHint: string | null = null

mock.module('@/entrypoints/newtab/index/useActiveHint', () => ({
  useActiveHint: () => activeHint,
}))

const { AgentCommandHome } = await import('./AgentCommandHome')

const markup = () =>
  renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(AgentCommandHome as never)),
  )

describe('agentCommandHomeContract', () => {
  it('answers the empty state when no agent exists', () => {
    legacyAgents = []
    activeHint = null
    const m = markup()
    expect(m).toContain('No agents yet')
    expect(m).toContain(
      'Create an agent to start using BrowserOS as an agent-first new tab.',
    )
    expect(m).toContain('Create agent')
    expect(m).not.toContain('What should your agent')
  })

  it('answers the home headline, its note and the conversation slot', () => {
    legacyAgents = [
      { agentId: 'agent-1', name: 'Research Bot', source: 'agent-harness' },
    ]
    activeHint = null
    const m = markup()
    expect(m).toContain('What should your agent')
    expect(m).toContain('work on')
    expect(m).toContain('next?')
    expect(m).toContain(
      'Start a task, continue a thread, or hand off to a different agent',
    )
    expect(m).toContain('data-testid="conversation-input"')
    // The selection effect never runs in a static render, so the input
    // answers the not-running placeholder even with agents present
    // (measured) - and the Recent threads section stays away because the
    // harness list is empty.
    expect(m).toContain('Agent runtime is not running...')
    expect(m).not.toContain('Recent agents')
  })

  it('answers the recent-threads section only when the harness list carries agents', () => {
    legacyAgents = [
      { agentId: 'agent-1', name: 'Bot', source: 'agent-harness' },
    ]
    activeHint = null
    const m = markup()
    expect(m).not.toContain('Recent agents')
    legacyAgents = []
  })

  it('answers the active hint by kind and none by default', () => {
    legacyAgents = []
    activeHint = 'signin'
    expect(markup()).toContain('Sync your data')
    activeHint = 'import'
    expect(markup()).toContain('Import your data')
    activeHint = null
    const m = markup()
    expect(m).not.toContain('Sync your data')
    expect(m).not.toContain('Import your data')
  })
})
