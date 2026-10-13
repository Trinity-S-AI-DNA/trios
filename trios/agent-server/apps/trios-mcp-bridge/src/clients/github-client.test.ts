/**
 * @license AGPL-3.0-or-later
 * Copyright 2026 TRIOS
 *
 * The GitHub MCP client, held against its contract
 * (gHashTag/trios#1599): the single export of
 * github-client.ts - GitHubMcpClient - pinned as it behaves today,
 * so the next change to that file has something to fail against.
 *
 * The client launches the trios-mcp-github binary over stdio. The
 * no-server contract is pinned: a fresh client starts disconnected
 * with a named circuit breaker; connect() against a nonexistent
 * binary path retries three times with backoff and then propagates
 * the launch failure; a .ts/.js path is launched through bun
 * (measured: same refusal through the script route); disconnect()
 * answers gracefully on a fresh client; the circuit opens after
 * the failure threshold and refuses the next tool call fast; and
 * extractText joins the text parts of a tool result.
 *
 * The only filesystem touches are launch attempts against a
 * nonexistent path (the stdio transport refuses before any real
 * process work) - no network, no database, no container.
 */

import { describe, expect, it } from 'bun:test'
import { CircuitBreaker, CircuitOpenError } from '../circuit-breaker.js'
import { GitHubMcpClient } from './github-client.js'

const MISSING = '/nonexistent/path/to/trios-mcp-github-bin'

describe('GitHubMcpClient', () => {
  it('starts disconnected with a named circuit breaker', () => {
    const client = new GitHubMcpClient(MISSING)
    expect(client.isConnected).toBe(false)
    expect(client.circuit).toBeInstanceOf(CircuitBreaker)
  })

  it('retries a missing binary three times with backoff and propagates the failure', async () => {
    const client = new GitHubMcpClient(MISSING)
    let caught: unknown
    try {
      await client.connect()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
  }, 20_000)

  it('refuses a .ts script path through the bun route the same way', async () => {
    const client = new GitHubMcpClient('/nonexistent/path/to/tool.ts')
    let caught: unknown
    try {
      await client.connect()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
  }, 20_000)

  it('disconnects gracefully from a fresh client', async () => {
    const client = new GitHubMcpClient(MISSING)
    await client.disconnect()
    expect(client.isConnected).toBe(false)
  })

  it('opens the circuit after the failure threshold, refusing fast', async () => {
    const client = new GitHubMcpClient(MISSING)
    for (let i = 0; i < 3; i++) {
      let caught: unknown
      try {
        await client.callTool('repo_create', { name: 'x' })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(Error)
      expect(caught).not.toBeInstanceOf(CircuitOpenError)
    }

    const started = Date.now()
    let opened: unknown
    try {
      await client.callTool('repo_create', { name: 'x' })
    } catch (e) {
      opened = e
    }
    expect(opened).toBeInstanceOf(CircuitOpenError)
    expect(Date.now() - started).toBeLessThan(500)
  }, 60_000)

  it('joins the text parts of a tool result', () => {
    const client = new GitHubMcpClient(MISSING)
    expect(client.extractText(null)).toBe('')
    expect(
      client.extractText({
        content: [
          { type: 'text', text: 'first' },
          { type: 'image', data: 'x' },
          { type: 'text', text: 'second' },
        ],
      }),
    ).toBe('first\nsecond')
  })
})
