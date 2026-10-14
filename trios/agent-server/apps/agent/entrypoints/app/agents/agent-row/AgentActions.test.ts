/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The agent row actions, held against their contract
 * (gHashTag/trios#1836): the one export of
 * entrypoints/app/agents/agent-row/AgentActions.tsx - AgentActions -
 * pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * Everything the row draws rides props and the real kits: the
 * dropdown and tooltip kits stay real (their triggers survive a
 * static render, as the open-in-chat and web-preview suites show),
 * the display helpers (displayName, canDelete, canRename) stay real
 * - their own suites pin them - and only the router hook is
 * stubbed, through a query-qualified spread-real read that keeps
 * every other export of the router module for the rest of the
 * graph. Measured, the static render answers the two states the
 * primary CTA dispatches on: an active turn draws the filled Resume
 * button, no active turn the outlined Chat one - and both states
 * draw the more-actions trigger naming the agent through the real
 * display helper, with the dropdown's menu content staying hidden
 * as the menu first mounts.
 *
 * Not pinned, and why (issue User Story 2): the menu's own body -
 * the copy-id, rename and reset-history items, the coming-soon
 * tooltips and the delete wiring - sits behind the dropdown's and
 * the tooltips' internal open states, and reaching them needs a
 * live document to open them; the navigation itself is a callback
 * into the router the suite stubs. The subject is read through a
 * query-qualified specifier so this suite's graph loads as its own
 * fresh instances under this file's registrations.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const realRouterUrl = 'react-router?agent-actions-real'
const realRouter = (await import(realRouterUrl)) as Record<string, unknown>

mock.module('react-router', () => ({
  ...realRouter,
  useNavigate: () => () => {},
}))

const subjectUrl = './AgentActions?agent-actions-suite-real'
const { AgentActions } = (await import(
  subjectUrl
)) as typeof import('./AgentActions')

type AgentActionsProps = Parameters<typeof AgentActions>[0]

const agent: AgentActionsProps['agent'] = {
  key: 'k1',
  agentId: 'agent-1',
  name: 'Research Bot',
  source: 'openclaw',
  runtimeLabel: 'OpenClaw',
  modelLabel: 'GLM',
  detail: '/workspace/research',
  canChat: true,
  canDelete: true,
}

const renderActions = (activeTurnId: string | null) =>
  renderToStaticMarkup(
    createElement(AgentActions, {
      agent,
      activeTurnId,
      onDelete: () => {},
    }),
  )

describe('AgentActionsTsxContract', () => {
  describe('AgentActions', () => {
    it('answers the active turn with the filled Resume button and no active turn with the outlined Chat one, both naming the agent on the more-actions trigger, with the dropdown menu content hidden as it first mounts', () => {
      const resumed = renderActions('turn-1')
      expect(resumed).toContain('Resume')
      expect(resumed).not.toContain('Chat')
      expect(resumed).toContain('More actions for Research Bot')
      expect(resumed).not.toContain('Copy id')
      expect(resumed).not.toContain('Delete')

      const chatting = renderActions(null)
      expect(chatting).toContain('Chat')
      expect(chatting).not.toContain('Resume')
      expect(chatting).toContain('More actions for Research Bot')
    })
  })
})
