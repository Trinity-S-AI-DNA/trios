/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The screenshot capture, held against its contract
 * (gHashTag/trinos#1653): the single export of
 * capture/screenshot.ts - ScreenshotCapture - pinned as it behaves
 * today, so the next change to that file has something to fail
 * against.
 *
 * The capture serves two modes: direct CDP through a Browser
 * instance, and - without a browser - an MCP fallback whose
 * connection failure is swallowed into a warn and the capture
 * count still advances. Every capture writes <n>.png into the
 * <outputDir>/screenshots directory the constructor derives and
 * init() creates. The direct path remembers the device pixel
 * ratio; when a page id is rejected it retries with the first
 * page the browser lists; when both fail it warns and keeps the
 * count.
 *
 * The browser is a local recording fake (no mock.module at all);
 * the MCP fallback is exercised against a refused loopback port -
 * no live server, no network, no database, no container.
 */

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser } from '@browseros/server/browser'
import { ScreenshotCapture } from './screenshot'

interface ScreenshotCall {
  pageId: number
  options: { format: string; fullPage: boolean }
}

interface FakeBrowser {
  browser: Browser
  screenshotCalls: ScreenshotCall[]
  listPagesCalled: boolean
  failScreenshot: boolean
  failList: boolean
  pixelRatio: number
}

const fakeBrowser = (): FakeBrowser => {
  const state: FakeBrowser = {
    screenshotCalls: [],
    listPagesCalled: false,
    failScreenshot: false,
    failList: false,
    pixelRatio: 2,
    browser: null as unknown as Browser,
  }
  state.browser = {
    screenshot: async (pageId: number, options: ScreenshotCall['options']) => {
      state.screenshotCalls.push({ pageId, options })
      if (state.failScreenshot) {
        throw new Error('invalid page id')
      }
      return {
        data: Buffer.from('fake-png-bytes').toString('base64'),
        mimeType: 'image/png',
        devicePixelRatio: state.pixelRatio,
      }
    },
    listPages: async () => {
      state.listPagesCalled = true
      if (state.failList) throw new Error('list failed')
      return [{ pageId: 7 }]
    },
  } as unknown as Browser
  return state
}

const newDir = (): string => mkdtempSync(join(tmpdir(), 'shots-'))

const PNG_BYTES = Buffer.from('fake-png-bytes')

describe('ScreenshotCapture - construction', () => {
  it('derives the screenshots output directory and defaults the pixel ratio', () => {
    const capture = new ScreenshotCapture('http://127.0.0.1:9', '/tmp/base')
    expect(capture.getOutputDir()).toBe('/tmp/base/screenshots')
    expect(capture.getDevicePixelRatio()).toBe(1)
    expect(capture.getCount()).toBe(0)
  })

  it('init creates the output directory', async () => {
    const dir = newDir()
    const capture = new ScreenshotCapture('http://127.0.0.1:9', dir)
    await capture.init()
    // The directory exists - proven by listing it without a throw.
    expect(readdirSync(capture.getOutputDir())).toEqual([])
  })
})

describe('ScreenshotCapture - direct CDP', () => {
  it('captures through the browser, writes the numbered file and keeps the ratio', async () => {
    const dir = newDir()
    const fake = fakeBrowser()
    const capture = new ScreenshotCapture(
      'http://127.0.0.1:9',
      dir,
      fake.browser,
    )
    await capture.init()

    expect(await capture.capture(3)).toBe(1)
    expect(await capture.capture(3)).toBe(2)
    expect(fake.screenshotCalls.map((c) => c.pageId)).toEqual([3, 3])
    expect(fake.screenshotCalls[0].options).toEqual({
      format: 'png',
      fullPage: false,
    })

    const written = readdirSync(capture.getOutputDir()).sort()
    expect(written).toEqual(['1.png', '2.png'])
    expect(readFileSync(join(capture.getOutputDir(), '1.png'))).toEqual(
      PNG_BYTES,
    )
    expect(capture.getCount()).toBe(2)
    expect(capture.getDevicePixelRatio()).toBe(2)
  })

  it('retries with the first listed page when the page id is rejected', async () => {
    const dir = newDir()
    const fake = fakeBrowser()
    fake.failScreenshot = true
    // First screenshot attempt throws, listPages returns page 7, and the
    // retry with the list's first page must NOT hit the throw again.
    let failOnce = true
    fake.browser.screenshot = async (
      pageId: number,
      options: ScreenshotCall['options'],
    ) => {
      fake.screenshotCalls.push({ pageId, options })
      if (failOnce) {
        failOnce = false
        throw new Error('invalid page id')
      }
      return {
        data: Buffer.from('recovered').toString('base64'),
        mimeType: 'image/png',
        devicePixelRatio: 3,
      }
    }
    const capture = new ScreenshotCapture(
      'http://127.0.0.1:9',
      dir,
      fake.browser,
    )
    await capture.init()
    expect(await capture.capture(42)).toBe(1)
    expect(fake.screenshotCalls.map((c) => c.pageId)).toEqual([42, 7])
    expect(fake.listPagesCalled).toBe(true)
    expect(capture.getDevicePixelRatio()).toBe(3)
  })

  it('warns and keeps the count when both the capture and the listing fail', async () => {
    const dir = newDir()
    const fake = fakeBrowser()
    fake.failScreenshot = true
    fake.failList = true
    const capture = new ScreenshotCapture(
      'http://127.0.0.1:9',
      dir,
      fake.browser,
    )
    await capture.init()
    expect(await capture.capture(1)).toBe(1)
    expect(readdirSync(capture.getOutputDir())).toEqual([])
  })
})

describe('ScreenshotCapture - MCP fallback', () => {
  it('swallows the refused MCP connection into a warn and still counts', async () => {
    const dir = newDir()
    // No browser: capture falls back to MCP against a refused loopback port.
    const capture = new ScreenshotCapture('http://127.0.0.1:9', dir)
    await capture.init()
    expect(await capture.capture(1)).toBe(1)
    expect(readdirSync(capture.getOutputDir())).toEqual([])
    expect(capture.getCount()).toBe(1)
  })

  it('a browser set later routes the captures to direct CDP', async () => {
    const dir = newDir()
    const fake = fakeBrowser()
    const capture = new ScreenshotCapture('http://127.0.0.1:9', dir)
    capture.setBrowser(fake.browser)
    await capture.init()
    expect(await capture.capture(1)).toBe(1)
    expect(fake.screenshotCalls.length).toBe(1)
    expect(readdirSync(capture.getOutputDir())).toEqual(['1.png'])
  })
})
