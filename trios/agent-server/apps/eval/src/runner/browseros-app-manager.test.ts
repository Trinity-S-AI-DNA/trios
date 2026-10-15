/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The BrowserOS app manager, held against its contract
 * (gHashTag/trios#1517): the single export of
 * browseros-app-manager.ts - BrowserOSAppManager - pinned as it
 * behaves today, so the next change to that file has something to
 * fail against.
 *
 * The manager derives per-worker ports from the base (defaults
 * 9010/9110/9310, offset by workerIndex) and answers its server
 * URL from the derived server port. isAppRunning() is a
 * port-specific lsof check - proven both ways below with a real
 * listener on a high port. killApp() on a fresh manager completes
 * silently (null processes, no temp dir).
 *
 * Not pinned, named per the issue's User Story 2: restart() and
 * the start paths (they spawn real Chrome and the real agent
 * server - a live application, not exercisable without a
 * container-grade environment); the static patchNopechaApiKey
 * (it mutates the shared CAPTCHA extension directory); and
 * killApp()'s lsof|xargs force-kill branch - measured: with a
 * listener in this process it targets the test runner itself
 * (the run truncated), so that branch needs a separate helper
 * process to be pinned safely.
 *
 * The listener is a real node:net server on a throwaway high port;
 * no mock.module, no spawned application, no network beyond
 * loopback, no database, no container.
 */

import { describe, expect, it } from 'bun:test'
import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:net'
import { BrowserOSAppManager } from './browseros-app-manager'

const listenOnFreePort = (): Promise<{
  server: Server
  port: number
  close: () => Promise<void>
}> =>
  new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        server,
        port,
        close: () => new Promise((res) => server.close(() => res())),
      })
    })
  })

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('BrowserOSAppManager - port derivation', () => {
  it('derives per-worker ports from the defaults', () => {
    const worker0 = new BrowserOSAppManager(0)
    expect(worker0.getPorts()).toEqual({
      cdp: 9010,
      server: 9110,
      extension: 9310,
    })
    const worker2 = new BrowserOSAppManager(2)
    expect(worker2.getPorts()).toEqual({
      cdp: 9012,
      server: 9112,
      extension: 9312,
    })
  })

  it('derives per-worker ports from a given base', () => {
    const manager = new BrowserOSAppManager(1, {
      cdp: 100,
      server: 200,
      extension: 300,
    })
    expect(manager.getPorts()).toEqual({
      cdp: 101,
      server: 201,
      extension: 301,
    })
  })

  it('answers the server URL from the derived server port', () => {
    expect(new BrowserOSAppManager(0).getServerUrl()).toBe(
      'http://127.0.0.1:9110',
    )
    expect(new BrowserOSAppManager(3).getServerUrl()).toBe(
      'http://127.0.0.1:9113',
    )
  })
})

describe('BrowserOSAppManager - isAppRunning', () => {
  it('answers false when nothing listens on the server port', () => {
    const manager = new BrowserOSAppManager(0, {
      cdp: 49990,
      server: 49991,
      extension: 49992,
    })
    expect(manager.isAppRunning()).toBe(false)
  })

  it('answers true while a real listener holds the server port', async () => {
    const listener = await listenOnFreePort()
    const manager = new BrowserOSAppManager(0, {
      cdp: 49993,
      server: listener.port,
      extension: 49994,
    })
    try {
      expect(manager.isAppRunning()).toBe(true)
    } finally {
      await listener.close()
    }
    // Measured: after the listener closes, the port is free again.
    await wait(200)
    expect(manager.isAppRunning()).toBe(false)
  })
})

describe('BrowserOSAppManager - killApp', () => {
  it('completes silently on a fresh manager', async () => {
    const manager = new BrowserOSAppManager(0, {
      cdp: 49995,
      server: 49996,
      extension: 49997,
    })
    await manager.killApp()
    expect(manager.isAppRunning()).toBe(false)
  })
})
