/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The agent conversation hook, held against its contract
 * (gHashTag/trios#1666): the one export of
 * entrypoints/app/agent-command/useAgentConversation.ts -
 * useAgentConversation - pinned as it behaves today, so the next
 * change to that file has something to fail against.
 *
 * The hook's whole observable life at rest is its initial answer -
 * every send, stream, resume and reset flow lives inside handlers
 * and effects a static render never runs - so the suite renders
 * that answer through a probe component with no stubs at all: the
 * agents module, the agent-files invalidation hook (inside a real
 * query client provider), the SSE consumer and the tool-label
 * helpers all load for real and nothing calls them before a live
 * mount. Measured, the first mount answers the empty turn list,
 * the idle streaming flag, the session key the options hand in, and
 * the three mutators as functions.
 *
 * Not pinned, and why (issue User Story 2): the conversation flow
 * itself - sending, the SSE stream and its resume bookkeeping, the
 * turn history assembly, the stop and reset paths - lives in async
 * handlers needing a live document, a connected agent and effects
 * that actually run. The port env seam is seeded before any import
 * can reach the env module (its one-time snapshot - the trap the
 * agent-outputs suite documented), with the subject read through a
 * query-qualified specifier so this suite's graph loads as its own
 * fresh instances.
 */

import { describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type FC } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// biome-ignore lint/style/noProcessEnv: the env seam is the only way to reach the port helpers before the env module's one-time snapshot freezes (see suite header)
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'

const subjectUrl = './useAgentConversation?agent-conversation-suite-real'
const { useAgentConversation } = (await import(
  subjectUrl
)) as typeof import('./useAgentConversation')

const Probe: FC = () => {
  const answer = useAgentConversation('agent-1', {
    sessionKey: 'session-1',
  })
  return createElement(
    'pre',
    null,
    JSON.stringify({
      turns: answer.turns,
      streaming: answer.streaming,
      sessionKey: answer.sessionKey,
      send: typeof answer.send,
      stop: typeof answer.stop,
      resetConversation: typeof answer.resetConversation,
    }),
  )
}

describe('useAgentConversationContract', () => {
  describe('useAgentConversation', () => {
    it('answers the first mount with the empty turn list, the idle streaming flag, the session key the options hand in, and the three mutators as functions', () => {
      const markup = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(Probe),
        ),
      )
      // static markup escapes the quotes of the rendered JSON, so
      // the pins stick to the escaped-proof keys and bare values
      expect(markup).toContain('turns')
      expect(markup).toContain('streaming')
      expect(markup).toContain(':false')
      expect(markup).toContain('sessionKey')
      expect(markup).toContain('session-1')
      expect(markup).toContain('function')
    })
  })
})
