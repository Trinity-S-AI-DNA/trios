/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The artifact-card helpers, held against their contract
 * (gHashTag/trios#1661): the five exports of file-helpers.ts -
 * inferFileKind, extensionOf, basenameOf, formatFileSize,
 * buildFileDownloadUrl - pinned as they behave today, so the next
 * change to that file has something to fail against.
 *
 * All five are pure display helpers (the module header says it: no
 * React, no fetch, no DOM), so every case below is a direct input to
 * output pin, measured on the live module before writing. The
 * download URL keeps the harness's /agents root and percent-encodes
 * the file id exactly the way the API route expects it.
 */

import { describe, expect, it } from 'bun:test'
import {
  basenameOf,
  buildFileDownloadUrl,
  extensionOf,
  formatFileSize,
  inferFileKind,
} from './file-helpers'

describe('extensionOf', () => {
  it('answers the extension of the final path segment', () => {
    expect(extensionOf('a/b/c.txt')).toBe('txt')
  })

  it('answers an empty string when there is no dot in the last segment', () => {
    expect(extensionOf('no-ext')).toBe('')
    expect(extensionOf('dir.d/file')).toBe('')
  })

  it('treats a leading dot as an extension of the whole name', () => {
    expect(extensionOf('.hidden')).toBe('hidden')
  })
})

describe('basenameOf', () => {
  it('answers the final path segment', () => {
    expect(basenameOf('a/b/c.txt')).toBe('c.txt')
    expect(basenameOf('x.txt')).toBe('x.txt')
  })
})

describe('inferFileKind', () => {
  it('classifies by extension, case-insensitively', () => {
    expect(inferFileKind('photo.png')).toBe('image')
    expect(inferFileKind('doc.PDF')).toBe('pdf')
    expect(inferFileKind('notes.md')).toBe('text')
  })

  it('falls back to binary for unknown and missing extensions', () => {
    expect(inferFileKind('archive.zzz')).toBe('binary')
    expect(inferFileKind('README')).toBe('binary')
  })
})

describe('formatFileSize', () => {
  it('spells small sizes in bytes', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(512)).toBe('512 B')
  })

  it('walks up the units with one-digit precision below ten', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB')
    expect(formatFileSize(2.4 * 1024 * 1024)).toBe('2.4 MB')
  })

  it('rounds to an integer at ten and above', () => {
    expect(formatFileSize(15 * 1024 * 1024 * 1024)).toBe('15 GB')
  })

  it('answers the em dash for a size it cannot show', () => {
    expect(formatFileSize(-5)).toBe('—')
    expect(formatFileSize(Number.NaN)).toBe('—')
  })
})

describe('buildFileDownloadUrl', () => {
  it('builds the per-file download URL on the /agents API root', () => {
    expect(buildFileDownloadUrl('http://h:1', 'ok file')).toBe(
      'http://h:1/agents/files/ok%20file/download',
    )
  })

  it('percent-encodes the whole file id, slashes included', () => {
    expect(buildFileDownloadUrl('http://h:1/base/', 'f/1')).toBe(
      'http://h:1/base//agents/files/f%2F1/download',
    )
  })
})
