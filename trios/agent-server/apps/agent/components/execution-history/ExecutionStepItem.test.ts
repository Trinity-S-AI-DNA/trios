/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The execution step item, held against its contract
 * (gHashTag/trios#1640): the single export of
 * components/execution-history/ExecutionStepItem.tsx -
 * ExecutionStepItem - pinned as it behaves today, so the next change
 * to that file has something to fail against.
 *
 * The item is a Collapsible whose open state the parent seeds through
 * defaultOpen, so a static render reaches both. Pinned: the closed
 * answer (formatted tool name, the state badge, the state icon, no
 * content); the open answer (the rotated chevron, the content frame
 * with the Result header); every state's label and icon; the ACL
 * Blocked badge over the three trigger shapes; and the denied branch's
 * reason text. Not pinned: the shiki-highlighted payload text inside
 * ToolOutput - it arrives through an effect - and the toggle click.
 */
import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ExecutionStepRecord } from '@/lib/execution-history/types'

const { ExecutionStepItem } = await import('./ExecutionStepItem')

const step = (over: Partial<ExecutionStepRecord> = {}): ExecutionStepRecord =>
  ({
    toolName: 'browser_navigatePage',
    state: 'output-available',
    input: undefined,
    output: undefined,
    errorText: undefined,
    approval: undefined,
    previewText: undefined,
    ...over,
  }) as ExecutionStepRecord

const markup = (s: ExecutionStepRecord, defaultOpen = false) =>
  renderToStaticMarkup(
    createElement(ExecutionStepItem, { step: s, defaultOpen }),
  )

describe('executionStepItemContract', () => {
  it('answers the closed item with the formatted tool name, its badge and icon, and no content', () => {
    const m = markup(step())
    expect(m).toContain('Browser navigate Page')
    expect(m).toContain('Completed')
    expect(m).toContain('lucide-circle-check')
    expect(m).toContain('lucide-chevron-down')
    expect(m).not.toContain('rotate-180')
    // Radix renders the content hidden when closed - the frame is there,
    // the visibility is not; the open state drops the hidden attribute.
    expect(m).toContain('hidden=""')
  })

  it('answers the open item with the rotated chevron and the visible content frame', () => {
    const m = markup(step({ output: 'the answer text' }), true)
    expect(m).toContain('rotate-180')
    expect(m).toContain('data-slot="collapsible-content"')
    expect(m).not.toContain('hidden=""')
    expect(m).toContain('border-t')
    expect(m).toContain('Result')
  })

  it('answers every state with its label and its icon', () => {
    const cases: Array<[ExecutionStepRecord['state'], string, string]> = [
      ['input-streaming', 'Preparing', 'lucide-clock3'],
      ['input-available', 'Running', 'lucide-clock3'],
      ['approval-requested', 'Approval Needed', 'lucide-clock3'],
      ['approval-responded', 'Approval Responded', 'lucide-shield-check'],
      ['output-denied', 'Denied', 'lucide-shield-alert'],
      ['output-error', 'Error', 'lucide-circle-x'],
    ]
    for (const [state, label, icon] of cases) {
      const m = markup(step({ state }))
      expect(m).toContain(label)
      expect(m).toContain(icon)
    }
  })

  it('answers the ACL Blocked badge over the three trigger shapes', () => {
    expect(
      markup(
        step({
          state: 'output-error',
          errorText: 'Action blocked by ACL rule: payments',
        }),
      ),
    ).toContain('ACL Blocked')
    expect(
      markup(
        step({
          state: 'approval-requested',
          approval: { id: 'appr-1', reason: 'Action blocked by ACL rule' },
        }),
      ),
    ).toContain('ACL Blocked')
    expect(
      markup(
        step({
          state: 'input-available',
          previewText: 'Blocked by ACL rule',
        }),
      ),
    ).toContain('ACL Blocked')
    expect(markup(step({ state: 'input-available' }))).not.toContain(
      'ACL Blocked',
    )
  })

  it('answers the denied branch with the recorded reason, and only when denied', () => {
    const denied = markup(
      step({
        state: 'output-denied',
        approval: { id: 'appr-2', reason: 'You shall not pass' },
      }),
      true,
    )
    expect(denied).toContain('You shall not pass')
    expect(denied).not.toContain('The requested action was denied.')

    const deniedNoReason = markup(step({ state: 'output-denied' }), true)
    expect(deniedNoReason).toContain('The requested action was denied.')
  })

  it('answers the preview line only in the pre-output states', () => {
    const m = markup(
      step({ state: 'input-available', previewText: 'Going to the page' }),
    )
    expect(m).toContain('Going to the page')

    const done = markup(
      step({ state: 'output-available', previewText: 'Going to the page' }),
    )
    expect(done).not.toContain('Going to the page')
  })
})
