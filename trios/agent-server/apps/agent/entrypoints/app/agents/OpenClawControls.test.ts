/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The OpenClaw controls, held against their contract
 * (gHashTag/trios#1513): the six exports of
 * entrypoints/app/agents/OpenClawControls.tsx - ProviderSelector,
 * AgentsPageHeader, LifecycleAlert, InlineErrorAlert,
 * ControlPlaneAlert, GatewayStateCards - pinned as they behave
 * today, so the next change to that file has something to fail
 * against.
 *
 * Every export is a hook-free render function of its props, so the
 * suite calls each one directly and pins the element tree it
 * answers: the text it shows, the buttons it wires to the
 * callbacks it was handed (asserted by identity), and the disabled
 * states it applies. No DOM renderer is involved - a React element
 * is a plain object - and no suite of this job mocks any module in
 * this subject's import graph, so the load needs no stand-ins.
 * What is not expanded: the internals of the Radix Select the
 * provider selector renders (opening it needs a real renderer);
 * the pin reads its value, change wiring and item labels at the
 * element boundary, which is what the page hands to the kit.
 */

import { describe, expect, it } from 'bun:test'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select, SelectItem } from '@/components/ui/select'
import {
  AgentsPageHeader,
  ControlPlaneAlert,
  GatewayStateCards,
  InlineErrorAlert,
  LifecycleAlert,
  ProviderSelector,
} from './OpenClawControls'
import type { OpenClawStatus } from './useOpenClaw'

type AnyElement = {
  type: unknown
  props: Record<string, unknown>
}

const isElement = (node: unknown): node is AnyElement =>
  typeof node === 'object' && node !== null && 'type' in node

function* walk(node: unknown): Generator<AnyElement> {
  if (Array.isArray(node)) {
    for (const child of node) {
      yield* walk(child)
    }
    return
  }
  if (!isElement(node)) {
    return
  }
  yield node
  const children = node.props.children
  if (children !== null && children !== undefined) {
    yield* walk(children)
  }
}

const elementsOf = (node: unknown, type: unknown): AnyElement[] =>
  [...walk(node)].filter((element) => element.type === type)

const textOf = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join('')
  }
  if (isElement(node)) {
    return textOf(node.props.children)
  }
  return ''
}

const status = (over: Partial<OpenClawStatus>): OpenClawStatus => ({
  status: 'running',
  podmanAvailable: true,
  machineReady: true,
  port: 8080,
  agentCount: 2,
  error: null,
  controlPlaneStatus: 'connected',
  lastGatewayError: null,
  lastRecoveryReason: null,
  ...over,
})

const providers = [
  { id: 'p1', type: 'openai', name: 'Work OpenAI', modelId: 'gpt-4o' },
  { id: 'p2', type: 'anthropic', name: 'Claude', modelId: 'sonnet' },
]

describe('OpenClawControlsTsxContract', () => {
  describe('ProviderSelector', () => {
    it('renders the empty state with the AI settings link, and the selector with the given value, wiring and item labels', () => {
      const onSelect = () => {}
      const empty = ProviderSelector({
        providers: [],
        defaultProviderId: 'p1',
        selectedId: 'p1',
        onSelect,
      })
      expect(textOf(empty)).toContain('No compatible LLM providers configured.')
      expect(elementsOf(empty, 'a')[0]?.props.href).toBe('#/settings/ai')

      const filled = ProviderSelector({
        providers,
        defaultProviderId: 'p1',
        selectedId: 'p2',
        onSelect,
      })
      const select = elementsOf(filled, Select)[0]
      expect(select?.props.value).toBe('p2')
      expect(select?.props.onValueChange).toBe(onSelect)
      const items = elementsOf(filled, SelectItem)
      expect(items.map((item) => item.props.value)).toEqual(['p1', 'p2'])
      expect(textOf(items[0])).toBe('Work OpenAI - gpt-4o (default)')
      expect(textOf(items[1])).toBe('Claude - sonnet')
      expect(textOf(filled)).toContain('Uses your existing API key')

      const withoutHint = ProviderSelector({
        providers,
        defaultProviderId: 'p1',
        selectedId: 'p2',
        onSelect,
        hideApiKeyHint: true,
      })
      expect(textOf(withoutHint)).not.toContain('Uses your existing API key')
    })
  })

  describe('AgentsPageHeader', () => {
    it('shows only the always-there buttons without a status, the gateway controls while running, and a retry wired to the reconnect callback while the control plane is down', () => {
      const onCreateAgent = () => {}
      const onOpenTerminal = () => {}
      const onReconnect = () => {}
      const onRefresh = () => {}
      const onRestart = () => {}
      const onStop = () => {}
      const base = {
        actionInProgress: false,
        controlPlaneBusy: false,
        reconnecting: false,
        onCreateAgent,
        onOpenTerminal,
        onReconnect,
        onRefresh,
        onRestart,
        onStop,
      }

      const withoutStatus = AgentsPageHeader({ ...base, status: null })
      expect(elementsOf(withoutStatus, Button).length).toBe(2)
      expect(textOf(withoutStatus)).not.toContain('Terminal')

      const connected = AgentsPageHeader({
        ...base,
        status: status({ controlPlaneStatus: 'connected' }),
      })
      expect(textOf(connected)).not.toContain('Retry Connection')
      const terminal = elementsOf(connected, Button).find((button) =>
        textOf(button).includes('Terminal'),
      )
      expect(terminal?.props.onClick).toBe(onOpenTerminal)

      const reconnecting = AgentsPageHeader({
        ...base,
        actionInProgress: true,
        status: status({ controlPlaneStatus: 'disconnected' }),
      })
      const retry = elementsOf(reconnecting, Button).find((button) =>
        textOf(button).includes('Retry Connection'),
      )
      expect(retry?.props.onClick).toBe(base.onReconnect)
      expect(retry?.props.disabled).toBe(true)

      const stopped = AgentsPageHeader({
        ...base,
        status: status({ status: 'stopped' }),
      })
      expect(textOf(stopped)).not.toContain('Terminal')
      expect(textOf(stopped)).not.toContain('Retry Connection')
      expect(
        elementsOf(stopped, Button).find((button) =>
          textOf(button).includes('New Agent'),
        )?.props.onClick,
      ).toBe(base.onCreateAgent)
    })
  })

  describe('LifecycleAlert', () => {
    it('shows the message it was given inside an alert', () => {
      const tree = LifecycleAlert({ message: 'Starting gateway' })
      expect(elementsOf(tree, Alert).length).toBe(1)
      expect(textOf(tree)).toContain('Starting gateway')
    })
  })

  describe('InlineErrorAlert', () => {
    it('shows the failure with the message it was given and a dismiss button wired to the callback it was given', () => {
      const onDismiss = () => {}
      const tree = InlineErrorAlert({ message: 'agent exploded', onDismiss })
      const alert = elementsOf(tree, Alert)[0]
      expect(alert?.props.variant).toBe('destructive')
      expect(textOf(tree)).toContain('Agent action failed')
      expect(textOf(tree)).toContain('agent exploded')
      const dismiss = elementsOf(tree, Button)[0]
      expect(textOf(dismiss)).toBe('Dismiss')
      expect(dismiss?.props.onClick).toBe(onDismiss)
    })
  })

  describe('ControlPlaneAlert', () => {
    it('carries the copy it was given, switches tone on failure, and wires the recovery buttons to the callbacks they were given', () => {
      const copy = {
        badgeVariant: 'default' as const,
        badgeLabel: 'Recovering',
        title: 'Control plane is recovering',
        description: 'The gateway is restoring its connection.',
      }
      const onReconnect = () => {}
      const onRestart = () => {}

      const recovering = ControlPlaneAlert({
        actionInProgress: false,
        controlPlaneBusy: false,
        controlPlaneCopy: copy,
        reconnecting: false,
        recoveryDetail: 'Retrying in 30 seconds',
        status: status({ controlPlaneStatus: 'recovering' }),
        onReconnect,
        onRestart,
      })
      expect(elementsOf(recovering, Alert)[0]?.props.variant).toBe('default')
      expect(textOf(recovering)).toContain(copy.title)
      expect(textOf(recovering)).toContain(copy.description)
      expect(textOf(recovering)).toContain('Retrying in 30 seconds')

      const failed = ControlPlaneAlert({
        actionInProgress: false,
        controlPlaneBusy: false,
        controlPlaneCopy: copy,
        reconnecting: false,
        recoveryDetail: null,
        status: status({ controlPlaneStatus: 'failed' }),
        onReconnect,
        onRestart,
      })
      expect(elementsOf(failed, Alert)[0]?.props.variant).toBe('destructive')
      expect(textOf(failed)).not.toContain('Retrying in 30 seconds')

      const busy = ControlPlaneAlert({
        actionInProgress: true,
        controlPlaneBusy: false,
        controlPlaneCopy: copy,
        reconnecting: false,
        recoveryDetail: null,
        status: status({ controlPlaneStatus: 'failed' }),
        onReconnect,
        onRestart,
      })
      const retry = elementsOf(busy, Button).find((button) =>
        textOf(button).includes('Retry Connection'),
      )
      expect(retry?.props.disabled).toBe(true)
      const restart = elementsOf(busy, Button).find((button) =>
        textOf(button).includes('Restart Gateway'),
      )
      expect(restart?.props.onClick).toBe(onRestart)
    })
  })

  describe('GatewayStateCards', () => {
    it('renders the card the gateway state calls for, with its buttons wired and disabled as handed', () => {
      const onOpenSetup = () => {}
      const onRestart = () => {}
      const onStart = () => {}
      const props = {
        actionInProgress: false,
        onOpenSetup,
        onRestart,
        onStart,
      }

      const withoutStatus = GatewayStateCards({
        ...props,
        status: null,
      })
      expect(elementsOf(withoutStatus, Card).length).toBe(0)

      const unconfigured = GatewayStateCards({
        ...props,
        status: status({ status: 'uninitialized' }),
      })
      expect(textOf(unconfigured)).toContain('Set Up OpenClaw')
      const setUp = elementsOf(unconfigured, Button).find((button) =>
        textOf(button).includes('Set Up Now'),
      )
      expect(setUp?.props.onClick).toBe(onOpenSetup)

      const noRuntime = GatewayStateCards({
        ...props,
        status: status({ status: 'uninitialized', podmanAvailable: false }),
      })
      expect(textOf(noRuntime)).toContain(
        'BrowserOS VM runtime is unavailable on this system.',
      )
      expect(textOf(noRuntime)).not.toContain('Set Up Now')

      const starting = GatewayStateCards({
        ...props,
        actionInProgress: true,
        status: status({ status: 'stopped' }),
      })
      expect(textOf(starting)).toContain('Gateway Stopped')
      const start = elementsOf(starting, Button).find((button) =>
        textOf(button).includes('Start Gateway'),
      )
      expect(start?.props.onClick).toBe(onStart)
      expect(start?.props.onClick).not.toBe(onRestart)
      expect(start?.props.disabled).toBe(true)

      const failed = GatewayStateCards({
        ...props,
        status: status({
          status: 'error',
          error: 'gateway exploded',
          lastGatewayError: 'older failure',
        }),
      })
      expect(textOf(failed)).toContain('Gateway Error')
      expect(textOf(failed)).toContain('gateway exploded')
      expect(textOf(failed)).not.toContain('older failure')
    })
  })
})
