/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The onboarding features page, held against its contract
 * (gHashTag/trios#1507): the one export of
 * entrypoints/onboarding/features/Features.tsx - FeaturesPage - pinned
 * as it behaves today, so the next change to that file has something
 * to fail against.
 *
 * The page is a hook-bearing component whose start button reaches for
 * chrome APIs in its handler, so the pins read a static render of it
 * (measured, the render goes through the pill, bento and community
 * pieces with the mounted-gated grid hidden - the effect that flips
 * it never runs in a static render, exactly the pre-mount frame a
 * server would paint).
 *
 * Not pinned, and why (issue User Story 2): the start flow - it
 * swaps the tab through chrome.tabs - and the mounted reveal - they
 * live in effects and handlers that need a live document and window.
 * The port env seam is seeded before any import can reach the env
 * module (its one-time snapshot - the trap the agent-outputs suite
 * documented), with the subject imported dynamically for that reason.
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// biome-ignore lint/style/noProcessEnv: the env seam is the only way to reach the port helpers before the env module's one-time snapshot freezes (see suite header)
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'

const { FeaturesPage } = await import('./Features')

describe('FeaturesTsxContract', () => {
  describe('FeaturesPage', () => {
    it('answers the pre-mount frame: the welcome pill and the hero copy, the scroll hint, the features heading, and the community cards with their joins', () => {
      const markup = renderToStaticMarkup(createElement(FeaturesPage))
      expect(markup).toContain('WELCOME')
      expect(markup).toContain('Why Switch to')
      expect(markup).toContain('BrowserOS?')
      expect(markup).toContain('Scroll for Features')
      expect(markup).toContain('Explore What')
      expect(markup).toContain('Possible')
      expect(markup).toContain('Join Discord')
      expect(markup).toContain('Join Slack')
      expect(markup).toContain('Star our repository')
      expect(markup).toContain('Start Using BrowserOS')
    })
  })
})
