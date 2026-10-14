/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The SHAPE of a chat request, for diagnosing a provider's HTTP 400
 * (gHashTag/trios#2005, Z.ai code 1214). Nothing here changes a request.
 *
 * NOTHING FROM THE REQUEST IS COPIED INTO THE RESULT. A role or a part type is
 * looked up in a closed table and anything else is reported as "unknown"; the
 * model name is not reported; a provider code is reported only when it is
 * digits and short. The bounds (how many messages are listed, the largest
 * count, the longest code) are the card's (specs/queen/worktree_keep.t27, via
 * queen-worktree-keep.ts). The two tables below are the wire vocabulary at
 * the I/O edge - which spelling is which id - and decide nothing.
 */

import {
  CODE_MAX_LEN,
  codeReportable,
  PART_EMPTY,
  PART_IMAGE,
  PART_REASONING,
  PART_TEXT,
  PART_TOOL_CALL,
  PART_TOOL_RESULT,
  PART_UNKNOWN,
  ROLE_ASSISTANT,
  ROLE_SYSTEM,
  ROLE_TOOL,
  ROLE_UNKNOWN,
  ROLE_USER,
  SHAPE_MAX_COUNT,
  SHAPE_MAX_SEQUENCE,
  shapeCount,
} from '../api/services/queen-worktree-keep'

const ROLE_LABELS = new Map<number, string>([
  [ROLE_SYSTEM, 'system'],
  [ROLE_USER, 'user'],
  [ROLE_ASSISTANT, 'assistant'],
  [ROLE_TOOL, 'tool'],
  [ROLE_UNKNOWN, 'unknown'],
])

const PART_LABELS = new Map<number, string>([
  [PART_TEXT, 'text'],
  [PART_IMAGE, 'image'],
  [PART_TOOL_CALL, 'tool_call'],
  [PART_TOOL_RESULT, 'tool_result'],
  [PART_REASONING, 'reasoning'],
  [PART_EMPTY, 'empty'],
  [PART_UNKNOWN, 'unknown'],
])

/** Wire spelling -> id. A Map, so a key such as "__proto__" is only a miss. */
const ROLE_BY_NAME = new Map<string, number>([
  ['system', ROLE_SYSTEM],
  ['user', ROLE_USER],
  ['assistant', ROLE_ASSISTANT],
  ['tool', ROLE_TOOL],
])

const PART_BY_TYPE = new Map<string, number>([
  ['text', PART_TEXT],
  ['input_text', PART_TEXT],
  ['output_text', PART_TEXT],
  ['image_url', PART_IMAGE],
  ['image', PART_IMAGE],
  ['tool-call', PART_TOOL_CALL],
  ['tool_call', PART_TOOL_CALL],
  ['tool-result', PART_TOOL_RESULT],
  ['tool_result', PART_TOOL_RESULT],
  ['reasoning', PART_REASONING],
])

/** Most kinds named for one message, so one message cannot grow a line. */
const KINDS_PER_MESSAGE = 8

export interface RequestShape {
  messages: number
  /** One entry per message (bounded), "<role>:<kind>+<kind>", closed labels only. */
  sequence: string[]
  roleCounts: Record<string, number>
  partTypeCounts: Record<string, number>
  toolCalls: number
  toolResults: number
  hasReasoning: boolean
  tools: number
}

function zeroed(labels: Map<number, string>): Record<string, number> {
  const out: Record<string, number> = Object.create(null)
  for (const label of labels.values()) out[label] = 0
  return out
}

function label(labels: Map<number, string>, id: number): string {
  return labels.get(id) ?? 'unknown'
}

function partIdOf(part: unknown): number {
  if (typeof part !== 'object' || part === null) return PART_UNKNOWN
  const type = (part as { type?: unknown }).type
  return typeof type === 'string'
    ? (PART_BY_TYPE.get(type) ?? PART_UNKNOWN)
    : PART_UNKNOWN
}

/** The part ids of one message, read as far as the budget allows. */
function partsOf(message: Record<string, unknown>, budget: number): number[] {
  const ids: number[] = []
  const content = message.content
  if (typeof content === 'string') ids.push(PART_TEXT)
  else if (Array.isArray(content)) {
    for (let i = 0; i < content.length && ids.length < budget; i++)
      ids.push(partIdOf(content[i]))
  } else if (content === null || content === undefined) ids.push(PART_EMPTY)
  else ids.push(PART_UNKNOWN)
  if (Array.isArray(message.tool_calls)) {
    const n = Math.min(message.tool_calls.length, budget)
    for (let i = 0; i < n; i++) ids.push(PART_TOOL_CALL)
  }
  if (typeof message.reasoning_content === 'string') ids.push(PART_REASONING)
  if (typeof message.tool_call_id === 'string') ids.push(PART_TOOL_RESULT)
  return ids
}

interface Tally {
  roleCounts: Record<string, number>
  partCounts: Record<string, number>
  sequence: string[]
  toolCalls: number
  toolResults: number
  hasReasoning: boolean
  partsSeen: number
}

/** One message into the tally: its role and part kinds, by closed label only. */
function tallyMessage(raw: unknown, tally: Tally): void {
  const message = (
    typeof raw === 'object' && raw !== null ? raw : {}
  ) as Record<string, unknown>
  const roleName = typeof message.role === 'string' ? message.role : ''
  const role = label(ROLE_LABELS, ROLE_BY_NAME.get(roleName) ?? ROLE_UNKNOWN)
  tally.roleCounts[role] = (tally.roleCounts[role] ?? 0) + 1
  const names: string[] = []
  for (const id of partsOf(message, SHAPE_MAX_SEQUENCE)) {
    const name = label(PART_LABELS, id)
    if (tally.partsSeen < SHAPE_MAX_COUNT) {
      tally.partCounts[name] = (tally.partCounts[name] ?? 0) + 1
      tally.partsSeen++
    }
    if (id === PART_TOOL_CALL) tally.toolCalls++
    if (id === PART_TOOL_RESULT) tally.toolResults++
    if (id === PART_REASONING) tally.hasReasoning = true
    if (names.length < KINDS_PER_MESSAGE) names.push(name)
  }
  if (tally.sequence.length < SHAPE_MAX_SEQUENCE)
    tally.sequence.push(`${role}:${names.join('+') || 'none'}`)
}

/** The shape of a JSON request body, or undefined when it is not one we read. */
export function describeRequestShape(body: unknown): RequestShape | undefined {
  if (typeof body !== 'string') return undefined
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof json !== 'object' || json === null) return undefined
  const record = json as Record<string, unknown>
  if (!Array.isArray(record.messages)) return undefined

  const tally: Tally = {
    roleCounts: zeroed(ROLE_LABELS),
    partCounts: zeroed(PART_LABELS),
    sequence: [],
    toolCalls: 0,
    toolResults: 0,
    hasReasoning: false,
    partsSeen: 0,
  }
  const read = Math.min(record.messages.length, SHAPE_MAX_COUNT)
  for (let i = 0; i < read; i++) tallyMessage(record.messages[i], tally)
  for (const counts of [tally.roleCounts, tally.partCounts])
    for (const key of Object.keys(counts))
      counts[key] = shapeCount(counts[key] ?? 0)

  return {
    messages: shapeCount(record.messages.length),
    sequence: tally.sequence,
    roleCounts: tally.roleCounts,
    partTypeCounts: tally.partCounts,
    toolCalls: shapeCount(tally.toolCalls),
    toolResults: shapeCount(tally.toolResults),
    hasReasoning: tally.hasReasoning,
    tools: shapeCount(Array.isArray(record.tools) ? record.tools.length : 0),
  }
}

/**
 * The provider code of an error body ({"error":{"code":1214}} or
 * {"code":"1214"}) when it is digits and short; the message text and every
 * other spelling are dropped.
 */
export function providerErrorCode(responseBody: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(responseBody)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const top = parsed as { code?: unknown; error?: unknown }
  const inner =
    typeof top.error === 'object' && top.error !== null
      ? (top.error as { code?: unknown }).code
      : undefined
  const code = inner ?? top.code
  const text =
    typeof code === 'number' && Number.isSafeInteger(code) && code >= 0
      ? String(code)
      : typeof code === 'string'
        ? code
        : ''
  const allDigits = /^[0-9]+$/.test(text)
  // the length is read only up to the card's bound + 1, never the whole text
  const length = Math.min(text.length, CODE_MAX_LEN + 1)
  return codeReportable(length, allDigits) ? text : undefined
}

export interface ClientErrorInfo {
  status: number
  code?: string
  shape?: RequestShape
}

/**
 * Wrap a fetch so a 4xx (400 above all) is described by shape and code to
 * `onClientError`, and nothing else changes: the same response is returned, or
 * the same error is re-thrown, so terminal-quota handling (a 429 that means
 * the balance is spent) and the SDK's own retry rules stay exactly as they
 * were. Works for both kinds of inner fetch: one that returns the 4xx
 * (overload-retry-fetch) and one that throws an APICallError for it
 * (openrouter-fetch, the Z.ai path). Never retries.
 */
export function observeClientErrors(
  inner: typeof fetch,
  onClientError: (info: ClientErrorInfo) => void,
  deadlineMs = DIAGNOSTIC_DEADLINE_MS,
): typeof fetch {
  const report = (status: unknown, head: string, init?: RequestInit) => {
    if (typeof status !== 'number' || status < 400 || status >= 500) return
    try {
      onClientError({
        status,
        code: providerErrorCode(head),
        shape: describeRequestShape(init?.body),
      })
    } catch {
      // diagnostics never change the answer
    }
  }
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    let response: Response
    try {
      response = await inner(url, init)
    } catch (error) {
      const failed = error as { statusCode?: unknown; responseBody?: unknown }
      const body =
        typeof failed?.responseBody === 'string'
          ? failed.responseBody.slice(0, 4096)
          : ''
      report(failed?.statusCode, body, init)
      throw error
    }
    if (response.status >= 400 && response.status < 500) {
      // a clone, read for at most deadlineMs; the original goes back as it is
      const head = await readBodyHead(response.clone(), 4096, deadlineMs)
      report(response.status, head, init)
    }
    return response
  }) as typeof fetch
}

/**
 * How long a diagnostic may wait for the head of an error body. This is I/O
 * transport glue, not a business rule: the card's verdicts do not depend on
 * it, and the original response never waits for more than this.
 */
export const DIAGNOSTIC_DEADLINE_MS = 250

/**
 * The first `max` bytes of a body, read without holding the rest, best effort
 * and bounded in time.
 *
 * Meant for a CLONE of a response. Two things it must never do: wait for the
 * original branch (the cancel of a tee branch completes only once the other
 * branch is consumed or cancelled, so awaiting it would deadlock a caller
 * that returns the original afterwards), and wait without limit for a body
 * that stalls. So the cancel is started and NOT awaited, its outcome is
 * swallowed, and the loop gives up at `deadlineMs` with whatever it has.
 */
export async function readBodyHead(
  response: Response,
  max = 4096,
  deadlineMs = DIAGNOSTIC_DEADLINE_MS,
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), deadlineMs)
  })
  try {
    while (size < max) {
      const next = await Promise.race([reader.read(), late])
      if (next === 'late' || next.done) break
      const take = next.value.subarray(0, max - size)
      chunks.push(take)
      size += take.length
    }
  } catch {
    // an unreadable body is an empty one for diagnostics
  } finally {
    clearTimeout(timer)
    // started, never awaited: see the comment above
    void reader.cancel().catch(() => {})
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    all.set(chunk, at)
    at += chunk.length
  }
  return new TextDecoder().decode(all)
}
