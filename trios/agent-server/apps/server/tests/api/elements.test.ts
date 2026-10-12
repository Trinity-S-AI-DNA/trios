/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The CDP element helpers, held against their contract
 * (gHashTag/trios#1650): the seven exports of browser/elements.ts -
 * getElementCenter, scrollIntoView, focusElement, jsClick,
 * resolveObjectId, getInputValue, callOnElement - pinned as they
 * behave today, so the next change to that file has something to fail
 * against.
 *
 * getElementCenter walks a three-tier fallback - content quads, box
 * model, then a live getBoundingClientRect - and says so when nothing
 * resolves. scrollIntoView is best-effort and never throws.
 * focusElement pushes the node first and focuses the pushed id.
 * jsClick clicks through the resolved object id. resolveObjectId
 * answers the id or refuses with the snapshot hint. getInputValue
 * reads value-or-textContent and answers an empty string on failure.
 * callOnElement maps plain arguments to the CDP { value } form.
 *
 * No network, no database, no container: the session is a recording
 * fake of the CDP protocol surface (as-unknown-as, like the GitButler
 * fake of the absorb suite).
 */

import { describe, expect, it } from 'bun:test'
import type { ProtocolApi } from '@browseros/cdp-protocol/protocol-api'
import {
  callOnElement,
  focusElement,
  getElementCenter,
  getInputValue,
  jsClick,
  resolveObjectId,
  scrollIntoView,
} from '../../src/browser/elements'

interface FakeCdp {
  session: ProtocolApi
  calls: string[]
}

const fakeCdp = (behavior: {
  quads?: number[][] | null
  boxContent?: number[] | null
  objectId?: string | null
  nodeIds?: number[]
  rect?: { x: number; y: number; w: number; h: number } | null
  value?: unknown
  failScroll?: boolean
  failCallOnElement?: boolean
}): FakeCdp => {
  const calls: string[] = []
  const session = {
    DOM: {
      getContentQuads: async () => ({
        quads: behavior.quads === undefined ? null : behavior.quads,
      }),
      getBoxModel: async () =>
        behavior.boxContent === null
          ? { model: undefined }
          : { model: { content: behavior.boxContent ?? [] } },
      resolveNode: async () =>
        behavior.objectId
          ? { object: { objectId: behavior.objectId } }
          : { object: undefined },
      scrollIntoViewIfNeeded: async () => {
        if (behavior.failScroll) throw new Error('node detached')
      },
      pushNodesByBackendIdsToFrontend: async () => ({
        nodeIds: behavior.nodeIds ?? [101],
      }),
      focus: async (args: { nodeId: number }) => {
        calls.push(`focus:${args.nodeId}`)
      },
    },
    Runtime: {
      callFunctionOn: async (args: {
        functionDeclaration: string
        objectId?: string
        returnByValue?: boolean
        arguments?: { value: unknown }[]
      }) => {
        calls.push(
          `call:${args.functionDeclaration.slice(0, 32)}@${args.objectId}:${JSON.stringify(args.arguments ?? [])}`,
        )
        if (behavior.failCallOnElement) throw new Error('context destroyed')
        return { result: { value: behavior.value } }
      },
    },
  }
  return { session: session as unknown as ProtocolApi, calls }
}

describe('getElementCenter', () => {
  it('answers the center of the first content quad', async () => {
    const { session } = fakeCdp({
      quads: [[0, 0, 10, 0, 10, 10, 0, 10]],
    })
    const center = await getElementCenter(session, 7)
    expect(center).toEqual({ x: 5, y: 5 })
  })

  it('falls back to the box model when quads answer nothing', async () => {
    const { session } = fakeCdp({
      quads: null,
      boxContent: [0, 4, 8, 4, 8, 8, 0, 8],
    })
    const center = await getElementCenter(session, 7)
    expect(center).toEqual({ x: 4, y: 6 })
  })

  it('falls back to a live bounding rect, and refuses when nothing resolves', async () => {
    const { session } = fakeCdp({
      quads: null,
      boxContent: null,
      objectId: 'obj-1',
      rect: null,
      value: { x: 2, y: 4, w: 10, h: 2 },
    })
    const center = await getElementCenter(session, 7)
    expect(center).toEqual({ x: 7, y: 5 })

    const dead = fakeCdp({ quads: null, boxContent: null, objectId: null })
    let caught: unknown
    try {
      await getElementCenter(dead.session, 7)
    } catch (e) {
      caught = e
    }
    expect((caught as Error).message).toContain(
      'may have been removed from the page',
    )
  })
})

describe('scrollIntoView', () => {
  it('is best-effort: a detached node does not throw', async () => {
    const { session } = fakeCdp({ failScroll: true })
    await scrollIntoView(session, 7)
  })
})

describe('focusElement', () => {
  it('pushes the node to the frontend first and focuses the pushed id', async () => {
    const { session, calls } = fakeCdp({ nodeIds: [4242] })
    await focusElement(session, 7)
    expect(calls).toEqual(['focus:4242'])
  })
})

describe('jsClick', () => {
  it('clicks through the resolved object id', async () => {
    const { session, calls } = fakeCdp({ objectId: 'obj-9' })
    await jsClick(session, 7)
    expect(calls).toEqual(['call:function(){this.click()}@obj-9:[]'])
  })
})

describe('resolveObjectId', () => {
  it('answers the resolved object id', async () => {
    const { session } = fakeCdp({ objectId: 'obj-3' })
    expect(await resolveObjectId(session, 7)).toBe('obj-3')
  })

  it('refuses with the snapshot hint when the node has none', async () => {
    const { session } = fakeCdp({ objectId: null })
    let caught: unknown
    try {
      await resolveObjectId(session, 7)
    } catch (e) {
      caught = e
    }
    expect((caught as Error).message).toBe(
      'Element not found in DOM. Take a new snapshot.',
    )
  })
})

describe('getInputValue', () => {
  it('reads the value the element call returns', async () => {
    const { session } = fakeCdp({ objectId: 'obj-5', value: 'typed text' })
    expect(await getInputValue(session, 7)).toBe('typed text')
  })

  it('answers an empty string when the call fails', async () => {
    const { session } = fakeCdp({ objectId: 'obj-5', failCallOnElement: true })
    expect(await getInputValue(session, 7)).toBe('')
  })
})

describe('callOnElement', () => {
  it('maps plain arguments to the CDP value form and returns the value', async () => {
    const { session, calls } = fakeCdp({ objectId: 'obj-2', value: 42 })
    const got = await callOnElement(
      session,
      7,
      'function(a,b){return a+b}',
      [3, 4],
    )
    expect(got).toBe(42)
    expect(calls).toEqual([
      'call:function(a,b){return a+b}@obj-2:[{"value":3},{"value":4}]',
    ])
  })
})
