/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The admin dashboard page, held against its contract
 * (gHashTag/trios#1594): the single export of
 * entrypoints/app/admin-dashboard/AdminDashboardPage.tsx -
 * AdminDashboardPage - pinned as it behaves today, so the next change
 * to that file has something to fail against.
 *
 * The history hook answers its initial empty map (it populates through
 * effects a static render never runs), so the page's static answer is
 * the EMPTY dashboard - which is most of its visible surface: the
 * header and approvals slots (stubbed with named markers - their own
 * suites own their contracts), the Approvals and Audit Trail section
 * titles, the empty-state card with its shield icon and note, and the
 * delete AlertDialog in its controlled-closed shape (its title,
 * description and buttons render inside the group's stand-in shape,
 * with the task name empty because no task is pending deletion).
 * The storage seam is the repository's in-memory item shim (the real
 * @wxt-dev/storage refuses the test process; the store suites assert
 * only on their own maps). Not pinned: the populated audit trail (it
 * rides the effect-populated hook), the delete flow and the toasts.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement, type FC, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const passChildren =
  (): FC<{ children?: ReactNode }> =>
  ({ children }) =>
    createElement('div', null, children)

// The generated graphql tag is never generated in the Tests jobs; the
// ScheduledTasks suite's graph reaches it, and in the CI readdir order
// this file's registrations come first - the stub keeps that import
// alive for whoever links it after us.
mock.module('@/generated/graphql/gql', () => ({
  graphql: (query: string) => ({ query }),
}))

mock.module('@wxt-dev/storage', () => ({
  storage: {
    defineItem: (
      key: string,
      options?: { fallback?: unknown } & Record<string, unknown>,
    ) => ({
      getValue: async () => {
        if (key === 'local:tool-approval-config') {
          return { categories: {} }
        }
        return options && 'fallback' in options ? options.fallback : null
      },
      setValue: async () => {},
      watch: () => () => {},
    }),
  },
}))
mock.module('@/lib/execution-history/storage', () => ({
  removeConversationExecutionTask: async () => {},
  useExecutionHistoryByConversation: () => ({}),
}))
mock.module('@/components/ui/alert-dialog', () => {
  const pass = passChildren()
  return {
    // The root honours the open flag exactly like the group's dialog
    // stand-ins: a CLOSED alert renders nothing. The first push of this
    // PR passed children through unconditionally and broke the sibling
    // Skills and ScheduledTasks suites in the CI readdir order - their
    // contracts pin their closed alerts as empty (measured in the CI
    // log of the first push).
    AlertDialog: ({
      open,
      children,
    }: {
      open?: boolean
      children?: ReactNode
    }) => (open ? children : null),
    AlertDialogAction: pass,
    AlertDialogCancel: pass,
    AlertDialogContent: pass,
    AlertDialogDescription: pass,
    AlertDialogFooter: pass,
    AlertDialogHeader: pass,
    AlertDialogTitle: pass,
    AlertDialogTrigger: pass,
  }
})
mock.module('./AdminDashboardHeader', () => ({
  AdminDashboardHeader: () =>
    createElement('div', { 'data-testid': 'admin-header' }),
}))
mock.module('./PendingApprovals', () => ({
  PendingApprovals: () =>
    createElement('div', { 'data-testid': 'pending-approvals' }),
}))

const { AdminDashboardPage } = await import('./AdminDashboardPage')

const markup = () => renderToStaticMarkup(createElement(AdminDashboardPage))

describe('adminDashboardPageContract', () => {
  it('answers its header and approvals slots', () => {
    const m = markup()
    expect(m).toContain('data-testid="admin-header"')
    expect(m).toContain('data-testid="pending-approvals"')
    expect(m).toContain('Approvals')
  })

  it('answers the Audit Trail section with its empty state', () => {
    const m = markup()
    expect(m).toContain('Audit Trail')
    expect(m).toContain('No agent runs yet')
    expect(m).toContain(
      'Run a task in BrowserOS and the execution history will appear here.',
    )
    expect(m).toContain('lucide-shield')
    // The run-count line renders only when a run exists; the delete
    // dialog's description carries the words "recorded run" in its
    // fixed sentence, so the count line is pinned by its own shape.
    expect(m).not.toContain('recorded runs across')
  })

  it('answers the delete dialog closed: none of its content renders', () => {
    const m = markup()
    expect(m).not.toContain('Delete Run')
    expect(m).not.toContain('from local history?')
    expect(m).not.toContain('This only clears the recorded run on this device.')
    expect(m).not.toContain('>Cancel<')
  })
})
