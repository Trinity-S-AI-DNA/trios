/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The markdown editor wrapper, held against its contract
 * (gHashTag/trios#1626): the single export of
 * components/ui/MarkdownEditor.tsx - MarkdownEditor - pinned as it
 * behaves today, so the next change to that file has something to fail
 * against.
 *
 * The MDX editor underneath renders its own machinery (the content
 * itself arrives through its async pipeline, measured: neither the
 * markdown text nor its rendered html appears in a static answer), so
 * what is pinned is the wrapper this file owns: the outer frame with
 * its pass-through id, the themed pane, the content-editable class,
 * the toolbar that disappears in read-only mode, and the copy bar with
 * its Copy markdown affordance. Not pinned: the markdown pipeline's
 * rendering, the paste interception, the clipboard write and the
 * copied flip, and the effect that syncs the value.
 */
import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const { MarkdownEditor } = await import('./MarkdownEditor')

const markup = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(
      MarkdownEditor as never,
      {
        value: '# Title\ntext',
        onChange: () => {},
        ...props,
      } as never,
    ),
  )

describe('markdownEditorContract', () => {
  it('answers the outer frame with its id and the themed pane', () => {
    const m = markup({ id: 'ed-1' })
    expect(m).toContain('id="ed-1"')
    expect(m).toContain('mdx-editor-outer')
    expect(m).toContain('mdx-editor-themed')
    expect(m).toContain('mdx-content-editable')
    expect(m).toContain('prose prose-sm')
  })

  it('answers the toolbar in edit mode and none in read-only', () => {
    // The toolbar answers by role, not by an mdx-toolbar class (measured).
    const editable = markup()
    expect(editable).toContain('role="toolbar"')
    const readOnly = markup({ readOnly: true })
    expect(readOnly).not.toContain('mdx-toolbar')
    expect(readOnly).toContain('mdx-editor-outer')
  })

  it('answers the copy bar with the Copy markdown affordance in both modes', () => {
    const m = markup()
    expect(m).toContain('mdx-copy-bar')
    expect(m).toContain('Copy markdown')
    expect(m).toContain('lucide-copy')
    expect(m).not.toContain('Copied')

    const readOnly = markup({ readOnly: true })
    expect(readOnly).toContain('Copy markdown')
  })
})
