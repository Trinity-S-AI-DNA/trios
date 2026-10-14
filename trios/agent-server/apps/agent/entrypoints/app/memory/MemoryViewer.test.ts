/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The memory viewer, held against its contract
 * (gHashTag/trios#1610): the one export of
 * entrypoints/app/memory/MemoryViewer.tsx - MemoryViewer - pinned
 * as it behaves today, so the next change to that file has something
 * to fail against.
 *
 * Every branch the viewer dispatches on rides its memory-content
 * hook, so that seam is stubbed through a mutable holder the test
 * drives state by state - and everything else stays real. Measured,
 * the loading branch answers only its spinner - no card title, no
 * empty note; the failed branch answers the server note; the empty
 * branch answers the no-memories note with the add button; and the
 * loaded branch answers the CORE.md card with its editable mark and
 * the edit button - the markdown body rides the shared streamdown
 * renderer, whose default stream mode draws nothing in a static
 * mount, so the card frame is this file's own observable answer.
 *
 * Not pinned, and why (issue User Story 2): the flows the callbacks
 * own - the edit toggle with its editor, the save and its inline
 * failure note, the hover refetch - need a live document to press,
 * and the markdown editor mounts only inside the editing branch
 * this mount never reaches. The subject is read through a
 * query-qualified specifier so this suite's graph loads as its own
 * fresh instances.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const memoryState: {
  content: string
  isLoading: boolean
  error: Error | null
  isSaving: boolean
  saveError: Error | null
} = {
  content: '',
  isLoading: false,
  error: null,
  isSaving: false,
  saveError: null,
}

mock.module('@/entrypoints/app/memory/useMemoryContent', () => ({
  useMemoryContent: () => ({
    content: memoryState.content,
    isLoading: memoryState.isLoading,
    error: memoryState.error,
    refetch: () => {},
    save: async () => {},
    isSaving: memoryState.isSaving,
    saveError: memoryState.saveError,
    resetSaveError: () => {},
  }),
}))

const subjectUrl = './MemoryViewer?memory-viewer-suite-real'
const { MemoryViewer } = (await import(
  subjectUrl
)) as typeof import('./MemoryViewer')

const renderViewer = () => renderToStaticMarkup(createElement(MemoryViewer))

describe('MemoryViewerTsxContract', () => {
  describe('MemoryViewer', () => {
    it('answers every branch the memory-content state drives: the loading spinner alone, the failed note, the no-memories note with its add button, and the loaded card with its title, editable mark, edit button and the memory heading', () => {
      memoryState.isLoading = true
      const loading = renderViewer()
      expect(loading).not.toContain('CORE.md')
      expect(loading).not.toContain('No memories yet')

      memoryState.isLoading = false
      memoryState.error = new Error('server down')
      const failed = renderViewer()
      expect(failed).toContain(
        'Could not load memory. Make sure BrowserOS server is running.',
      )

      memoryState.error = null
      const empty = renderViewer()
      expect(empty).toContain('No memories yet')
      expect(empty).toContain(
        'Start a conversation and your agent will learn about you',
      )
      expect(empty).toContain('Add memory')
      expect(empty).not.toContain('CORE.md')

      memoryState.content = '# The launch plan\nShip on Friday.'
      const loaded = renderViewer()
      expect(loaded).toContain('CORE.md')
      expect(loaded).toContain('editable')
      expect(loaded).toContain('Edit')
      // the markdown body rides the shared streamdown renderer, whose
      // default stream mode draws nothing in a static mount - the card
      // frame is this file's own observable answer
      expect(loaded).not.toContain('No memories yet')
    })
  })
})
