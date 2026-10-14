/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The chat error card, held against its contract
 * (gHashTag/trios#1615): the one export of
 * entrypoints/sidepanel/index/ChatError.tsx - ChatError - pinned
 * as it behaves today, so the next change to that file has something
 * to fail against.
 *
 * Everything the card answers rides its props - the message parser
 * and the titles are its own - so the suite needs no stubs at all.
 * Measured, the parser's every branch shows: a fetch failure answers
 * the connection-failed title with the local-server note and the
 * troubleshooting link; the gateway's exhausted credits answer the
 * daily-limit title with the midnight note and the usage link; the
 * BrowserOS daily limit answers the key suggestion with the learn
 * link and the survey link carrying the experiment prefix; a
 * JSON-wrapped provider error answers the plain title with the
 * unwrapped message and the URL lifted out of it into the link;
 * and the retry callback draws the try-again button.
 *
 * Not pinned, and why (issue User Story 2): the flows the callbacks
 * own - the retry press and the link navigation - need a live
 * document; the survey's random direction is pinned only by its
 * stable prefix, the draw itself being random. The subject is read
 * through a query-qualified specifier so this suite's graph loads
 * as its own fresh instances.
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const subjectUrl = './ChatError?chat-error-suite-real'
const { ChatError } = (await import(subjectUrl)) as typeof import('./ChatError')

const renderError = (message: string, providerType?: string) =>
  renderToStaticMarkup(
    createElement(ChatError, {
      error: new Error(message),
      providerType,
      onRetry: () => {},
    }),
  )

describe('ChatErrorTsxContract', () => {
  describe('ChatError', () => {
    it('answers every branch of the message parser: the fetch failure with the connection title and troubleshooting link, the exhausted credits with the daily-limit title and usage link, the BrowserOS daily limit with the key suggestion and survey link, the JSON-wrapped provider error with the lifted URL, and the retry button', () => {
      const connection = renderError('TypeError: Failed to fetch')
      expect(connection).toContain('Connection failed')
      expect(connection).toContain(
        'Unable to connect to BrowserOS agent. Follow below instructions.',
      )
      expect(connection).toContain('View troubleshooting guide')

      const credits = renderError('CREDITS_EXHAUSTED for today', 'browseros')
      expect(credits).toContain('Daily limit reached')
      expect(credits).toContain(
        'Daily credits exhausted. Credits reset at midnight UTC.',
      )
      // static markup escapes the ampersand, so the pin stops before it
      expect(credits).toContain('View Usage')

      const dailyLimit = renderError(
        'BrowserOS LLM daily limit reached',
        'browseros',
      )
      expect(dailyLimit).toContain('Add your own API key for unlimited usage.')
      expect(dailyLimit).toContain('Learn more')
      expect(dailyLimit).toContain('take a quick survey')
      expect(dailyLimit).toContain('experimentId=daily_limit_')

      const wrapped = renderError(
        JSON.stringify({
          error: { message: 'boom happened see https://x.test/y' },
        }),
      )
      expect(wrapped).toContain('Something went wrong')
      expect(wrapped).toContain('boom happened see')

      expect(connection).toContain('Try again')
    })
  })
})
