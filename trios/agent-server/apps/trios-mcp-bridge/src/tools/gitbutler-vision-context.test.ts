/**
 * @license AGPL-3.0-or-later
 * Copyright 2026 TRIOS
 *
 * The GitButler vision context tool, held against its contract
 * (gHashTag/trios#1672): the single export of
 * gitbutler-vision-context.ts - gitbutler_vision_context - pinned
 * as it behaves today, so the next change to that file has
 * something to fail against.
 *
 * The tool's definition is the contract: the pinned name and
 * description, the automation approval category, the input schema
 * (the optional flags with their bounds and defaults, measurable on
 * the zod schema itself), and the output schema (the
 * repository_info / ui_state / changes / recent_commits shape).
 * The handler is the Phase-2 placeholder: it answers with the
 * preamble text, the placeholder repository payload (name
 * BrowserOS, active panel ai-chat, the one placeholder change),
 * and an image when the response supports one.
 *
 * The response is a recording fake; the handler needs no ctx. No
 * network, no database, no container.
 */

import { describe, expect, it } from 'bun:test'
import type { z } from 'zod'
import { gitbutler_vision_context } from './gitbutler-vision-context'

interface Recorded {
  texts: string[]
  data: unknown[]
  errors: string[]
  images: Array<{ data: string; mimeType?: string }>
}

const runHandler = async (): Promise<Recorded> => {
  const recorded: Recorded = {
    texts: [],
    data: [],
    errors: [],
    images: [],
  }
  await gitbutler_vision_context.handler({} as never, undefined as never, {
    text: (message: string) => {
      recorded.texts.push(message)
    },
    data: (payload: unknown) => {
      recorded.data.push(payload)
    },
    error: (message: string) => {
      recorded.errors.push(message)
    },
    image: (data: string, mimeType?: string) => {
      recorded.images.push({ data, mimeType })
    },
  })
  return recorded
}

describe('gitbutler_vision_context - definition', () => {
  it('carries the pinned name, description and approval category', () => {
    expect(gitbutler_vision_context.name).toBe('gitbutler_vision_context')
    expect(gitbutler_vision_context.description).toContain(
      'comprehensive Git repository context',
    )
    expect(gitbutler_vision_context.approvalCategory).toBe('automation')
  })

  it('bounds the numeric inputs with the pinned defaults', () => {
    const input =
      gitbutler_vision_context.input as unknown as z.ZodObject<z.ZodRawShape>
    const maxFiles = input.shape.max_files as z.ZodDefault<z.ZodNumber>
    const recent = input.shape
      .include_recent_commits as z.ZodDefault<z.ZodNumber>
    expect(maxFiles.parse(undefined)).toBe(20)
    expect(recent.parse(undefined)).toBe(5)
    expect(() => maxFiles.parse(51)).toThrow()
    expect(() => recent.parse(11)).toThrow()
  })

  it('describes the output contract: repository info, ui state, changes, commits', () => {
    const output =
      gitbutler_vision_context.output as unknown as z.ZodObject<z.ZodRawShape>
    expect(Object.keys(output.shape).sort()).toEqual([
      'changes',
      'recent_commits',
      'repository_info',
      'ui_state',
    ])
    const info = output.shape.repository_info as z.ZodObject<z.ZodRawShape>
    expect(Object.keys(info.shape)).toContain('head')
    expect(Object.keys(info.shape)).toContain('clean')
  })
})

describe('gitbutler_vision_context - the placeholder handler', () => {
  it('answers with the preamble, the placeholder payload and an image', async () => {
    const recorded = await runHandler()
    expect(recorded.texts).toEqual([
      'Retrieving GitButler repository context...',
    ])
    expect(recorded.errors).toEqual([])
    const payload = recorded.data[0] as {
      repository_info: { name: string; head: string }
      ui_state: { active_panel: string }
      changes: Array<{ type: string; path: string }>
      recent_commits: unknown[]
    }
    expect(payload.repository_info.name).toBe('BrowserOS')
    expect(payload.repository_info.head).toBe('unknown')
    expect(payload.ui_state.active_panel).toBe('ai-chat')
    expect(payload.changes[0]).toMatchObject({
      type: 'file_modified',
      path: 'README.md',
      status: 'visible',
    })
    expect(payload.recent_commits).toEqual([])
    expect(recorded.images.length).toBe(1)
    expect(recorded.images[0].mimeType).toBe('image/png')
  })
})
