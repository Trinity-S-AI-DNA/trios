/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The runner's pass/fail helpers, held against their contract
 * (gHashTag/trios#1667): the two exports of runner/types.ts -
 * isSuccessfulResult and getPrimaryGraderResult - pinned as they
 * behave today, so the next change to that file has something to fail
 * against.
 *
 * isSuccessfulResult counts only a completed or a timed-out task as
 * success - a run that hit its ceiling still produced output.
 * getPrimaryGraderResult answers with the first grader of
 * PASS_FAIL_GRADER_ORDER that ran, whatever the insertion order of
 * the record, falls back to the first entry for graders outside the
 * order, and says null when nothing ran.
 */

import { describe, expect, it } from 'bun:test'
import {
  getPrimaryGraderResult,
  isSuccessfulResult,
} from './types'

describe('isSuccessfulResult', () => {
  it('counts a completed task as a success', () => {
    expect(isSuccessfulResult({ status: 'completed' })).toBe(true)
  })

  it('counts a task that hit its time ceiling as a success', () => {
    expect(isSuccessfulResult({ status: 'timeout' })).toBe(true)
  })

  it('refuses every other status a task can end with', () => {
    for (const status of ['failed', 'error', 'skipped', 'cancelled']) {
      expect(isSuccessfulResult({ status } as never)).toBe(false)
    }
  })
})

describe('getPrimaryGraderResult', () => {
  it('answers with the highest-priority grader that ran, not the first inserted', () => {
    const got = getPrimaryGraderResult({
      performance_grader: { pass: true, score: 1 },
      agisdk_state_diff: { pass: false, score: 0 },
    })
    expect(got).toEqual({
      name: 'agisdk_state_diff',
      pass: false,
      score: 0,
    })
  })

  it('walks the order down when the higher graders did not run', () => {
    const got = getPrimaryGraderResult({
      performance_grader: { pass: true, score: 1 },
      infinity_state: { pass: true, score: 1 },
    })
    expect(got?.name).toBe('infinity_state')
  })

  it('falls back to the first grader outside the pass/fail order', () => {
    const got = getPrimaryGraderResult({
      custom_check: { pass: true, score: 5 },
      other_check: { pass: false, score: 0 },
    })
    expect(got).toEqual({ name: 'custom_check', pass: true, score: 5 })
  })

  it('says null when no grader ran at all', () => {
    expect(getPrimaryGraderResult({})).toBeNull()
  })
})
