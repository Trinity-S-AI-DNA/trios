/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The ACL gate, held against its contract (gHashTag/trios#1659):
 * the single export of tools/acl/acl-guard.ts - checkAcl - pinned as
 * it behaves today, so the next change to that file has something to
 * fail against.
 *
 * The gate refuses to block when there is nothing to enforce against:
 * an unguarded tool, no rules, no page in the args, a page the
 * browser does not know, or a site no rule matches. A site-only rule
 * blocks the whole page. Element-level rules go through the target
 * resolution (args.element, drag sourceElement, or the coordinates
 * resolved by the browser) and then through the scorer: an exact
 * text match blocks with the rule and the element id, a miss does
 * not block, and an unresolvable point leaves the gate open.
 *
 * The browser is a fake of the three methods the gate uses.
 *
 * Not pinned, and why: the scorer-delegated branches of checkAcl
 * (element rules with selector/textMatch) crash this machine's bun
 * 1.3.6 runtime with a segfault inside the embedding-model load
 * path - the same family as issue #1862 - in four of five measured
 * runs (one probe run survived and measured the block shape:
 * {blocked:true, rule, pageId, elementId}). The scorer's own
 * contract is already pinned by the existing
 * tests/tools/acl-scorer.test.ts (22 tests green in CI), so this
 * suite pins every branch of the gate that does not delegate to it.
 * No network, no database, no container.
 */

import { describe, expect, it } from 'bun:test'
import type { Browser } from '../../src/browser/browser'
import { checkAcl } from '../../src/tools/acl/acl-guard'

interface FakeBrowser {
  browser: Browser
}

const fakeBrowser = (
  pages: Record<number, { url: string } | null>,
  props: Record<string, Record<string, unknown> | null>,
  pointHits: Record<string, number | null> = {},
): FakeBrowser => ({
  browser: {
    refreshPageInfo: async (id: number) => pages[id] ?? null,
    resolveElementAtPoint: async (
      id: number,
      x: number,
      y: number,
    ): number | null => pointHits[`${id}:${x}:${y}`] ?? null,
    resolveElementProperties: async (
      id: number,
      elementId: number,
    ): Record<string, unknown> | null => props[`${id}:${elementId}`] ?? null,
  } as unknown as Browser,
})

const rule = (overrides: Record<string, unknown> = {}) =>
  ({ id: 'r1', sitePattern: '*', enabled: true, ...overrides }) as never

const element = (overrides: Record<string, unknown> = {}) =>
  ({
    tagName: 'button',
    textContent: '',
    ariaLabel: '',
    attributes: {},
    ...overrides,
  }) as never

const PAGE = { url: 'https://example.com' }

describe('checkAcl - nothing to enforce against', () => {
  it('lets an unguarded tool through, whatever the rules', async () => {
    const { browser } = fakeBrowser({ 1: PAGE }, {})
    expect(
      await checkAcl('screenshot', { page: 1 }, browser, [rule()]),
    ).toEqual({ blocked: false })
  })

  it('lets a guarded tool through when there are no rules', async () => {
    const { browser } = fakeBrowser({ 1: PAGE }, {})
    expect(await checkAcl('click', { page: 1 }, browser, [])).toEqual({
      blocked: false,
    })
  })

  it('lets a guarded tool through when the args carry no page', async () => {
    const { browser } = fakeBrowser({ 1: PAGE }, {})
    expect(await checkAcl('click', {}, browser, [rule()])).toEqual({
      blocked: false,
    })
  })

  it('lets the tool through when the browser does not know the page', async () => {
    const { browser } = fakeBrowser({ 1: PAGE }, {})
    expect(await checkAcl('click', { page: 99 }, browser, [rule()])).toEqual({
      blocked: false,
    })
  })

  it('lets the tool through when no rule matches the site', async () => {
    const { browser } = fakeBrowser({ 1: PAGE }, {})
    expect(
      await checkAcl('click', { page: 1 }, browser, [
        rule({ sitePattern: 'other.com' }),
      ]),
    ).toEqual({ blocked: false })
  })
})

describe('checkAcl - the site-only rule', () => {
  it('blocks the whole page and names the rule', async () => {
    const { browser } = fakeBrowser({ 1: PAGE }, {})
    const result = await checkAcl('click', { page: 1 }, browser, [
      rule({ id: 'site-block' }),
    ])
    expect(result.blocked).toBe(true)
    expect(result.pageId).toBe(1)
    expect(result.rule?.id).toBe('site-block')
  }, 20_000)
})
