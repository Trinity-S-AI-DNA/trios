/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The add-hub-provider dialog, held against its contract
 * (gHashTag/trios#1628): the single export of
 * entrypoints/app/llm-hub/AddHubProviderDialog.tsx - AddHubProviderDialog
 * - pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * The dialog is controlled and the form starts empty (the reset effect
 * never runs statically), so a static render reaches both titles with
 * their descriptions, both field frames, and the footer; the dialog kit
 * is stubbed with the group's stand-in shape. Not pinned: the submit
 * flow with its URL normalization and the zod validation errors
 * (react-hook-form validates on submit, which a static render never
 * fires), the reset effect, and the clicks.
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

const { AddHubProviderDialog } = await import('./AddHubProviderDialog')

const markup = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(
      AddHubProviderDialog as never,
      {
        open: true,
        onOpenChange: () => {},
        onSave: () => {},
        ...props,
      } as never,
    ),
  )

describe('addHubProviderDialogContract', () => {
  it('answers the closed dialog with nothing', () => {
    expect(markup({ open: false })).toBe('')
  })

  it('answers the add mode with its title, description, both fields and the Add footer', () => {
    const m = markup()
    expect(m).toContain('Add Custom Provider')
    expect(m).toContain('Add a new AI chat provider for quick access.')
    expect(m).toContain('Provider Name')
    expect(m).toContain('placeholder="e.g., DeepSeek"')
    expect(m).toContain('URL')
    expect(m).toContain('placeholder="e.g., chat.deepseek.com"')
    expect(m).toContain('The web address of the AI chat service')
    expect(m).toContain('Cancel')
    expect(m).toContain('>Add<')
    expect(m).not.toContain('>Update<')
  })

  it('answers the edit mode with its own title, description and footer', () => {
    const m = markup({
      initialValues: { name: 'DeepSeek', url: 'chat.deepseek.com' },
    })
    expect(m).toContain('Edit Provider')
    expect(m).toContain('Update your custom AI chat provider.')
    expect(m).toContain('Update')
    expect(m).not.toContain('Add Custom Provider')
  })
})
