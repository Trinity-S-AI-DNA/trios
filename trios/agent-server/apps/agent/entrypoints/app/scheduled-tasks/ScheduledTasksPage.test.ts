/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The scheduled-tasks page, held against its contract
 * (gHashTag/trios#1561): the one export of
 * entrypoints/app/scheduled-tasks/ScheduledTasksPage.tsx -
 * ScheduledTasksPage - pinned as it behaves today, so the next
 * change to that file has something to fail against.
 *
 * The page composes the schedule-storage hooks (pinned by their
 * own suite of this wave) and reads the router's search params, so
 * the storage seams are stubbed with the full stand-ins their own
 * suites run with in this very process - the @wxt-dev/storage fake
 * (the chat graph the page pulls in defines its own storage items
 * at module scope, and the real module cannot initialize outside
 * a browser), the schedule-storage wrapper with its hooks, and the
 * router seam spread over the real module with useSearchParams
 * replaced (it refuses outside a Router). The generated graphql
 * module the chat graph reaches for is produced by the app's own
 * codegen step, as CI does.
 *
 * Measured, the static render shows the page as it first answers:
 * the framed page with its header, and the tab strip, the dialogs
 * and the delete alert all closed - the tab choice arrives through
 * a storage effect and the dialogs through clicks, both needing a
 * live document (the boundary the reasoning and web-preview suites
 * of this wave documented). The port env seam is seeded before any
 * import can reach the env module (its one-time snapshot - the
 * trap the agent-outputs suite documented), with the subject
 * imported dynamically for that reason.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// biome-ignore lint/style/noProcessEnv: the env seam is the only way to reach the port helpers before the env module's one-time snapshot freezes (see suite header)
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'

const defines: Array<{ key: string; opts: unknown }> = []
const values = new Map<string, unknown>()
const fakeItem = (key: string, opts: unknown) => ({
  getValue: async () =>
    values.has(key)
      ? values.get(key)
      : ((opts as { fallback?: unknown })?.fallback ?? null),
  setValue: async (v: unknown) => {
    values.set(key, v)
  },
  watch: () => () => {},
})
mock.module('@wxt-dev/storage', () => ({
  storage: {
    defineItem: (key: string, opts?: unknown) => {
      defines.push({ key, opts })
      return fakeItem(key, opts)
    },
  },
}))
mock.module('@/lib/schedules/scheduleStorage', () => ({
  scheduledJobStorage: fakeItem('a', { fallback: [] }),
  scheduledJobRunStorage: fakeItem('b', { fallback: [] }),
  pendingDeletionStorage: fakeItem('c', { fallback: [] }),
  useScheduledJobs: () => ({
    jobs: [],
    addJob: async () => {},
    removeJob: async () => {},
    editJob: async () => {},
    toggleJob: async () => {},
    runJob: async () => {},
  }),
  useScheduledJobRuns: () => ({
    jobRuns: [],
    addJobRun: async () => {},
    removeJobRun: async () => {},
    editJobRun: async () => {},
    cancelJobRun: async () => {},
  }),
  syncScheduledJobs: async () => {},
  setupScheduledJobsSyncToBackend: () => () => {},
}))
const realRouterUrl = 'react-router?tasks-page-real'
const realRouter = (await import(realRouterUrl)) as Record<string, unknown>
mock.module('react-router', () => ({
  ...realRouter,
  useSearchParams: () => [new URLSearchParams(), () => {}],
}))

const { ScheduledTasksPage } = await import('./ScheduledTasksPage')

describe('ScheduledTasksPageTsxContract', () => {
  describe('ScheduledTasksPage', () => {
    it('answers the framed page with its header, before any tab is chosen and with every dialog and the delete alert closed', () => {
      const markup = renderToStaticMarkup(createElement(ScheduledTasksPage))
      expect(markup).toContain('fade-in')
      expect(markup).toContain('Scheduled Tasks')
      expect(markup).not.toContain('data-slot="tabs-trigger"')
      expect(markup).not.toContain('Delete Scheduled Task')
    })
  })
})
