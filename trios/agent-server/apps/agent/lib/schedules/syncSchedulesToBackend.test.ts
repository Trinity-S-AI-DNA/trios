/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * syncSchedulesToBackend held against its contract
 * (gHashTag/trios#1571): the two-way GraphQL sync of scheduled jobs -
 * the profile-lookup gate, pending deletions (delete / resolve /
 * report), the pull direction (remote-only jobs added locally with
 * normalized timestamps, newer remote copies merged over local ones)
 * with the alarm re-wiring it triggers, and the push direction
 * (update for a changed newer local job, create for a local-only
 * job, the remote-newer-or-equal skip) with its per-job sentry catch
 * - pinned as it behaves today on recording fakes.
 *
 * Module plumbing, measured before writing (the pattern of the
 * uploadLlmProvidersToGraphql suite of trios#1668):
 * - The Tests jobs never generate @/generated/graphql/gql, so a
 *   one-export graphql tag is stubbed before anything imports the
 *   document chain.
 * - scheduleStorage.test.ts keeps a load-bearing process-global stub
 *   of this very subject (without it its static chain dies on the
 *   missing generated module), so this suite binds the real subject
 *   through a query suffix bun's mock registry does not match, in
 *   any file order.
 * - Snapshotting the real ./scheduleStorage needs the environment
 *   mocks first: @wxt-dev/storage as an in-memory shim (the real
 *   one is browser-bound), the schedules messaging stand-in
 *   (webextension-polyfill throws at module scope outside an
 *   extension) and the auth session stand-in. The real module is
 *   then copied, re-mocked as a two-key store fake, and restored in
 *   afterAll together with the execute, sentry and createAlarmFromJob
 *   seams. No other test file imports those seams (verified by
 *   grep; scheduleStorage.test.ts is its own subject and runs
 *   earlier in the file order), so nothing else in this job
 *   observes the mocks.
 * - chrome.alarms does not exist under bun test; this suite installs
 *   a recording global and removes it in afterAll. The subject's
 *   alarm branch swallows its own failures by design.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ScheduledJob } from './scheduleTypes'

mock.module('@/generated/graphql/gql', () => ({
  graphql: (query: string) => ({ query }),
}))

const storedValues = new Map<string, unknown>()
const watchers = new Map<string, Array<(value: unknown) => void>>()
mock.module('@wxt-dev/storage', () => ({
  storage: {
    defineItem: (
      key: string,
      options?: { fallback?: unknown } & Record<string, unknown>,
    ) => ({
      getValue: async () => {
        if (!storedValues.has(key)) {
          return options && 'fallback' in options ? options.fallback : null
        }
        return storedValues.get(key)
      },
      setValue: async (value: unknown) => {
        storedValues.set(key, value)
        for (const fn of watchers.get(key) ?? []) fn(value)
      },
      watch: (fn: (value: unknown) => void) => {
        watchers.set(key, [...(watchers.get(key) ?? []), fn])
        return () => {
          watchers.set(
            key,
            (watchers.get(key) ?? []).filter((entry) => entry !== fn),
          )
        }
      },
    }),
  },
}))

mock.module('@/lib/messaging/schedules/scheduleMessages', () => ({
  onScheduleMessage: () => () => {},
  sendScheduleMessage: async () => ({}),
}))

mock.module('@/lib/auth/sessionStorage', () => ({
  sessionStorage: {
    getValue: async () => null,
    watch: () => () => {},
  },
}))

const realScheduleStorage = { ...(await import('./scheduleStorage')) }
const realExecute = { ...(await import('@/lib/graphql/execute')) }
const realSentry = { ...(await import('@/lib/sentry/sentry')) }
const realCreateAlarm = { ...(await import('./createAlarmFromJob')) }

afterAll(() => {
  mock.module('./scheduleStorage', () => realScheduleStorage)
  mock.module('@/lib/graphql/execute', () => realExecute)
  mock.module('@/lib/sentry/sentry', () => realSentry)
  mock.module('./createAlarmFromJob', () => realCreateAlarm)
  const holder = globalThis as { chrome?: unknown }
  if (chromeBefore === undefined) delete holder.chrome
  else holder.chrome = chromeBefore
})

type Call = { doc: unknown; vars: unknown }
type SentryCall = { error: unknown; hint: unknown }

let calls: Call[] = []
let sentryCalls: SentryCall[] = []
let profileRowId: string | null = 'profile-1'
let remoteNodes: unknown[] = []
let failingDocs = new Set<unknown>()
let pendingDeletions: string[] = []
let scheduledJobs: ScheduledJob[] = []
let alarmClears: string[] = []
let alarmCreates: ScheduledJob[] = []

mock.module('./scheduleStorage', () => ({
  pendingDeletionStorage: {
    getValue: async () => pendingDeletions,
    setValue: async (value: string[]) => {
      pendingDeletions = value
    },
  },
  scheduledJobStorage: {
    getValue: async () => scheduledJobs,
    setValue: async (value: ScheduledJob[]) => {
      scheduledJobs = value
    },
  },
}))

const documents = {
  profile: (
    await import('@/lib/conversations/graphql/uploadConversationDocument')
  ).GetProfileIdByUserIdDocument,
  list: (await import('./graphql/syncSchedulesDocument'))
    .GetScheduledJobsByProfileIdDocument,
  create: (await import('./graphql/syncSchedulesDocument'))
    .CreateScheduledJobDocument,
  update: (await import('./graphql/syncSchedulesDocument'))
    .UpdateScheduledJobDocument,
  delete: (await import('./graphql/syncSchedulesDocument'))
    .DeleteScheduledJobDocument,
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
      return { scheduledJobs: { nodes: remoteNodes } }
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

mock.module('./createAlarmFromJob', () => ({
  createAlarmFromJob: async (job: ScheduledJob) => {
    alarmCreates.push(job)
  },
}))

const chromeBefore = (globalThis as { chrome?: unknown }).chrome
;(globalThis as { chrome?: unknown }).chrome = {
  alarms: {
    clear: async (name: string) => {
      alarmClears.push(name)
      return true
    },
  },
}

const subjectSpecifier: string =
  './syncSchedulesToBackend.ts?zcode-real-subject'
const { syncSchedulesToBackend } = (await import(
  subjectSpecifier
)) as typeof import('./syncSchedulesToBackend')

type RemoteScheduledJob = {
  rowId: string
  name: string
  query: string
  scheduleType: string
  scheduleTime: string | null
  scheduleInterval: number | null
  enabled: boolean
  llmProviderId: string | null
  createdAt: string
  updatedAt: string
  lastRunAt: string | null
}

const localJob = (overrides: Partial<ScheduledJob> = {}): ScheduledJob => ({
  id: 'job-1',
  name: 'Morning digest',
  query: 'summarize the news',
  scheduleType: 'daily',
  scheduleTime: '09:00',
  enabled: true,
  providerId: 'prov-1',
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-02T10:00:00Z',
  ...overrides,
})

const remoteJob = (
  overrides: Partial<RemoteScheduledJob> = {},
): RemoteScheduledJob => ({
  rowId: 'job-1',
  name: 'Morning digest',
  query: 'summarize the news',
  scheduleType: 'daily',
  scheduleTime: '09:00',
  scheduleInterval: null,
  enabled: true,
  llmProviderId: 'prov-1',
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-02T10:00:00Z',
  lastRunAt: null,
  ...overrides,
})

const mutationCalls = () =>
  calls.filter(
    (call) => call.doc === documents.create || call.doc === documents.update,
  )

describe('syncSchedulesToBackend', () => {
  beforeEach(() => {
    calls = []
    sentryCalls = []
    profileRowId = 'profile-1'
    remoteNodes = []
    failingDocs = new Set()
    pendingDeletions = []
    scheduledJobs = []
    alarmClears = []
    alarmCreates = []
  })

  test('stops after the profile lookup when the user has no profile', async () => {
    profileRowId = null
    pendingDeletions = ['job-x']

    await syncSchedulesToBackend([localJob()], 'user-1')

    expect(calls.length).toBe(1)
    expect(calls[0].doc).toBe(documents.profile)
    expect(calls[0].vars).toEqual({ userId: 'user-1' })
    expect(pendingDeletions).toEqual(['job-x'])
  })

  test('deletes a pending deletion that still exists remotely and clears it', async () => {
    pendingDeletions = ['job-x']
    remoteNodes = [remoteJob({ rowId: 'job-x' })]

    await syncSchedulesToBackend([], 'user-1')

    const deletes = calls.filter((call) => call.doc === documents.delete)
    expect(deletes.length).toBe(1)
    expect(deletes[0].vars).toEqual({ rowId: 'job-x' })
    expect(pendingDeletions).toEqual([])
    expect(scheduledJobs).toEqual([])
  })

  test('resolves a pending deletion that is already gone remotely', async () => {
    pendingDeletions = ['job-x']

    await syncSchedulesToBackend([], 'user-1')

    expect(calls.filter((call) => call.doc === documents.delete).length).toBe(0)
    expect(pendingDeletions).toEqual([])
  })

  test('keeps a failed pending deletion and reports it to sentry', async () => {
    pendingDeletions = ['job-x']
    remoteNodes = [remoteJob({ rowId: 'job-x' })]
    failingDocs.add(documents.delete)

    await syncSchedulesToBackend([], 'user-1')

    expect(sentryCalls.length).toBe(1)
    expect(sentryCalls[0].hint).toEqual({
      extra: { jobId: 'job-x', context: 'sync-pending-deletion' },
    })
    expect(pendingDeletions).toEqual(['job-x'])
  })

  test('adds remote-only jobs locally with normalized timestamps and rewires alarms', async () => {
    remoteNodes = [
      remoteJob({
        createdAt: '2026-10-01T10:00:00',
        updatedAt: '2026-10-03T11:00:00',
        lastRunAt: null,
      }),
      remoteJob({
        rowId: 'job-2',
        name: 'Evening digest',
        enabled: false,
      }),
    ]

    await syncSchedulesToBackend([], 'user-1')

    expect(scheduledJobs.length).toBe(2)
    expect(scheduledJobs[0]).toEqual({
      id: 'job-1',
      name: 'Morning digest',
      query: 'summarize the news',
      scheduleType: 'daily',
      scheduleTime: '09:00',
      scheduleInterval: undefined,
      enabled: true,
      providerId: 'prov-1',
      createdAt: '2026-10-01T10:00:00Z',
      updatedAt: '2026-10-03T11:00:00Z',
      lastRunAt: undefined,
    })
    expect(alarmClears).toEqual(['scheduled-job-job-1', 'scheduled-job-job-2'])
    expect(alarmCreates.map((job) => job.id)).toEqual(['job-1'])
    expect(mutationCalls().length).toBe(0)
  })

  test('merges a newer remote copy over the local one', async () => {
    scheduledJobs = [localJob()]
    remoteNodes = [
      remoteJob({
        name: 'Morning digest v2',
        updatedAt: '2026-10-05T10:00:00Z',
      }),
    ]

    await syncSchedulesToBackend([localJob()], 'user-1')

    expect(scheduledJobs.length).toBe(1)
    expect(scheduledJobs[0].name).toBe('Morning digest v2')
    expect(mutationCalls().length).toBe(0)
    expect(alarmCreates.map((job) => job.id)).toEqual(['job-1'])
  })

  test('pushes a changed newer local job as an update', async () => {
    remoteNodes = [
      remoteJob({
        name: 'Old name',
        updatedAt: '2026-10-01T10:00:00Z',
      }),
    ]

    await syncSchedulesToBackend(
      [
        localJob({
          name: 'New name',
          updatedAt: '2026-10-04T12:00:00Z',
          lastRunAt: '2026-10-03T09:00:00Z',
        }),
      ],
      'user-1',
    )

    expect(scheduledJobs).toEqual([])
    const mutations = mutationCalls()
    expect(mutations.length).toBe(1)
    expect(mutations[0].doc).toBe(documents.update)
    expect(mutations[0].vars).toEqual({
      input: {
        rowId: 'job-1',
        patch: {
          name: 'New name',
          query: 'summarize the news',
          scheduleType: 'daily',
          scheduleTime: '09:00',
          scheduleInterval: null,
          enabled: true,
          llmProviderId: 'prov-1',
          lastRunAt: '2026-10-03T09:00:00.000Z',
          updatedAt: '2026-10-04T12:00:00Z',
        },
      },
    })
  })

  test('creates a local job that is missing remotely', async () => {
    remoteNodes = []

    await syncSchedulesToBackend(
      [localJob({ lastRunAt: '2026-10-02T09:00:00Z' })],
      'user-1',
    )

    const mutations = mutationCalls()
    expect(mutations.length).toBe(1)
    expect(mutations[0].doc).toBe(documents.create)
    expect(mutations[0].vars).toEqual({
      input: {
        scheduledJob: {
          rowId: 'job-1',
          profileId: 'profile-1',
          name: 'Morning digest',
          query: 'summarize the news',
          scheduleType: 'daily',
          scheduleTime: '09:00',
          scheduleInterval: null,
          enabled: true,
          llmProviderId: 'prov-1',
          createdAt: '2026-10-01T10:00:00.000Z',
          updatedAt: '2026-10-02T10:00:00Z',
          lastRunAt: '2026-10-02T09:00:00.000Z',
        },
      },
    })
  })

  test('does not push when the remote copy is at least as new', async () => {
    remoteNodes = [
      remoteJob({
        name: 'Renamed remotely',
        updatedAt: '2026-10-02T10:00:00Z',
      }),
    ]

    await syncSchedulesToBackend(
      [localJob({ name: 'Renamed locally' })],
      'user-1',
    )

    expect(mutationCalls().length).toBe(0)
    expect(scheduledJobs).toEqual([])
  })

  test('captures a failed create with sentry and returns normally', async () => {
    failingDocs.add(documents.create)

    await syncSchedulesToBackend([localJob()], 'user-1')

    expect(sentryCalls.length).toBe(1)
    expect(sentryCalls[0].error).toBeInstanceOf(Error)
    expect(sentryCalls[0].hint).toEqual({
      extra: { jobId: 'job-1', jobName: 'Morning digest' },
    })
  })
})
