/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The conversation header, held against its contract
 * (gHashTag/trios#1601): the single export of
 * entrypoints/app/agent-command/ConversationHeader.tsx -
 * ConversationHeader - pinned as it behaves today, so the next change
 * to that file has something to fail against.
 *
 * The header is a pure presentational strip (every branch rides its
 * props; the chips and the pin toggle are sibling components the row
 * suites own). Pinned: the fallback answer (the fallback name, the
 * mobile back button with its label, the Setup pill, no pin toggle, no
 * meta); the live-agent answer (the agent's name, the pin toggle, the
 * meta line - the measured relative time, the lifetime tokens through
 * the real formatter (2.0M tokens), the queued count - and the
 * headerExtra slot); the back-target icon dispatch (home vs page); the
 * status pill dispatch (working amber with the pulse, asleep muted,
 * error destructive, idle emerald Ready, unknown Setup - plus the
 * defensive idle+activeTurn fallthrough to working); and the meta
 * line's singular/plural queued forms. Not pinned: the pin toggle's
 * and the back button's clicks, and the chips' internals.
 */
import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { HarnessAgent } from '../agents/agent-harness-types'
import { ConversationHeader } from './ConversationHeader'

const baseProps = {
  fallbackName: 'My Agent',
  fallbackAdapter: 'claude' as const,
  adapterHealth: null,
  backLabel: 'Agents',
  backTarget: 'home' as const,
  onGoHome: () => {},
  onPinToggle: () => {},
}

const markup = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(
      ConversationHeader as never,
      {
        ...baseProps,
        agent: null,
        ...over,
      } as never,
    ),
  )

const agent = (over: Record<string, unknown> = {}) =>
  ({
    name: 'Real Agent',
    adapter: 'codex',
    status: 'working',
    lastUsedAt: Date.now() - 3_600_000,
    pinned: true,
    queue: ['a', 'b'],
    tokens: { cumulative: { input: 1_500_000, output: 500_000 } },
    modelId: 'gpt-x',
    reasoningEffort: 'high',
    ...over,
  }) as unknown as HarnessAgent

describe('conversationHeaderContract', () => {
  it('answers the fallback: the fallback name, the back button, the Setup pill and no pin toggle', () => {
    const m = markup()
    expect(m).toContain('My Agent')
    expect(m).toContain('title="Agents"')
    expect(m).toContain('lucide-house')
    expect(m).toContain('Setup')
    expect(m).not.toContain('Ready')
    expect(m).not.toContain('pin')
  })

  it('answers the live agent: its name, the pin toggle, the measured meta line and the extra slot', () => {
    const m = markup({
      agent: agent(),
      headerExtra: createElement('button', {
        type: 'button' as const,
        title: 'rail',
      }),
    })
    expect(m).toContain('Real Agent')
    expect(m).toContain('title="rail"')
    expect(m).toContain('1 hr ago')
    expect(m).toContain('2.0M tokens')
    expect(m).toContain('2 queued')
    expect(m).toContain('Working')
    expect(m).toContain('animate-pulse')
  })

  it('answers the back-target icon dispatch', () => {
    expect(markup()).toContain('lucide-house')
    expect(markup({ backTarget: 'page' })).toContain('lucide-arrow-left')
  })

  it('answers the status pill dispatch through its states', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ status: 'asleep' }, 'Asleep'],
      [{ status: 'error' }, 'Attention'],
      [{ status: 'idle' }, 'Ready'],
      [{ status: 'whatever' }, 'Setup'],
    ]
    for (const [over, label] of cases) {
      const m = markup({
        agent: agent({ ...over, status: over.status as never }),
      })
      expect(m).toContain(label)
    }
    expect(markup({ agent: agent({ status: 'idle' }) })).toContain('emerald')
    expect(
      markup({ agent: agent({ status: 'idle', activeTurnId: 'turn-1' }) }),
    ).toContain('Working')
  })

  it('answers the queued count in its singular and plural forms', () => {
    expect(markup({ agent: agent({ queue: ['a'] }) })).toContain('1 queued')
    const bare = markup({
      agent: agent({ queue: [], tokens: null, lastUsedAt: null }),
    })
    expect(bare).not.toContain('queued')
    expect(bare).not.toContain('tokens')
  })
})
