/**
 * @license AGPL-3.0-or-later
 * Copyright 2026 TRIOS
 *
 * The trios-mcp-rag client, held against its contract
 * (gHashTag/trios#1606): the single export of
 * trios-rag-client.ts - TriosRagClient - pinned as it behaves
 * today, so the next change to that file has something to fail
 * against.
 *
 * The client launches the trios-mcp-rag Rust binary over stdio,
 * with the optional database URL injected into the subprocess
 * environment. The no-server contract is pinned (the same family
 * as the railway #1555 and github #1599 suites): a fresh client
 * starts disconnected with a named circuit breaker; connect()
 * against a nonexistent binary retries three times with backoff
 * and then propagates the launch failure; disconnect() answers
 * gracefully; the circuit opens after the failure threshold and
 * refuses the next tool call fast; and extractText joins the text
 * parts of a tool result.
 *
 * The only filesystem touches are launch attempts against a
 * nonexistent path - no network, no database, no container.
 */

import { describe, expect, it } from 'bun:test'
import { CircuitBreaker, CircuitOpenError } from '../circuit-breaker.js'
import { TriosRagClient } from './trios-rag-client.js'

const MISSING = '/nonexistent/path/to/trios-mcp-rag-bin'

describe('TriosRagClient', () => {
  it('starts disconnected with a named circuit breaker', () => {
    const client = new TriosRagClient(MISSING)
    expect(client.isConnected).toBe(false)
    expect(client.circuit).toBeInstanceOf(CircuitBreaker)
  })

  it('retries a missing binary three times with backoff and propagates the failure', async () => {
    const client = new TriosRagClient(MISSING, 'postgres://localhost/rag')
    let caught: unknown
    try {
      await client.connect()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
  }, 20_000)

  it('disconnects gracefully from a fresh client', async () => {
    const client = new TriosRagClient(MISSING)
    await client.disconnect()
    expect(client.isConnected).toBe(false)
  })

  it('opens the circuit after the failure threshold, refusing fast', async () => {
    const client = new TriosRagClient(MISSING)
    for (let i = 0; i < 3; i++) {
      let caught: unknown
      try {
        await client.callTool('rag_search', { query: 'x' })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(Error)
      expect(caught).not.toBeInstanceOf(CircuitOpenError)
    }

    const started = Date.now()
    let opened: unknown
    try {
      await client.callTool('rag_search', { query: 'x' })
    } catch (e) {
      opened = e
    }
    expect(opened).toBeInstanceOf(CircuitOpenError)
    expect(Date.now() - started).toBeLessThan(500)
  }, 60_000)

  it('joins the text parts of a tool result', () => {
    const client = new TriosRagClient(MISSING)
    expect(client.extractText(null)).toBe('')
    expect(
      client.extractText({
        content: [
          { type: 'text', text: 'first' },
          { type: 'resource', data: 'x' },
          { type: 'text', text: 'second' },
        ],
      }),
    ).toBe('first\nsecond')
  })
})
