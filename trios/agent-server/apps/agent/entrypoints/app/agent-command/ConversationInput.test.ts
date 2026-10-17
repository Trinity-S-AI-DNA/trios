/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The conversation input, held against its contract
 * (gHashTag/trios#1495): the one export of
 * entrypoints/app/agent-command/ConversationInput.tsx -
 * ConversationInput - pinned as it behaves today, so the next change
 * to that file has something to fail against.
 *
 * The composer reads the seam family this wave has pinned
 * elsewhere, so each is stubbed with the same full stand-ins: the
 * capabilities, workspace, MCP store, user integrations and voice
 * hooks, the metrics track (a no-op - its real module pulls the
 * adapter graph other suites stub incompletely), and the
 * attachment staging seam (kept real - its limits are pinned by the
 * attachments suite of this wave; the staging itself only runs on
 * a real file drop). Measured, the static render goes through and
 * shows the composer as it first mounts.
 *
 * Not pinned, and why (issue User Story 2): the typing flow - the
 * send path, the attachment staging, the voice capture and the
 * tab picker - they live in handlers that need a live document and
 * window. The port env seam is seeded before any import can reach
 * the env module (its one-time snapshot - the trap the
 * agent-outputs suite documented), with the subject imported
 * dynamically for that reason.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// biome-ignore lint/style/noProcessEnv: the env seam is the only way to reach the port helpers before the env module's one-time snapshot freezes (see suite header)
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'

const values = new Map<string, unknown>()

const fakeItem = (key: string, opts: unknown) => ({
  getValue: async () => {
    if (values.has(key)) {
      return values.get(key)
    }
    const fallback = (opts as { fallback?: unknown } | undefined)?.fallback
    return fallback ?? null
  },
  setValue: async (value: unknown) => {
    values.set(key, value)
  },
  watch: () => () => {},
})

mock.module('@wxt-dev/storage', () => ({
  storage: {
    defineItem: (key: string, opts?: unknown) => fakeItem(key, opts),
  },
}))

mock.module('@/lib/browseros/useCapabilities', () => ({
  useCapabilities: () => ({ supports: () => false }),
}))

mock.module('@/lib/workspace/use-workspace', () => ({
  useWorkspace: () => ({
    recentFolders: [],
    selectedFolder: null,
    selectFolder: () => {},
    addFolder: () => {},
    removeFolder: () => {},
    clearSelection: () => {},
  }),
}))

mock.module('@/lib/mcp/mcpServerStorage', () => ({
  McpServer: class {},
  mcpServerStorage: fakeItem('local:mcp-servers', { fallback: [] }),
  useMcpServers: () => ({
    servers: [],
    addServer: () => {},
    removeServer: () => {},
  }),
}))

mock.module('@/entrypoints/app/connect-mcp/useGetUserMCPIntegrations', () => ({
  INTEGRATIONS_QUERY_KEY: 'klavis-user-integrations',
  useGetUserMCPIntegrations: () => ({
    data: undefined,
    isLoading: false,
    isFetching: false,
    isSuccess: true,
    mutate: () => {},
  }),
}))

mock.module('@/lib/voice/useVoiceInput', () => ({
  useVoiceInput: () => ({
    isRecording: false,
    isTranscribing: false,
    transcript: '',
    audioLevel: 0,
    audioLevels: [],
    error: null,
    startRecording: async () => false,
    stopRecording: async () => {},
    clearTranscript: () => {},
  }),
}))

mock.module('@/lib/metrics/track', () => ({
  track: () => {},
}))

const { ConversationInput } = await import('./ConversationInput')

const markup = (
  over: { selectedAgentId?: string | null; placeholder?: string } = {},
) =>
  renderToStaticMarkup(
    createElement(ConversationInput, {
      agents: [
        {
          agentId: 'agent-1',
          name: 'Research Bot',
        } as unknown as Parameters<
          typeof ConversationInput
        >[0]['agents'][number],
      ],
      selectedAgentId: over.selectedAgentId ?? null,
      onSelectAgent: () => {},
      onSend: () => {},
      streaming: false,
      placeholder: over.placeholder,
    }),
  )

describe('ConversationInputTsxContract', () => {
  describe('ConversationInput', () => {
    it('answers the composer as it first mounts: the textarea naming the selected agent, or the placeholder handed in', () => {
      const withAgent = markup({ selectedAgentId: 'agent-1' })
      expect(withAgent).toContain('Message Research Bot')

      const withoutAgent = markup({ selectedAgentId: null })
      expect(withoutAgent).toContain('Message agent')

      const custom = markup({ placeholder: 'Ask anything' })
      expect(custom).toContain('Ask anything')
    })
  })
})
