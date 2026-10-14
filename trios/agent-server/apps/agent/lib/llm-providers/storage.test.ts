/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The LLM provider store, held against its contract
 * (gHashTag/trios#1630): the nine exports of
 * lib/llm-providers/storage.ts - DEFAULT_PROVIDER_ID,
 * providersStorage, defaultProviderIdStorage, loadProviders,
 * createDefaultBrowserOSProvider, createDefaultProvidersConfig,
 * syncLlmProviders, setupLlmProvidersBackupToBrowserOS,
 * setupLlmProvidersSyncToBackend - pinned as they behave today, so
 * the next change to that file has something to fail against.
 *
 * The storage seam is an in-memory mock.module stub of
 * @wxt-dev/storage (the pattern of SkillsPage.test.ts, also used by
 * the execution-history suite of this wave); the GraphQL upload, the
 * auth session, the BrowserOS adapter and its prefs constants are
 * stubbed the same way - the upload and backup paths are named as
 * blocked below, and the stubs keep this suite free of the
 * graphql/sentry/adapter import chains entirely. No other suite of
 * this job imports these modules (that is exactly why they were
 * untested), so the process-global mocks cannot leak into a suite
 * that wants the real ones.
 *
 * Not pinned, and why: syncLlmProviders with a logged-in session
 * (needs the auth session and the real GraphQL upload - two more
 * process-global seams for behaviour the issue does not ask to
 * pin here), and the pref content of the backup watcher
 * (setupLlmProvidersBackupToBrowserOS writes through the BrowserOS
 * adapter, unavailable outside the shell). What IS pinned for both
 * setups: they subscribe exactly one watcher on the providers item
 * and hand back a working unsubscribe.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { scheduleSystemPrompt } from '../schedules/scheduleSystemPrompt'
import type { LlmProviderConfig } from './types'

const defines: Array<{ key: string; opts: unknown }> = []
const values = new Map<string, unknown>()
const watches: Map<string, Array<() => void>> = new Map()

const fakeItem = (key: string) => ({
  getValue: async () => values.get(key) ?? null,
  setValue: async (value: unknown) => {
    values.set(key, value)
  },
  watch: (unwatch: () => void) => {
    const list = watches.get(key) ?? []
    list.push(unwatch)
    watches.set(key, list)
    return () => {
      watches.set(
        key,
        (watches.get(key) ?? []).filter((f) => f !== unwatch),
      )
    }
  },
})

mock.module('@wxt-dev/storage', () => ({
  storage: {
    defineItem: (key: string, opts?: unknown) => {
      defines.push({ key, opts })
      return fakeItem(key)
    },
  },
}))

mock.module('./uploadLlmProvidersToGraphql', () => ({
  uploadLlmProvidersToGraphql: async () => {},
}))

mock.module('@/lib/auth/sessionStorage', () => ({
  sessionStorage: {
    getValue: async () => null,
    watch: () => () => {},
  },
}))

// The adapter stub must be a COMPLETE stand-in for the module's
// value exports: capabilities.ts imports the BrowserOSAdapter class
// itself, so the mock carries both. Like the real adapter outside the
// shell, the methods reject - which is exactly what the port helpers
// and the backup path already catch.
class BrowserOSAdapterStub {
  static getInstance(): BrowserOSAdapterStub {
    return new BrowserOSAdapterStub()
  }
  async getPref(): Promise<never> {
    throw new Error('BrowserOS API not available')
  }
  async setPref(): Promise<never> {
    throw new Error('BrowserOS API not available')
  }
  async getBrowserosVersion(): Promise<never> {
    throw new Error('BrowserOS API not available')
  }
}

mock.module('@/lib/browseros/adapter', () => ({
  BrowserOSAdapter: BrowserOSAdapterStub,
  getBrowserOSAdapter: () => BrowserOSAdapterStub.getInstance(),
}))

mock.module('@/lib/browseros/prefs', () => ({
  BROWSEROS_PREFS: { PROVIDERS: 'llmProviders' },
}))

const {
  createDefaultBrowserOSProvider,
  createDefaultProvidersConfig,
  DEFAULT_PROVIDER_ID,
  defaultProviderIdStorage,
  loadProviders,
  providersStorage,
  setupLlmProvidersBackupToBrowserOS,
  setupLlmProvidersSyncToBackend,
  syncLlmProviders,
} = await import('./storage')

const renamedDefault = {
  id: 'browseros',
  type: 'browseros' as const,
  name: 'Kimi K2.5',
  baseUrl: 'https://api.browseros.com/v1',
  modelId: 'browseros-auto',
  contextWindow: 100000,
}

describe('DEFAULT_PROVIDER_ID', () => {
  it('is the browseros id', () => {
    expect(DEFAULT_PROVIDER_ID).toBe('browseros')
  })
})

describe('providersStorage', () => {
  it('declares the providers array under its key at version 2 with a v2 migration', () => {
    expect(providersStorage).toBeDefined()
    const declared = defines.find((d) => d.key === 'local:llm-providers')
    expect(declared).toBeDefined()
    const opts = declared?.opts as {
      version: number
      migrations: Record<string, unknown>
    }
    expect(opts.version).toBe(2)
    expect(typeof opts.migrations['2']).toBe('function')
  })

  it('the v2 migration sets the default provider context window and passes others through', () => {
    const declared = defines.find((d) => d.key === 'local:llm-providers')
    const migrate = (
      declared?.opts as {
        migrations: { 2: (p: unknown[] | null) => unknown[] | null }
      }
    ).migrations['2']
    const browseros = { id: 'browseros', type: 'browseros', contextWindow: 1 }
    const other = { id: 'openai', type: 'openai', contextWindow: 1 }
    expect(migrate([browseros, other])).toEqual([
      { id: 'browseros', type: 'browseros', contextWindow: 200000 },
      other,
    ])
    expect(migrate(null)).toBeNull()
  })
})

describe('defaultProviderIdStorage', () => {
  it('declares the default provider id under its key with the browseros fallback', () => {
    expect(defaultProviderIdStorage).toBeDefined()
    expect(defines).toContainEqual({
      key: 'local:default-provider-id',
      opts: expect.objectContaining({ fallback: 'browseros' }),
    })
  })
})

describe('loadProviders', () => {
  it('answers an empty list when nothing is stored, without writing back', async () => {
    expect(await loadProviders()).toEqual([])
    expect(values.has('local:llm-providers')).toBe(false)
  })

  it('normalizes a renamed default provider back to BrowserOS and keeps storage consistent', async () => {
    values.set('local:llm-providers', [renamedDefault])
    const loaded = await loadProviders()
    expect(loaded[0].name).toBe('BrowserOS')
    expect(values.get('local:llm-providers')).toEqual([
      { ...renamedDefault, name: 'BrowserOS' },
    ])
  })

  it('leaves non-default providers untouched', async () => {
    const openai = {
      id: 'openai',
      type: 'openai',
      name: 'OpenAI',
    } as unknown as Awaited<ReturnType<typeof loadProviders>>[number]
    values.set('local:llm-providers', [openai])
    const loaded = await loadProviders()
    expect(loaded).toEqual([openai])
  })
})

describe('createDefaultBrowserOSProvider / createDefaultProvidersConfig', () => {
  it('builds the default provider with the pinned shape', () => {
    const provider = createDefaultBrowserOSProvider()
    expect(provider.id).toBe('browseros')
    expect(provider.type).toBe('browseros')
    expect(provider.name).toBe('BrowserOS')
    expect(provider.baseUrl).toBe('https://api.browseros.com/v1')
    expect(provider.modelId).toBe('browseros-auto')
    expect(provider.supportsImages).toBe(true)
    expect(provider.contextWindow).toBe(200000)
    expect(provider.temperature).toBe(0.2)
  })

  it('answers exactly the default provider', () => {
    const config = createDefaultProvidersConfig()
    expect(config.length).toBe(1)
    expect(config[0].id).toBe('browseros')
  })
})

describe('syncLlmProviders', () => {
  it('resolves without uploading when no session is present', async () => {
    await syncLlmProviders()
  })
})

describe('setupLlmProvidersBackupToBrowserOS', () => {
  it('subscribes exactly one watcher and the unsubscribe removes it', () => {
    const before = (watches.get('local:llm-providers') ?? []).length
    const unsubscribe = setupLlmProvidersBackupToBrowserOS()
    expect((watches.get('local:llm-providers') ?? []).length).toBe(before + 1)
    unsubscribe()
    expect((watches.get('local:llm-providers') ?? []).length).toBe(before)
  })
})

describe('setupLlmProvidersSyncToBackend', () => {
  it('subscribes exactly one watcher and the unsubscribe removes it', () => {
    const before = (watches.get('local:llm-providers') ?? []).length
    const unsubscribe = setupLlmProvidersSyncToBackend()
    expect((watches.get('local:llm-providers') ?? []).length).toBe(before + 1)
    unsubscribe()
    expect((watches.get('local:llm-providers') ?? []).length).toBe(before)
  })
})

/*
 * The getChatServerResponse contract (gHashTag/trios#1545) -
 * appended to this file because this file owns the heaviest seam
 * the subject reads: the provider store, whose real instance
 * materializes against this file's in-memory storage shim (the
 * readdir file-order constraint found in trios#1571, applied before
 * push this time). The subject's other storage seams -
 * mcpServerStorage and personalizationStorage - are the same kind
 * of wxt items and are driven through this file's values map. The
 * helpers seam (getAgentServerUrl) and buildChatRequestBody are
 * recording fakes with the copy-before-mock, restore-in-afterAll
 * pattern; the subject itself is bound through a query suffix the
 * mock registry does not match, so the schedules suite's own
 * process-global stub of it cannot interfere, in any file order.
 * fetch is overridden with a programmable SSE responder and restored
 * in afterAll. scheduleSystemPrompt, eventsource-parser,
 * crypto.randomUUID and Date stay real, so the pinned
 * userSystemPrompt is built from the real constant and timestamps
 * are asserted by shape.
 */

const realHelpers = { ...(await import('@/lib/browseros/helpers')) }
const realBuildBody = {
  ...(await import('@/lib/messaging/server/buildChatRequestBody')),
}
const realFetch = globalThis.fetch

type FetchCall = { url: string; init: RequestInit }
type BodyCall = Record<string, unknown>

let fetchCalls: FetchCall[] = []
let fetchResponseFactory: () => Response = () =>
  new Response('data: {"type":"finish","finishReason":"stop"}\n\n', {
    status: 200,
  })
let agentUrl = 'http://agent.test:1234'
let bodyCalls: BodyCall[] = []
let bodyResult: Record<string, unknown> = { built: 'by-fake' }

afterAll(() => {
  mock.module('@/lib/browseros/helpers', () => realHelpers)
  mock.module(
    '@/lib/messaging/server/buildChatRequestBody',
    () => realBuildBody,
  )
  globalThis.fetch = realFetch
})

mock.module('@/lib/browseros/helpers', () => ({
  getAgentServerUrl: async () => agentUrl,
}))

mock.module('@/lib/messaging/server/buildChatRequestBody', () => ({
  buildChatRequestBody: (args: BodyCall) => {
    bodyCalls.push(args)
    return { ...bodyResult }
  },
}))

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  fetchCalls.push({ url: String(input), init: init ?? {} })
  return fetchResponseFactory()
}) as typeof fetch

const chatSpecifier: string =
  '../schedules/getChatServerResponse.ts?zcode-real-chat'
const { getChatServerResponse } = (await import(
  chatSpecifier
)) as typeof import('../schedules/getChatServerResponse')

const chatProvider = (
  overrides: Partial<LlmProviderConfig> = {},
): LlmProviderConfig => ({
  id: 'prov-1',
  type: 'openai',
  name: 'Primary',
  modelId: 'gpt-x',
  supportsImages: true,
  contextWindow: 128000,
  temperature: 0.5,
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
  ...overrides,
})

const sseResponse = (events: string[], status = 200) =>
  new Response(events.map((data) => `data: ${data}\n\n`).join(''), { status })

const requestBody = (index = 0): Record<string, unknown> =>
  JSON.parse(String(fetchCalls[index].init.body)) as Record<string, unknown>

describe('getChatServerResponse', () => {
  beforeEach(() => {
    fetchCalls = []
    fetchResponseFactory = () =>
      new Response('data: {"type":"finish","finishReason":"stop"}\n\n', {
        status: 200,
      })
    agentUrl = 'http://agent.test:1234'
    bodyCalls = []
    bodyResult = { built: 'by-fake' }
    values.delete('local:llm-providers')
    values.delete('local:default-provider-id')
    values.delete('local:mcpServers')
    values.delete('local:personalization')
  })

  it('posts the user message to the agent chat endpoint and spreads the built body', async () => {
    values.set('local:llm-providers', [chatProvider()])
    values.set('local:personalization', 'You are concise.')

    const result = await getChatServerResponse({
      message: 'plan my day',
      conversationId: 'conv-9',
    })

    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0].url).toBe('http://agent.test:1234/chat')
    expect(fetchCalls[0].init.method).toBe('POST')
    expect(
      (fetchCalls[0].init.headers as Record<string, string>)['Content-Type'],
    ).toBe('application/json')

    const body = requestBody()
    expect(body.messages).toEqual([{ role: 'user', content: 'plan my day' }])
    expect(body.built).toBe('by-fake')

    expect(bodyCalls.length).toBe(1)
    const passed = bodyCalls[0]
    expect(passed.message).toBe('plan my day')
    expect(passed.conversationId).toBe('conv-9')
    expect((passed.provider as LlmProviderConfig).id).toBe('prov-1')
    expect(passed.mode).toBe('agent')
    expect(passed.browserContext).toBeUndefined()
    expect(passed.supportsImages).toBe(true)
    expect(passed.isScheduledTask).toBe(true)
    expect(passed.userSystemPrompt).toBe(
      `You are concise.\n${scheduleSystemPrompt}`,
    )

    expect(result.conversationId).toBe('conv-9')
  })

  it('resolves the requested provider by id before falling back to the first stored provider', async () => {
    values.set('local:llm-providers', [
      chatProvider(),
      chatProvider({ id: 'prov-2', name: 'Secondary' }),
    ])

    await getChatServerResponse({
      message: 'hi',
      conversationId: 'c',
      providerId: 'prov-2',
    })

    expect((bodyCalls[0].provider as LlmProviderConfig).id).toBe('prov-2')

    await getChatServerResponse({ message: 'hi', conversationId: 'c' })

    expect((bodyCalls[1].provider as LlmProviderConfig).id).toBe('prov-1')
  })

  it('falls back to the built-in browseros provider when nothing is stored', async () => {
    const result = await getChatServerResponse({
      message: 'hi',
      conversationId: 'c',
    })

    expect((bodyCalls[0].provider as LlmProviderConfig).type).toBe('browseros')
    expect(result.conversationId).toBe('c')
  })

  it('passes the abort signal and the custom mode through to the request', async () => {
    const controller = new AbortController()

    await getChatServerResponse({
      message: 'hi',
      conversationId: 'c',
      mode: 'chat',
      signal: controller.signal,
    })

    expect(fetchCalls[0].init.signal).toBe(controller.signal)
    expect(bodyCalls[0].mode).toBe('chat')
  })

  it('includes the browser context only when there is something to include', async () => {
    await getChatServerResponse({ message: 'hi', conversationId: 'c' })
    expect(bodyCalls[0].browserContext).toBeUndefined()

    await getChatServerResponse({
      message: 'hi',
      conversationId: 'c',
      windowId: 7,
    })
    expect(bodyCalls[1].browserContext).toEqual({
      windowId: 7,
      activeTab: undefined,
      enabledMcpServers: undefined,
      customMcpServers: undefined,
    })

    values.set('local:mcpServers', [
      {
        id: 'm1',
        displayName: 'Managed',
        type: 'managed',
        managedServerName: 'search',
      },
      { id: 'm2', displayName: 'Broken', type: 'managed' },
      {
        id: 'c1',
        displayName: 'Custom',
        type: 'custom',
        config: { url: 'https://mcp.test' },
      },
      { id: 'c2', displayName: 'No url', type: 'custom', config: {} },
    ])
    await getChatServerResponse({ message: 'hi', conversationId: 'c' })
    expect(bodyCalls[2].browserContext).toEqual({
      windowId: undefined,
      activeTab: undefined,
      enabledMcpServers: ['search'],
      customMcpServers: [{ name: 'Custom', url: 'https://mcp.test' }],
    })
  })

  it('threads the personalization into the system prompt', async () => {
    values.set('local:personalization', 'Be terse.')

    await getChatServerResponse({ message: 'hi', conversationId: 'c' })

    expect(
      String(bodyCalls[0].userSystemPrompt).startsWith('Be terse.\n'),
    ).toBe(true)
  })

  it('throws the HTTP failure with the status and status text', async () => {
    fetchResponseFactory = () =>
      new Response('nope', { status: 500, statusText: 'Internal Server Error' })

    await expect(
      getChatServerResponse({ message: 'hi', conversationId: 'c' }),
    ).rejects.toThrow('Chat request failed: 500 Internal Server Error')
  })

  it('assembles the text, the final result and the log from the stream', async () => {
    fetchResponseFactory = () =>
      sseResponse([
        '{"type":"text-delta","id":"1","delta":"Hello "}',
        '{"type":"text-delta","id":"2","delta":"world"}',
        '[DONE]',
        '{"type":"finish","finishReason":"stop"}',
      ])

    const result = await getChatServerResponse({
      message: 'hi',
      conversationId: 'c',
    })

    expect(result.text).toBe('Hello world')
    expect(result.finalResult).toBe('Hello world')
    expect(result.executionLog).toBe('Hello world')
    expect(result.toolCalls).toEqual([])
  })

  it('records tool calls with their outputs and errors and splits the execution log', async () => {
    fetchResponseFactory = () =>
      sseResponse([
        '{"type":"text-delta","id":"1","delta":"Step one"}',
        '{"type":"tool-input-available","toolCallId":"t1","toolName":"search","input":{"q":"news"}}',
        '{"type":"text-delta","id":"2","delta":"Step two"}',
        '{"type":"tool-output-available","toolCallId":"t1","output":"ok"}',
        '{"type":"tool-input-available","toolCallId":"t2","toolName":"fetch","input":{}}',
        '{"type":"tool-output-error","toolCallId":"t2","errorText":"boom"}',
        '{"type":"finish","finishReason":"stop"}',
      ])

    const result = await getChatServerResponse({
      message: 'hi',
      conversationId: 'c',
    })

    expect(result.toolCalls.length).toBe(2)
    expect(result.toolCalls[0]).toEqual({
      id: 't1',
      name: 'search',
      input: { q: 'news' },
      output: 'ok',
      timestamp: expect.any(String) as string,
    })
    expect(result.toolCalls[1].name).toBe('fetch')
    expect((result.toolCalls[1] as { error?: string }).error).toBe('boom')
    expect(result.executionLog).toBe('Step one\n\nStep two\n\nStep oneStep two')
  })

  it('throws the error event text from the stream', async () => {
    fetchResponseFactory = () =>
      sseResponse([
        '{"type":"text-delta","id":"1","delta":"partial"}',
        '{"type":"error","errorText":"model exploded"}',
      ])

    await expect(
      getChatServerResponse({ message: 'hi', conversationId: 'c' }),
    ).rejects.toThrow('model exploded')
  })

  it('throws the interruption note when the stream ends without a finish', async () => {
    fetchResponseFactory = () =>
      sseResponse(['{"type":"text-delta","id":"1","delta":"partial"}'])

    await expect(
      getChatServerResponse({ message: 'hi', conversationId: 'c' }),
    ).rejects.toThrow(
      'Stream ended unexpectedly without completion. The task may have been interrupted.',
    )
  })

  it('generates a uuid conversation id when none is given', async () => {
    const result = await getChatServerResponse({ message: 'hi' })

    expect(result.conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(bodyCalls[0].conversationId).toBe(result.conversationId)
  })
})
