/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The sidebar navigation, held against its contract
 * (gHashTag/trios#1641): the single export of
 * components/sidebar/SidebarNavigation.tsx - SidebarNavigation - pinned
 * as it behaves today, so the next change to that file has something to
 * fail against.
 *
 * The nav reads the router location, so the tree renders inside a
 * MemoryRouter with seeded entries - which also makes the active-state
 * rules statically reachable. The capabilities hook answers the same
 * shape the ConversationInput and AgentCommandConversation suites stub
 * it with, behind a flag so one suite covers both answers; the active
 * pair is asserted as the exact bigram
 * `bg-sidebar-accent text-sidebar-accent-foreground`, because the
 * hover variant of the same classes sits on every item and the bare
 * class name counts all of them. Not pinned: the tooltip hover (an
 * interaction) and the collapsed layout's pixel behaviour.
 */
import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'

let supportsAll = true

mock.module('@/lib/browseros/useCapabilities', () => ({
  useCapabilities: () => ({ supports: () => supportsAll }),
}))

const { SidebarNavigation } = await import('./SidebarNavigation')

const markup = (pathname: string, expanded = true) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [pathname] },
      createElement(SidebarNavigation, { expanded }),
    ),
  )

const ACTIVE_PAIR = 'bg-sidebar-accent text-sidebar-accent-foreground'
const activeCount = (m: string) =>
  (m.match(new RegExp(ACTIVE_PAIR, 'g')) ?? []).length

describe('sidebarNavigationContract', () => {
  it('answers every nav item as its link with the measured icons', () => {
    supportsAll = true
    const m = markup('/home')
    for (const name of [
      'Home',
      'Connect Apps',
      'Scheduled Tasks',
      'Agents',
      'Skills',
      'Memory',
      'Soul',
      'Governance',
      'Settings',
    ]) {
      expect(m).toContain(`>${name}<`)
    }
    for (const href of [
      '/home',
      '/connect-apps',
      '/scheduled',
      '/agents',
      '/home/skills',
      '/home/memory',
      '/home/soul',
      '/admin',
      '/settings/ai',
    ]) {
      expect(m).toContain(`href="${href}"`)
    }
    expect(m).toContain('lucide-house')
    expect(m).toContain('lucide-plug-zap')
    expect(m).toContain('lucide-calendar-clock')
    expect(m).toContain('lucide-cpu')
    expect(m).toContain('lucide-brain')
    expect(m).toContain('lucide-settings')
  })

  it('answers the feature-gated items only when the capability answers true', () => {
    supportsAll = false
    const m = markup('/home')
    for (const gone of [
      'Connect Apps',
      'Agents',
      'Skills',
      'Memory',
      'Soul',
      'Governance',
    ]) {
      expect(m).not.toContain(`>${gone}<`)
    }
    for (const stays of ['Home', 'Scheduled Tasks', 'Settings']) {
      expect(m).toContain(`>${stays}<`)
    }
    supportsAll = true
  })

  it('answers the active item through the bigram the hover class cannot fake', () => {
    supportsAll = true
    expect(activeCount(markup('/home'))).toBe(1)
    expect(activeCount(markup('/settings/llm'))).toBe(1)
    expect(activeCount(markup('/agents/agent-1'))).toBe(1)
    expect(activeCount(markup('/memory'))).toBe(0)
  })

  it('answers the collapsed sidebar with hidden labels and tooltips', () => {
    supportsAll = true
    const collapsed = markup('/home', false)
    expect(collapsed).toContain('opacity-0')
    expect(collapsed).toContain('tooltip')
    expect(markup('/home', true)).toContain('opacity-100')
  })
})
