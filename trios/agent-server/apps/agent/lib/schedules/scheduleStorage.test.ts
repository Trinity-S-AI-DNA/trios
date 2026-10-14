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

mock.module('@/lib/auth/sessionStorage', () => ({
  sessionStorage: {
    getValue: async () => sessionFixture,
    watch: () => () => {},
  },
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

const chromeBefore = (globalThis as { chrome?: unknown }).chrome
;(globalThis as { chrome?: unknown }).chrome = {
  alarms: {
    clear: async (name: string) => {
      alarmClears.push(name)
      return true
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
