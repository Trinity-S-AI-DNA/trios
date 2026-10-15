/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The toolbar settings card, held against its contract
 * (gHashTag/trios#1612): the one export of
 * entrypoints/app/customization/ToolbarSettingsCard.tsx -
 * ToolbarSettingsCard - pinned as it behaves today, so the next
 * change to that file has something to fail against.
 *
 * The card reads its toggles from the BrowserOS adapter inside one
 * load effect a static render never runs, so the suite needs no
 * stubs at all: the adapter, capabilities and prefs modules load
 * for real and nothing calls them before a live mount. Measured,
 * the first mount answers the card's title with the three toolbar
 * toggles - the chat and hub buttons and the button labels, each
 * with its description - while the vertical-tabs row stays away,
 * the capability it gates on not yet resolved.
 *
 * Not pinned, and why (issue User Story 2): the toggling flow
 * itself - the adapter pref writes, the failure toast, and the
 * vertical-tabs row behind its capability check - lives in
 * handlers and the load effect, and needs a live document with a
 * working adapter. The subject is read through a query-qualified
 * specifier so this suite's graph loads as its own fresh instances.
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const subjectUrl = './ToolbarSettingsCard?toolbar-settings-suite-real'
const { ToolbarSettingsCard } = (await import(
  subjectUrl
)) as typeof import('./ToolbarSettingsCard')

describe('ToolbarSettingsCardTsxContract', () => {
  describe('ToolbarSettingsCard', () => {
    it('answers the first mount with the card title and the three toolbar toggles with their descriptions, the vertical-tabs row staying away while its capability is unresolved', () => {
      const markup = renderToStaticMarkup(createElement(ToolbarSettingsCard))
      expect(markup).toContain('Toolbar Settings')
      expect(markup).toContain('Show Chat Button')
      expect(markup).toContain('Display the Chat button in the browser toolbar')
      expect(markup).toContain('Show Hub Button')
      expect(markup).toContain('Display the Hub button in the browser toolbar')
      expect(markup).toContain('Show Button Labels')
      expect(markup).toContain(
        'Display text labels next to toolbar button icons',
      )
      expect(markup).not.toContain('Use Vertical Tabs')
    })
  })
})
