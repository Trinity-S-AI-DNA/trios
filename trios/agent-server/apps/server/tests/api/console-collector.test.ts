/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The console collector, held against its contract
 * (gHashTag/trios#1663): the single export of
 * browser/console-collector.ts - ConsoleCollector - pinned as it
 * behaves today, so the next change to that file has something to
 * fail against.
 *
 * The collector routes the three console event kinds into per-page
 * buffers (console calls by their type-to-level map, exceptions as
 * errors with the description preferred, browser log entries by the
 * log level map), clears the buffer on a main-frame navigation, and
 * answers getLogs with a severity-threshold filter (measured: the
 * default threshold is 'info', so debug-level entries are hidden
 * unless asked for), a case-insensitive text search, the most recent
 * entries up to the limit, an honest totalCount of the filtered
 * set, and an optional clear. Sessions map to pages at attach time
 * and re-attach replaces the old session; detach forgets the page.
 * Args are serialized space-joined per value.
 *
 * The CdpBackend is a recording fake that hands back the registered
 * handlers, which the suite invokes through a fire() helper. No
 * network, no database, no container.
 */

import { describe, expect, it } from 'bun:test'
import type { CdpBackend } from '../../src/browser/backends/types'
import { ConsoleCollector } from '../../src/browser/console-collector'

type Handler = (params: unknown, sessionId: string) => void
interface FakeCdp {
  cdp: CdpBackend
  handlers: Map<string, Handler>
}

const fakeCdp = (): FakeCdp => {
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    cdp: {
      onSessionEvent: (type: string, handler: Handler) => {
        handlers.set(type, handler)
      },
    } as unknown as CdpBackend,
  }
}

const consoleEvent = (
  type: string,
  args: Array<{ type: string; value?: unknown; description?: string }>,
) => ({ type, args, timestamp: 1000 })

const wired = () => {
  const fake = fakeCdp()
  const collector = new ConsoleCollector(fake.cdp)
  collector.attach(1, 'session-a')
  const fire = (type: string, params: unknown, sessionId = 'session-a') => {
    const handler = fake.handlers.get(type)
    if (handler) handler(params, sessionId)
  }
  return { collector, fire }
}

describe('ConsoleCollector - event routing', () => {
  it('maps console types to levels and serializes the args', () => {
    const { collector, fire } = wired()
    fire(
      'Runtime.consoleAPICalled',
      consoleEvent('error', [{ type: 'string', value: 'boom' }]),
    )
    fire(
      'Runtime.consoleAPICalled',
      consoleEvent('log', [
        { type: 'string', value: 'count:' },
        { type: 'number', value: 42 },
      ]),
    )
    fire(
      'Runtime.consoleAPICalled',
      consoleEvent('trace', [
        { type: 'object', description: 'HTMLDivElement' },
      ]),
    )
    // Measured: getLogs defaults to the 'info' threshold, which hides
    // debug-level entries - the trace entry needs the explicit level.
    expect(collector.getLogs(1).totalCount).toBe(2)
    const logs = collector.getLogs(1, { level: 'debug' })
    expect(logs.totalCount).toBe(3)
    expect(logs.entries[0]).toMatchObject({ level: 'error', text: 'boom' })
    expect(logs.entries[1]).toMatchObject({ level: 'info', text: 'count: 42' })
    expect(logs.entries[2]).toMatchObject({
      level: 'debug',
      text: 'HTMLDivElement',
    })
  })

  it('falls back to info for an unknown console type', () => {
    const { collector, fire } = wired()
    fire(
      'Runtime.consoleAPICalled',
      consoleEvent('future-type', [{ type: 'string', value: 'x' }]),
    )
    expect(collector.getLogs(1).entries[0].level).toBe('info')
  })

  it('records exceptions as errors with the description preferred', () => {
    const { collector, fire } = wired()
    fire('Runtime.exceptionThrown', {
      timestamp: 2000,
      exceptionDetails: {
        text: 'Uncaught',
        exception: { description: 'TypeError: x is not a function' },
        url: 'https://example.com/app.js',
        lineNumber: 42,
      },
    })
    const entry = collector.getLogs(1).entries[0]
    expect(entry).toMatchObject({
      source: 'exception',
      level: 'error',
      text: 'TypeError: x is not a function',
      url: 'https://example.com/app.js',
      lineNumber: 42,
      timestamp: 2000,
    })
  })

  it('records browser log entries by the log level map', () => {
    const { collector, fire } = wired()
    fire('Log.entryAdded', {
      entry: { level: 'verbose', text: 'verbose thing', timestamp: 3000 },
    })
    fire('Log.entryAdded', {
      entry: { level: 'unexpected', text: 'odd thing', timestamp: 3001 },
    })
    const logs = collector.getLogs(1, { level: 'debug' })
    expect(logs.entries[0]).toMatchObject({
      source: 'browser',
      level: 'debug',
      text: 'verbose thing',
    })
    expect(logs.entries[1].level).toBe('info')
  })

  it('clears the buffer on a main-frame navigation but not a child frame', () => {
    const { collector, fire } = wired()
    fire(
      'Runtime.consoleAPICalled',
      consoleEvent('log', [{ type: 'string', value: 'before' }]),
    )
    fire('Page.frameNavigated', { frame: { parentId: 'frame-1' } })
    expect(collector.getLogs(1).totalCount).toBe(1)

    fire('Page.frameNavigated', { frame: {} })
    expect(collector.getLogs(1).totalCount).toBe(0)
  })
})

describe('ConsoleCollector - sessions', () => {
  it('ignores events from an unknown session', () => {
    const { collector, fire } = wired()
    fire(
      'Runtime.consoleAPICalled',
      consoleEvent('log', [{ type: 'string', value: 'x' }]),
      'unknown-session',
    )
    expect(collector.getLogs(1).totalCount).toBe(0)
  })

  it('replaces the old session on re-attach', () => {
    const { collector, fire } = wired()
    collector.attach(1, 'session-b')
    fire(
      'Runtime.consoleAPICalled',
      consoleEvent('log', [{ type: 'string', value: 'old' }]),
    )
    fire(
      'Runtime.consoleAPICalled',
      consoleEvent('log', [{ type: 'string', value: 'new' }]),
      'session-b',
    )
    const logs = collector.getLogs(1)
    expect(logs.totalCount).toBe(1)
    expect(logs.entries[0].text).toBe('new')
  })

  it('forgets the page on detach', () => {
    const { collector, fire } = wired()
    collector.detach(1)
    fire(
      'Runtime.consoleAPICalled',
      consoleEvent('log', [{ type: 'string', value: 'late' }]),
    )
    expect(collector.getLogs(1)).toEqual({ entries: [], totalCount: 0 })
  })
})

describe('ConsoleCollector - getLogs', () => {
  it('filters by severity threshold, search and recency limit', () => {
    const { collector, fire } = wired()
    for (const [type, text] of [
      ['error', 'disk failure'],
      ['log', 'normal message'],
      ['error', 'network failure'],
    ] as const) {
      fire(
        'Runtime.consoleAPICalled',
        consoleEvent(type, [{ type: 'string', value: text }]),
      )
    }
    expect(collector.getLogs(1).totalCount).toBe(3)
    expect(collector.getLogs(1, { level: 'error' }).totalCount).toBe(2)
    expect(collector.getLogs(1, { search: 'FAILURE' }).totalCount).toBe(2)
    expect(
      collector.getLogs(1, { search: 'failure', level: 'error' }).totalCount,
    ).toBe(2)
    expect(
      collector.getLogs(1, { search: 'normal', level: 'error' }).totalCount,
    ).toBe(0)
  })

  it('answers the most recent entries up to the limit, clears on request', () => {
    const { collector, fire } = wired()
    for (let i = 0; i < 60; i++) {
      fire(
        'Runtime.consoleAPICalled',
        consoleEvent('log', [{ type: 'string', value: `entry-${i}` }]),
      )
    }
    const paged = collector.getLogs(1)
    expect(paged.entries.length).toBe(50)
    expect(paged.totalCount).toBe(60)
    expect(paged.entries[0].text).toBe('entry-10')
    expect(paged.entries[49].text).toBe('entry-59')

    expect(collector.getLogs(1, { clear: true }).totalCount).toBe(60)
    expect(collector.getLogs(1).totalCount).toBe(0)
  })
})
