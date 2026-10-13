/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The workspace walker, held against its contract
 * (gHashTag/trios#1657): the single export of
 * produced-files-walker.ts - walkWorkspace - pinned as it behaves
 * today, so the next change to that file has something to fail
 * against.
 *
 * The walker yields one (workspace-relative POSIX path, size,
 * mtimeMs) triple per regular file, recursing subdirectories.
 * The well-known cruft directories (node_modules, .git, .cache) are
 * excluded. Symlinks are skipped - never followed, never recorded -
 * so an agent cannot smuggle host-fs paths into the diff. A missing
 * workspace directory answers silently instead of throwing (a fresh
 * agent has produced nothing yet). A visitor returning false stops
 * the walk early (the 50 000-entry cap drives that same brake).
 *
 * The workspaces are throwaway mkdtempSync trees; no network, no
 * database, no container.
 */

import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { walkWorkspace } from '../../src/api/services/openclaw/produced-files-walker'

interface Seen {
  path: string
  size: number
  mtimeMs: number
}

const walkAll = async (dir: string): Promise<Seen[]> => {
  const seen: Seen[] = []
  await walkWorkspace(dir, (relativePath, metadata) => {
    seen.push({ path: relativePath, ...metadata })
  })
  return seen
}

const workspaceWith = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'walker-'))
  for (const [name, content] of Object.entries(files)) {
    const absolute = join(dir, name)
    mkdirSync(absolute.slice(0, absolute.lastIndexOf('/')), { recursive: true })
    writeFileSync(absolute, content)
  }
  return dir
}

describe('walkWorkspace', () => {
  it('yields every regular file with its size and mtime, recursing', async () => {
    const dir = workspaceWith({
      'top.txt': 'top-level',
      'sub/nested.txt': 'nested file',
    })
    const seen = await walkAll(dir)
    expect(seen.map((f) => f.path).sort()).toEqual([
      'sub/nested.txt',
      'top.txt',
    ])
    const top = seen.find((f) => f.path === 'top.txt')
    expect(top?.size).toBe('top-level'.length)
    expect(top?.mtimeMs).toBeGreaterThan(0)
  })

  it('answers silently for a missing workspace directory', async () => {
    const missing = join(tmpdir(), `walker-absent-${Date.now()}`)
    const seen = await walkAll(missing)
    expect(seen).toEqual([])
  })

  it('skips the well-known cruft directories', async () => {
    const dir = workspaceWith({
      'real.txt': 'kept',
      'node_modules/pkg/index.js': 'skipped',
      '.git/config': 'skipped',
      '.cache/blob': 'skipped',
    })
    const seen = await walkAll(dir)
    expect(seen.map((f) => f.path)).toEqual(['real.txt'])
  })

  it('never follows or records symlinks', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'walker-outside-'))
    writeFileSync(join(outside, 'host-secret.txt'), 'should never appear')
    const dir = workspaceWith({ 'real.txt': 'kept' })
    symlinkSync(join(outside, 'host-secret.txt'), join(dir, 'leak.txt'))
    const seen = await walkAll(dir)
    expect(seen.map((f) => f.path)).toEqual(['real.txt'])
  })

  it('recurses deep workspaces within the depth cap', async () => {
    const dir = workspaceWith({
      'a/b/c/d/e/deep.txt': 'deep file',
    })
    const seen = await walkAll(dir)
    expect(seen.map((f) => f.path)).toEqual(['a/b/c/d/e/deep.txt'])
  })
})
