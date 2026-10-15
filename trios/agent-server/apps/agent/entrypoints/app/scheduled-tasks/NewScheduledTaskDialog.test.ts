/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The new-scheduled-task dialog, held against its contract
 * (gHashTag/trios#1503): the one export of
 * entrypoints/app/scheduled-tasks/NewScheduledTaskDialog.tsx -
 * NewScheduledTaskDialog - pinned as it behaves today, so the next
 * change to that file has something to fail against.
 *
 * The dialog loads its provider list from the LLM provider store
 * and refines prompts through the schedules refine seam, so both are
 * stubbed: the provider store with the fake storage items every
 * storage suite of this wave runs with (the store module itself is
 * spread over the real one so its value exports stay intact), and
 * the refine seam with a no-op. Measured, the static render goes
 * through the react-hook-form resolver and shows the dialog for the
 * mode it was handed: the create copy when opened fresh, the edit
 * copy when opened with initial values.
 *
 * Not pinned, and why (issue User Story 2): the form flow itself -
 * the submit validation, the prompt refinement with its undo stack,
 * the provider list loading - they live in effects and handlers
 * that need a live document and window. The port env seam is seeded
 * before any import can reach the env module (its one-time snapshot
 * - the trap the agent-outputs suite documented), with the subject
 * imported dynamically for that reason.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// biome-ignore lint/style/noProcessEnv: the env seam is the only way to reach the port helpers before the env module's one-time snapshot freezes (see suite header)
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'

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

mock.module('@wxt-dev/storage', () => ({
  storage: {
    defineItem: (key: string, opts?: unknown) => fakeItem(key, opts),
  },
}))

// The provider store module's own value exports (loader, factories,
// watchers) stay real - read through a query-qualified specifier no
// stand-in occupies - so only the two storage items the dialog
// reads are stubbed.
const realProvidersUrl = '@/lib/llm-providers/storage?task-dialog-real'
const realProvidersModule = (await import(realProvidersUrl)) as Record<
  string,
  unknown
>
mock.module('@/lib/llm-providers/storage', () => ({
  ...realProvidersModule,
  providersStorage: fakeItem('local:llm-providers', { fallback: [] }),
  defaultProviderIdStorage: fakeItem('local:default-provider-id', {
    fallback: null,
  }),
}))

mock.module('@/lib/schedules/refine-prompt', () => ({
  refinePrompt: async () => '',
}))

mock.module('@/lib/metrics/track', () => ({
  track: () => {},
}))

// Radix portals never flush through a static render, so the dialog
// kit is stubbed with a portal-free stand-in: every value export the
// module carries, each piece rendering its children inline and the
// root honouring the open flag - which keeps closed dialogs hidden
// for every other suite of this group, exactly as the real one
// behaves outside a live document.
const passthrough = (props: { children?: React.ReactNode }) =>
  props.children ?? null

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({
    open,
    children,
  }: {
    open?: boolean
    children?: React.ReactNode
  }) => (open ? children : null),
  DialogClose: passthrough,
  DialogContent: passthrough,
  DialogDescription: passthrough,
  DialogFooter: passthrough,
  DialogHeader: passthrough,
  DialogOverlay: () => null,
  DialogPortal: passthrough,
  DialogTitle: passthrough,
  DialogTrigger: passthrough,
}))

const { NewScheduledTaskDialog } = await import('./NewScheduledTaskDialog')

const markup = (open: boolean, initialValues?: unknown) =>
  renderToStaticMarkup(
    createElement(NewScheduledTaskDialog, {
      open,
      onOpenChange: () => {},
      initialValues: (initialValues ?? null) as Parameters<
        typeof NewScheduledTaskDialog
      >[0]['initialValues'],
      onSave: () => {},
    }),
  )

describe('NewScheduledTaskDialogTsxContract', () => {
  describe('NewScheduledTaskDialog', () => {
    it('answers the dialog for the mode it was handed: the create copy when opened fresh, the edit copy when opened with initial values', () => {
      const closed = markup(false)
      expect(closed).toBe('')

      const create = markup(true)
      expect(create).toContain('Create Scheduled Task')
      expect(create).toContain('Create a new task that runs automatically')

      const edit = markup(true, {
        id: 'job-1',
        name: 'Morning Briefing',
        query: 'Summarize my email',
        scheduleType: 'daily',
        scheduleTime: '09:00',
        enabled: true,
        createdAt: '',
        updatedAt: '',
      } as unknown as Parameters<
        typeof NewScheduledTaskDialog
      >[0]['initialValues'])
      expect(edit).toContain('Edit Scheduled Task')
      expect(edit).toContain('Update your scheduled task configuration.')
    })
  })
})
