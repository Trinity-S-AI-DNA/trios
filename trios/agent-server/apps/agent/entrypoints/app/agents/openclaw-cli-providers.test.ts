/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The OpenClaw CLI provider registry, held against its contract
 * (gHashTag/trios#1605): the five exports of
 * entrypoints/app/agents/openclaw-cli-providers.tsx -
 * OPENCLAW_CLI_PROVIDERS, findOpenClawCliProviderById,
 * buildOpenClawCliProviderOptions, useOpenClawCliProviderAuthStatus,
 * OpenClawCliProviderStatusPanel - pinned as they behave today, so
 * the next change to that file has something to fail against.
 *
 * The registry data and its two pure lookups are pinned below. The
 * two UI seams this module imports ('@/components/ui/button' and
 * '@/lib/browseros/useBrowserOSProviders') are stubbed with
 * mock.module as complete stand-ins for their value exports - the
 * pattern proven by the llm-providers and execution-history suites
 * of this sweep.
 *
 * Not pinned, and why: useOpenClawCliProviderAuthStatus (a React
 * Query hook that needs a renderer and the agent-server URL) and
 * OpenClawCliProviderStatusPanel (a DOM component) - this project's
 * bun test environment has no renderer and no DOM (the limitation
 * named in SkillsPage.test.ts). No other suite of this job imports
 * this module (that is exactly why it was untested), so the
 * process-global stubs cannot leak into a suite that wants the real
 * ones.
 */

import { describe, expect, it, mock } from 'bun:test'

mock.module('@/components/ui/button', () => ({
  Button: () => null,
}))

mock.module('@/lib/browseros/useBrowserOSProviders', () => ({
  useAgentServerUrl: () => ({ baseUrl: null, isLoading: false }),
}))

const {
  buildOpenClawCliProviderOptions,
  findOpenClawCliProviderById,
  OPENCLAW_CLI_PROVIDERS,
} = await import('./openclaw-cli-providers')

describe('OPENCLAW_CLI_PROVIDERS', () => {
  it('carries the Claude CLI with its models and login command', () => {
    expect(OPENCLAW_CLI_PROVIDERS.length).toBe(1)
    const provider = OPENCLAW_CLI_PROVIDERS[0]
    expect(provider.id).toBe('claude-cli')
    expect(provider.displayName).toBe('Anthropic Claude CLI')
    expect(provider.models).toEqual([
      'claude-sonnet-4-6',
      'claude-opus-4-6',
      'claude-haiku-4-5',
    ])
    expect(provider.authLoginCommand).toBe('claude /login')
    expect(provider.description.length).toBeGreaterThan(0)
  })
})

describe('findOpenClawCliProviderById', () => {
  it('answers the provider for a known id', () => {
    expect(findOpenClawCliProviderById('claude-cli')?.id).toBe('claude-cli')
  })

  it('answers undefined for an unknown id', () => {
    expect(findOpenClawCliProviderById('nope')).toBeUndefined()
  })
})

describe('buildOpenClawCliProviderOptions', () => {
  it('expands every model into an option under its provider', () => {
    const options = buildOpenClawCliProviderOptions()
    expect(options.map((o) => o.id)).toEqual([
      'claude-cli/claude-sonnet-4-6',
      'claude-cli/claude-opus-4-6',
      'claude-cli/claude-haiku-4-5',
    ])
    expect(options[0]).toEqual({
      id: 'claude-cli/claude-sonnet-4-6',
      type: 'claude-cli',
      name: 'Anthropic Claude CLI',
      modelId: 'claude-sonnet-4-6',
    })
  })
})
