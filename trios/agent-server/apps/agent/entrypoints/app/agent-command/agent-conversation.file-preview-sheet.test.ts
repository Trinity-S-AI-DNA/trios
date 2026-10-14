/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The shared file preview sheet, held against its contract
 * (gHashTag/trios#1543): the one export of
 * entrypoints/app/agent-command/agent-conversation.file-preview-sheet.tsx
 * - FilePreviewSheet - pinned as it behaves today, so the next change
 * to that file has something to fail against.
 *
 * The sheet is controlled (the parent owns open), so a static render
 * reaches both states. The seams are stubbed where they pull live
 * machinery and left real where they are pure: the agent-server URL
 * hook answers the seeded loopback base (its real module rides the
 * capabilities/adapter graph), while the agent-files helpers
 * (basenameOf, extensionOf, formatFileSize, buildFileDownloadUrl and
 * the rest) stay real through a query-qualified read - mock.module
 * registrations persist for every later-linking file, so the module
 * keeps its real value exports and only the preview hook is
 * replaced, answering whatever preview state the test sets. Radix
 * portals never flush through a static render, so the sheet kit is
 * stubbed with a portal-free stand-in carrying every value export
 * the kit has: the root honours the open flag, the content renders
 * its children inline while open and nothing while closed. Measured,
 * the closed sheet renders nothing, and the open sheet answers the
 * header with the file's basename and path, the download button,
 * and the body the preview union dispatches: the text preview with
 * its snippet, meta and truncation note, the image with its data
 * url, the pdf and binary fallbacks, the missing-file note, and the
 * load failure with its message.
 *
 * Not pinned, and why (issue User Story 2): the markdown branch of
 * the text preview - it rides the shared MessageResponse renderer
 * the ai-elements suites pin on their own, and exercising it here
 * would pin that renderer's markdown machinery rather than this
 * file's contract - and the download click itself (a document
 * appendChild/click flow needing a live DOM). The port env seam is
 * seeded before any import can reach the env module (its one-time
 * snapshot - the trap the agent-outputs suite documented), with the
 * subject read through a query-qualified specifier so this suite's
 * graph loads as its own fresh instances.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// biome-ignore lint/style/noProcessEnv: the env seam is the only way to reach the port helpers before the env module's one-time snapshot freezes (see suite header)
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'

mock.module('@/lib/browseros/useBrowserOSProviders', () => ({
  // baseUrl null is what the real hook answers in a test process (no
  // live adapter behind the capabilities seam) - and what the
  // downstream OpenClaw suites bake in, so this registration must
  // not hand them a server address the real one would not give.
  useAgentServerUrl: () => ({ baseUrl: null }),
}))

const realAgentFilesUrl = '@/lib/agent-files?file-preview-sheet-real'
const realAgentFiles = (await import(realAgentFilesUrl)) as Record<
  string,
  unknown
>

// The preview state the stubbed hook answers - the test moves it
// from branch to branch of the union the sheet dispatches on.
const previewState: {
  preview: unknown
  loading: boolean
  error: unknown
} = {
  preview: null,
  loading: false,
  error: null,
}

mock.module('@/lib/agent-files', () => ({
  ...realAgentFiles,
  useFilePreview: () => ({
    preview: previewState.preview,
    loading: previewState.loading,
    error: previewState.error,
  }),
}))

// Radix portals never flush through a static render, so the sheet
// kit is stubbed with a portal-free stand-in - every value export
// the module carries, the content rendering its children inline and
// the root honouring the open flag, so closed sheets stay empty for
// every other suite of this group, exactly as the real one behaves
// outside a live document.
let sheetOpen = false
mock.module('@/components/ui/sheet', () => ({
  Sheet: ({
    open,
    children,
  }: {
    open?: boolean
    children?: React.ReactNode
  }) => {
    sheetOpen = !!open
    return children ?? null
  },
  SheetClose: () => null,
  SheetContent: ({ children }: { children?: React.ReactNode }) =>
    sheetOpen ? children : null,
  SheetDescription: ({ children }: { children?: React.ReactNode }) =>
    children ?? null,
  SheetFooter: ({ children }: { children?: React.ReactNode }) =>
    children ?? null,
  SheetHeader: ({ children }: { children?: React.ReactNode }) =>
    children ?? null,
  SheetTitle: ({ children }: { children?: React.ReactNode }) =>
    children ?? null,
  SheetTrigger: ({ children }: { children?: React.ReactNode }) =>
    children ?? null,
}))

const subjectUrl =
  './agent-conversation.file-preview-sheet?file-preview-sheet-suite-real'
const { FilePreviewSheet } = (await import(
  subjectUrl
)) as typeof import('./agent-conversation.file-preview-sheet')

const renderSheet = (open: boolean) =>
  renderToStaticMarkup(
    createElement(FilePreviewSheet, {
      fileId: 'file-1',
      filePath: '/workspace/notes.txt',
      open,
      onOpenChange: () => {},
    }),
  )

describe('agentConversationFilePreviewSheetTsxContract', () => {
  describe('FilePreviewSheet', () => {
    it('answers the closed sheet with nothing, and the open sheet with the header naming the file, the download button, and every branch of the preview union: text with its snippet, meta and truncation note, the image with its data url, the pdf and binary fallbacks, the missing-file note, and the load failure with its message', () => {
      previewState.preview = null
      previewState.loading = false
      previewState.error = null
      const closed = renderSheet(false)
      expect(closed).toBe('')

      previewState.preview = {
        kind: 'text',
        snippet: 'the first lines of the note',
        size: 2048,
        mimeType: 'text/plain',
        truncated: true,
      }
      const text = renderSheet(true)
      expect(text).toContain('notes.txt')
      expect(text).toContain('/workspace/notes.txt')
      expect(text).toContain('the first lines of the note')
      expect(text).toContain('text/plain')
      expect(text).toContain('Showing the first part of this file')
      expect(text).toContain('Download')
      expect(text).not.toContain('Loading preview...')

      previewState.preview = {
        kind: 'image',
        dataUrl: 'data:image/png;base64,AAAA',
        size: 4096,
        mimeType: 'image/png',
      }
      const image = renderSheet(true)
      expect(image).toContain('data:image/png;base64,AAAA')
      expect(image).toContain('image/png')

      previewState.preview = {
        kind: 'pdf',
        size: 8192,
        mimeType: 'application/pdf',
      }
      const pdf = renderSheet(true)
      expect(pdf).toContain(
        'supported inline yet. Use Download to open this file in your default PDF viewer.',
      )

      previewState.preview = {
        kind: 'binary',
        size: 256,
        mimeType: 'unknown/bytes',
      }
      const binary = renderSheet(true)
      expect(binary).toContain('No inline preview for this file type.')

      previewState.preview = { kind: 'missing' }
      const missing = renderSheet(true)
      expect(missing).toContain('This file is no longer in the workspace.')

      previewState.preview = null
      previewState.error = { message: 'the server closed the connection' }
      const failed = renderSheet(true)
      expect(failed).toContain('Could not load preview')
      expect(failed).toContain('the server closed the connection')
    })
  })
})
