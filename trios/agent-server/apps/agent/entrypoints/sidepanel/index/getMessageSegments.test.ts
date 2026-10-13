/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The message segmenter, held against its contract
 * (gHashTag/trinos#1639): the single export of
 * getMessageSegments.ts - getMessageSegments - pinned as it behaves
 * today, so the next change to that file has something to fail
 * against.
 *
 * The function folds a UIMessage's parts into ordered segments:
 * text parts become text segments (with per-message index keys),
 * reasoning parts become reasoning segments (streaming only when
 * the message is last, streaming, and this is the final part), and
 * consecutive tool parts batch into one tool-batch segment that
 * flushes when a non-tool part arrives or the message ends. The
 * two nudge tools (suggest_schedule, suggest_app_connection) never
 * join a batch: on output-available their JSON text output is
 * parsed into a nudge segment, and only nudge-shaped JSON makes it
 * through. Pure function - no environment needed at all.
 */

import { describe, expect, it } from 'bun:test'
import type { UIMessage } from 'ai'
import { getMessageSegments } from './getMessageSegments'

const message = (parts: unknown[]): UIMessage =>
  ({ id: 'm1', parts }) as unknown as UIMessage

const textPart = (text: string) => ({ type: 'text', text })
const reasoningPart = (text: string) => ({ type: 'reasoning', text })
const toolPart = (
  name: string,
  state: string,
  output?: unknown,
  input?: Record<string, unknown>,
  toolCallId = `call-${name}`,
) => ({
  type: `tool-${name}`,
  toolCallId,
  state,
  input: input ?? {},
  output,
})

const nudgeOutput = (data: Record<string, unknown>) => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
  isError: false,
})

describe('getMessageSegments', () => {
  it('maps text and reasoning parts to segments with indexed keys', () => {
    const segments = getMessageSegments(
      message([textPart('a'), reasoningPart('thinking'), textPart('b')]),
      true,
      false,
    )
    expect(segments).toEqual([
      { type: 'text', key: 'm1-text-0', text: 'a' },
      {
        type: 'reasoning',
        key: 'm1-reasoning-0',
        text: 'thinking',
        isStreaming: false,
      },
      { type: 'text', key: 'm1-text-1', text: 'b' },
    ])
  })

  it('marks reasoning streaming only for the last part of the last streaming message', () => {
    const last = getMessageSegments(
      message([textPart('a'), reasoningPart('tail')]),
      true,
      true,
    )
    expect((last[1] as { isStreaming: boolean }).isStreaming).toBe(true)

    const notLast = getMessageSegments(
      message([reasoningPart('tail')]),
      false,
      true,
    )
    expect((notLast[0] as { isStreaming: boolean }).isStreaming).toBe(false)
  })

  it('batches consecutive tool parts into one segment, flushing on text', () => {
    const segments = getMessageSegments(
      message([
        toolPart('read_file', 'result'),
        toolPart('write_file', 'result'),
        textPart('after'),
        toolPart('read_file', 'call'),
      ]),
      true,
      false,
    )
    expect(segments.map((s) => s.type)).toEqual([
      'tool-batch',
      'text',
      'tool-batch',
    ])
    const batch = segments[0] as { tools: Array<{ toolName: string }> }
    expect(batch.tools.map((t) => t.toolName)).toEqual([
      'read_file',
      'write_file',
    ])
  })

  it('parses nudge tools into nudge segments and drops everything else', () => {
    const segments = getMessageSegments(
      message([
        toolPart(
          'suggest_schedule',
          'output-available',
          nudgeOutput({ type: 'schedule_suggestion', when: 'tomorrow' }),
        ),
        toolPart('suggest_app_connection', 'output-available', {
          content: [{ type: 'text', text: 'not json' }],
          isError: false,
        }),
        toolPart('suggest_schedule', 'call'),
      ]),
      true,
      false,
    )
    expect(segments).toEqual([
      {
        type: 'nudge',
        key: 'm1-nudge-call-suggest_schedule',
        nudgeType: 'schedule_suggestion',
        data: { type: 'schedule_suggestion', when: 'tomorrow' },
      },
    ])
  })

  it('answers an empty message with no segments', () => {
    expect(getMessageSegments(message([]), true, false)).toEqual([])
  })
})
