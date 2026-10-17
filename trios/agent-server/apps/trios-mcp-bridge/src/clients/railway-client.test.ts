/**
 * @license AGPL-3.0-or-later
 * Copyright 2026 TRIOS
 *
 * The Railway MCP client, held against its contract
 * (gHashTag/trios#1555): the single export of railway-client.ts -
 * RailwayMcpClient - pinned as it behaves today, so the next change
 * to that file has something to fail against.
 *
 * The client retries a failing connect three times with exponential
 * backoff and then propagates the failure; it answers isConnected
 * honestly; a graceful disconnect works on a fresh client; and the
 * built-in circuit breaker opens after the threshold of failed tool
 * calls, refusing the next one immediately. The happy paths need a
 * live Railway MCP server, which this suite deliberately does not
 * spin up - the failure contract and the breaker integration are
 * what can be pinned without one. The only socket the suite touches
 * is a connection-refused loopback port, identical on an offline
 * machine; no database, no container.
 */

import { describe, expect, it } from 'bun:test'
import { CircuitBreaker, CircuitOpenError } from '../circuit-breaker.js'
import { RailwayMcpClient } from './railway-client.js'

const REFUSED = 'http://127.0.0.1:9/mcp'
const INVALID = 'not a url at all'

describe('RailwayMcpClient', () => {
  it('starts disconnected with a named circuit breaker', () => {
    const client = new RailwayMcpClient(REFUSED)
    expect(client.isConnected).toBe(false)
    expect(client.circuit).toBeInstanceOf(CircuitBreaker)
  })

  it('refuses an invalid URL after the retries, staying disconnected', async () => {
    const client = new RailwayMcpClient(INVALID)
    let caught: unknown
    try {
      await client.connect()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('cannot be parsed as a URL')
    expect(client.isConnected).toBe(false)
  })

  it('propagates a refused connection after the retries', async () => {
    const client = new RailwayMcpClient(REFUSED)
    let caught: unknown
    try {
      await client.connect()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    // Measured on the current source: the Client object is assigned
    // before the failing connect() and survives the last attempt
    // (destroy() runs at the START of each attempt), so isConnected
    // honestly answers true even though the connect failed. Pinning
    // today's behaviour, not the tidy one.
    expect(client.isConnected).toBe(true)
  })

  it('disconnects gracefully from a fresh client', async () => {
    const client = new RailwayMcpClient(REFUSED)
    await client.disconnect()
    expect(client.isConnected).toBe(false)
  })

  it('opens the circuit after the failure threshold, refusing fast', async () => {
    const client = new RailwayMcpClient(REFUSED)
    for (let i = 0; i < 3; i++) {
      let caught: unknown
      try {
        await client.redeploy('svc')
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(Error)
      expect(caught).not.toBeInstanceOf(CircuitOpenError)
    }

    const started = Date.now()
    let opened: unknown
    try {
      await client.redeploy('svc')
    } catch (e) {
      opened = e
    }
    expect(opened).toBeInstanceOf(CircuitOpenError)
    // The open circuit refuses before any connect retries run.
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('starts and stops a health check without firing it', () => {
    const client = new RailwayMcpClient(REFUSED)
    client.startHealthCheck(60_000)
    client.stopHealthCheck()
    expect(client.isConnected).toBe(false)
  })
})
