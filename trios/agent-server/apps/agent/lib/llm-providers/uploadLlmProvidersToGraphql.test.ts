/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * uploadLlmProvidersToGraphql held against its contract
 * (gHashTag/trios#1668): the GraphQL sync of local LLM providers -
 * the profile-lookup gate, the browseros skip, change detection
 * against the remote list (ignored fields, undefined-to-null
 * normalization), the create and update payloads, and the
 * per-provider sentry catch that keeps the loop going - pinned as
 * it behaves today on recording fakes of the execute and sentry
 * seams.
 *
 * Module plumbing, measured before writing:
 * - The subject's chain reaches @/generated/graphql/gql, which the
 *   Tests jobs never generate (only the code-quality job runs
 *   codegen), so this suite stubs that module with a one-export
 *   graphql tag before anything imports the chain. No other test
 *   file imports it, so the stub cannot surprise a sibling.
 * - storage.test.ts must keep its process-global stub of this very
 *   subject: with the stub it stays green, without it its static
 *   chain dies on the missing generated module. To bind the real
 *   subject anyway, this suite imports it through a query suffix
 *   ('./uploadLlmProvidersToGraphql.ts?zcode-real-subject'), which
 *   bun's mock registry does not match, in any file order.
 * - execute and sentry are snapshot-restored in afterAll (the
 *   queen-roadmap pattern); no other test file imports them, so
 *   nothing else in this job observes the mocks.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { LlmProviderConfig } from './types'

const realExecute = { ...(await import('@/lib/graphql/execute')) }
const realSentry = { ...(await import('@/lib/sentry/sentry')) }

afterAll(() => {
  mock.module('@/lib/graphql/execute', () => realExecute)
  mock.module('@/lib/sentry/sentry', () => realSentry)
})

type Call = { doc: unknown; vars: unknown }
type SentryCall = { error: unknown; hint: unknown }

let calls: Call[] = []
let sentryCalls: SentryCall[] = []
let profileRowId: string | null = 'profile-1'
let remoteNodes: unknown[] = []
let failingDocs = new Set<unknown>()

mock.module('@/generated/graphql/gql', () => ({
  graphql: (query: string) => ({ query }),
}))

const documents = {
  profile: (
    await import('@/lib/conversations/graphql/uploadConversationDocument')
  ).GetProfileIdByUserIdDocument,
  list: (await import('./graphql/uploadLlmProviderDocument'))
    .GetLlmProvidersByProfileIdDocument,
  update: (await import('./graphql/uploadLlmProviderDocument'))
    .UpdateLlmProviderForUploadDocument,
  create: (await import('./graphql/uploadLlmProviderDocument'))
    .CreateLlmProviderForUploadDocument,
}

mock.module('@/lib/graphql/execute', () => ({
  execute: async (doc: unknown, vars: unknown) => {
    calls.push({ doc, vars })
    if (doc === documents.profile) {
      return {
        profileByUserId: profileRowId === null ? null : { rowId: profileRowId },
      }
    }
    if (doc === documents.list) {
      return { llmProviders: { nodes: remoteNodes } }
    }
    if (failingDocs.has(doc)) throw new Error('graphql is down')
    return {}
  },
}))

mock.module('@/lib/sentry/sentry', () => ({
  sentry: {
    captureException: (error: unknown, hint: unknown) => {
      sentryCalls.push({ error, hint })
    },
  },
}))

const subjectSpecifier: string =
  './uploadLlmProvidersToGraphql.ts?zcode-real-subject'
const { uploadLlmProvidersToGraphql } = (await import(
  subjectSpecifier
)) as typeof import('./uploadLlmProvidersToGraphql')

type RemoteProvider = {
  rowId: string
  type: string
  name: string
  baseUrl: string | null
  modelId: string
  supportsImages: boolean
  contextWindow: number | null
  temperature: number | null
  resourceName: string | null
  region: string | null
}

const localProvider = (
  overrides: Partial<LlmProviderConfig> = {},
): LlmProviderConfig => ({
  id: 'prov-1',
  type: 'openai',
  name: 'OpenAI',
  modelId: 'gpt-x',
  supportsImages: true,
  contextWindow: 128000,
  temperature: 0.5,
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
  apiKey: 'sk-local-1',
  ...overrides,
})

const remoteProvider = (
  overrides: Partial<RemoteProvider> = {},
): RemoteProvider => ({
  rowId: 'prov-1',
  type: 'openai',
  name: 'OpenAI',
  baseUrl: null,
  modelId: 'gpt-x',
  supportsImages: true,
  contextWindow: 128000,
  temperature: 0.5,
  resourceName: null,
  region: null,
  ...overrides,
})

const mutationCalls = () =>
  calls.filter(
    (call) => call.doc === documents.create || call.doc === documents.update,
  )

describe('uploadLlmProvidersToGraphql', () => {
  beforeEach(() => {
    calls = []
    sentryCalls = []
    profileRowId = 'profile-1'
    remoteNodes = []
    failingDocs = new Set()
  })

  test('makes no graphql call for an empty provider list', async () => {
    await uploadLlmProvidersToGraphql([], 'user-1')

    expect(calls.length).toBe(0)
  })

  test('stops after the profile lookup when the user has no profile', async () => {
    profileRowId = null

    await uploadLlmProvidersToGraphql([localProvider()], 'user-1')

    expect(calls.length).toBe(1)
    expect(calls[0].doc).toBe(documents.profile)
    expect(calls[0].vars).toEqual({ userId: 'user-1' })
  })

  test('skips browseros providers and unchanged ones without mutating', async () => {
    remoteNodes = [remoteProvider()]

    await uploadLlmProvidersToGraphql(
      [
        localProvider({ id: 'prov-browseros', type: 'browseros' }),
        localProvider(),
      ],
      'user-1',
    )

    expect(calls.length).toBe(2)
    expect(calls[1].doc).toBe(documents.list)
    expect(calls[1].vars).toEqual({ profileId: 'profile-1' })
    expect(mutationCalls().length).toBe(0)
  })

  test('sends no update when only ignored fields differ', async () => {
    remoteNodes = [remoteProvider()]

    await uploadLlmProvidersToGraphql(
      [
        localProvider({
          apiKey: 'sk-changed-locally',
          createdAt: 1700000009999,
          updatedAt: 1700000009999,
        }),
      ],
      'user-1',
    )

    expect(mutationCalls().length).toBe(0)
  })

  test('updates a provider whose tracked fields changed', async () => {
    remoteNodes = [remoteProvider()]

    await uploadLlmProvidersToGraphql(
      [localProvider({ name: 'OpenAI Renamed' })],
      'user-1',
    )

    const mutations = mutationCalls()
    expect(mutations.length).toBe(1)
    expect(mutations[0].doc).toBe(documents.update)
    expect(mutations[0].vars).toEqual({
      input: {
        rowId: 'prov-1',
        patch: {
          type: 'openai',
          name: 'OpenAI Renamed',
          baseUrl: null,
          modelId: 'gpt-x',
          supportsImages: true,
          contextWindow: 128000,
          temperature: 0.5,
          resourceName: null,
          region: null,
          updatedAt: new Date(1700000001000).toISOString(),
        },
      },
    })
  })

  test('creates a provider missing from the remote list', async () => {
    remoteNodes = []

    await uploadLlmProvidersToGraphql(
      [localProvider({ baseUrl: 'https://api.example.com' })],
      'user-1',
    )

    const mutations = mutationCalls()
    expect(mutations.length).toBe(1)
    expect(mutations[0].doc).toBe(documents.create)
    expect(mutations[0].vars).toEqual({
      input: {
        llmProvider: {
          rowId: 'prov-1',
          profileId: 'profile-1',
          type: 'openai',
          name: 'OpenAI',
          baseUrl: 'https://api.example.com',
          modelId: 'gpt-x',
          supportsImages: true,
          contextWindow: 128000,
          temperature: 0.5,
          resourceName: null,
          region: null,
          createdAt: new Date(1700000000000).toISOString(),
          updatedAt: new Date(1700000001000).toISOString(),
        },
      },
    })
  })

  test('captures a failed mutation with sentry and keeps syncing', async () => {
    remoteNodes = [remoteProvider()]
    failingDocs.add(documents.update)

    await uploadLlmProvidersToGraphql(
      [
        localProvider({ name: 'OpenAI Renamed' }),
        localProvider({ id: 'prov-2', name: 'Second' }),
      ],
      'user-1',
    )

    expect(sentryCalls.length).toBe(1)
    expect(sentryCalls[0].error).toBeInstanceOf(Error)
    expect(sentryCalls[0].hint).toEqual({
      extra: {
        providerId: 'prov-1',
        providerName: 'OpenAI Renamed',
      },
    })

    const mutations = mutationCalls()
    expect(mutations.length).toBe(2)
    expect(mutations[0].doc).toBe(documents.update)
    expect(mutations[1].doc).toBe(documents.create)
  })

  test('ignores null remote nodes', async () => {
    remoteNodes = [null, remoteProvider()]

    await uploadLlmProvidersToGraphql([localProvider()], 'user-1')

    expect(calls.length).toBe(2)
    expect(mutationCalls().length).toBe(0)
  })
})
