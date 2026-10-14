/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The onboarding feature card, held against its contract
 * (gHashTag/trios#1602): the one export of
 * entrypoints/onboarding/features/BentoCard.tsx - BentoCard - pinned
 * as it behaves today, so the next change to that file has something
 * to fail against.
 *
 * The card face is the statically reachable half: the dialog that
 * opens on click carries its details through a Radix portal, which
 * never flushes through a static render - so the card is pinned with
 * a contract-true dialog stand-in around it (the root always renders
 * its children the way the real kit does - the card face is the
 * trigger inside the root - while the portal and overlay stay away
 * as in any static render; earlier suites of this group register a
 * root-gated form for their controlled dialogs, and this file's
 * graph reads this registration) and the metrics track stubbed
 * (its call lives in the dialog's open handler). Measured, the mounted card
 * answers its tag and title, its description, the video duration
 * note and the open-details hint, with the entrance animation the
 * mount flag and index drive.
 *
 * Not pinned, and why (issue User Story 2): the details half - the
 * dialog with the video, the detailed description and the
 * highlights list, the close button and the click tracking - rides
 * the uncontrolled portal the card owns, and reaching it needs a
 * live document to open; the hover effects are styling. The subject
 * is read through a query-qualified specifier so this suite's graph
 * loads as its own fresh instances.
 */

import { describe, expect, it, mock } from 'bun:test'
import { Sparkles } from 'lucide-react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('@/lib/metrics/track', () => ({
  track: () => {},
}))

// The dialog kit, stubbed with the contract-true form: the root
// ALWAYS renders its children the way the real kit does (this
// subject's dialog is uncontrolled - the card face IS the trigger
// inside the root), while the portal and overlay stay away as they
// do in any static render. Earlier suites of this group register a
// root-gated stand-in for their controlled dialogs, and this
// registration is the one this file's graph reads.
const passthrough = (props: { children?: React.ReactNode }) =>
  props.children ?? null

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { open?: boolean; children?: React.ReactNode }) =>
    children ?? null,
  DialogClose: passthrough,
  DialogContent: passthrough,
  DialogDescription: passthrough,
  DialogFooter: passthrough,
  DialogHeader: passthrough,
  DialogOverlay: () => null,
  DialogPortal: () => null,
  DialogTitle: passthrough,
  DialogTrigger: passthrough,
}))

const subjectUrl = './BentoCard?bento-card-suite-real'
const { BentoCard } = (await import(subjectUrl)) as typeof import('./BentoCard')

describe('BentoCardTsxContract', () => {
  describe('BentoCard', () => {
    it('answers the mounted card with its tag, title, description, video duration note and open-details hint', () => {
      const markup = renderToStaticMarkup(
        createElement(BentoCard, {
          feature: {
            id: 'agent-memory',
            Icon: Sparkles,
            tag: 'MEMORY',
            title: 'Agent Memory',
            description: 'Your agent remembers across sessions.',
            detailedDescription: 'The detailed half lives in the dialog.',
            highlights: ['Remembers preferences', 'Learns workflows'],
            videoDuration: '2',
            gridClass: 'md:col-span-2',
            videoUrl: 'https://videos.test/agent-memory.mp4',
          },
          mounted: true,
          index: 0,
        }),
      )
      expect(markup).toContain('MEMORY')
      expect(markup).toContain('Agent Memory')
      expect(markup).toContain('Your agent remembers across sessions.')
      expect(markup).toContain('Video: 2 mins')
      expect(markup).toContain('Open details')
      expect(markup).not.toContain('The detailed half lives in the dialog.')
    })
  })
})
