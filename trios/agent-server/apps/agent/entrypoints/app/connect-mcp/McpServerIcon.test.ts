/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The MCP server icon, held against its contract
 * (gHashTag/trios#1665): the single export of
 * entrypoints/app/connect-mcp/McpServerIcon.tsx - McpServerIcon - pinned
 * as it behaves today, so the next change to that file has something to
 * fail against.
 *
 * Under bun an imported svg answers its own path, so the known-name
 * answers pin the img frame with that path; the unknown-name answer is the
 * lucide Server fallback. Not pinned: the pixel content of the assets.
 */
import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const { McpServerIcon } = await import('./McpServerIcon')

const markup = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(McpServerIcon as never, props as never))

describe('mcpServerIconContract', () => {
  it('answers a known server as the img frame carrying its asset path', () => {
    const m = markup({ serverName: 'Slack' })
    expect(m).toContain('<img')
    expect(m).toContain('mcp-icons/slack.svg')
    expect(m).toContain('alt="Slack"')
    expect(m).toContain('width="20"')
    expect(m).toContain('height="20"')
    expect(m).toContain('rounded-md')
  })

  it('answers the custom size and the extra class on the img', () => {
    const m = markup({ serverName: 'Slack', size: 32, className: 'mt-1' })
    expect(m).toContain('width="32"')
    expect(m).toContain('height="32"')
    expect(m).toContain('rounded-md mt-1')
  })

  it('answers an unknown server as the lucide Server fallback', () => {
    const m = markup({ serverName: 'TotallyUnknown' })
    expect(m).toContain('lucide-server')
    expect(m).not.toContain('<img')
    expect(m).toContain('width="20"')
    expect(m).toContain('height="20"')
  })

  it('answers the named special cases with their exact assets', () => {
    const cases: Array<[string, string]> = [
      ['Google Sheets', 'google.svg'],
      ['Cal.com', 'cal_com.svg'],
      ['Microsoft Teams', 'microsoft_teams.svg'],
      ['Mem0', 'memo.webp'],
      ['Brave Search', 'brave_search.svg'],
      ['Outlook Calendar', 'outlook.svg'],
    ]
    for (const [name, asset] of cases) {
      const m = markup({ serverName: name })
      expect(m).toContain(`mcp-icons/${asset}`)
      expect(m).toContain(`alt="${name}"`)
    }
  })
})
