/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The MCP client utilities, held against their contract
 * (gHashTag/trios#1629): the two exports of utils/mcp-client.ts -
 * callMcpTool and McpClient - pinned as they behave today, so the
 * next change to that file has something to fail against.
 *
 * callMcpTool refuses an invalid server URL synchronously (the URL
 * constructor's TypeError surfaces) and propagates a connection
 * failure instead of swallowing it. McpClient keeps the same URL
 * contract in its constructor, closes a fresh transport cleanly,
 * survives a failed call (the client resets so a retry also refuses
 * instead of crashing), and close() answers even after failures.
 *
 * The happy-path tool call needs a live MCP server, which this
 * suite deliberately does not spin up: the failure paths and the
 * lifecycle contract above are what can be pinned without a
 * container, a database or any external network. The one socket the
 * suite touches is a connection-refused loopback port - it behaves
 * the same on an offline machine.
 */

import { describe, expect, it } from 'bun:test'
import { callMcpTool, McpClient } from './mcp-client'

const REFUSED = 'http://127.0.0.1:9/mcp'
const INVALID = 'not a url at all'

describe('callMcpTool', () => {
  it('refuses an invalid server URL with the URL constructor error', async () => {
    let caught: unknown
    try {
      await callMcpTool(INVALID, 'tool')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(TypeError)
    expect((caught as Error).message).toContain('cannot be parsed as a URL')
  })

  it('propagates a connection failure instead of swallowing it', async () => {
    let caught: unknown
    try {
      await callMcpTool(REFUSED, 'tool', { a: 1 })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
  })
})

describe('McpClient', () => {
  it('refuses an invalid server URL in the constructor, same as the one-shot', () => {
    let caught: unknown
    try {
      new McpClient(INVALID)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(TypeError)
    expect((caught as Error).message).toContain('cannot be parsed as a URL')
  })

  it('closes a fresh transport cleanly', async () => {
    const client = new McpClient(REFUSED)
    await client.close()
  })

  it('survives a failed call: a retry refuses again and close still answers', async () => {
    const client = new McpClient(REFUSED)
    let first: unknown
    try {
      await client.callTool('tool')
    } catch (e) {
      first = e
    }
    expect(first).toBeInstanceOf(Error)

    let second: unknown
    try {
      await client.callTool('tool')
    } catch (e) {
      second = e
    }
    expect(second).toBeInstanceOf(Error)

    await client.close()
  })
})
