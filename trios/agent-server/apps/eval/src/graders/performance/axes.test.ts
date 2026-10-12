/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The performance-grading axes, held against their contract
 * (gHashTag/trios#1592): the three exports of
 * graders/performance/axes.ts - DEFAULT_AXES,
 * PERFORMANCE_SYSTEM_PROMPT, buildUserPrompt - pinned as they behave
 * today, so the next change to that file has something to fail
 * against.
 *
 * DEFAULT_AXES carries the six scoring axes with weights that sum to
 * a whole pass. PERFORMANCE_SYSTEM_PROMPT tells the evaluator its
 * job and the JSON it must answer with. buildUserPrompt assembles the
 * per-task prompt: the task, the agent's answer (with its no-answer
 * marker), the optional ground-truth block, the pre-computed metrics,
 * the screenshot inventory and the axes with their weights.
 *
 * No network, no database, no container: the exports are pure data
 * and a pure function.
 */

import { describe, expect, it } from 'bun:test'
import {
  buildUserPrompt,
  DEFAULT_AXES,
  PERFORMANCE_SYSTEM_PROMPT,
} from './axes'

describe('DEFAULT_AXES', () => {
  it('carries the six named axes', () => {
    expect(DEFAULT_AXES.map((a) => a.name)).toEqual([
      'task_completion',
      'reasoning_quality',
      'efficiency',
      'speed',
      'error_recovery',
      'autonomy',
    ])
  })

  it('weights the axes to a whole pass and spells each one out', () => {
    expect(
      DEFAULT_AXES.reduce((sum, axis) => sum + axis.weight, 0),
    ).toBeCloseTo(1, 10)
    for (const axis of DEFAULT_AXES) {
      expect(axis.description.length).toBeGreaterThan(0)
    }
  })
})

describe('PERFORMANCE_SYSTEM_PROMPT', () => {
  it('tells the evaluator its job and the JSON it must return', () => {
    expect(PERFORMANCE_SYSTEM_PROMPT).toContain('performance evaluator')
    expect(PERFORMANCE_SYSTEM_PROMPT).toContain('browser automation agent')
    expect(PERFORMANCE_SYSTEM_PROMPT).toContain('messages.jsonl')
    expect(PERFORMANCE_SYSTEM_PROMPT).toContain('screenshots/')
    expect(PERFORMANCE_SYSTEM_PROMPT).toContain('tool-input-available')
  })
})

describe('buildUserPrompt', () => {
  const metrics = {
    screenshotCount: 4,
    toolCallCount: 12,
    messageCount: 30,
  } as never
  const axes = [
    {
      name: 'speed',
      weight: 0.1,
      description: 'Was it fast?',
    },
  ]

  it('embeds the task, the answer, the metrics and every axis', () => {
    const prompt = buildUserPrompt(
      'book a table',
      'Booked at 7pm',
      metrics,
      axes,
    )
    expect(prompt).toContain('book a table')
    expect(prompt).toContain('Booked at 7pm')
    expect(prompt).toContain('"screenshotCount": 4')
    expect(prompt).toContain('- **speed** (weight: 0.1): Was it fast?')
    expect(prompt).toContain('1.png to 4.png')
    expect(prompt).toContain('"axes"')
  })

  it('marks a missing answer instead of inventing one', () => {
    const prompt = buildUserPrompt('q', null, metrics, axes)
    expect(prompt).toContain('[No answer provided]')
  })

  it('adds the ground-truth block only when an expected answer is given', () => {
    const withTruth = buildUserPrompt('q', 'a', metrics, axes, 'TRUTH')
    expect(withTruth).toContain('## Expected Answer (Ground Truth)')
    expect(withTruth).toContain('TRUTH')

    const withoutTruth = buildUserPrompt('q', 'a', metrics, axes)
    expect(withoutTruth).not.toContain('Ground Truth')
  })
})
