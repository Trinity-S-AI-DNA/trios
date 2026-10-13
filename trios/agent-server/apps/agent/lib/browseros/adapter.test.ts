/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The BrowserOS adapter, held against its contract
 * (gHashTag/trios#1505): the three exports of
 * lib/browseros/adapter.ts - SCREENSHOT_SIZES, BrowserOSAdapter,
 * getBrowserOSAdapter - pinned as they behave today, so the next
 * change to that file has something to fail against.
 *
 * The BrowserOS shell is a live dependency this group does not
 * have: in a bun test process there is no chrome global, so every
 * method that reaches for chrome.browserOS refuses, and the pin
 * below records exactly that refusal - the behaviour every caller
 * in the app already catches (metrics/track, the capabilities
 * bootstrap, the port helpers, the storage backup path). Not
 * pinned, and why: the callback-path behaviour of the shell-facing
 * methods - snapshot trees, pref round-trips, metric delivery -
 * which needs the live chrome.browserOS API this group cannot
 * provide. All three exports are exercised; none is blocked.
 */

import { describe, expect, it } from 'bun:test'
import {
  BrowserOSAdapter,
  getBrowserOSAdapter,
  SCREENSHOT_SIZES,
} from './adapter'

describe('adapterContract', () => {
  describe('SCREENSHOT_SIZES', () => {
    it('names the three screenshot sizes the UI offers, with their pixel bounds', () => {
      expect(SCREENSHOT_SIZES.small).toBe(512)
      expect(SCREENSHOT_SIZES.medium).toBe(768)
      expect(SCREENSHOT_SIZES.large).toBe(1028)
    })
  })

  describe('BrowserOSAdapter', () => {
    it('hands out one shared instance, and its shell-facing methods refuse rather than answer outside the BrowserOS shell', async () => {
      const shared = BrowserOSAdapter.getInstance()
      expect(BrowserOSAdapter.getInstance()).toBe(shared)

      await expect(shared.getVersion()).rejects.toThrow()
      await expect(shared.getBrowserosVersion()).rejects.toThrow()
      await expect(shared.getPref('adapter.contract.probe')).rejects.toThrow()
      await expect(
        shared.setPref('adapter.contract.probe', 1),
      ).rejects.toThrow()
      await expect(shared.logMetric('probe', { probe: true })).rejects.toThrow()
    })
  })

  describe('getBrowserOSAdapter', () => {
    it('answers the same shared instance as the class it wraps', () => {
      expect(getBrowserOSAdapter()).toBe(BrowserOSAdapter.getInstance())
      expect(getBrowserOSAdapter()).toBe(getBrowserOSAdapter())
    })
  })
})
