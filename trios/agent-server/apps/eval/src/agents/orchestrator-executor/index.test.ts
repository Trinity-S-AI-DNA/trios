/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The orchestrator-executor evaluator, held against its contract
 * (gHashTag/trinos#1804): the single export of
 * orchestrator-executor/index.ts - OrchestratorExecutorEvaluator -
 * pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * The evaluator validates its configuration BEFORE it touches a
 * browser: a config whose agent type is not
 * orchestrator-executor, an orchestrator without a model, an
 * executor without a model, and a clado-action executor without a
 * baseUrl each answer with their pinned error text - measured,
 * all four refuse before any CDP connection, after the user query
 * has been logged. The full execute path needs a live browser and
 * agent backends, which this suite deliberately does not spin up -
 * the entry validation contract above is the no-environment
 * behaviour.
 *
 * The capture context is a recording fake; no mocks, no network, no
 * database, no container.
 */

import { describe, expect, it } from 'bun:test'
import type { AgentContext } from '../types'
import { OrchestratorExecutorEvaluator } from './index'

interface Recorded {
  loggedQueries: string[]
}

const fakeContext = (
  agent: Record<string, unknown>,
): { ctx: AgentContext; recorded: Recorded } => {
  const recorded: Recorded = { loggedQueries: [] }
  const ctx = {
    config: {
      timeout_ms: 1000,
      agent,
      browseros: { base_cdp_port: 9222 },
    },
    task: { query_id: 'q1', query: 'do it' },
    capture: {
      messageLogger: {
        logUser: async (query: string) => {
          recorded.loggedQueries.push(query)
        },
      },
      getErrors: () => [] as unknown[],
      screenshot: {} as never,
      emitEvent: () => {},
      setActivePageId: () => {},
      getActivePageId: () => 1,
    },
    workerIndex: 0,
  } as unknown as AgentContext
  return { ctx, recorded }
}

const expectRefusal = async (
  agent: Record<string, unknown>,
  message: string,
) => {
  const { ctx, recorded } = fakeContext(agent)
  const evaluator = new OrchestratorExecutorEvaluator(ctx)
  let caught: unknown
  try {
    await evaluator.execute()
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).message).toBe(message)
  // Measured: the user query is logged before the config is judged.
  expect(recorded.loggedQueries).toEqual(['do it'])
}

const ORCHESTRATOR = { provider: 'openai', model: 'gpt-test' }

describe('OrchestratorExecutorEvaluator', () => {
  it('refuses a config whose agent type is not orchestrator-executor', async () => {
    await expectRefusal(
      { type: 'single', orchestrator: ORCHESTRATOR, executor: ORCHESTRATOR },
      'OrchestratorExecutorEvaluator requires orchestrator-executor config',
    )
  })

  it('refuses an orchestrator without a model', async () => {
    await expectRefusal(
      {
        type: 'orchestrator-executor',
        orchestrator: { provider: 'openai' },
        executor: { provider: 'openai', model: 'gpt-test' },
      },
      'orchestrator.model is required in config',
    )
  })

  it('refuses an executor without a model', async () => {
    await expectRefusal(
      {
        type: 'orchestrator-executor',
        orchestrator: ORCHESTRATOR,
        executor: { provider: 'openai' },
      },
      'executor.model is required in config',
    )
  })

  it('refuses a clado-action executor without a baseUrl', async () => {
    await expectRefusal(
      {
        type: 'orchestrator-executor',
        orchestrator: ORCHESTRATOR,
        executor: { provider: 'clado-action', model: 'x' },
      },
      'executor.baseUrl is required in config for clado-action provider',
    )
  })
})
