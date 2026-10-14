/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The agent container terminal, held against its contract
 * (gHashTag/trios#1692): the one export of
 * entrypoints/app/agents/AgentTerminal.tsx - AgentTerminal - pinned
 * as it behaves today, so the next change to that file has something
 * to fail against.
 *
 * The whole terminal - the xterm instance, its fit and web-links
 * addons, the PTY websocket, the resize and theme observers - lives
 * inside one mount effect a static render never runs, so the render
 * itself needs no stubs at all: the shared container constants and
 * the agent-server URL helper module load for real, and the first
 * mount answers the header with the terminal title, the shell line
 * naming the container home through the real shared constant, the
 * shell bar with the home directory and the shell basename of the
 * real terminal-shell constant, and the copy button in its un-copied
 * state.
 *
 * Not pinned, and why (issue User Story 2): everything the effect
 * owns - the xterm session, the websocket message protocol and its
 * exit handling, the resize/theme observers, the clipboard copy and
 * its Copied flash, the custom key handlers - needs a live document,
 * a real terminal surface and a connected socket, none of which a
 * static mount provides. The port env seam is seeded before any
 * import can reach the env module (its one-time snapshot - the trap
 * the agent-outputs suite documented), with the subject read
 * through a query-qualified specifier so this suite's graph loads
 * as its own fresh instances.
 */

import { describe, expect, it } from 'bun:test'
import {
  OPENCLAW_CONTAINER_HOME,
  OPENCLAW_TERMINAL_SHELL,
} from '@browseros/shared/constants/openclaw'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// biome-ignore lint/style/noProcessEnv: the env seam is the only way to reach the port helpers before the env module's one-time snapshot freezes (see suite header)
process.env.VITE_BROWSEROS_SERVER_PORT ??= '43210'

const subjectUrl = './AgentTerminal?agent-terminal-suite-real'
const { AgentTerminal } = (await import(
  subjectUrl
)) as typeof import('./AgentTerminal')

describe('AgentTerminalTsxContract', () => {
  describe('AgentTerminal', () => {
    it('answers the first mount with the terminal title, the shell line naming the container home, the shell bar with the home directory and the shell basename, and the copy button un-copied', () => {
      const markup = renderToStaticMarkup(
        createElement(AgentTerminal, {
          onBack: () => {},
          onSessionExit: () => {},
        }),
      )
      expect(markup).toContain('Container Terminal')
      expect(markup).toContain(`OpenClaw shell in ${OPENCLAW_CONTAINER_HOME}`)
      expect(markup).toContain(OPENCLAW_CONTAINER_HOME)
      expect(markup).toContain(
        OPENCLAW_TERMINAL_SHELL.slice(
          OPENCLAW_TERMINAL_SHELL.lastIndexOf('/') + 1,
        ),
      )
      expect(markup).toContain('Copy')
      expect(markup).not.toContain('Copied')
    })
  })
})
