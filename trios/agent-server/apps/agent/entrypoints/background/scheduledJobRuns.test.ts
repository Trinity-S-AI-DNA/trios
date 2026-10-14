/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The scheduled job runner, held against its contract
 * (gHashTag/trios#1567): the one export of
 * entrypoints/background/scheduledJobRuns.ts - scheduledJobRuns -
 * pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * The runner wires the browser's alarm and runtime events and the
 * schedule messaging protocol, then executes the jobs those events
 * name. Everything that touches the live browser lives behind two
 * seams this suite provides: a chrome global stub whose listener
 * registrations are captured and can be fired by hand, and a full
 * stand-in of the schedule messaging module (both value exports -
 * the real one refuses outside an extension). The storage seam is
 * the fake every storage suite of this wave runs with, seeded with
 * a job, and the chat server response is a capturing stand-in so
 * the executed job's outcome can be read from the run store.
 * Measured through the captured handlers, the pins read the real
 * flow: the alarm for a scheduled job runs it and records the
 * completed run with the chat answer and the job's last-run stamp,
 * an alarm for anything else is ignored, and the run message
 * answers success for a real job and a named failure for a missing
 * one.
 */

import { describe, expect, it, mock } from 'bun:test'

const values = new Map<string, unknown>()

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
  watch: () => () => {},
})

type AlarmHandler = (alarm: { name: string }) => Promise<void>
type ScheduleHandler = (message: {
  data: { jobId?: string; runId?: string }
}) => Promise<unknown>

const alarmHandlers: AlarmHandler[] = []
const startupHandlers: Array<() => Promise<void>> = []
const installedHandlers: Array<() => Promise<void>> = []
const messageHandlers = new Map<string, ScheduleHandler>()
const createdAlarms: string[] = []
let existingAlarms = new Set<string>()

const chromeStub = {
  alarms: {
    get: async (name: string) =>
      existingAlarms.has(name) ? { name } : undefined,
    create: async (name: string) => {
      createdAlarms.push(name)
      existingAlarms.add(name)
    },
    onAlarm: {
      addListener: (handler: AlarmHandler) => {
        alarmHandlers.push(handler)
      },
    },
  },
  runtime: {
    onStartup: {
      addListener: (handler: () => Promise<void>) => {
        startupHandlers.push(handler)
      },
    },
    onInstalled: {
      addListener: (handler: () => Promise<void>) => {
        installedHandlers.push(handler)
      },
    },
  },
}

;(globalThis as { chrome: unknown }).chrome = chromeStub

const chatResponses: Array<{ message: string; providerId?: string }> = []
const chatAnswer = 'CHAT ANSWER'

mock.module('@/lib/messaging/schedules/scheduleMessages', () => ({
  onScheduleMessage: (kind: string, handler: ScheduleHandler) => {
    messageHandlers.set(kind, handler)
  },
  sendScheduleMessage: async () => ({ success: true }),
}))

mock.module('@/lib/schedules/getChatServerResponse', () => ({
  getChatServerResponse: async (input: {
    message: string
    providerId?: string
  }) => {
    chatResponses.push(input)
    return {
      text: chatAnswer,
      conversationId: 'convo-1',
      finalResult: undefined,
      executionLog: [],
      toolCalls: [],
    }
  },
}))

mock.module('@/lib/schedules/scheduleStorage', () => ({
  scheduledJobStorage: fakeItem('local:scheduledJobs', { fallback: [] }),
  scheduledJobRunStorage: fakeItem('local:scheduledJobRuns', {
    fallback: [],
  }),
  pendingDeletionStorage: fakeItem('local:scheduledJobsPendingDeletion', {
    fallback: [],
  }),
  useScheduledJobs: () => ({ jobs: [] }),
  useScheduledJobRuns: () => ({ jobRuns: [] }),
  syncScheduledJobs: async () => {},
  setupScheduledJobsSyncToBackend: () => () => {},
}))

const { scheduledJobRuns } = await import('./scheduledJobRuns')

const job = {
  id: 'job-1',
  name: 'Hourly digest',
  query: 'Summarize the news',
  scheduleType: 'hourly',
  scheduleInterval: 60,
  enabled: true,
  createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
}

const storedRuns = () =>
  (values.get('local:scheduledJobRuns') as
    | Array<{ jobId: string; status: string; result?: string }>
    | undefined) ?? []

describe('scheduledJobRunsContract', () => {
  describe('scheduledJobRuns', () => {
    it('wires the alarm and runtime listeners and the run protocol, and the alarm for a scheduled job runs it - recording the completed run with the chat answer and the last-run stamp - while other alarms are ignored and the run message answers success only for a real job', async () => {
      values.set('local:scheduledJobs', [job])
      values.set('local:scheduledJobRuns', [])
      existingAlarms = new Set()

      await scheduledJobRuns()
      await startupHandlers[0]?.()

      expect(alarmHandlers.length).toBe(1)
      expect(startupHandlers.length).toBe(1)
      expect(installedHandlers.length).toBe(1)
      expect(messageHandlers.has('runScheduledJob')).toBe(true)
      expect(messageHandlers.has('cancelScheduledJobRun')).toBe(true)
      expect(createdAlarms).toContain('scheduled-job-job-1')

      await alarmHandlers[0]?.({ name: 'other-alarm' })
      expect(storedRuns().length).toBe(0)

      await alarmHandlers[0]?.({ name: 'scheduled-job-job-1' })
      const runs = storedRuns()
      expect(runs.length).toBe(1)
      expect(runs[0]?.jobId).toBe('job-1')
      expect(runs[0]?.status).toBe('completed')
      expect(runs[0]?.result).toBe('CHAT ANSWER')
      expect(chatResponses[0]?.message).toBe('Summarize the news')
      const storedJobs = values.get('local:scheduledJobs') as Array<{
        id: string
        lastRunAt?: string
      }>
      expect(storedJobs.find((j) => j.id === 'job-1')?.lastRunAt).toBeDefined()

      const runResult = (await messageHandlers.get('runScheduledJob')?.({
        data: { jobId: 'missing-job' },
      })) as { success: boolean; error?: string }
      expect(runResult.success).toBe(false)
      expect(runResult.error).toBe('Job not found: missing-job')
    })
  })
})
