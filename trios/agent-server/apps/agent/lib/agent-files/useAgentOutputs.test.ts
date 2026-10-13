/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The agent-outputs hooks, held against their contract
 * (gHashTag/trios#1670): the four exports of
 * lib/agent-files/useAgentOutputs.ts - useAgentOutputs,
 * useAgentTurnFiles, useInvalidateAgentOutputs,
 * useRefreshAgentOutputs - pinned as they behave today, so the next
 * change to that file has something to fail against.
 *
 * Every export is a React Query hook, so the suite runs each one
 * inside a fresh QueryClientProvider with renderToStaticMarkup (a
 * React element tree needs no DOM). Outside the BrowserOS shell the
 * agent server URL hook answers no base URL, so both queries stay
 * disabled - and a disabled query still reads the cache, which is
 * how the data-path pins drive everything without any network: seed
 * the cache under the very key the hook declares, and the fixture
 * must flow out. The invalidator and the refresh are captured from
 * the render and then driven against the real cache afterwards:
 * invalidation is read from each entry's isInvalidated mark (the
 * default stale time of zero makes isStale meaningless here), and
 * the refresh is awaited with nothing in the cache to refetch.
 *
 * The pins read only what holds no matter which stand-ins other
 * suites of this job register for the URL hook: the base URL is
 * null either way, so the data flow and the cache marks are
 * identical; the loading flag is the one thing that varies, so it
 * is not pinned. Not pinned, and why: the fetch paths themselves
 * (queryFn through agentsFetch) - they need the live agent server.
 */

import { describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AGENT_QUERY_KEYS } from '@/entrypoints/app/agents/useAgents'
import {
  useAgentOutputs,
  useAgentTurnFiles,
  useInvalidateAgentOutputs,
  useRefreshAgentOutputs,
} from './useAgentOutputs'

const railGroup = (turnId: string) => ({
  turnId,
  turnPrompt: 'Build the report',
  createdAt: 1,
  files: [],
})

const producedFile = (id: string) => ({
  id,
  path: `/jobs/${id}.md`,
  size: 512,
  mtimeMs: 1,
  createdAt: 1,
  detectedBy: 'diff' as const,
})

const renderWith = (client: QueryClient, probe: () => React.ReactNode) =>
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(probe)),
  )

describe('useAgentOutputsContract', () => {
  describe('useAgentOutputs', () => {
    it('answers no groups without a base URL, and flows the cached groups through once the cache holds them under its key', () => {
      const client = new QueryClient()
      const probe = () => {
        const { groups } = useAgentOutputs('agent-1')
        return createElement(
          'pre',
          null,
          groups.length === 0
            ? 'no-groups'
            : `groups:${groups.map((group) => group.turnId).join(',')}`,
        )
      }
      expect(renderWith(client, probe)).toContain('no-groups')

      client.setQueryData(
        [AGENT_QUERY_KEYS.agentOutputs, null, 'agent-1'],
        [railGroup('turn-1'), railGroup('turn-2')],
      )
      expect(renderWith(client, probe)).toContain('groups:turn-1,turn-2')
    })
  })

  describe('useAgentTurnFiles', () => {
    it('answers no files without a base URL, and flows the cached turn files through for the very turn asked about', () => {
      const client = new QueryClient()
      const probe = (turnId: string | null) => () => {
        const { files } = useAgentTurnFiles('agent-1', turnId)
        return createElement(
          'pre',
          null,
          files.length === 0
            ? 'no-files'
            : `files:${files.map((file) => file.id).join(',')}`,
        )
      }
      expect(renderWith(client, probe('turn-1'))).toContain('no-files')

      client.setQueryData(
        [AGENT_QUERY_KEYS.agentTurnFiles, null, 'agent-1', 'turn-1'],
        [producedFile('f1'), producedFile('f2')],
      )
      expect(renderWith(client, probe('turn-1'))).toContain('files:f1,f2')
      expect(renderWith(client, probe('turn-9'))).toContain('no-files')
    })
  })

  describe('useInvalidateAgentOutputs', () => {
    it("invalidates one agent's outputs and only the turn asked about, leaving every other agent untouched", async () => {
      const client = new QueryClient()
      let invalidate: undefined | ReturnType<typeof useInvalidateAgentOutputs>
      const probe = () => {
        invalidate = useInvalidateAgentOutputs()
        return createElement('pre', null, 'ready')
      }
      renderWith(client, probe)
      expect(typeof invalidate).toBe('function')

      client.setQueryData(
        [AGENT_QUERY_KEYS.agentOutputs, null, 'agent-1'],
        [railGroup('turn-1')],
      )
      client.setQueryData(
        [AGENT_QUERY_KEYS.agentOutputs, null, 'agent-2'],
        [railGroup('turn-2')],
      )
      client.setQueryData(
        [AGENT_QUERY_KEYS.agentTurnFiles, null, 'agent-1', 'turn-1'],
        [producedFile('f1')],
      )
      client.setQueryData(
        [AGENT_QUERY_KEYS.agentTurnFiles, null, 'agent-1', 'turn-2'],
        [producedFile('f2')],
      )
      client.setQueryData(
        [AGENT_QUERY_KEYS.agentTurnFiles, null, 'agent-2', 'turn-9'],
        [producedFile('f9')],
      )

      await invalidate?.('agent-1', 'turn-1')
      expect(
        client.getQueryState([AGENT_QUERY_KEYS.agentOutputs, null, 'agent-1'])
          ?.isInvalidated,
      ).toBe(true)
      expect(
        client.getQueryState([AGENT_QUERY_KEYS.agentOutputs, null, 'agent-2'])
          ?.isInvalidated,
      ).toBe(false)
      expect(
        client.getQueryState([
          AGENT_QUERY_KEYS.agentTurnFiles,
          null,
          'agent-1',
          'turn-1',
        ])?.isInvalidated,
      ).toBe(true)
      expect(
        client.getQueryState([
          AGENT_QUERY_KEYS.agentTurnFiles,
          null,
          'agent-1',
          'turn-2',
        ])?.isInvalidated,
      ).toBe(false)

      await invalidate?.('agent-2')
      expect(
        client.getQueryState([AGENT_QUERY_KEYS.agentOutputs, null, 'agent-2'])
          ?.isInvalidated,
      ).toBe(true)
      expect(
        client.getQueryState([
          AGENT_QUERY_KEYS.agentTurnFiles,
          null,
          'agent-2',
          'turn-9',
        ])?.isInvalidated,
      ).toBe(true)
      expect(
        client.getQueryState([
          AGENT_QUERY_KEYS.agentTurnFiles,
          null,
          'agent-1',
          'turn-2',
        ])?.isInvalidated,
      ).toBe(false)
    })
  })

  describe('useRefreshAgentOutputs', () => {
    it('answers the refresh mutation ready and idle, and it resolves when there is nothing in the cache to refetch', async () => {
      const client = new QueryClient()
      let mutation: undefined | ReturnType<typeof useRefreshAgentOutputs>
      const probe = () => {
        mutation = useRefreshAgentOutputs('agent-9')
        return createElement('pre', null, 'ready')
      }
      renderWith(client, probe)

      expect(typeof mutation?.mutateAsync).toBe('function')
      expect(mutation?.isPending).toBe(false)
      await mutation?.mutateAsync()
      expect(mutation?.isPending).toBe(false)
    })
  })
})
