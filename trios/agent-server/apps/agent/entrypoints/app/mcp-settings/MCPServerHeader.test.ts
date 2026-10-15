/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The MCP server header, held against its contract
 * (gHashTag/trios#1614): the single export of
 * entrypoints/app/mcp-settings/MCPServerHeader.tsx - MCPServerHeader -
 * pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * The messaging seam is stubbed with the same stand-in the
 * ServerSettingsCard suite uses (the real module rides
 * webext-core messaging, which rejects the test process), and the
 * metrics seam with the group's shape. The clipboard, the restart flow
 * and the adapter import all live inside click handlers a static render
 * never runs. Pinned: the header with its server icon and the Docs
 * link against the constant; the URL field's three branches (the url,
 * the Loading note, the error in destructive color); the copy affordance
 * with its hover title and the copied flip's icons; the restart
 * affordance with its title and the spinning state's icon; and the
 * disabled dispatch of both buttons (copy disabled without a url or
 * while loading, restart disabled while loading). Not pinned: the
 * clipboard write, the restart flow (the adapter import, the health
 * polling, the toasts) and the clicks.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('@/lib/messaging/server/serverMessages', () => ({
  onServerMessage: () => () => {},
  sendServerMessage: async () => ({ healthy: true }),
}))

mock.module('@/lib/metrics/track', () => ({
  track: () => {},
}))

const { MCPServerHeader } = await import('./MCPServerHeader')

const markup = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(
      MCPServerHeader as never,
      {
        serverUrl: 'http://127.0.0.1:9999/mcp',
        isLoading: false,
        error: null,
        ...over,
      } as never,
    ),
  )

describe('mcpServerHeaderContract', () => {
  it('answers the header with the server icon, the title and the Docs link', () => {
    const m = markup()
    expect(m).toContain('lucide-server')
    expect(m).toContain('BrowserOS MCP Server')
    expect(m).toContain(
      'href="https://docs.browseros.com/features/use-with-claude-code"',
    )
    expect(m).toContain('Docs')
    expect(m).toContain('lucide-external-link')
    expect(m).toContain(
      'Connect BrowserOS to MCP clients like Claude Code, Gemini CLI and others.',
    )
  })

  it('answers the URL field in its three branches', () => {
    expect(markup()).toContain('http://127.0.0.1:9999/mcp')

    const loading = markup({ isLoading: true, serverUrl: null })
    expect(loading).toContain('Loading...')
    expect(loading).not.toContain('text-destructive">')

    const error = markup({ error: 'Server not running' })
    expect(error).toContain('text-destructive">Server not running')
  })

  it('answers the copy affordance and the restart affordance with their titles', () => {
    const m = markup()
    expect(m).toContain('title="Copy URL"')
    expect(m).toContain('lucide-copy')
    expect(m).not.toContain('lucide-check')
    expect(m).toContain('title="Restart server"')
    expect(m).toContain('lucide-refresh-cw')
    expect(m).not.toContain('lucide-loader-circle')
  })

  it('answers the disabled dispatch of both buttons', () => {
    const ready = markup()
    expect(ready).not.toContain('disabled=""')

    const noUrl = markup({ serverUrl: null })
    expect(noUrl).toContain('disabled=""')

    const loading = markup({ isLoading: true })
    expect(loading).toContain('disabled=""')
    expect((loading.match(/disabled=""/g) ?? []).length).toBe(2)
  })
})
