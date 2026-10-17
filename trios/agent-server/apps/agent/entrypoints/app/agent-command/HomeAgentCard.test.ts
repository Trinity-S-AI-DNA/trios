/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The home agent card, held against its contract
 * (gHashTag/trios#1559): the one export of
 * entrypoints/app/agent-command/HomeAgentCard.tsx - HomeAgentCard -
 * pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * The card is a hook-free render function of the agent it is handed,
 * so the suite calls it directly (the button it answers carries the
 * click callback by identity - read from the element it returns) and
 * renders it with renderToStaticMarkup for each state the agent
 * answers: the working card with its amber badge and the now
 * footnote, the idle card with the preview line and the relative
 * last-used copy, the asleep card with its outline badge, the error
 * card with the Attention badge, the resume chip for an in-flight
 * turn, the unavailable chip when the adapter health is false, and
 * the accent ring when the card is the active one.
 *
 * Not pinned, and why: the error text - it lives inside a hover card
 * that opens only on a live document; the Attention badge it
 * replaces is what the static pin reads. No mocks at all; no suite
 * of this job mocks any module in this subject's import graph.
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { HomeAgentCard } from './HomeAgentCard'

type CardProps = Parameters<typeof HomeAgentCard>[0]

const baseAgent: CardProps['agent'] = {
  id: 'agent-1',
  name: 'Research Bot',
  adapter: 'claude',
  permissionMode: 'approve-all',
  sessionKey: 's1',
  createdAt: 1,
  updatedAt: 2,
  modelId: 'sonnet-4-5',
  reasoningEffort: 'high',
  lastUserMessage: 'Find the pricing page',
  lastUsedAt: Date.now() - 5 * 60 * 1000,
}

const markup = (
  agent: Partial<CardProps['agent']>,
  extra: Partial<CardProps> = {},
) =>
  renderToStaticMarkup(
    createElement(HomeAgentCard, {
      agent: { ...baseAgent, ...agent } as CardProps['agent'],
      adapter: 'claude',
      adapterHealth: null,
      onClick: () => {},
      ...extra,
    }),
  )

describe('HomeAgentCardTsxContract', () => {
  describe('HomeAgentCard', () => {
    it('answers the button wired to the click callback, and the card for every agent state: working, idle with its preview, asleep, error attention, resumable, unhealthy adapter, and the active ring', () => {
      const onClick = () => {}
      const card = HomeAgentCard({
        agent: { ...baseAgent, status: 'working' },
        adapter: 'claude',
        adapterHealth: null,
        onClick,
      }) as { props: { onClick: () => void } }
      expect(card.props.onClick).toBe(onClick)

      const working = markup({ status: 'working' })
      expect(working).toContain('Research Bot')
      expect(working).toContain('Working')
      expect(working).toContain('sonnet-4-5')
      expect(working).toContain('now')

      const idle = markup({ status: 'idle' })
      expect(idle).toContain('Find the pricing page')
      expect(idle).toContain('min ago')

      const asleep = markup({ status: 'asleep' })
      expect(asleep).toContain('Asleep')

      const errored = markup({ status: 'error', lastError: 'gateway died' })
      expect(errored).toContain('Attention')

      const resumable = markup({ status: 'idle', activeTurnId: 'turn-9' })
      expect(resumable).toContain('Resume')

      const unhealthy = markup(
        { status: 'idle' },
        {
          adapterHealth: { healthy: false, reason: 'missing', checkedAt: 1 },
        },
      )
      expect(unhealthy).toContain('Unavailable')

      const active = markup({ status: 'idle' }, { active: true })
      expect(active).toContain('ring-1')
    })
  })
})
