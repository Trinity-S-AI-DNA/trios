/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The memory search tool, held against its contract
 * (gHashTag/trinos#1652): the single export of
 * tools/memory/search.ts - createMemorySearchTool - pinned as it
 * behaves today, so the next change to that file has something to
 * fail against.
 *
 * The tool fuzzy-searches the memory directory's .md files - both
 * section-level entries (## delimited) and line-level entries -
 * merging keywords by best score and answering at most ten blocks
 * in the pinned '[file] (relevance: X.XX)\ncontent' format. Lines
 * covered by a higher-ranked section of the same file are
 * deduplicated (measured: the dedup only bites when the section
 * outranks the line). A missing or empty memory directory answers
 * 'No memories found.'; a keyword that matches nothing names the
 * keywords back.
 *
 * The memory directory is steered through the BROWSEROS_DIR
 * environment override into throwaway mkdtempSync trees; no
 * network, no database, no container.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemorySearchTool } from '../../src/tools/memory/search'

interface SearchTool {
  description: string
  execute: (params: { keywords: string[] }) => Promise<{ text: string }>
}

const withMemoryDir = (files: Record<string, string>): SearchTool => {
  const dir = mkdtempSync(join(tmpdir(), 'memsearch-'))
  const memDir = join(dir, 'memory')
  mkdirSync(memDir)
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(memDir, name), content)
  }
  process.env.BROWSEROS_DIR = dir
  return createMemorySearchTool() as unknown as SearchTool
}

const releaseMemoryDir = () => {
  delete process.env.BROWSEROS_DIR
}

afterAll(() => {
  // Defense in depth: even if an assertion throws before the release
  // call, the override must not leak into sibling suites.
  delete process.env.BROWSEROS_DIR
})

const CORE_MD = '## User Preferences\nThe user prefers dark mode.\n'

describe('createMemorySearchTool', () => {
  it('describes the fuzzy multi-keyword search', () => {
    const tool = createMemorySearchTool() as unknown as SearchTool
    expect(tool.description).toContain('fuzzy matching')
    expect(tool.description).toContain('multiple keywords')
  })

  it('answers No memories found. when the memory directory is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memsearch-empty-'))
    process.env.BROWSEROS_DIR = dir
    const tool = createMemorySearchTool() as unknown as SearchTool
    const result = await tool.execute({ keywords: ['anything'] })
    expect(result.text).toBe('No memories found.')
    releaseMemoryDir()
  })

  it('formats matches as file-tagged relevance blocks', async () => {
    const tool = withMemoryDir({ 'core.md': CORE_MD })
    const result = await tool.execute({ keywords: ['dark mode'] })
    expect(result.text).toContain('[core.md] (relevance: ')
    expect(result.text).toContain('## User Preferences')
    expect(result.text).toContain('The user prefers dark mode.')
    releaseMemoryDir()
  })

  it('surfaces line-level entries and sections, best score first', async () => {
    const tool = withMemoryDir({ 'core.md': CORE_MD })
    const result = await tool.execute({ keywords: ['dark mode'] })
    const blocks = result.text.split('\n\n---\n\n')
    expect(blocks.length).toBe(2)
    // Measured: the line-level entry outranks its section for this
    // keyword, so it comes first.
    expect(blocks[0]).toContain('The user prefers dark mode.')
    expect(blocks[1]).toContain('## User Preferences')
    releaseMemoryDir()
  })

  it('deduplicates lines covered by a higher-ranked section', async () => {
    const tool = withMemoryDir({ 'core.md': CORE_MD })
    const result = await tool.execute({ keywords: ['User Preferences'] })
    // Measured: the section outranks its line for this keyword and
    // the line is swallowed by the dedup.
    expect(result.text).toContain('## User Preferences')
    expect(result.text).not.toContain('---')
    releaseMemoryDir()
  })

  it('names the keywords back when nothing matches', async () => {
    const tool = withMemoryDir({ 'core.md': CORE_MD })
    const result = await tool.execute({ keywords: ['zzzznonexistentzzz'] })
    expect(result.text).toBe('No memories matching [zzzznonexistentzzz] found.')
    releaseMemoryDir()
  })

  it('answers at most ten blocks however much matches', async () => {
    let many = ''
    for (let i = 0; i < 15; i++) {
      many += `## Topic ${i}\nquantum widget variant ${i} unique-text-${i}\n`
    }
    const tool = withMemoryDir({ 'many.md': many })
    const result = await tool.execute({ keywords: ['quantum'] })
    expect(result.text.split('\n\n---\n\n').length).toBe(10)
    releaseMemoryDir()
  })

  it('merges multiple keywords keeping each entry once', async () => {
    const tool = withMemoryDir({
      'core.md': '## User Preferences\nThe user prefers dark mode.\n',
      'schedule.md': '## Schedule\nStandup happens every Monday.\n',
    })
    const result = await tool.execute({
      keywords: ['dark mode', 'standup'],
    })
    expect(result.text).toContain('[core.md]')
    expect(result.text).toContain('[schedule.md]')
    releaseMemoryDir()
  })
})
