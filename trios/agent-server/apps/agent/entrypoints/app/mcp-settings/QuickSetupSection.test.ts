/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The quick setup section, held against its contract
 * (gHashTag/trios#1625): the single export of
 * entrypoints/app/mcp-settings/QuickSetupSection.tsx -
 * QuickSetupSection - pinned as it behaves today, so the next change to
 * that file has something to fail against.
 *
 * Radix Tabs answer their whole list statically (every tab's content
 * renders, the active one marked), so one render covers every client's
 * snippet. Pinned: the null answer; the header (the terminal icon, the
 * title, the note); the tab list (all five clients); the active tab
 * (claude-code by default); the command snippets with the URL spliced in
 * and the dollar prompt on the command types; and the copy affordance.
 * Radix Tabs answer ONLY the active tab's content statically (measured:
 * the gemini and codex commands and the JSON clients are absent from
 * the rendered answer, and only one dollar prompt appears), so the
 * inactive clients' snippets are pinned as source shapes - the pattern
 * the repository's own calibration suite uses for behavior no static
 * render can reach. Not pinned: the clipboard write and the copied
 * flip.
 */
import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { QuickSetupSection } from './QuickSetupSection'

const markup = (serverUrl: string | null) =>
  renderToStaticMarkup(createElement(QuickSetupSection, { serverUrl }))

describe('quickSetupSectionContract', () => {
  it('answers nothing without a server url', () => {
    expect(markup(null)).toBe('')
  })

  it('answers the header with the terminal icon, the title and the note', () => {
    const m = markup('http://127.0.0.1:9999/mcp')
    expect(m).toContain('lucide-terminal')
    expect(m).toContain('Quick Setup')
    expect(m).toContain('Copy and run the command for your tool')
  })

  it('answers all five client tabs with claude-code active by default', () => {
    const m = markup('http://127.0.0.1:9999/mcp')
    for (const name of [
      'Claude Code',
      'Gemini CLI',
      'Codex',
      'Claude Desktop',
      'OpenClaw',
    ]) {
      expect(m).toContain(`>${name}<`)
    }
    expect(m).toContain('data-state="active"')
  })

  it('answers the ACTIVE tab content with its command, the dollar prompt and the copy affordance', () => {
    const m = markup('http://127.0.0.1:9999/mcp')
    expect(m).toContain(
      'claude mcp add --transport http browseros http://127.0.0.1:9999/mcp --scope user',
    )
    expect((m.match(/\$/g) ?? []).length).toBe(1)
    expect(m).toContain('lucide-copy')
    expect(m).not.toContain('gemini mcp add')
    expect(m).not.toContain('codex mcp add')
  })

  it('carries all five clients with their snippets in its own table (source shape: Radix answers only the active tab)', () => {
    const src = fs
      .readFileSync(
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          'QuickSetupSection.tsx',
        ),
        'utf8',
      )
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    for (const snippet of [
      'claude mcp add --transport http browseros ' + '$' + '{url} --scope user',
      'gemini mcp add local-server ' +
        '$' +
        '{url} --transport http --scope user',
      'codex mcp add browseros ' + '$' + '{url}',
    ]) {
      expect(src).toContain(snippet)
    }
    expect(src).toContain("fileName: 'claude_desktop_config.json'")
    expect(src).toContain("fileName: 'openclaw.json'")
    expect(src).toContain("'mcp-remote', url")
    expect(src).toContain('browseros: { url }')
    const ids = (src.match(/id: '/g) ?? []).length
    expect(ids).toBeGreaterThanOrEqual(5)
  })
})
