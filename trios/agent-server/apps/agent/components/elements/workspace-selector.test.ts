/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The workspace selector, held against its contract
 * (gHashTag/trios#1597): the one export of
 * components/elements/workspace-selector.tsx - WorkspaceSelector -
 * pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * The selector reads the workspace seam, so that hook is stubbed
 * with the full six-field stand-in its destructure demands (the
 * wave's useWorkspace lesson) and the popover kit carries the
 * contract-true portal-free form of this group - the trigger always
 * renders, the content only while open, every value export of the
 * kit in place. Measured, the static render answers the trigger
 * with the children handed in, while the selector first mounts
 * closed and leaks none of its content.
 *
 * Not pinned, and why (issue User Story 2): the open picker - the
 * search box, the no-workspace entry, the recent folders with their
 * selection marks and remove buttons - sits behind an open state
 * the selector owns internally (no controlled prop), so reaching it
 * needs a click on a live document; the choose-folder flow rides
 * the adapter's path picker, and every folder action lives in
 * handlers. The subject is read through a query-qualified specifier
 * so this suite's graph loads as its own fresh instances.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('@/lib/workspace/use-workspace', () => ({
  useWorkspace: () => ({
    recentFolders: [],
    selectedFolder: null,
    selectFolder: async () => {},
    addFolder: async () => {},
    removeFolder: async () => {},
    clearSelection: async () => {},
  }),
}))

// Radix portals never flush through a static render, so the popover
// kit is stubbed with the contract-true portal-free form of this
// group - every value export the module carries, the trigger always
// rendering, the content only while open - so closed pickers stay
// hidden for every other suite, exactly as the real one behaves
// outside a live document.
let popoverOpen = false
mock.module('@/components/ui/popover', () => ({
  Popover: ({
    open,
    children,
  }: {
    open?: boolean
    children?: React.ReactNode
  }) => {
    popoverOpen = !!open
    return children ?? null
  },
  PopoverAnchor: () => null,
  PopoverContent: ({ children }: { children?: React.ReactNode }) =>
    popoverOpen ? children : null,
  PopoverTrigger: ({ children }: { children?: React.ReactNode }) =>
    children ?? null,
}))

const subjectUrl = './workspace-selector?workspace-selector-suite-real'
const { WorkspaceSelector } = (await import(
  subjectUrl
)) as typeof import('./workspace-selector')

describe('workspaceSelectorTsxContract', () => {
  describe('WorkspaceSelector', () => {
    it('answers the trigger with the children handed in, while the closed selector hides its content', () => {
      const markup = renderToStaticMarkup(
        createElement(
          WorkspaceSelector,
          { side: 'top' },
          'PICK-WORKSPACE-TRIGGER',
        ),
      )
      expect(markup).toContain('PICK-WORKSPACE-TRIGGER')
      expect(markup).not.toContain('Search folders...')
      expect(markup).not.toContain('No workspace')
    })
  })
})
