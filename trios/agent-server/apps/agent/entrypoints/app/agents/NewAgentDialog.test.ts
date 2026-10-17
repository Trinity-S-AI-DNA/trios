/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The new-agent dialog, held against its contract
 * (gHashTag/trios#1544): the one export of
 * entrypoints/app/agents/NewAgentDialog.tsx - NewAgentDialog -
 * pinned as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * The dialog is controlled (the parent owns open), and everything it
 * draws is prop-driven: the provider selector and the CLI provider
 * status panel are the real modules their own suites pin, the
 * select kit stays real (it survives a static render, as the
 * OpenClaw controls suite shows), and only the Radix dialog - a
 * portal that never flushes statically - is stubbed with the
 * portal-free stand-in this group already uses: every value export
 * the kit carries, the root honouring the open flag. Measured, the
 * closed dialog renders nothing, the open one answers its title and
 * the name field with the harness placeholder, the adapter, model
 * and reasoning labels, and the footer buttons; the blocked OpenClaw
 * runtime answers the not-ready alert with the provider selector
 * still drawn; and a create failure answers the alert with its
 * message.
 *
 * Not pinned, and why (issue User Story 2): the create flow itself -
 * the callbacks the buttons wire to and the Enter-to-create path -
 * needs a live document to press, and the runtime-specific bodies
 * beyond their static text (the hermes provider list and the CLI
 * auth panel states are the real modules' contracts, pinned by
 * their own suites) ride props this suite passes through. The
 * subject is read through a query-qualified specifier so this
 * suite's graph loads as its own fresh instances.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const passthrough = (props: { children?: React.ReactNode }) =>
  props.children ?? null

// Radix portals never flush through a static render, so the dialog
// kit is stubbed with a portal-free stand-in - every value export
// the module carries, the root honouring the open flag, so closed
// dialogs stay empty for every other suite of this group, exactly
// as the real one behaves outside a live document.
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({
    open,
    children,
  }: {
    open?: boolean
    children?: React.ReactNode
  }) => (open ? children : null),
  DialogClose: passthrough,
  DialogContent: passthrough,
  DialogDescription: passthrough,
  DialogFooter: passthrough,
  DialogHeader: passthrough,
  DialogOverlay: () => null,
  DialogPortal: passthrough,
  DialogTitle: passthrough,
  DialogTrigger: passthrough,
}))

const subjectUrl = './NewAgentDialog?new-agent-dialog-suite-real'
const { NewAgentDialog } = (await import(
  subjectUrl
)) as typeof import('./NewAgentDialog')

type NewAgentDialogProps = Parameters<typeof NewAgentDialog>[0]

const baseProps: NewAgentDialogProps = {
  adapters: [
    {
      id: 'claude',
      name: 'Claude Code',
      defaultModelId: 'sonnet',
      defaultReasoningEffort: 'high',
      modelControl: 'runtime-supported',
      models: [{ id: 'sonnet', label: 'Sonnet', recommended: true }],
      reasoningEfforts: [{ id: 'high', label: 'High', recommended: true }],
    },
  ],
  canManageOpenClaw: false,
  createError: null,
  createRuntime: 'claude',
  creating: false,
  defaultProviderId: 'p1',
  harnessAdapterId: 'claude',
  harnessModelId: 'sonnet',
  harnessReasoningEffort: 'high',
  hermesProviders: [],
  hermesSelectedProviderId: '',
  name: 'Bot',
  open: true,
  providers: [
    { id: 'p1', type: 'browseros', name: 'BrowserOS', modelId: 'glm' },
  ],
  selectedCliProvider: undefined,
  selectedProviderId: 'p1',
  cliAuthError: null,
  cliAuthLoading: false,
  cliAuthStatus: undefined,
  onConnectCliProvider: () => {},
  onCreate: () => {},
  onOpenChange: () => {},
  onRuntimeChange: () => {},
  onHarnessAdapterChange: () => {},
  onHarnessModelChange: () => {},
  onHarnessReasoningChange: () => {},
  onHermesProviderChange: () => {},
  onNameChange: () => {},
  onProviderChange: () => {},
}

const renderDialog = (overrides: Partial<NewAgentDialogProps>) =>
  renderToStaticMarkup(
    createElement(NewAgentDialog, { ...baseProps, ...overrides }),
  )

describe('NewAgentDialogTsxContract', () => {
  describe('NewAgentDialog', () => {
    it('answers the closed dialog with nothing, the open one with its title, name field, adapter, model and reasoning labels and the footer buttons, the blocked OpenClaw runtime with the not-ready alert and the provider selector, and a create failure with the alert carrying its message', () => {
      const closed = renderDialog({ open: false })
      expect(closed).toBe('')

      const harness = renderDialog({})
      expect(harness).toContain('New Agent')
      expect(harness).toContain('Name')
      expect(harness).toContain('Review bot')
      expect(harness).toContain('Adapter')
      expect(harness).toContain('Model')
      expect(harness).toContain('Reasoning')
      expect(harness).toContain('Cancel')
      expect(harness).toContain('Create')
      expect(harness).not.toContain('OpenClaw is not ready')

      const blocked = renderDialog({ createRuntime: 'openclaw' })
      expect(blocked).toContain('OpenClaw is not ready')
      expect(blocked).toContain('Start or set up the OpenClaw gateway')
      expect(blocked).toContain('BrowserOS')

      const failed = renderDialog({
        createError: 'the gateway refused the request',
      })
      expect(failed).toContain('Create failed')
      expect(failed).toContain('the gateway refused the request')
    })
  })
})
