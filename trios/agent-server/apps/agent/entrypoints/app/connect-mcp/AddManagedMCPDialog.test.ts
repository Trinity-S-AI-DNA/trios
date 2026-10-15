/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The add-managed-MCP dialog, held against its contract
 * (gHashTag/trios#1627): the single export of
 * entrypoints/app/connect-mcp/AddManagedMCPDialog.tsx -
 * AddManagedMCPDialog - pinned as it behaves today, so the next change
 * to that file has something to fail against.
 *
 * The dialog is controlled, so a static render reaches both answers
 * through the group's stand-in dialog shape (the root honours the open
 * flag, everything else a passthrough). The search input starts empty
 * (its filter runs against the empty query), so the list branches are
 * pinned with their full lists; the search filtering itself needs a
 * state change a static render never runs, and is documented as not
 * pinned together with the clicks. Pinned: the closed answer; the
 * header; the Needs authentication section with its amber key affordance
 * and the per-server icon asset; the Available section (with its label
 * only when the unauthenticated section is also shown); the
 * no-results note when both lists are empty; and the search field's
 * frame.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement, type FC, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const passChildren =
  (): FC<{ children?: ReactNode }> =>
  ({ children }) =>
    createElement('div', null, children)

mock.module('@/components/ui/dialog', () => {
  const pass = passChildren()
  return {
    Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? children : null,
    DialogClose: pass,
    DialogContent: pass,
    DialogDescription: pass,
    DialogFooter: pass,
    DialogHeader: pass,
    DialogOverlay: () => null,
    DialogPortal: pass,
    DialogTitle: pass,
    DialogTrigger: pass,
  }
})

const { AddManagedMCPDialog } = await import('./AddManagedMCPDialog')

const unauthenticated = [{ name: 'Slack', description: 'Team chat' }]
const available = [
  { name: 'Notion', description: 'Docs and wikis' },
  { name: 'GitHub', description: 'Code hosting' },
]

const markup = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(
      AddManagedMCPDialog as never,
      {
        open: true,
        onOpenChange: () => {},
        unauthenticatedServers: unauthenticated,
        serversList: available,
        onAddServer: () => {},
        onAuthenticate: () => {},
        ...props,
      } as never,
    ),
  )

describe('addManagedMcpDialogContract', () => {
  it('answers the closed dialog with nothing', () => {
    const m = markup({ open: false })
    expect(m).toBe('')
  })

  it('answers the header and the search frame', () => {
    const m = markup()
    expect(m).toContain('Add built-in app')
    expect(m).toContain('Select a built-in app to connect')
    expect(m).toContain('placeholder="Search apps..."')
    expect(m).toContain('lucide-search')
  })

  it('answers the Needs authentication section with the amber key affordance', () => {
    const m = markup()
    expect(m).toContain('Needs authentication')
    expect(m).toContain('Team chat')
    expect(m).toContain('lucide-key-round')
    expect(m).toContain('mcp-icons/slack.svg')
    expect(m).toContain('text-amber-500')
  })

  it('answers the Available section, its label only beside the first section, and the plus affordance', () => {
    const m = markup()
    expect(m).toContain('Available')
    expect(m).toContain('Notion')
    expect(m).toContain('Docs and wikis')
    expect(m).toContain('GitHub')
    expect(m).toContain('lucide-plus')
    expect(m).toContain('mcp-icons/notion.svg')

    const onlyAvailable = markup({ unauthenticatedServers: [] })
    expect(onlyAvailable).toContain('Notion')
    expect(onlyAvailable).not.toContain('Available')
    expect(onlyAvailable).not.toContain('Needs authentication')
  })

  it('answers the no-results note when both lists are empty', () => {
    const m = markup({ unauthenticatedServers: [], serversList: [] })
    expect(m).toContain('No apps found')
  })
})
