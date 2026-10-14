/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The usage page, held against its contract
 * (gHashTag/trios#1635): the single export of
 * entrypoints/app/usage/UsagePage.tsx - UsagePage - pinned as it
 * behaves today, so the next change to that file has something to fail
 * against.
 *
 * The credits hook is a data-answering stand-in behind a flag, so one
 * suite reaches all three of the page's answers: the loading note, the
 * error card, and the data card. The credit colors stay real - the
 * threshold dispatch is part of this page's answer. Not pinned: the
 * react-query machinery behind the hook and the Add Provider click.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

let answer:
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'data'; credits: number; dailyLimit: number } = {
  kind: 'loading',
}

mock.module('@/lib/credits/useCredits', () => ({
  useCredits: () => {
    if (answer.kind === 'loading')
      return { data: undefined, isLoading: true, error: null }
    if (answer.kind === 'error')
      return {
        data: undefined,
        isLoading: false,
        error: new Error('no credits'),
      }
    return {
      data: { credits: answer.credits, dailyLimit: answer.dailyLimit },
      isLoading: false,
      error: null,
    }
  },
}))

const { UsagePage } = await import('./UsagePage')

const markup = () => renderToStaticMarkup(createElement(UsagePage))

describe('usagePageContract', () => {
  it('answers the loading note while the query is in flight', () => {
    answer = { kind: 'loading' }
    const m = markup()
    expect(m).toContain('Loading usage data...')
  })

  it('answers the error card with the header kept', () => {
    answer = { kind: 'error' }
    const m = markup()
    expect(m).toContain('Usage &' + 'amp; Billing')
    expect(m).toContain('Unable to load credit information')
    expect(m).toContain('lucide-circle-alert')
    expect(m).not.toContain('Daily Credits')
  })

  it('answers the data card with the counts and the measured color dispatch', () => {
    answer = { kind: 'data', credits: 80, dailyLimit: 100 }
    let m = markup()
    expect(m).toContain('Daily Credits')
    expect(m).toContain('80')
    expect(m).toContain('/ 100')
    expect(m).toContain('text-green-500')
    expect(m).toContain('bg-green-500')
    expect(m).toContain('width:80%')
    expect(m).toContain('Credits used today')
    expect(m).toContain('20 of 100')

    answer = { kind: 'data', credits: 25, dailyLimit: 100 }
    m = markup()
    expect(m).toContain('text-yellow-500')
    expect(m).toContain('bg-yellow-500')

    answer = { kind: 'data', credits: 0, dailyLimit: 100 }
    m = markup()
    expect(m).toContain('text-red-500')
    expect(m).toContain('bg-red-500')
    expect(m).toContain('width:0%')
  })

  it('answers the fixed cards: resets, packages teaser and the add-provider link', () => {
    answer = { kind: 'data', credits: 50, dailyLimit: 100 }
    const m = markup()
    expect(m).toContain('Resets daily')
    expect(m).toContain('Midnight UTC')
    expect(m).toContain('Coming soon')
    expect(m).toContain('Additional credit packages will be available soon')
    expect(m).toContain('Want unlimited usage?')
    expect(m).toContain('href="/app.html#/settings/ai"')
    expect(m).toContain('Add Provider')
  })

  it('caps the bar at a full width when the credits exceed the limit', () => {
    answer = { kind: 'data', credits: 150, dailyLimit: 100 }
    const m = markup()
    expect(m).toContain('width:100%')
  })
})
