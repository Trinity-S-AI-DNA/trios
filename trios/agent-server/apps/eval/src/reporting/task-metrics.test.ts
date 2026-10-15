/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The run metrics, held against their contract
 * (gHashTag/trios#1598): the five exports of
 * reporting/task-metrics.ts - countMessageMetrics, buildTaskMetrics,
 * buildRunMetrics, readTaskMetrics, readRunMetricSummary - pinned as
 * they behave today, so the next change to that file has something to
 * fail against.
 *
 * countMessageMetrics counts the tool call and tool error events from
 * a messages.jsonl stream and ignores what it cannot parse.
 * buildTaskMetrics prefers metadata numbers and falls back to the
 * screenshot count for steps and to zeros for the rest.
 * buildRunMetrics aggregates totals and averages, zeros when empty.
 * readTaskMetrics reads one task directory (a missing stream counts
 * as no calls). readRunMetricSummary walks a run directory - the
 * canonical tasks/ subdirectory when it exists - reading each task's
 * metadata.json for its query id, termination status and primary
 * grader grade.
 *
 * No network, no database, no container: run directories are
 * throwaway mkdtempSync trees.
 */

import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildRunMetrics,
  buildTaskMetrics,
  countMessageMetrics,
  readRunMetricSummary,
  readTaskMetrics,
} from './task-metrics'

const metrics = (
  overrides: Partial<{
    durationMs: number
    steps: number
    screenshots: number
    toolCalls: number
    toolErrors: number
  }>,
) => ({
  durationMs: 1000,
  steps: 5,
  screenshots: 3,
  toolCalls: 7,
  toolErrors: 1,
  ...overrides,
})

describe('countMessageMetrics', () => {
  it('counts tool calls and tool errors across the stream', () => {
    const stream = [
      JSON.stringify({ type: 'tool-input-available' }),
      JSON.stringify({ type: 'tool-input-available' }),
      JSON.stringify({ type: 'tool-output-error' }),
      JSON.stringify({ type: 'something-else' }),
    ].join('\n')
    expect(countMessageMetrics(stream)).toEqual({
      toolCalls: 2,
      toolErrors: 1,
    })
  })

  it('ignores blank and malformed lines', () => {
    expect(
      countMessageMetrics('{not json\n\n  \n{"type":"tool-input-available"}'),
    ).toEqual({ toolCalls: 1, toolErrors: 0 })
  })
})

describe('buildTaskMetrics', () => {
  it('prefers the metadata numbers, falling back for steps and screenshots', () => {
    expect(
      buildTaskMetrics(
        {
          total_duration_ms: 42,
          total_steps: 9,
          screenshot_count: 4,
        },
        { toolCalls: 2, toolErrors: 3 },
      ),
    ).toEqual({
      durationMs: 42,
      steps: 9,
      screenshots: 4,
      toolCalls: 2,
      toolErrors: 3,
    })
  })

  it('falls back to the screenshot count for steps and treats junk as zero', () => {
    expect(
      buildTaskMetrics(
        { total_duration_ms: 'junk', screenshot_count: 'junk' },
        { toolCalls: 0, toolErrors: 0 },
        4,
      ),
    ).toEqual({
      durationMs: 0,
      steps: 4,
      screenshots: 4,
      toolCalls: 0,
      toolErrors: 0,
    })
  })
})

describe('buildRunMetrics', () => {
  it('aggregates totals and averages over the tasks', () => {
    const run = buildRunMetrics([metrics({}), metrics({ durationMs: 3000 })])
    expect(run).toEqual({
      taskCount: 2,
      totalDurationMs: 4000,
      avgDurationMs: 2000,
      totalSteps: 10,
      avgSteps: 5,
      totalToolCalls: 14,
      avgToolCalls: 7,
      totalToolErrors: 2,
      avgToolErrors: 1,
    })
  })

  it('answers zeros for an empty run', () => {
    expect(buildRunMetrics([])).toEqual({
      taskCount: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      totalSteps: 0,
      avgSteps: 0,
      totalToolCalls: 0,
      avgToolCalls: 0,
      totalToolErrors: 0,
      avgToolErrors: 0,
    })
  })
})

describe('readTaskMetrics', () => {
  it('reads one task directory, and a missing stream counts as no calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-metrics-'))
    writeFileSync(
      join(dir, 'messages.jsonl'),
      '{"type":"tool-input-available"}\n{"type":"tool-output-error"}\n',
    )
    expect(await readTaskMetrics(dir, { total_duration_ms: 5 }, 2)).toEqual({
      durationMs: 5,
      steps: 2,
      screenshots: 2,
      toolCalls: 1,
      toolErrors: 1,
    })

    expect(await readTaskMetrics(dir, {}, 0)).toEqual({
      durationMs: 0,
      steps: 0,
      screenshots: 0,
      toolCalls: 1,
      toolErrors: 1,
    })

    const empty = mkdtempSync(join(tmpdir(), 'task-metrics-'))
    expect(await readTaskMetrics(empty, {})).toEqual({
      durationMs: 0,
      steps: 0,
      screenshots: 0,
      toolCalls: 0,
      toolErrors: 0,
    })
  })
})

describe('readRunMetricSummary', () => {
  it('walks the canonical tasks/ directory and grades each task', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'run-metrics-'))
    const tasksDir = join(runDir, 'tasks')
    mkdirSync(tasksDir)
    for (const taskId of ['t1', 't2']) {
      const taskDir = join(tasksDir, taskId)
      mkdirSync(taskDir)
      writeFileSync(
        join(taskDir, 'metadata.json'),
        JSON.stringify({
          query_id: `q-${taskId}`,
          total_duration_ms: 100,
          grader_results: { primary: { score: 0.9, pass: true } },
        }),
      )
      writeFileSync(
        join(taskDir, 'messages.jsonl'),
        '{"type":"tool-input-available"}\n',
      )
    }

    const summary = await readRunMetricSummary(runDir)
    expect(summary.tasks.length).toBe(2)
    const byQuery = (a: { queryId: string }, b: { queryId: string }) =>
      a.queryId.localeCompare(b.queryId)
    summary.tasks.sort(byQuery)
    expect(summary.tasks[0]).toEqual({
      queryId: 'q-t1',
      status: 'completed',
      score: 0.9,
      pass: true,
      metrics: {
        durationMs: 100,
        steps: 0,
        screenshots: 0,
        toolCalls: 1,
        toolErrors: 0,
      },
    })
    expect(summary.run.taskCount).toBe(2)
    expect(summary.run.totalDurationMs).toBe(200)
  })

  it('derives timeout and failed statuses and skips tasks with no readable metadata', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'run-metrics-'))
    mkdirSync(join(runDir, 'timedout'))
    writeFileSync(
      join(runDir, 'timedout', 'metadata.json'),
      JSON.stringify({ termination_reason: 'timeout' }),
    )
    mkdirSync(join(runDir, 'errored'))
    writeFileSync(
      join(runDir, 'errored', 'metadata.json'),
      JSON.stringify({ errors: [{ message: 'boom' }] }),
    )
    mkdirSync(join(runDir, 'unreadable'))

    const summary = await readRunMetricSummary(runDir)
    // readdir order is not sorted; the summary is a directory walk.
    expect(summary.tasks.map((t) => t.status).sort()).toEqual([
      'failed',
      'timeout',
    ])
    expect(summary.tasks.map((t) => t.queryId).sort()).toEqual([
      'errored',
      'timedout',
    ])
  })
})
