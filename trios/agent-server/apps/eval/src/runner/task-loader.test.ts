/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The task loader, held against its contract (gHashTag/trios#1619):
 * the four exports of runner/task-loader.ts - TaskLoadError,
 * TaskValidationError, loadTasks, getTaskSourceDescription - pinned
 * as they behave today, so the next change to that file has something
 * to fail against.
 *
 * loadTasks reads a JSONL file one task per line, aggregates every
 * parse or validation failure with its line number, refuses an empty
 * file and a duplicate query_id, and wraps a read failure with its
 * cause. A single-query source builds one manual task (or refuses an
 * empty query). The error classes carry their contract data (source,
 * cause, line number, zod issues) and getTaskSourceDescription spells
 * the source out for a human.
 *
 * No network, no database, no container: task files live in a
 * throwaway mkdtempSync directory.
 */

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  getTaskSourceDescription,
  loadTasks,
  TaskLoadError,
  TaskValidationError,
} from './task-loader'

const taskLine = (id: string) =>
  JSON.stringify({
    query_id: id,
    dataset: 'web',
    query: `run ${id}`,
    metadata: { original_task_id: `orig-${id}` },
  })

const tmpFile = (content: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'task-loader-'))
  const file = join(dir, 'tasks.jsonl')
  writeFileSync(file, content)
  return file
}

describe('TaskLoadError', () => {
  it('carries the source, the optional cause and its own name', () => {
    const cause = new Error('ENOENT')
    const err = new TaskLoadError('nope', { type: 'file', path: '/x' }, cause)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('TaskLoadError')
    expect(err.source).toEqual({ type: 'file', path: '/x' })
    expect(err.cause).toBe(cause)
  })
})

describe('TaskValidationError', () => {
  it('carries the line number and the zod issues', () => {
    const issues = new z.ZodError([
      { code: 'invalid_type', path: ['query_id'], message: 'Required' },
    ])
    const err = new TaskValidationError('bad line', 7, issues)
    expect(err.name).toBe('TaskValidationError')
    expect(err.lineNumber).toBe(7)
    expect(err.validationErrors).toBeInstanceOf(z.ZodError)
    expect(err.validationErrors.issues[0].path).toEqual(['query_id'])
  })
})

describe('loadTasks', () => {
  it('reads a JSONL file one task per line, with the graders default', async () => {
    const file = tmpFile(`${taskLine('q1')}\n${taskLine('q2')}\n`)
    const result = await loadTasks({ type: 'file', path: file })
    expect(result.tasks.length).toBe(2)
    expect(result.tasks[0].query_id).toBe('q1')
    expect(result.tasks[0].query).toBe('run q1')
    expect(result.tasks[0].graders).toEqual([])
    expect(result.source).toEqual({ type: 'file', path: file })
  })

  it('skips blank lines between tasks', async () => {
    const file = tmpFile(`\n  \n${taskLine('q1')}\n\n`)
    const result = await loadTasks({ type: 'file', path: file })
    expect(result.tasks.length).toBe(1)
  })

  it('aggregates a bad-JSON line and a failed validation with their line numbers', async () => {
    const file = tmpFile(
      `{not json\n${JSON.stringify({ dataset: 'web', query: 'x', metadata: {} })}\n`,
    )
    let caught: unknown
    try {
      await loadTasks({ type: 'file', path: file })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(TaskLoadError)
    const err = caught as TaskLoadError
    expect(err.message).toContain('Failed to parse 2 task(s)')
    expect(err.message).toContain('Line 1: Invalid JSON')
    expect(err.message).toContain('Line 2: Validation failed')
    expect(err.message).toContain('query_id: Required')
  })

  it('refuses a tasks file that is empty after trimming', async () => {
    const file = tmpFile('   \n\n')
    let caught: unknown
    try {
      await loadTasks({ type: 'file', path: file })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(TaskLoadError)
    expect((caught as TaskLoadError).message).toBe('Tasks file is empty')
  })

  it('wraps a read failure with the cause attached', async () => {
    let caught: unknown
    try {
      await loadTasks({ type: 'file', path: join(tmpdir(), 'missing-file.jsonl') })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(TaskLoadError)
    const err = caught as TaskLoadError
    expect(err.message).toContain('Failed to read tasks file')
    expect(err.cause).toBeInstanceOf(Error)
  })

  it('refuses duplicate query ids, naming them', async () => {
    const file = tmpFile(`${taskLine('dup')}\n${taskLine('dup')}\n`)
    let caught: unknown
    try {
      await loadTasks({ type: 'file', path: file })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(TaskLoadError)
    expect((caught as TaskLoadError).message).toContain(
      'Duplicate query_ids found: dup',
    )
  })

  it('builds one manual task from a single-query source, query trimmed', async () => {
    const result = await loadTasks({
      type: 'single',
      query: '  book a table  ',
      startUrl: 'https://x.example',
    })
    expect(result.tasks.length).toBe(1)
    expect(result.tasks[0].query).toBe('book a table')
    expect(result.tasks[0].dataset).toBe('manual')
    expect(result.tasks[0].graders).toEqual(['performance_grader'])
    expect(result.tasks[0].start_url).toBe('https://x.example')
    expect(result.tasks[0].metadata.original_task_id).toBe('manual')
    expect(result.tasks[0].query_id.startsWith('single-')).toBe(true)
  })

  it('refuses an empty single query', async () => {
    let caught: unknown
    try {
      await loadTasks({ type: 'single', query: '   ' })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(TaskLoadError)
    expect((caught as TaskLoadError).message).toBe('Query cannot be empty')
  })
})

describe('getTaskSourceDescription', () => {
  it('spells a file source out with its path', () => {
    expect(getTaskSourceDescription({ type: 'file', path: '/a/b.jsonl' })).toBe(
      'file: /a/b.jsonl',
    )
  })

  it('calls the single-query mode by name', () => {
    expect(getTaskSourceDescription({ type: 'single', query: 'q' })).toBe(
      'single task mode',
    )
  })
})
