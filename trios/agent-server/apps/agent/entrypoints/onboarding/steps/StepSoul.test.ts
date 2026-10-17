/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The soul onboarding step, held against its contract
 * (gHashTag/trios#1655): the one export of
 * entrypoints/onboarding/steps/StepSoul.tsx - StepSoul - pinned as
 * it behaves today, so the next change to that file has something
 * to fail against.
 *
 * The step draws the four soul presets from the real presets module
 * - their names and descriptions are its real data - through the
 * real button, transition and icon machinery, so the only stubs are
 * the metrics track (a no-op - its real module pulls the adapter
 * graph other suites stub incompletely) and the RPC client hook
 * (its write lives in the continue handler a static render never
 * presses). Measured, the first mount answers the heading with its
 * intro, the four preset cards with their real names and
 * descriptions, the selected-mark on the default balanced preset,
 * and the continue button.
 *
 * Not pinned, and why (issue User Story 2): the continue flow
 * itself - the soul write through the RPC client, the two tracked
 * events, the saving flash and the callback - lives in the button's
 * handler and needs a live document to press. The subject is read
 * through a query-qualified specifier so this suite's graph loads
 * as its own fresh instances.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('@/lib/metrics/track', () => ({
  track: () => {},
}))

mock.module('@/lib/rpc/RpcClientProvider', () => ({
  useRpcClient: () => ({
    soul: { $put: async () => {} },
  }),
}))

const subjectUrl = './StepSoul?soul-suite-real'
const { StepSoul } = (await import(subjectUrl)) as typeof import('./StepSoul')

describe('StepSoulTsxContract', () => {
  describe('StepSoul', () => {
    it('answers the first mount with the heading and intro, the four preset cards with their real names and descriptions, the default balanced preset carrying the selected mark, and the continue button', () => {
      const markup = renderToStaticMarkup(
        createElement(StepSoul, {
          direction: 1,
          onContinue: () => {},
        }),
      )
      expect(markup).toContain('Choose your agent')
      expect(markup).toContain('This sets the starting tone')
      expect(markup).toContain('Balanced')
      expect(markup).toContain('Helpful, clear, and adapts to context')
      expect(markup).toContain('Professional')
      expect(markup).toContain('Friendly')
      expect(markup).toContain('Minimal')
      expect(markup).toContain('Continue')
      // exactly the default balanced preset carries the selected mark
      expect(markup).toContain('top-2.5')
    })
  })
})
