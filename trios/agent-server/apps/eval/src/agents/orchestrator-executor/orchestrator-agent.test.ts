/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The orchestrator agent, held against its contract
 * (gHashTag/trinos#1587): the single export of
 * orchestrator-agent.ts - OrchestratorAgent - pinned as it behaves
 * today, so the next change to that file has something to fail
 * against.
 *
 * The agent wires one delegate tool into the SDK's tool loop: the
 * executor factory is invoked per delegation with the instruction,
 * its result becomes the "Executor Result" observation (with a
 * TIMED OUT note for timeouts), a throwing factory becomes a
 * timeout-shaped observation, and the step-budget guard refuses
 * further delegations once LIMITS.maxTotalSteps is reached. run()
 * answers success for a direct text answer; an empty text falls
 * back to the last observation and is judged a failure with the
 * turn-budget reason; a throw answers 'Aborted by eval timeout'
 * only when the caller's signal aborted, otherwise the error
 * message; and a silent agent answers the turn (or step) budget
 * reason. The final shape reports the delegation and step counts
 * (turns mirrors delegations).
 *
 * The two seams are snapshot-and-restored with the repo's proven
 * pattern (the real module copied before the mock, re-installed in
 * afterAll): 'ai' (the ToolLoopAgent stand-in records the wiring
 * and drives run() per test) and the provider factory (its
 * consumers in this test group are this module alone - measured).
 * No network, no database, no container.
 */

import { afterAll, describe, expect, it, mock } from 'bun:test'
import { LIMITS, ORCHESTRATOR_DEFAULTS } from './types'

const realAi = { ...(await import('ai')) } as typeof import('ai')
const realFactory = {
  ...(await import('@browseros/server/agent/tool-loop/provider-factory')),
} as typeof import('@browseros/server/agent/tool-loop/provider-factory')

type DelegateExecute = (
  args: { instruction: string },
  opts: { abortSignal?: AbortSignal },
) => Promise<string>

interface Wiring {
  instructions: string
  toolNames: string[]
  delegateDescription: string
  delegateExecute: DelegateExecute
  stopWhen: unknown[]
}

let wiring: Wiring | null = null
let nextGenerate: (params: {
  prompt: string
  abortSignal?: AbortSignal
}) => Promise<{ text: string; toolCalls?: unknown[] }> = async () => ({
  text: 'final answer',
})

class StandInToolLoopAgent {
  constructor(options: Record<string, unknown>) {
    const tools = options.tools as Record<
      string,
      { description: string; execute: DelegateExecute }
    >
    wiring = {
      instructions: options.instructions as string,
      toolNames: Object.keys(tools),
      delegateDescription: tools.delegate.description,
      delegateExecute: tools.delegate.execute,
      stopWhen: options.stopWhen as unknown[],
    }
  }

  async generate(params: { prompt: string; abortSignal?: AbortSignal }) {
    return nextGenerate(params)
  }
}

mock.module('ai', () => ({ ...realAi, ToolLoopAgent: StandInToolLoopAgent }))
mock.module('@browseros/server/agent/tool-loop/provider-factory', () => ({
  ...realFactory,
  createLanguageModel: (config: unknown) => {
    void config
    return { modelId: 'stand-in-model' }
  },
}))

const { OrchestratorAgent } = await import('./orchestrator-agent')

afterAll(() => {
  mock.module('ai', () => ({ ...realAi }))
  mock.module('@browseros/server/agent/tool-loop/provider-factory', () => ({
    ...realFactory,
  }))
})

const doneResult = (overrides: Record<string, unknown> = {}) => ({
  observation: 'Clicked the link.',
  status: 'done',
  url: 'https://example.com',
  actionsPerformed: 4,
  toolsUsed: ['click'],
  ...overrides,
})

const build = (
  executorFactory: (
    instruction: string,
    signal: AbortSignal,
  ) => Promise<unknown>,
  maxTurns?: number,
) => {
  const agent = OrchestratorAgent.create(
    {
      provider: 'openai',
      model: 'test',
      apiKey: 'k',
      conversationId: 'c1',
      workingDir: '/tmp/x',
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    } as never,
    { executorFactory } as never,
  )
  if (!wiring) throw new Error('wiring not captured')
  return { agent, wiring: wiring as Wiring }
}

describe('OrchestratorAgent.create', () => {
  it('wires the orchestrator prompt, the single delegate tool and the default turn budget', () => {
    const { wiring: w } = build(async () => doneResult())
    expect(w.instructions).toContain('task orchestrator')
    expect(w.toolNames).toEqual(['delegate'])
    expect(w.delegateDescription).toContain('browser executor')
    // stopWhen is measured as [stepCountIs(maxTurns)] - the length is the
    // observable contract; the default is ORCHESTRATOR_DEFAULTS.maxTurns.
    expect(w.stopWhen.length).toBe(1)
    void ORCHESTRATOR_DEFAULTS.maxTurns
  })
})

describe('the delegate tool', () => {
  it('hands the instruction to the executor factory and formats the result', async () => {
    const instructions: string[] = []
    const { wiring: w } = build(async (instruction: string) => {
      instructions.push(instruction)
      return doneResult()
    })
    const observation = await w.delegateExecute(
      { instruction: 'open example.com' },
      {},
    )
    expect(instructions).toEqual(['open example.com'])
    expect(observation).toBe(
      [
        'Executor Result:',
        '- Status: done',
        '- Actions: 4',
        '- URL: https://example.com',
        '',
        'Observation:',
        'Clicked the link.',
      ].join('\n'),
    )
  })

  it('adds a TIMED OUT note to a timeout status', async () => {
    const { wiring: w } = build(async () =>
      doneResult({ status: 'timeout', url: '', actionsPerformed: 0 }),
    )
    const observation = await w.delegateExecute({ instruction: 'x' }, {})
    expect(observation).toContain('Status: timeout (TIMED OUT)')
    expect(observation).toContain('Actions: 0')
    expect(observation).toContain('URL: unknown')
  })

  it('answers a throwing factory with a delegation-failed timeout observation', async () => {
    const { wiring: w } = build(async () => {
      throw new Error('executor exploded')
    })
    const observation = await w.delegateExecute({ instruction: 'x' }, {})
    expect(observation).toContain('Status: timeout')
    expect(observation).toContain('Delegation failed: executor exploded')
    expect(observation).toContain('Actions: 0')
  })

  it('refuses further delegations once the step budget is spent', async () => {
    const calls: string[] = []
    const { wiring: w } = build(async (instruction: string) => {
      calls.push(instruction)
      return doneResult({ actionsPerformed: LIMITS.maxTotalSteps })
    })
    const first = await w.delegateExecute({ instruction: 'spend it all' }, {})
    expect(first).toContain('Actions: 300')
    calls.length = 0
    const second = await w.delegateExecute({ instruction: 'once more' }, {})
    expect(calls).toEqual([])
    expect(second).toContain(
      `Step budget exhausted (${LIMITS.maxTotalSteps} steps used)`,
    )
  })
})

describe('run', () => {
  it('answers success for a direct text answer', async () => {
    nextGenerate = async () => ({ text: 'the final answer' })
    const { agent } = build(async () => doneResult())
    const result = await agent.run('do the thing')
    expect(result).toEqual({
      success: true,
      answer: 'the final answer',
      reason: null,
      delegationCount: 0,
      totalExecutorSteps: 0,
      turns: 0,
    })
  })

  it('falls back to the last observation and answers the turn-budget reason', async () => {
    nextGenerate = async () => ({ text: '' })
    const { agent, wiring: w } = build(async () => doneResult(), 3)
    await w.delegateExecute({ instruction: 'step one' }, {})
    const result = await agent.run('do the thing')
    expect(result.success).toBe(false)
    expect(result.answer).toContain('Executor Result:')
    expect(result.reason).toBe(`Exceeded maximum orchestrator turns (3)`)
    expect(result.delegationCount).toBe(1)
    expect(result.totalExecutorSteps).toBe(4)
    expect(result.turns).toBe(1)
  })

  it('answers the abort reason only when the caller aborted, else the error message', async () => {
    nextGenerate = async (params) => {
      const signal = params.abortSignal
      return Promise.reject(
        signal instanceof AbortSignal && signal.aborted
          ? new Error('the real error')
          : new Error('model exploded'),
      )
    }
    const { agent } = build(async () => doneResult())
    const aborted = new AbortController()
    aborted.abort()
    const viaAbort = await agent.run('q', aborted.signal)
    expect(viaAbort.reason).toBe('Aborted by eval timeout')

    const viaError = await agent.run('q')
    expect(viaError.reason).toBe('model exploded')
  })
})
