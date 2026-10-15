/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The glowing border, held against its contract
 * (gHashTag/trios#1631): the two exports of
 * components/elements/glowing-border.tsx - GlowingBorder and
 * GlowingElement - pinned as they behave today, so the next change
 * to that file has something to fail against.
 *
 * GlowingBorder draws through motion hooks (useMotionValue,
 * useAnimationFrame, useTransform, useMotionTemplate), so the suite
 * renders it with renderToStaticMarkup - measured, the static render
 * goes through and shows the frame it answers: the cosmetic svg
 * carrying the corner radii and the rest of the props, the rect the
 * animation walks, and the children drawn twice - once in each of
 * the two absolutely-positioned layers the travelling glows sit in.
 * The animation itself (the frame loop pacing two glows along the
 * path) needs a live document with requestAnimationFrame, and is not
 * pinned. GlowingElement is a hook-free render function, so the
 * suite calls it directly and pins the gradient square it answers.
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GlowingBorder, GlowingElement } from './glowing-border'

describe('glowingBorderTsxContract', () => {
  describe('GlowingBorder', () => {
    it('answers the frame the glows travel: the cosmetic svg with the corner radii and the props, the rect, and the children in both absolutely-positioned layers', () => {
      const markup = renderToStaticMarkup(
        createElement(
          GlowingBorder,
          { rx: '12', ry: '12', duration: 2000, delay: 100 },
          createElement('span', null, 'GLOW-CHILD'),
        ),
      )
      expect(markup).toContain('<rect')
      expect(markup).toContain('rx="12"')
      expect(markup).toContain('ry="12"')
      expect(markup).toContain('preserveAspectRatio="none"')
      expect(markup.match(/GLOW-CHILD/g)?.length).toBe(2)
      expect(markup.match(/position:absolute/g)?.length).toBe(2)
    })
  })

  describe('GlowingElement', () => {
    it('answers the orange gradient square the glows are made of', () => {
      const element = GlowingElement({}) as {
        props: { className: string }
      }
      expect(element.props.className).toContain('h-20 w-20')
      expect(element.props.className).toContain('radial-gradient')
    })
  })
})
