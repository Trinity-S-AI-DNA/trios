/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The BrowserOS server-address helpers, held against their contract
 * (gHashTag/trios#1656): the seven exports of browseros/helpers.ts -
 * AgentPortError, McpPortError, ProxyPortError, getAgentServerUrl,
 * getMcpServerUrl, getProxyServerUrl, getHealthCheckUrl - pinned as
 * they behave today, so the next change to that file has something to
 * fail against.
 *
 * The helpers read the port from import.meta.env (parsed once when
 * @/lib/env loads) and from BrowserOS adapter prefs. This suite sets
 * VITE_BROWSEROS_SERVER_PORT before importing the helpers (a dynamic
 * import, top-level await) and restores it afterwards, so the
 * happy-path URL composition is pinned; the proxy port has no env
 * fallback, so its refusal is pinned as the live path. Outside
 * BrowserOS the adapter seam is unavailable, which blocks: the
 * no-env throw paths of getAgentServerUrl/getMcpServerUrl (the env
 * object is parsed once per process, so a successful capture cannot
 * be unset in-process) and the pref-backed happy path of
 * getProxyServerUrl. The port error classes themselves are pinned
 * directly below. mock.module is deliberately NOT used: it is
 * process-global in bun and would leak into the other suites of this
 * job (see the warning in tests/pglive/pg-migrate-live.test.ts).
 *
 * No network, no database, no container.
 */

import { afterAll, describe, expect, it } from 'bun:test'

const HAD_PORT = process.env.VITE_BROWSEROS_SERVER_PORT
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'
const PORT = process.env.VITE_BROWSEROS_SERVER_PORT

const {
  AgentPortError,
  getAgentServerUrl,
  getHealthCheckUrl,
  getMcpServerUrl,
  getProxyServerUrl,
  McpPortError,
  ProxyPortError,
} = await import('./helpers')

afterAll(() => {
  if (HAD_PORT === undefined) {
    delete process.env.VITE_BROWSEROS_SERVER_PORT
  } else {
    process.env.VITE_BROWSEROS_SERVER_PORT = HAD_PORT
  }
})

describe('port error classes', () => {
  it('AgentPortError says the agent server port is not configured', () => {
    const err = new AgentPortError()
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('AgentPortError')
    expect(err.message).toBe('Agent server port not configured.')
  })

  it('McpPortError says the MCP server port is not configured', () => {
    const err = new McpPortError()
    expect(err.name).toBe('McpPortError')
    expect(err.message).toBe('MCP server port not configured.')
  })

  it('ProxyPortError says the proxy server port is not configured', () => {
    const err = new ProxyPortError()
    expect(err.name).toBe('ProxyPortError')
    expect(err.message).toBe('Proxy server port not configured.')
  })
})

describe('getAgentServerUrl', () => {
  it('answers the loopback URL on the configured port', async () => {
    expect(await getAgentServerUrl()).toBe(`http://127.0.0.1:${PORT}`)
  })
})

describe('getMcpServerUrl', () => {
  it('answers the MCP URL on the same loopback port', async () => {
    expect(await getMcpServerUrl()).toBe(`http://127.0.0.1:${PORT}/mcp`)
  })
})

describe('getProxyServerUrl', () => {
  it('refuses with ProxyPortError: the proxy port has no env fallback', async () => {
    let caught: unknown
    try {
      await getProxyServerUrl()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ProxyPortError)
    expect((caught as Error).message).toBe(
      'Proxy server port not configured.',
    )
  })
})

describe('getHealthCheckUrl', () => {
  it('answers the health URL on the loopback port', async () => {
    expect(await getHealthCheckUrl()).toBe(
      `http://127.0.0.1:${PORT}/health`,
    )
  })
})
