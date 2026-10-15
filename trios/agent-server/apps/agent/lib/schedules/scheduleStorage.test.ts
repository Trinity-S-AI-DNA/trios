/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The schedule storage, held against its contract
 * (gHashTag/trios#1604): the seven exports of
 * lib/schedules/scheduleStorage.ts - scheduledJobStorage,
 * scheduledJobRunStorage, pendingDeletionStorage, useScheduledJobs,
 * useScheduledJobRuns, syncScheduledJobs,
 * setupScheduledJobsSyncToBackend - pinned as they behave today, so
 * the next change to that file has something to fail against.
 *
 * The storage seam is an in-memory fake of @wxt-dev/storage (the
 * pattern of the execution-history and llm-providers suites of this
 * wave, CI-proven in this very process); the auth session and the
 * backend sync are stubbed the same way, the sync stub recording
 * what it was handed. An earlier attempt at this file reported the
 * storage mock "not applying" locally - that was the resolver break
 * of issue #1909 (wxt prepare's generated .wxt/tsconfig.json makes
 * bun stop resolving @/ aliases after a local typecheck), not the
 * mock; every run quoted here is from a checkout without .wxt/.
 *
 * Not pinned, and why (issue User Story 2): the mutator logic the
 * two hooks build (addJob/removeJob/toggleJob/editJob and their run
 * counterparts) - the mutators are closures created inside hooks, so
 * exercising them needs a mounted render that runs the effects
 * (chrome.alarms included), which this group does not have; the
 * render-time contract of each hook - the state it starts with and
 * the mutators it answers - is what the pins read.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ScheduledJob } from './scheduleTypes'

const defines: Array<{ key: string; opts: unknown }> = []
const values = new Map<string, unknown>()
const watches: Map<string, Array<() => void>> = new Map()

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
  watch: (unwatch: () => void) => {
    const list = watches.get(key) ?? []
    list.push(unwatch)
    watches.set(key, list)
    return () => {
      watches.set(
        key,
        (watches.get(key) ?? []).filter((fn) => fn !== unwatch),
      )
    }
  },
})

mock.module('@wxt-dev/storage', () => ({
  storage: {
    defineItem: (key: string, opts?: unknown) => {
      defines.push({ key, opts })
      return fakeItem(key, opts)
    },
  },
}))

let sessionFixture: { user?: { id: string } } | null = null

// This suite links before every other registrar of the session seam
// in the group's run order, and bun freezes a mock facade's export
// set at its first link: the stand-in must carry every named export
// any subject of the group imports (the #1504 rule). useSessionInfo
// joins here so later suites' subjects that import the hook link
// against a complete set.
mock.module('@/lib/auth/sessionStorage', () => ({
  sessionStorage: {
    getValue: async () => sessionFixture,
    watch: () => () => {},
  },
  useSessionInfo: () => ({
    sessionInfo: sessionFixture ?? {},
    isLoading: sessionFixture !== null,
    updateSessionInfo: async () => {},
  }),
}))

// The messaging module refuses to load outside a browser extension
// (webextension-polyfill throws at module scope), so the subject's
// import of it is stubbed with a full stand-in: both value exports
// it carries, with the shapes their callers use.
mock.module('@/lib/messaging/schedules/scheduleMessages', () => ({
  onScheduleMessage: () => () => {},
  sendScheduleMessage: async () => ({}),
}))

const synced: Array<{ jobs: unknown; userId: unknown }> = []

mock.module('./syncSchedulesToBackend', () => ({
  syncSchedulesToBackend: async (jobs: unknown, userId: unknown) => {
    synced.push({ jobs, userId })
  },
}))

const {
  pendingDeletionStorage,
  scheduledJobRunStorage,
  scheduledJobStorage,
  setupScheduledJobsSyncToBackend,
  syncScheduledJobs,
  useScheduledJobRuns,
  useScheduledJobs,
} = await import('./scheduleStorage')

const job = (id: string) => ({
  id,
  name: 'Daily digest',
  query: 'summarize the news',
  scheduleType: 'daily' as const,
  scheduleTime: '08:00',
  enabled: true,
  createdAt: '2026-10-13T00:00:00.000Z',
  updatedAt: '2026-10-13T00:00:00.000Z',
})

describe('scheduleStorageContract', () => {
  describe('scheduledJobStorage', () => {
    it('declares the jobs array under its key with the empty fallback', () => {
      const declared = defines.find((d) => d.key === 'local:scheduledJobs')
      expect(declared).toBeDefined()
      expect((declared?.opts as { fallback: unknown }).fallback).toEqual([])
      expect(scheduledJobStorage).toBeDefined()
    })
  })

  describe('scheduledJobRunStorage', () => {
    it('declares the runs array under its key with the empty fallback', () => {
      const declared = defines.find((d) => d.key === 'local:scheduledJobRuns')
      expect(declared).toBeDefined()
      expect((declared?.opts as { fallback: unknown }).fallback).toEqual([])
      expect(scheduledJobRunStorage).toBeDefined()
    })
  })

  describe('pendingDeletionStorage', () => {
    it('declares the pending deletions under its key with the empty fallback', () => {
      const declared = defines.find(
        (d) => d.key === 'local:scheduledJobsPendingDeletion',
      )
      expect(declared).toBeDefined()
      expect((declared?.opts as { fallback: unknown }).fallback).toEqual([])
      expect(pendingDeletionStorage).toBeDefined()
    })
  })

  describe('useScheduledJobs', () => {
    it('starts with no jobs and answers every mutator ready', () => {
      const probe = () => {
        const { jobs, addJob, removeJob, editJob, toggleJob, runJob } =
          useScheduledJobs()
        const ready = [addJob, removeJob, editJob, toggleJob, runJob].every(
          (mutator) => typeof mutator === 'function',
        )
        return createElement(
          'pre',
          null,
          [String(jobs.length), String(ready)].join('|'),
        )
      }
      expect(renderToStaticMarkup(createElement(probe))).toContain('0|true')
    })
  })

  describe('useScheduledJobRuns', () => {
    it('starts with no runs and answers every mutator ready', () => {
      const probe = () => {
        const { jobRuns, addJobRun, removeJobRun, editJobRun, cancelJobRun } =
          useScheduledJobRuns()
        const ready = [addJobRun, removeJobRun, editJobRun, cancelJobRun].every(
          (mutator) => typeof mutator === 'function',
        )
        return createElement(
          'pre',
          null,
          [String(jobRuns.length), String(ready)].join('|'),
        )
      }
      expect(renderToStaticMarkup(createElement(probe))).toContain('0|true')
    })
  })

  describe('syncScheduledJobs', () => {
    it('hands the stored jobs to the backend sync for the logged-in user, and nothing without a session', async () => {
      const stored = [job('job-1'), job('job-2')]
      values.set('local:scheduledJobs', stored)
      sessionFixture = { user: { id: 'user-1' } }

      await syncScheduledJobs()
      expect(synced).toEqual([{ jobs: stored, userId: 'user-1' }])

      sessionFixture = null
      await syncScheduledJobs()
      expect(synced.length).toBe(1)
    })
  })

  describe('setupScheduledJobsSyncToBackend', () => {
    it('syncs once on setup and subscribes exactly one watcher on the jobs, and the unsubscribe removes it', async () => {
      values.set('local:scheduledJobs', [job('job-1')])
      sessionFixture = { user: { id: 'user-2' } }
      const before = (watches.get('local:scheduledJobs') ?? []).length

      const unsubscribe = setupScheduledJobsSyncToBackend()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(synced.length).toBe(2)
      expect(synced[1]?.userId).toBe('user-2')
      expect((watches.get('local:scheduledJobs') ?? []).length).toBe(before + 1)

      unsubscribe()
      expect((watches.get('local:scheduledJobs') ?? []).length).toBe(before)
    })
  })
})

/*
 * The syncSchedulesToBackend contract (gHashTag/trios#1571) - appended
 * to this file by necessity, not preference: a standalone suite for
 * the sync cannot coexist with this store suite inside one bun
 * process. bun runs a group's test files in readdir order, which
 * differs between macOS and the CI runner; measured both ways, a sync
 * suite that runs first materializes ./scheduleStorage itself and this
 * suite's contract - which must materialize that module against its
 * own seams (the values/watches/defines maps above) - cannot hold,
 * and mock.module has no unregister to hand the path back. One file
 * removes the file-order question entirely.
 *
 * The real sync is bound through a query suffix the mock registry
 * does not match (measured), so the store above stays bound to this
 * suite's own stub of the sync, while the real sync reads the very
 * store items this file already owns: store state is set and read
 * through the values map. The execute and sentry seams are recording
 * fakes with the copy-before-mock, restore-in-afterAll pattern;
 * nothing else in this job imports them (grep-verified).
 * @/generated/graphql/gql is stubbed with a one-export graphql tag -
 * the Tests jobs never generate it (only the code-quality job runs
 * codegen). chrome.alarms does not exist under bun test, so a
 * recording global is installed and removed in afterAll; the sync's
 * alarm branch swallows its own failures by design.
 */

mock.module('@/generated/graphql/gql', () => ({
  graphql: (query: string) => ({ query }),
}))

const realExecute = { ...(await import('@/lib/graphql/execute')) }
const realSentry = { ...(await import('@/lib/sentry/sentry')) }
const realCreateAlarm = { ...(await import('./createAlarmFromJob')) }

afterAll(() => {
  mock.module('@/lib/graphql/execute', () => realExecute)
  mock.module('@/lib/sentry/sentry', () => realSentry)
  mock.module('./createAlarmFromJob', () => realCreateAlarm)
  const holder = globalThis as { chrome?: unknown }
  if (chromeBefore === undefined) delete holder.chrome
  else holder.chrome = chromeBefore
})

type SyncCall = { doc: unknown; vars: unknown }
type SentryCall = { error: unknown; hint: unknown }

let syncCalls: SyncCall[] = []
let sentryCalls: SentryCall[] = []
let profileRowId: string | null = 'profile-1'
let remoteNodes: unknown[] = []
let failingDocs = new Set<unknown>()
let alarmClears: string[] = []
let alarmCreates: unknown[] = []

const syncDocuments = {
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
    syncCalls.push({ doc, vars })
    if (doc === syncDocuments.profile) {
      return {
        profileByUserId: profileRowId === null ? null : { rowId: profileRowId },
      }
    }
    if (doc === syncDocuments.list) {
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
  createAlarmFromJob: async (job: unknown) => {
    alarmCreates.push(job)
  },
}))

let alarmGets: string[] = []
let existingAlarms: Record<string, { name: string }> = {}
let alarmHandlers: Array<(alarm: { name: string }) => void | Promise<void>> = []
let startupHandlers: Array<() => void | Promise<void>> = []
let installedHandlers: Array<() => void | Promise<void>> = []

const chromeBefore = (globalThis as { chrome?: unknown }).chrome
;(globalThis as { chrome?: unknown }).chrome = {
  alarms: {
    clear: async (name: string) => {
      alarmClears.push(name)
      return true
    },
    get: async (name: string) => {
      alarmGets.push(name)
      return existingAlarms[name] ?? null
    },
    onAlarm: {
      addListener: (fn: (alarm: { name: string }) => void | Promise<void>) => {
        alarmHandlers.push(fn)
      },
    },
  },
  runtime: {
    onStartup: {
      addListener: (fn: () => void | Promise<void>) => {
        startupHandlers.push(fn)
      },
    },
    onInstalled: {
      addListener: (fn: () => void | Promise<void>) => {
        installedHandlers.push(fn)
      },
    },
  },
}

const syncSpecifier: string = './syncSchedulesToBackend.ts?zcode-real-sync'
const { syncSchedulesToBackend } = (await import(
  syncSpecifier
)) as typeof import('./syncSchedulesToBackend')

type RemoteSyncJob = {
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

const localSyncJob = (overrides: Partial<ScheduledJob> = {}): ScheduledJob => ({
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

const remoteSyncJob = (
  overrides: Partial<RemoteSyncJob> = {},
): RemoteSyncJob => ({
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

const storedJobs = () =>
  (values.get('local:scheduledJobs') as Array<unknown>) ?? []
const pendingDeletions = () =>
  (values.get('local:scheduledJobsPendingDeletion') as Array<unknown>) ?? []
const syncMutations = () =>
  syncCalls.filter(
    (call) =>
      call.doc === syncDocuments.create || call.doc === syncDocuments.update,
  )

describe('syncSchedulesToBackend', () => {
  beforeEach(() => {
    syncCalls = []
    sentryCalls = []
    profileRowId = 'profile-1'
    remoteNodes = []
    failingDocs = new Set()
    alarmClears = []
    alarmCreates = []
    values.delete('local:scheduledJobs')
    values.delete('local:scheduledJobsPendingDeletion')
  })

  it('stops after the profile lookup when the user has no profile', async () => {
    profileRowId = null
    values.set('local:scheduledJobsPendingDeletion', ['job-x'])

    await syncSchedulesToBackend([localSyncJob()], 'user-1')

    expect(syncCalls.length).toBe(1)
    expect(syncCalls[0].doc).toBe(syncDocuments.profile)
    expect(syncCalls[0].vars).toEqual({ userId: 'user-1' })
    expect(pendingDeletions()).toEqual(['job-x'])
  })

  it('deletes a pending deletion that still exists remotely and clears it', async () => {
    values.set('local:scheduledJobsPendingDeletion', ['job-x'])
    remoteNodes = [remoteSyncJob({ rowId: 'job-x' })]

    await syncSchedulesToBackend([], 'user-1')

    const deletes = syncCalls.filter(
      (call) => call.doc === syncDocuments.delete,
    )
    expect(deletes.length).toBe(1)
    expect(deletes[0].vars).toEqual({ rowId: 'job-x' })
    expect(pendingDeletions()).toEqual([])
    expect(storedJobs()).toEqual([])
  })

  it('resolves a pending deletion that is already gone remotely', async () => {
    values.set('local:scheduledJobsPendingDeletion', ['job-x'])

    await syncSchedulesToBackend([], 'user-1')

    expect(
      syncCalls.filter((call) => call.doc === syncDocuments.delete).length,
    ).toBe(0)
    expect(pendingDeletions()).toEqual([])
  })

  it('keeps a failed pending deletion and reports it to sentry', async () => {
    values.set('local:scheduledJobsPendingDeletion', ['job-x'])
    remoteNodes = [remoteSyncJob({ rowId: 'job-x' })]
    failingDocs.add(syncDocuments.delete)

    await syncSchedulesToBackend([], 'user-1')

    expect(sentryCalls.length).toBe(1)
    expect(sentryCalls[0].hint).toEqual({
      extra: { jobId: 'job-x', context: 'sync-pending-deletion' },
    })
    expect(pendingDeletions()).toEqual(['job-x'])
  })

  it('adds remote-only jobs locally with normalized timestamps and rewires alarms', async () => {
    remoteNodes = [
      remoteSyncJob({
        createdAt: '2026-10-01T10:00:00',
        updatedAt: '2026-10-03T11:00:00',
        lastRunAt: null,
      }),
      remoteSyncJob({
        rowId: 'job-2',
        name: 'Evening digest',
        enabled: false,
      }),
    ]

    await syncSchedulesToBackend([], 'user-1')

    expect(storedJobs().length).toBe(2)
    expect(storedJobs()[0]).toEqual({
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
    expect((alarmCreates[0] as { id?: string }).id).toBe('job-1')
    expect(alarmCreates.length).toBe(1)
    expect(syncMutations().length).toBe(0)
  })

  it('merges a newer remote copy over the local one', async () => {
    values.set('local:scheduledJobs', [localSyncJob()])
    remoteNodes = [
      remoteSyncJob({
        name: 'Morning digest v2',
        updatedAt: '2026-10-05T10:00:00Z',
      }),
    ]

    await syncSchedulesToBackend([localSyncJob()], 'user-1')

    expect(storedJobs().length).toBe(1)
    expect((storedJobs()[0] as Record<string, unknown>).name).toBe(
      'Morning digest v2',
    )
    expect(syncMutations().length).toBe(0)
    expect(alarmCreates.length).toBe(1)
  })

  it('pushes a changed newer local job as an update', async () => {
    remoteNodes = [
      remoteSyncJob({
        name: 'Old name',
        updatedAt: '2026-10-01T10:00:00Z',
      }),
    ]

    await syncSchedulesToBackend(
      [
        localSyncJob({
          name: 'New name',
          updatedAt: '2026-10-04T12:00:00Z',
          lastRunAt: '2026-10-03T09:00:00Z',
        }),
      ],
      'user-1',
    )

    expect(values.has('local:scheduledJobs')).toBe(false)
    const mutations = syncMutations()
    expect(mutations.length).toBe(1)
    expect(mutations[0].doc).toBe(syncDocuments.update)
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

  it('creates a local job that is missing remotely', async () => {
    remoteNodes = []

    await syncSchedulesToBackend(
      [localSyncJob({ lastRunAt: '2026-10-02T09:00:00Z' })],
      'user-1',
    )

    const mutations = syncMutations()
    expect(mutations.length).toBe(1)
    expect(mutations[0].doc).toBe(syncDocuments.create)
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

  it('does not push when the remote copy is at least as new', async () => {
    remoteNodes = [
      remoteSyncJob({
        name: 'Renamed remotely',
        updatedAt: '2026-10-02T10:00:00Z',
      }),
    ]

    await syncSchedulesToBackend(
      [localSyncJob({ name: 'Renamed locally' })],
      'user-1',
    )

    expect(syncMutations().length).toBe(0)
    expect(values.has('local:scheduledJobs')).toBe(false)
  })

  it('captures a failed create with sentry and returns normally', async () => {
    failingDocs.add(syncDocuments.create)

    await syncSchedulesToBackend([localSyncJob()], 'user-1')

    expect(sentryCalls.length).toBe(1)
    expect(sentryCalls[0].error).toBeInstanceOf(Error)
    expect(sentryCalls[0].hint).toEqual({
      extra: { jobId: 'job-1', jobName: 'Morning digest' },
    })
  })
})

/*
 * The scheduledJobRuns entrypoint contract (gHashTag/trios#1567) -
 * appended here for the same one-process reason as the sync contract
 * above: the entrypoint imports the store, and a standalone suite in
 * the same group would race the readdir file order again (measured
 * across OSes in trios#1571). The block reuses this file's seams: the
 * store items through the values map, the createAlarmFromJob
 * recording fake, and the chrome surface above (alarms.get plus the
 * alarm/startup/installed listener capture). The messaging seam is
 * re-registered as a recording stand-in that still carries both
 * exports (the file's own store instance keeps its earlier binding),
 * so the entrypoint's onScheduleMessage handlers can be invoked.
 * getChatServerResponse is a programmable recording fake - its real
 * chain never materializes in this job. crypto.randomUUID and Date
 * stay real, so run ids and timestamps are asserted by shape, not by
 * value.
 */

type ChatCall = {
  message: string
  providerId: string | undefined
  signal: AbortSignal
}

let scheduleHandlers = new Map<
  string,
  (message: { data: Record<string, unknown> }) => Promise<unknown>
>()
let chatCalls: ChatCall[] = []
let chatBehavior: 'respond' | 'throw' | 'hang' = 'respond'
let chatResponse: Record<string, unknown> = {}

mock.module('@/lib/messaging/schedules/scheduleMessages', () => ({
  onScheduleMessage: (
    type: string,
    handler: (message: { data: Record<string, unknown> }) => Promise<unknown>,
  ) => {
    scheduleHandlers.set(type, handler)
    return () => scheduleHandlers.delete(type)
  },
  sendScheduleMessage: async () => ({}),
}))

mock.module('@/lib/schedules/getChatServerResponse', () => ({
  getChatServerResponse: async (request: {
    message: string
    providerId?: string
    signal: AbortSignal
  }) => {
    chatCalls.push({
      message: request.message,
      providerId: request.providerId,
      signal: request.signal,
    })
    if (chatBehavior === 'throw') throw new Error('boom from the server')
    if (chatBehavior === 'hang') {
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })
    }
    return { ...chatResponse }
  },
}))

const runsSpecifier: string =
  '../../entrypoints/background/scheduledJobRuns.ts?zcode-real-runs'
const { scheduledJobRuns } = (await import(
  runsSpecifier
)) as typeof import('../../entrypoints/background/scheduledJobRuns')

type StoredRun = {
  id: string
  jobId: string
  startedAt: string
  status: string
  completedAt?: string
  result?: string
  error?: string
  finalResult?: unknown
  executionLog?: unknown
  toolCalls?: unknown
}

const runsJob = (overrides: Partial<ScheduledJob> = {}): ScheduledJob => ({
  id: 'job-1',
  name: 'Morning digest',
  query: 'summarize the news',
  scheduleType: 'hourly',
  scheduleTime: '09:00',
  scheduleInterval: 1,
  enabled: true,
  providerId: 'prov-1',
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-02T10:00:00Z',
  ...overrides,
})

const storedRuns = (): StoredRun[] =>
  (values.get('local:scheduledJobRuns') as StoredRun[]) ?? []

const storedJobsList = (): ScheduledJob[] =>
  (values.get('local:scheduledJobs') as ScheduledJob[]) ?? []

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60 * 1000).toISOString()

describe('scheduledJobRuns', () => {
  beforeEach(() => {
    alarmClears = []
    alarmCreates = []
    alarmGets = []
    existingAlarms = {}
    alarmHandlers = []
    startupHandlers = []
    installedHandlers = []
    scheduleHandlers = new Map()
    chatCalls = []
    chatBehavior = 'respond'
    chatResponse = {
      text: 'ok text',
      finalResult: 'final answer',
      executionLog: ['step 1'],
      toolCalls: [{ name: 'search' }],
    }
    values.delete('local:scheduledJobs')
    values.delete('local:scheduledJobRuns')
  })

  it('registers every listener when the entrypoint runs', async () => {
    await scheduledJobRuns()

    expect(alarmHandlers.length).toBe(1)
    expect(startupHandlers.length).toBe(1)
    expect(installedHandlers.length).toBe(1)
    expect([...scheduleHandlers.keys()].sort()).toEqual([
      'cancelScheduledJobRun',
      'runScheduledJob',
    ])
  })

  it('ignores alarms that are not scheduled-job alarms', async () => {
    await scheduledJobRuns()
    await alarmHandlers[0]?.({ name: 'some-other-alarm' })

    expect(chatCalls.length).toBe(0)
    expect(storedRuns()).toEqual([])
  })

  it('executes the job behind a scheduled-job alarm and records the completed run', async () => {
    values.set('local:scheduledJobs', [
      runsJob({ id: 'job-1', query: 'plan my day' }),
    ])
    await scheduledJobRuns()
    await alarmHandlers[0]?.({ name: 'scheduled-job-job-1' })

    expect(chatCalls.length).toBe(1)
    expect(chatCalls[0].message).toBe('plan my day')
    expect(chatCalls[0].providerId).toBe('prov-1')
    expect(chatCalls[0].signal).toBeInstanceOf(AbortSignal)

    const runs = storedRuns()
    expect(runs.length).toBe(1)
    expect(runs[0].jobId).toBe('job-1')
    expect(runs[0].status).toBe('completed')
    expect(runs[0].result).toBe('ok text')
    expect(runs[0].finalResult).toBe('final answer')
    expect(runs[0].executionLog).toEqual(['step 1'])
    expect(runs[0].toolCalls).toEqual([{ name: 'search' }])
    expect(runs[0].completedAt).toBeDefined()

    const jobs = storedJobsList()
    expect(jobs[0].lastRunAt).toBeDefined()
  })

  it('records a failed run when the chat server errors', async () => {
    values.set('local:scheduledJobs', [runsJob()])
    chatBehavior = 'throw'
    await scheduledJobRuns()
    await alarmHandlers[0]?.({ name: 'scheduled-job-job-1' })

    const runs = storedRuns()
    expect(runs.length).toBe(1)
    expect(runs[0].status).toBe('failed')
    expect(runs[0].result).toBe('boom from the server')
    expect(runs[0].error).toBe('boom from the server')
  })

  it('keeps at most fifteen runs per job and never touches other jobs runs', async () => {
    const mine: StoredRun[] = Array.from({ length: 15 }, (_, i) => ({
      id: `old-run-${i}`,
      jobId: 'job-1',
      startedAt: minutesAgo(60 + i),
      status: 'completed',
    }))
    const theirs: StoredRun[] = [
      {
        id: 'other-run-0',
        jobId: 'job-2',
        startedAt: minutesAgo(90),
        status: 'completed',
      },
      {
        id: 'other-run-1',
        jobId: 'job-2',
        startedAt: minutesAgo(80),
        status: 'completed',
      },
    ]
    values.set('local:scheduledJobRuns', [...mine, ...theirs])
    values.set('local:scheduledJobs', [runsJob()])
    await scheduledJobRuns()
    await alarmHandlers[0]?.({ name: 'scheduled-job-job-1' })

    const runs = storedRuns()
    const mineAfter = runs.filter((r) => r.jobId === 'job-1')
    const theirsAfter = runs.filter((r) => r.jobId === 'job-2')
    expect(mineAfter.length).toBe(15)
    expect(mineAfter.filter((r) => !r.id.startsWith('old-run-')).length).toBe(1)
    expect(mineAfter.filter((r) => r.id.startsWith('old-run-')).length).toBe(14)
    expect(theirsAfter.map((r) => r.id)).toEqual(['other-run-0', 'other-run-1'])
  })

  it('marks stale running runs as timed out on startup and keeps fresh ones', async () => {
    values.set('local:scheduledJobRuns', [
      {
        id: 'stale-run',
        jobId: 'job-1',
        startedAt: minutesAgo(11),
        status: 'running',
      },
      {
        id: 'fresh-run',
        jobId: 'job-1',
        startedAt: minutesAgo(5),
        status: 'running',
      },
      {
        id: 'done-run',
        jobId: 'job-1',
        startedAt: minutesAgo(30),
        status: 'completed',
      },
    ])
    await scheduledJobRuns()
    await startupHandlers[0]?.()

    const byId = new Map(storedRuns().map((r) => [r.id, r]))
    expect(byId.get('stale-run')?.status).toBe('failed')
    expect(byId.get('stale-run')?.result).toBe('Job timed out!')
    expect(byId.get('stale-run')?.completedAt).toBeDefined()
    expect(byId.get('fresh-run')?.status).toBe('running')
    expect(byId.get('done-run')?.status).toBe('completed')
  })

  it('rewires alarms for enabled jobs without one on startup', async () => {
    values.set('local:scheduledJobs', [
      runsJob({ id: 'job-1' }),
      runsJob({ id: 'job-2', enabled: false }),
    ])
    values.set('local:scheduledJobRuns', [
      {
        id: 'recent',
        jobId: 'job-1',
        startedAt: minutesAgo(30),
        status: 'completed',
      },
    ])
    await scheduledJobRuns()
    await startupHandlers[0]?.()

    expect(alarmGets).toEqual(['scheduled-job-job-1'])
    expect(alarmCreates.length).toBe(1)
    expect((alarmCreates[0] as { id?: string }).id).toBe('job-1')
    expect(chatCalls.length).toBe(0)
  })

  it('runs the missed hourly job whose interval has elapsed', async () => {
    values.set('local:scheduledJobs', [runsJob({ createdAt: minutesAgo(125) })])
    await scheduledJobRuns()
    await startupHandlers[0]?.()

    expect(chatCalls.length).toBe(1)
    expect(storedRuns().length).toBe(1)
    expect(storedRuns()[0].status).toBe('completed')
  })

  it('skips the missed hourly job younger than one interval', async () => {
    values.set('local:scheduledJobs', [runsJob({ createdAt: minutesAgo(30) })])
    await scheduledJobRuns()
    await startupHandlers[0]?.()

    expect(chatCalls.length).toBe(0)
    expect(storedRuns()).toEqual([])
  })

  it('skips the missed job that already ran within the last twenty-four hours', async () => {
    values.set('local:scheduledJobs', [runsJob({ createdAt: minutesAgo(125) })])
    values.set('local:scheduledJobRuns', [
      {
        id: 'recent-done',
        jobId: 'job-1',
        startedAt: minutesAgo(30),
        status: 'completed',
      },
    ])
    await scheduledJobRuns()
    await startupHandlers[0]?.()

    expect(chatCalls.length).toBe(0)
  })

  it('cancels an in-flight run by run id and reports unknown ids', async () => {
    values.set('local:scheduledJobs', [runsJob()])
    chatBehavior = 'hang'
    await scheduledJobRuns()

    const running = scheduleHandlers.get('runScheduledJob')
    const started = running?.({ data: { jobId: 'job-1' } })
    let runId: string | undefined
    for (let i = 0; i < 100 && !runId; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      runId = storedRuns().find((r) => r.status === 'running')?.id
    }
    expect(runId).toBeDefined()

    const cancel = scheduleHandlers.get('cancelScheduledJobRun')
    const cancelled = await cancel?.({ data: { runId } })
    expect(cancelled).toEqual({ success: true })
    expect(await started).toEqual({ success: true })

    const failed = storedRuns().find((r) => r.id === runId)
    expect(failed?.status).toBe('failed')
    expect(failed?.result).toBe('Cancelled by user')
    expect(failed?.error).toBe('Cancelled by user')

    const unknown = await cancel?.({ data: { runId: 'no-such-run' } })
    expect(unknown).toEqual({
      success: false,
      error: 'Run not found or already completed',
    })

    const missingJob = await running?.({ data: { jobId: 'no-such-job' } })
    expect(missingJob).toEqual({
      success: false,
      error: 'Job not found: no-such-job',
    })
  })
})

// ---------------------------------------------------------------------------
// The scheduled task results list (gHashTag/trios#1634), appended to this
// file by the readdir rule: its subject imports this suite's subject (the
// store, through the two hooks), and a standalone suite in the same group
// would race the file order (measured across OSes in trios#1571). The
// real hooks answer empty arrays in a static render - they populate
// through effects a static render never runs - and a store mock
// registered here cannot replace the module this file already
// materialized for its own contract (measured: the first draft of this
// block registered data-answering hook stand-ins and the subject still
// answered the empty state, because the plain path was already linked
// real). So what is pinned is what is statically reachable - the empty
// answer - plus the list's ordering and gating semantics as source
// checks, the pattern this repository's own calibration suite uses for
// behavior no static render can reach.

// A source file with its comments removed - the calibration suite's rule:
// a shape check must ask the code, never the prose around it.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const resultsCode = () =>
  fs
    .readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../entrypoints/app/scheduled-tasks/ScheduledTaskResults.tsx',
      ),
      'utf8',
    )
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')

const { ScheduledTaskResults } = (await import(
  '../../entrypoints/app/scheduled-tasks/ScheduledTaskResults'
)) as typeof import('../../entrypoints/app/scheduled-tasks/ScheduledTaskResults')

const resultsMarkup = () =>
  renderToStaticMarkup(
    createElement(ScheduledTaskResults, {
      onViewRun: () => {},
      onCancelRun: () => {},
      onRetryRun: () => {},
    }),
  )

describe('scheduledTaskResultsContract', () => {
  it('answers the empty state when no run has been recorded', () => {
    const m = resultsMarkup()
    expect(m).toContain('No task runs yet')
    expect(m).toContain('lucide-calendar')
    expect(m).not.toContain('aria-label="Cancel run"')
    expect(m).not.toContain('aria-label="Retry run"')
  })

  it('orders the list with the running runs before the finished ones, newest first', () => {
    const src = resultsCode()
    const concat = src.match(
      /return \[\.\.\.running, \.\.\.completedOrFailed\]/,
    )
    if (!concat)
      throw new Error(
        'the running runs must be concatenated before the finished ones',
      )
    if (
      !/new Date\(b\.startedAt\)\.getTime\(\) - new Date\(a\.startedAt\)\.getTime\(\)/.test(
        src,
      )
    ) {
      throw new Error('the finished runs must be sorted newest first')
    }
    if (!/r\.status === 'running'/.test(src)) {
      throw new Error('the running partition must keep the running runs')
    }
  })

  it('gates the cancel control on the running status and the retry control on the failed one', () => {
    const src = resultsCode()
    const cancel = src.match(/\{run\.status === 'running' && \(/)
    const retry = src.match(/\{run\.status === 'failed' && \(/)
    if (!cancel)
      throw new Error('the cancel control must be gated on the running status')
    if (!retry)
      throw new Error('the retry control must be gated on the failed status')
  })

  it('dispatches the status icons through the measured set', () => {
    const src = resultsCode()
    for (const [status, icon] of [
      ['completed', 'CheckCircle2'],
      ['running', 'Loader2'],
      ['failed', 'XCircle'],
    ]) {
      const re = new RegExp(`case '${status}':\\s*\\n\\s*return <${icon} `)
      if (!re.test(src)) throw new Error(`the ${status} icon must stay ${icon}`)
    }
  })
})

// ---------------------------------------------------------------------------
// The newtab scheduled results panel (gHashTag/trios#1580), appended to
// this file by the same readdir rule as the block above: its subject
// imports this suite's subject (the store, through useScheduledJobRuns
// and useScheduledJobs), and the two hooks answer empty arrays in a
// static render - they populate through effects a static render never
// runs - while a store mock registered anywhere cannot replace the
// module this file already materialized real (measured in trios#1634).
// So what is pinned is what is statically reachable - the panel stays
// entirely away while no run has loaded - plus the list's ordering,
// cap, gating, header and dialog wiring as source checks, the pattern
// the block above uses for behavior no static render can reach.
//
// The subject reads the collapsed flag from localStorage inside its
// first useState initializer, and this group has no localStorage at
// all (measured: the bun-test globals leave it undefined) - so the
// render helper below lends the panel a not-collapsed flag for the
// duration of one render and takes it back.

const resultsPanelCode = () =>
  fs
    .readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../entrypoints/newtab/index/ScheduleResults.tsx',
      ),
      'utf8',
    )
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')

const { ScheduleResults } = (await import(
  '../../entrypoints/newtab/index/ScheduleResults'
)) as typeof import('../../entrypoints/newtab/index/ScheduleResults')

const scheduleResultsMarkup = () => {
  const had = 'localStorage' in globalThis
  const previous = Reflect.get(globalThis, 'localStorage')
  Reflect.set(globalThis, 'localStorage', {
    getItem: () => null,
    setItem: () => {},
  })
  try {
    return renderToStaticMarkup(createElement(ScheduleResults))
  } finally {
    if (had) Reflect.set(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
}

describe('scheduleResultsContract', () => {
  it('stays entirely away while the store has loaded no run', () => {
    expect(scheduleResultsMarkup()).toBe('')
  })

  it('orders the list with the running runs before the finished ones, newest first, and caps the display at three', () => {
    const src = resultsPanelCode()
    const concat = src.match(
      /return \[\.\.\.runningJobs, \.\.\.completedOrFailed\]/,
    )
    if (!concat)
      throw new Error(
        'the running runs must be concatenated before the finished ones',
      )
    if (
      !/new Date\(b\.startedAt\)\.getTime\(\) - new Date\(a\.startedAt\)\.getTime\(\)/.test(
        src,
      )
    ) {
      throw new Error('the finished runs must be sorted newest first')
    }
    if (!/if \(runningJobs\.length >= MAX_DISPLAY_COUNT\) \{/.test(src)) {
      throw new Error('a full running set must stand alone')
    }
    if (!/const MAX_DISPLAY_COUNT = 3/.test(src)) {
      throw new Error('the display cap must stay three')
    }
  })

  it('gates the cancel control on the running status and the retry control on the failed one, each behind its aria-label', () => {
    const src = resultsPanelCode()
    if (!/\{run\.status === 'running' && \(/.test(src))
      throw new Error('the cancel control must be gated on the running status')
    if (!/\{run\.status === 'failed' && \(/.test(src))
      throw new Error('the retry control must be gated on the failed status')
    if (!/aria-label="Cancel run"/.test(src))
      throw new Error('the cancel control must keep its aria-label')
    if (!/aria-label="Retry run"/.test(src))
      throw new Error('the retry control must keep its aria-label')
  })

  it('dispatches the status icons through the measured set', () => {
    const src = resultsPanelCode()
    for (const [status, icon] of [
      ['completed', 'CheckCircle2'],
      ['running', 'Loader2'],
      ['failed', 'XCircle'],
    ]) {
      const re = new RegExp(`case '${status}':\\s*\\n\\s*return <${icon} `)
      if (!re.test(src)) throw new Error(`the ${status} icon must stay ${icon}`)
    }
  })

  it('carries the header title, the running badge and the view-more anchor, opens by default, and wires the run result dialog', () => {
    const src = resultsPanelCode()
    if (!/Scheduled Task Outputs/.test(src))
      throw new Error('the header must keep its title')
    if (!/\{runningCount\} running/.test(src))
      throw new Error('the running badge must keep its count')
    if (!/href="\/app\.html#\/scheduled"/.test(src))
      throw new Error('the view-more anchor must keep its destination')
    if (!/View more/.test(src))
      throw new Error('the view-more anchor must keep its label')
    if (
      !/SCHEDULE_RESULTS_COLLAPSED_KEY = 'schedule-results-collapsed'/.test(src)
    )
      throw new Error('the collapsed flag must keep its key')
    if (!/stored !== 'true'/.test(src))
      throw new Error('the panel must open when the flag is unset')
    if (!/run=\{viewingRun\}/.test(src))
      throw new Error('the dialog must take the viewed run')
    if (!/onCancelRun=\{handleCancelRun\}/.test(src))
      throw new Error('the dialog must take the cancel handler')
    if (!/onRetryRun=\{handleRetryRun\}/.test(src))
      throw new Error('the dialog must take the retry handler')
  })
})

// ---------------------------------------------------------------------------
// The scheduled task card (gHashTag/trios#1550), appended to this file by
// the same readdir rule as the two blocks above: its subject imports this
// suite's subject (the store, through useScheduledJobRuns), whose module
// this file already materialized real behind its own stand-ins - a
// standalone suite in the subject's group would link the store fresh and
// trip the generated-graphql document the local run does not carry. The
// real hook answers an empty run list in a static render - it populates
// through effects a static render never runs - so the run history stays
// away and what is pinned is the card frame the static mount answers,
// plus the run-history rows, their gating and the switch label as source
// checks, the pattern the blocks above use.

const taskCardCode = () =>
  fs
    .readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../entrypoints/app/scheduled-tasks/ScheduledTaskCard.tsx',
      ),
      'utf8',
    )
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')

const { ScheduledTaskCard } = (await import(
  '../../entrypoints/app/scheduled-tasks/ScheduledTaskCard'
)) as typeof import('../../entrypoints/app/scheduled-tasks/ScheduledTaskCard')

const taskCardHandlers = {
  onEdit: () => {},
  onDelete: () => {},
  onToggle: () => {},
  onRun: () => {},
  onViewRun: () => {},
  onCancelRun: () => {},
  onRetryRun: () => {},
}

const taskCardMarkup = (over: Partial<ScheduledJob>) =>
  renderToStaticMarkup(
    createElement(ScheduledTaskCard, {
      job: {
        id: 'job-1',
        name: 'Morning brief',
        query: 'Morning news digest',
        scheduleType: 'daily',
        scheduleTime: '09:00',
        enabled: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        ...over,
      },
      ...taskCardHandlers,
    }),
  )

describe('scheduledTaskCardContract', () => {
  it('answers the enabled daily card: the switch on with its Disable label, the name and quoted query, the daily schedule line, the Test and Edit buttons and the delete behind its label, and keeps the Disabled badge, the provider bullet and the run history away', () => {
    const card = taskCardMarkup({})
    expect(card).toContain('role="switch"')
    expect(card).toContain('aria-checked="true"')
    expect(card).toContain('aria-label="Disable Morning brief"')
    expect(card).toContain('Morning brief')
    expect(card).toContain('Morning news digest')
    expect(card).toContain('Daily at 09:00')
    expect(card).toContain('>Test<')
    expect(card).toContain('>Edit<')
    expect(card).toContain('aria-label="Delete Morning brief"')
    expect(card).toContain('lucide-play')
    expect(card).toContain('lucide-pencil')
    expect(card).toContain('lucide-trash-2')
    expect(card).not.toContain('>Disabled<')
    expect(card).not.toContain('•')
    expect(card).not.toContain('Run History')
  })

  it('answers the disabled hourly card: the switch off with its Enable label, the Disabled badge, the every-two-hours schedule line and the last-run line in relative words', () => {
    const card = taskCardMarkup({
      name: 'Night brief',
      enabled: false,
      scheduleType: 'hourly',
      scheduleTime: undefined,
      scheduleInterval: 2,
      lastRunAt: '2020-01-01T00:00:00Z',
    })
    expect(card).toContain('aria-checked="false"')
    expect(card).toContain('aria-label="Enable Night brief"')
    expect(card).toContain('>Disabled<')
    expect(card).toContain('Every 2 hours')
    expect(card).toContain('Last run:')
    expect(card).toContain('years ago')
  })

  it('answers the schedule fallbacks: the single-minute interval and the unset time', () => {
    expect(
      taskCardMarkup({
        scheduleType: 'minutes',
        scheduleTime: undefined,
        scheduleInterval: 1,
      }),
    ).toContain('Every minute')
    expect(taskCardMarkup({ scheduleTime: undefined })).toContain(
      'Not scheduled',
    )
  })

  it('gates the run history rows on the measured statuses behind their icons and labels, keeps the View row action and the switch label on the enabled flag', () => {
    const src = taskCardCode()
    if (!/Run History \(\{runs\.length\}\)/.test(src))
      throw new Error('the run history must keep its counted title')
    if (!/run\.status === 'completed' \? \(/.test(src))
      throw new Error('the completed runs must keep their icon branch')
    if (!/run\.status === 'failed' \? \(/.test(src))
      throw new Error('the failed runs must keep their icon branch')
    if (!/<Loader2 /.test(src))
      throw new Error('the running runs must keep the spinner icon')
    if (!/\{run\.status === 'running' && \(/.test(src))
      throw new Error('the cancel control must be gated on the running status')
    if (!/aria-label="Cancel run"/.test(src))
      throw new Error('the cancel control must keep its aria-label')
    if (!/\{run\.status === 'failed' && \(/.test(src))
      throw new Error('the retry control must be gated on the failed status')
    if (!/aria-label="Retry run"/.test(src))
      throw new Error('the retry control must keep its aria-label')
    if (!/\n\s+View\n/.test(src))
      throw new Error('every run row must keep its View action')
    if (!/aria-label=\{`Delete \$\{job\.name\}`\}/.test(src))
      throw new Error('the delete control must keep its name label')
    if (
      !/aria-label=\{`\$\{job\.enabled \? 'Disable' : 'Enable'\} \$\{job\.name\}`\}/.test(
        src,
      )
    )
      throw new Error('the switch label must keep its enabled-branch naming')
  })
})
