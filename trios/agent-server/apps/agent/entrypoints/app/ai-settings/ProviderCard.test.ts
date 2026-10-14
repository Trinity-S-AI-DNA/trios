/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The provider card, held against its contract
 * (gHashTag/trios#1654): the single export of
 * entrypoints/app/ai-settings/ProviderCard.tsx - ProviderCard - pinned
 * as it behaves today, so the next change to that file has something to
 * fail against.
 *
 * The card is pure presentational (no storage, no router), so every
 * branch is reachable through a static render: the selected and plain
 * frames, the built-in card with its bring-your-own-key note and no
 * action buttons, the custom card with its model line and the
 * Test/Edit/Delete actions, and the testing state of the Test button.
 * Not pinned: the click handlers themselves (a static render fires none).
 */
import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { LlmProviderConfig } from '@/lib/llm-providers/types'

const { ProviderCard } = await import('./ProviderCard')

const provider = (
  over: Partial<LlmProviderConfig> = {},
): LlmProviderConfig => ({
  id: 'prov-1',
  type: 'openai',
  name: 'My OpenAI',
  modelId: 'gpt-x',
  supportsImages: true,
  contextWindow: 128000,
  temperature: 0.5,
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
  baseUrl: 'https://api.test/v1',
  ...over,
})

const markup = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(
      ProviderCard as never,
      {
        provider: provider(),
        isSelected: false,
        isBuiltIn: false,
        onSelect: () => {},
        ...props,
      } as never,
    ),
  )

describe('providerCardContract', () => {
  it('answers the selected frame with the DEFAULT badge and the check', () => {
    const m = markup({ isSelected: true })
    expect(m).toContain('DEFAULT')
    expect(m).toContain('lucide-check')
    expect(m).toContain(
      'border-[var(--accent-orange)] bg-[var(--accent-orange)]/5',
    )
    expect(m).toContain('checked=""')
  })

  it('answers the plain frame without the badge or the check', () => {
    const m = markup({ isSelected: false })
    expect(m).not.toContain('DEFAULT')
    expect(m).not.toContain('lucide-check')
    expect(m).toContain('border-border bg-card')
  })

  it('answers the radio input named for the default choice', () => {
    const m = markup({})
    expect(m).toContain('type="radio"')
    expect(m).toContain('id="provider-prov-1"')
    expect(m).toContain('name="default-provider"')
  })

  it('answers the built-in card with its note and no action buttons', () => {
    const m = markup({
      isBuiltIn: true,
      provider: provider({ modelId: 'browseros-1' }),
    })
    expect(m).toContain('BrowserOS-hosted model with strict rate limits.')
    expect(m).toContain('Bring your own key')
    expect(m).toContain(
      'href="https://docs.browseros.com/features/bring-your-own-llm"',
    )
    expect(m).not.toContain('>Test<')
    expect(m).not.toContain('Edit')
    expect(m).not.toContain('lucide-trash2')
  })

  it('answers the custom card with the model line and the actions, and the testing state of the Test button', () => {
    const m = markup({})
    expect(m).toContain('gpt-x \u2022 https://api.test/v1')
    expect(m).toContain('Test')
    expect(m).toContain('Edit')
    expect(m).toContain('lucide-trash2')
    expect(m).not.toContain('Testing...')

    const noBase = markup({ provider: provider({ baseUrl: undefined }) })
    expect(noBase).toContain('gpt-x')
    expect(noBase).not.toContain('\u2022')

    const testing = markup({ isTesting: true })
    expect(testing).toContain('Testing...')
    expect(testing).toContain('lucide-loader-circle')
    expect(testing).toContain('disabled=""')
  })
})
