/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The tab picker popover, held against its contract
 * (gHashTag/trios#1535): the one export of
 * components/elements/tab-picker-popover.tsx - TabPickerPopover -
 * pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * The picker reads the browser's tab list through useAvailableTabs,
 * so that seam is stubbed with a full stand-in: every field the
 * picker destructures (the filtered tabs, the whole list and the
 * loading flag), the chrome query never running in its effect. The
 * command kit stays real. Measured, the static render goes through
 * both variants the export dispatches on: the mention variant
 * renders nothing while closed and the tab list with its search box
 * and the empty note while open; the selector variant renders its
 * trigger with the children handed to it.
 *
 * Not pinned, and why (issue User Story 2): the picking flow itself
 * - the keyboard navigation, the tab toggling, the scroll into view
 * - they live in handlers and effects that need a live document and
 * window. The port env seam is seeded before any import can reach
 * the env module (its one-time snapshot - the trap the
 * agent-outputs suite documented), with the subject imported
 * dynamically for that reason.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// biome-ignore lint/style/noProcessEnv: the env seam is the only way to reach the port helpers before the env module's one-time snapshot freezes (see suite header)
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'

// Radix portals never flush through a static render, so the popover
// kit is stubbed with a portal-free stand-in - every value export the
// module carries, the content rendering its children inline and the
// root honouring the open flag - which keeps closed pickers hidden
// for every other suite of this group, exactly as the real one
// behaves outside a live document.
const passthrough = (props: { children?: React.ReactNode }) =>
  props.children ?? null

// The stand-in keeps the real kit's contract for the pieces the
// picker reads: the trigger always renders, the content only while
// open - the flag passed down through a closure the factories of
// one render share.
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
  PopoverTrigger: passthrough,
}))

mock.module('./use-available-tabs', () => ({
  useAvailableTabs: () => ({
    tabs: [
      { id: 1, title: 'Docs', url: 'https://docs.example.com' },
      { id: 2, title: 'Mail', url: 'https://mail.example.com' },
    ],
    allTabs: [
      { id: 1, title: 'Docs', url: 'https://docs.example.com' },
      { id: 2, title: 'Mail', url: 'mail.example.com' },
    ],
    isLoading: false,
  }),
}))

const { TabPickerPopover } = await import('./tab-picker-popover')

const mentionMarkup = (isOpen: boolean, filterText = '') =>
  renderToStaticMarkup(
    createElement(TabPickerPopover, {
      variant: 'mention' as const,
      isOpen,
      filterText,
      selectedTabs: [],
      onToggleTab: () => {},
      onClose: () => {},
      anchorRef: {
        current: null,
      } as unknown as React.RefObject<HTMLElement | null>,
    }),
  )

describe('tabPickerPopoverTsxContract', () => {
  describe('TabPickerPopover', () => {
    it('answers both variants: the mention picker renders nothing while closed, and while open answers the tab list with its header, the filter hint and the tab titles; the selector variant renders its trigger with the children handed in', () => {
      const closed = mentionMarkup(false)
      expect(closed).toBe('')

      const open = mentionMarkup(true)
      expect(open).toContain('Attach Tabs')
      expect(open).toContain('Type to filter')
      expect(open).toContain('Docs')
      expect(open).toContain('https://docs.example.com')
      expect(open).toContain('Mail')

      const selector = renderToStaticMarkup(
        createElement(
          TabPickerPopover,
          {
            variant: 'selector' as const,
            selectedTabs: [],
            onToggleTab: () => {},
          },
          'TRIGGER-CONTENT',
        ),
      )
      expect(selector).toContain('TRIGGER-CONTENT')
    })
  })
})
