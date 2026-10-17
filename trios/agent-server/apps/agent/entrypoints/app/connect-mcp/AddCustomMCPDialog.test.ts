/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The add-custom-MCP dialog, held against its contract
 * (gHashTag/trios#1607): the single export of
 * entrypoints/app/connect-mcp/AddCustomMCPDialog.tsx -
 * AddCustomMCPDialog - pinned as it behaves today, so the next change
 * to that file has something to fail against.
 *
 * The dialog is controlled, so a static render reaches both answers
 * through the group's stand-in dialog shape. The form starts empty and
 * its zod validation answers only on submit (which a static render
 * never fires). Pinned: the closed answer (nothing); the header; all
 * three field frames (the name with its placeholder, the URL with its
 * placeholder, the HTTP-only note and the url input type, the optional
 * description textarea); the uncontrolled How-do-I-find collapsible
 * (its trigger with the bulb and the chevron - the content renders
 * only when the user opens it, measured: absent here); and the footer
 * (Cancel, Add Server). Not pinned: the submit flow, the zod messages,
 * the reset and the clicks.
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

const { AddCustomMCPDialog } = await import('./AddCustomMCPDialog')

const markup = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(
      AddCustomMCPDialog as never,
      {
        open: true,
        onOpenChange: () => {},
        onAddServer: () => {},
        ...over,
      } as never,
    ),
  )

describe('addCustomMcpDialogContract', () => {
  it('answers the closed dialog with nothing', () => {
    expect(markup({ open: false })).toBe('')
  })

  it('answers the header with its title and description', () => {
    const m = markup()
    expect(m).toContain('Add Custom App')
    expect(m).toContain('Configure your custom app connection')
  })

  it('answers all three field frames with their measured inputs', () => {
    const m = markup()
    expect(m).toContain('Server Name')
    expect(m).toContain('placeholder="My Custom App"')
    expect(m).toContain('MCP Server URL')
    expect(m).toContain('(only supports HTTP)')
    expect(m).toContain('type="url"')
    expect(m).toContain('placeholder="http://mcp.example.com"')
    expect(m).toContain('Description (Optional)')
    expect(m).toContain('placeholder="Describe what this server does..."')
  })

  it('answers the how-to collapsible trigger, its content only on open', () => {
    const m = markup()
    expect(m).toContain('How do I find the URL?')
    expect(m).toContain('lucide-lightbulb')
    expect(m).toContain('lucide-chevron-right')
    // The collapsible is uncontrolled with no defaultOpen - Radix answers
    // its content only when the user opens it (measured: absent here).
    expect(m).not.toContain('Notion')
  })

  it('answers the footer with Cancel and Add Server', () => {
    const m = markup()
    expect(m).toContain('Cancel')
    expect(m).toContain('Add Server')
  })
})
