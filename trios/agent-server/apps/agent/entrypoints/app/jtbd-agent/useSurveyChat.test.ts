/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The JTBD survey chat, held against its contract
 * (gHashTag/trios#1565): the one export of
 * entrypoints/app/jtbd-agent/useSurveyChat.ts - useChat - pinned as
 * it behaves today, so the next change to that file has something
 * to fail against.
 *
 * The hook answers its interview through a live JTBD API with an SSE
 * stream - the start and respond paths are live dependencies this
 * group does not have (and the no-network rule forbids faking
 * remotely). What the pins read is the render-time contract every
 * consumer starts from, measured through a static render: the
 * interview begins idle with no messages, nothing streaming and no
 * error, and every action the hook answers is ready - start,
 * respond, stop and reset.
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useChat } from './useSurveyChat'

describe('useSurveyChatContract', () => {
  describe('useChat', () => {
    it('answers the idle interview with no messages, nothing streaming and no error, and every action ready', () => {
      const markup = renderToStaticMarkup(
        createElement(() => {
          const {
            phase,
            messages,
            isStreaming,
            error,
            start,
            respond,
            stop,
            reset,
          } = useChat()
          const ready = [start, respond, stop, reset].every(
            (action) => typeof action === 'function',
          )
          return createElement(
            'pre',
            null,
            [
              phase,
              String(messages.length),
              String(isStreaming),
              String(error === null),
              String(ready),
            ].join('|'),
          )
        }),
      )
      expect(markup).toContain('idle|0|false|true|true')
    })
  })
})
