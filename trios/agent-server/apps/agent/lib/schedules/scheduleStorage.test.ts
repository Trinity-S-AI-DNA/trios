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

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

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
