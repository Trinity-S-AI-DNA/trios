/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The Clado action executor, held against its contract
 * (gHashTag/trios#1496): the single export of
 * clado-action-executor.ts - CladoActionExecutor - pinned as it
 * behaves today, so the next change to that file has something to
 * fail against.
 *
 * The constructor refuses any provider other than "clado-action".
 * An already-aborted delegation answers a timeout result before
 * touching the network. An unreachable action server answers a
 * blocked result that names the failed screenshot capture, with no
 * steps counted. A fresh executor closes cleanly and reports zero
 * steps. The happy-path action loop needs a live Clado action
 * server, which this suite deliberately does not spin up - the
 * entry, refusal and failure contracts above are what can be
 * pinned without one. The only socket the suite touches is a
 * connection-refused loopback port, identical on an offline
 * machine.
 */

import { describe, expect, it } from 'bun:test'
import { CladoActionExecutor } from './clado-action-executor'

const CFG = {
  provider: 'clado-action',
  model: 'test-model',
  apiKey: 'test-key',
  baseUrl: 'http://127.0.0.1:9',
}

describe('CladoActionExecutor', () => {
  it('refuses a provider other than clado-action', () => {
    let caught: unknown
    try {
      new CladoActionExecutor(
        { ...CFG, provider: 'wrong' },
        'http://127.0.0.1:9',
      )
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe(
      'CladoActionExecutor requires provider="clado-action"',
    )
  })

  it('accepts the clado-action provider and starts at zero steps', () => {
    const executor = new CladoActionExecutor(CFG, 'http://127.0.0.1:9')
    executor.setCallbacks({})
    expect(executor.getTotalSteps()).toBe(0)
  })

  it('answers a timeout for an already-aborted delegation, before any network', async () => {
    const executor = new CladoActionExecutor(CFG, 'http://127.0.0.1:9')
    const controller = new AbortController()
    controller.abort()
    const result = await executor.execute('do something', controller.signal)
    expect(result.status).toBe('timeout')
    expect(result.observation).toContain(
      'Delegation aborted by timeout or cancellation.',
    )
    expect(result.actionsPerformed).toBe(0)
    expect(result.toolsUsed).toEqual([])
    expect(executor.getTotalSteps()).toBe(0)
  })

  it('answers a blocked result that names the failed screenshot capture', async () => {
    const executor = new CladoActionExecutor(CFG, 'http://127.0.0.1:9')
    const result = await executor.execute('do something')
    expect(result.status).toBe('blocked')
    expect(result.observation).toContain('Could not capture screenshot')
    expect(result.actionsPerformed).toBe(0)
    expect(executor.getTotalSteps()).toBe(0)
  })

  it('closes a fresh executor cleanly', async () => {
    const executor = new CladoActionExecutor(CFG, 'http://127.0.0.1:9')
    await executor.close()
  })
})
