/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The conversation outputs rail, held against its contract
 * (gHashTag/trios#1526): the two exports of
 * entrypoints/app/agent-command/agent-conversation.outputs-rail.tsx -
 * useOutputsRailOpen and OutputsRail - pinned as they behave today,
 * so the next change to that file has something to fail against.
 *
 * OutputsRail renders through hooks (its data hooks, its own state),
 * so the suite renders it with renderToStaticMarkup - a React element
 * tree needs no DOM - inside a fresh QueryClientProvider, which the
 * file preview sheet the rail mounts needs. The data seam is a full
 * stand-in for @/lib/agent-files: every real value export of the
 * module (read through a query-qualified specifier, so no other
 * suite's stand-in can be in the way) with only the two data hooks
 * stubbed, so the rail's own rendering - the header count, the
 * per-turn groups, the real basename/size/kind helpers on each file
 * chip - is what the pins read, in all four states the rail has.
 *
 * Not pinned, and why (issue User Story 2): useOutputsRailOpen. Its
 * contract is the per-agent open memory in localStorage, and the
 * hook's own effect guards on window being defined - measured, this
 * group has no window at all, so even a mounted render never runs
 * the memory, and what remains would pin nothing but the first
 * useState line. Exercising the memory needs a mounted window with
 * localStorage, which this group does not have.
 */

import { describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const realAgentFilesUrl = '../../../lib/agent-files?outputs-rail-real'
const realAgentFiles = (await import(realAgentFilesUrl)) as Record<
  string,
  unknown
>

const producedFile = (id: string, path: string, size: number) => ({
  id,
  path,
  size,
  mtimeMs: 1,
  createdAt: 1,
  detectedBy: 'diff' as const,
})

let railState: {
  groups: Array<{
    turnId: string
    turnPrompt: string
    createdAt: number
    files: Array<ReturnType<typeof producedFile>>
  }>
  loading: boolean
  error: Error | null
} = { groups: [], loading: false, error: null }

const refreshStub = { mutate: () => {}, isPending: false }

mock.module('@/lib/agent-files', () => ({
  ...realAgentFiles,
  useAgentOutputs: () => railState,
  useRefreshAgentOutputs: () => refreshStub,
}))

const { OutputsRail } = await import('./agent-conversation.outputs-rail')

const client = new QueryClient()

const markup = () =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(OutputsRail, { agentId: 'agent-1', onClose: () => {} }),
    ),
  )

describe('agentConversationOutputsRailTsxContract', () => {
  describe('OutputsRail', () => {
    it('shows the header with the file count and the real chip labels while loaded, the empty note without files, the failure text on error, and the skeleton while loading', () => {
      railState = {
        groups: [
          {
            turnId: 'turn-1',
            turnPrompt: 'Ship the report',
            createdAt: 1,
            files: [
              producedFile('f1', '/jobs/report.md', 1536),
              producedFile('f2', '/jobs/chart.png', 512),
            ],
          },
        ],
        loading: false,
        error: null,
      }
      const loaded = markup()
      expect(loaded).toContain('Outputs')
      expect(loaded).toContain('>2<')
      expect(loaded).toContain('Ship the report')
      expect(loaded).toContain('report.md')
      expect(loaded).toContain('1.5 KB')
      expect(loaded).toContain('chart.png')
      expect(loaded).toContain('512 B')
      expect(loaded).toContain('title="/jobs/report.md"')

      railState = { groups: [], loading: false, error: null }
      const empty = markup()
      expect(empty).toContain('No outputs yet')
      expect(empty).not.toContain('Ship the report')

      railState = {
        groups: [],
        loading: false,
        error: new Error('The agent outputs could not be loaded'),
      }
      expect(markup()).toContain('The agent outputs could not be loaded')

      railState = { groups: [], loading: true, error: null }
      const loading = markup()
      expect(loading).toContain('animate-pulse')
      expect(loading).not.toContain('No outputs yet')
    })
  })
})
