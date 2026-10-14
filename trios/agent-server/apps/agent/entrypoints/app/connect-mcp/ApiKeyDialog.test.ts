/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The API key dialog, held against its contract
 * (gHashTag/trios#1643): the single export of
 * entrypoints/app/connect-mcp/ApiKeyDialog.tsx - ApiKeyDialog - pinned
 * as it behaves today, so the next change to that file has something to
 * fail against.
 *
 * The dialog is controlled (the parent owns open), so a static render
 * reaches both states. The Radix dialog kit is stubbed with the same
 * portal-free stand-in the NewAgentDialog and NewScheduledTaskDialog
 * suites use: the root honours the open flag, every other export is a
 * passthrough - later-linking suites re-register their own equivalent,
 * so the file order cannot matter. Not pinned: the submit itself and
 * the zod validation error (react-hook-form runs its validation on
 * submit, which a static render never fires) and the close click.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement, type FC, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const passthrough =
  (tag: string): FC<{ children?: ReactNode }> =>
  ({ children }) =>
    createElement(tag, null, children)

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? children : null,
  DialogClose: passthrough('div'),
  DialogContent: passthrough('div'),
  DialogDescription: passthrough('p'),
  DialogFooter: passthrough('div'),
  DialogHeader: passthrough('div'),
  DialogOverlay: () => null,
  DialogPortal: passthrough('div'),
  DialogTitle: passthrough('h2'),
  DialogTrigger: passthrough('div'),
}))

const subjectUrl = './ApiKeyDialog?api-key-dialog-suite-real'
const { ApiKeyDialog } = (await import(
  subjectUrl
)) as typeof import('./ApiKeyDialog')

const markup = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(
      ApiKeyDialog as never,
      {
        open: true,
        onOpenChange: () => {},
        serverName: 'Slack',
        onSubmit: () => {},
        ...props,
      } as never,
    ),
  )

describe('apiKeyDialogContract', () => {
  it('answers the closed dialog with nothing', () => {
    const m = markup({ open: false })
    expect(m).toBe('')
  })

  it('answers the open dialog with the connect header and the key field', () => {
    const m = markup({})
    expect(m).toContain('Connect Slack')
    expect(m).toContain('Enter your Slack API key to connect')
    expect(m).toContain('mcp-icons/slack.svg')
    expect(m).toContain('API Key')
    expect(m).toContain('type="password"')
    expect(m).toContain('placeholder="Paste your API key here"')
    expect(m).toContain('autoComplete="off"')
  })

  it('answers the footer with Cancel and Connect, and the submitting state', () => {
    const m = markup({})
    expect(m).toContain('Cancel')
    expect(m).toContain('Connect')
    expect(m).not.toContain('Connecting...')

    const submitting = markup({ isSubmitting: true })
    expect(submitting).toContain('Connecting...')
    expect(submitting).toContain('lucide-loader-circle')
    expect((submitting.match(/disabled=""/g) ?? []).length).toBe(2)
  })
})
