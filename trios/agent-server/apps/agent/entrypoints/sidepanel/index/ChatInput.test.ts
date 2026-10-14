/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The sidepanel chat input, held against its contract
 * (gHashTag/trios#1506): the one export of
 * entrypoints/sidepanel/index/ChatInput.tsx - ChatInput - pinned as
 * it behaves today, so the next change to that file has something to
 * fail against.
 *
 * The component is a forwardRef with hooks, so the pins read a
 * static render of it - measured, the render goes through with the
 * tab-picker and voice seams left real (the picker stays closed, the
 * voice state is absent). The pins read the placeholder contract for
 * the mode handed in: the chat mode asks about this page, the agent
 * mode asks what it should do, and a transcribing voice state wins
 * over both.
 *
 * Not pinned, and why (issue User Story 2): the typing flow - the
 * tab-mention editing, the key handling, the imperative handle, the
 * submit and stop wiring - they live in handlers and effects that
 * need a live document and window. The port env seam is seeded
 * before any import can reach the env module (its one-time snapshot
 * - the trap the agent-outputs suite documented), with the subject
 * imported dynamically for that reason.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { VoiceInputState } from '@/lib/voice/useVoiceInput'

// biome-ignore lint/style/noProcessEnv: the env seam is the only way to reach the port helpers before the env module's one-time snapshot freezes (see suite header)
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'

const values = new Map<string, unknown>()

mock.module('@wxt-dev/storage', () => ({
  storage: {
    defineItem: (key: string, opts?: unknown) => ({
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
    }),
  },
}))

const { ChatInput } = await import('./ChatInput')

const markup = (
  over: { mode?: 'chat' | 'agent'; voice?: VoiceInputState } = {},
) =>
  renderToStaticMarkup(
    createElement(ChatInput, {
      input: '',
      status: 'ready',
      mode: over.mode ?? 'agent',
      onInputChange: () => {},
      onSubmit: () => {},
      onStop: () => {},
      selectedTabs: [],
      onToggleTab: () => {},
      voice: over.voice,
    }),
  )

describe('ChatInputTsxContract', () => {
  describe('ChatInput', () => {
    it('answers the input for the mode handed in: the chat mode asks about this page, the agent mode asks what it should do, and a transcribing voice wins over both', () => {
      const chat = markup({ mode: 'chat' })
      expect(chat).toContain('Ask about this page')

      const agent = markup({ mode: 'agent' })
      expect(agent).toContain('What should I do?')
      expect(agent).not.toContain('Ask about this page')

      const transcribing = markup({
        mode: 'agent',
        voice: {
          isRecording: false,
          isTranscribing: true,
          audioLevels: [],
          error: null,
          onStartRecording: () => {},
          onStopRecording: () => {},
        },
      })
      expect(transcribing).toContain('Transcribing...')
      expect(transcribing).toContain('disabled')
    })
  })
})
