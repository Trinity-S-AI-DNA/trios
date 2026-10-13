/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The OpenClaw gateway hooks, held against their contract
 * (gHashTag/trios#1533): the six exports of
 * entrypoints/app/agents/useOpenClaw.ts - getModelDisplayName,
 * OPENCLAW_QUERY_KEYS, useOpenClawStatus, useOpenClawAgents,
 * useOpenClawMutations, buildChatHistoryFromTurns - pinned as they
 * behave today, so the next change to that file has something to fail
 * against.
 *
 * The three data hooks render through React Query, so the suite runs
 * each one inside a fresh QueryClientProvider with renderToStaticMarkup
 * (a React element tree needs no DOM). Outside the BrowserOS shell the
 * agent server URL hook answers no base URL, so both queries stay
 * disabled - and a disabled query still reads the cache, which is how
 * the pins drive the data path without any network: seed the cache
 * under the very key the hook declares, and the fixture must flow out.
 * The suite installs no mocks of its own, and the pins read only what
 * holds no matter which stand-ins other suites of this job register:
 * with no base URL the status answers null and the agents an empty
 * list; with cache under the declared key the data flows through.
 */

import { describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  buildChatHistoryFromTurns,
  getModelDisplayName,
  OPENCLAW_QUERY_KEYS,
  useOpenClawAgents,
  useOpenClawMutations,
  useOpenClawStatus,
} from './useOpenClaw'

const renderProbe = (probe: () => React.ReactNode, client: QueryClient) =>
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(probe)),
  )

describe('useOpenClawContract', () => {
  describe('getModelDisplayName', () => {
    it('answers the last path segment of a model string and nothing for other values', () => {
      expect(getModelDisplayName('openai/gpt-4o')).toBe('gpt-4o')
      expect(getModelDisplayName('sonnet')).toBe('sonnet')
      expect(getModelDisplayName(42)).toBeUndefined()
      expect(getModelDisplayName(null)).toBeUndefined()
      expect(getModelDisplayName({})).toBeUndefined()
    })
  })

  describe('OPENCLAW_QUERY_KEYS', () => {
    it('names the two cache keys the hooks and the invalidations share', () => {
      expect(OPENCLAW_QUERY_KEYS.status).toBe('openclaw-status')
      expect(OPENCLAW_QUERY_KEYS.agents).toBe('openclaw-agents')
    })
  })

  describe('useOpenClawStatus', () => {
    it('answers no status without a base URL, and flows the cached status through once the cache holds it', () => {
      const client = new QueryClient()
      const probe = () => {
        const { status } = useOpenClawStatus()
        return createElement(
          'pre',
          null,
          status === null
            ? 'no-status'
            : `status:${status.status}:${status.agentCount}`,
        )
      }
      expect(renderProbe(probe, client)).toContain('no-status')

      client.setQueryData([OPENCLAW_QUERY_KEYS.status, null], {
        status: 'running',
        podmanAvailable: true,
        machineReady: true,
        port: 8080,
        agentCount: 7,
        error: null,
        controlPlaneStatus: 'connected',
        lastGatewayError: null,
        lastRecoveryReason: null,
      })
      expect(renderProbe(probe, client)).toContain('status:running:7')
    })
  })

  describe('useOpenClawAgents', () => {
    it('answers an empty list without a base URL, and flows the cached agents through once the cache holds them', () => {
      const client = new QueryClient()
      const probe = () => {
        const { agents } = useOpenClawAgents()
        return createElement(
          'pre',
          null,
          agents.length === 0
            ? 'no-agents'
            : `agents:${agents.map((agent) => agent.name).join(',')}`,
        )
      }
      expect(renderProbe(probe, client)).toContain('no-agents')

      client.setQueryData(
        [OPENCLAW_QUERY_KEYS.agents, null],
        [
          {
            id: 'a1',
            name: 'Research Bot',
          },
        ],
      )
      expect(renderProbe(probe, client)).toContain('Research Bot')
    })
  })

  describe('useOpenClawMutations', () => {
    it('answers every lifecycle action ready and none in progress outside the shell', () => {
      const client = new QueryClient()
      const probe = () => {
        const mutations = useOpenClawMutations()
        const ready = [
          mutations.setupOpenClaw,
          mutations.createAgent,
          mutations.deleteAgent,
          mutations.startOpenClaw,
          mutations.stopOpenClaw,
          mutations.restartOpenClaw,
          mutations.reconnectOpenClaw,
        ].every((action) => typeof action === 'function')
        return createElement(
          'pre',
          null,
          [
            String(mutations.actionInProgress),
            String(mutations.pendingGatewayAction),
            String(ready),
          ].join('|'),
        )
      }
      expect(renderProbe(probe, client)).toContain('false|null|true')
    })
  })

  describe('buildChatHistoryFromTurns', () => {
    it('pairs each turn user text with its joined text parts, skipping what is blank or not text', () => {
      expect(
        buildChatHistoryFromTurns([
          {
            userText: '  build the site  ',
            parts: [
              { kind: 'text', text: ' done ' },
              { kind: 'image' },
              { kind: 'text', text: '' },
              { kind: 'text', text: 'and shipped' },
            ],
          },
        ]),
      ).toEqual([
        { role: 'user', content: 'build the site' },
        { role: 'assistant', content: 'done\n\nand shipped' },
      ])

      expect(
        buildChatHistoryFromTurns([
          {
            userText: '',
            parts: [{ kind: 'text', text: 'only the answer' }],
          },
          {
            userText: 'next question',
            parts: [{ kind: 'thinking', text: 'not shown' }],
          },
        ]),
      ).toEqual([
        { role: 'assistant', content: 'only the answer' },
        { role: 'user', content: 'next question' },
      ])
    })
  })
})
