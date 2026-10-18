/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A model call on a lane no bee is using, for the Queen's side jobs: shaping
 * issues and the t27-bees review.
 *
 * WHY. Measured 2026-10-08: the shaper's first real calls all ended "the
 * operation timed out". It always took the first review lane and ignored the
 * keys running bees hold, and a z.ai key carries two concurrent requests. So
 * the call queued behind the bees until its 120 s ceiling. The round's own
 * reviewer never had this problem, because it passes runningKeys first. This
 * does the same:
 * - it never asks for a lane a running bee holds;
 * - it skips a lane in its half-hour backoff;
 * - it honours the reviewer pins (TRIOS_QUEEN_REVIEW_POOL / _MODEL) through
 *   chooseReviewerLane;
 * - on "not now" it tries up to MAX_LANES lanes, each one once.
 */

import type { Pool } from 'pg'
import type { AppLlm } from './queen-app'
import { loadCardWasm } from './queen-card-wasm'
import { reviewLaneCandidates, type WorkerProvider } from './queen-dispatch'
import * as KV from './queen-key-vault-card.gen'
import {
  chooseReviewerLane,
  defaultReviewerLlm,
  reviewerLaneBackedOff,
  reviewerLaneKey,
} from './queen-reviewer'
import { runningKeys } from './queen-tick'

export const MAX_LANES = 3

export interface FreeLaneDeps {
  candidates?: (taken: number[]) => WorkerProvider[]
  call?: typeof defaultReviewerLlm
  taken?: (pool: Pool) => Promise<number[]>
}

export function freeLaneLlm(
  pool: Pool | null,
  deps: FreeLaneDeps = {},
): AppLlm {
  const candidates =
    deps.candidates ?? ((taken: number[]) => reviewLaneCandidates(taken))
  const call = deps.call ?? defaultReviewerLlm
  return async (system, message) => {
    const taken = pool ? await (deps.taken ?? runningKeys)(pool) : []
    const tried = new Set<string>()
    let last = 'no reviewer lane is free'
    for (let i = 0; i < MAX_LANES; i += 1) {
      const choice = chooseReviewerLane(
        candidates(taken)
          .filter((lane) => !reviewerLaneBackedOff(lane))
          .filter((lane) => !tried.has(reviewerLaneKey(lane))),
        {},
      )
      if (!choice) break
      const lane = choice.lane
      tried.add(reviewerLaneKey(lane))
      const answer = await call(lane, system, message)
      if (answer.ok)
        return {
          ok: true,
          text: answer.text,
          model: `${lane.provider}/${lane.model}`,
        }
      last = answer.error
      if (!answer.transient) return answer
    }
    return { ok: false, error: last, transient: true }
  }
}

/** Lease decisions are key_vault.t27's; `leased` is the z.ai keys out now. */
export const vault = (fn: string, ...args: number[]) =>
  loadCardWasm('queen/key_vault.wasm').call(fn, ...args)
export const leased = new Map<string, symbol>()

/** One leased request: a lane makes it, a refused lane hands it on. */
export async function zaiLeaseCall(
  lanes: WorkerProvider[],
  path: string,
  init: RequestInit & { headers: Record<string, string> },
) {
  let last: Response | null = null
  for (const [i, lane] of lanes.slice(0, KV.LEASE_TRIES).entries()) {
    const key = reviewerLaneKey(lane)
    const id = Symbol()
    const free = () => leased.get(key) === id && leased.delete(key)
    leased.set(key, id)
    setTimeout(free, KV.LEASE_SECONDS * 1000)
    const res = await fetch(`https://api.z.ai/api/anthropic${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${lane.apiKey}` },
      signal: AbortSignal.timeout(KV.LEASE_SECONDS * 1000),
    }).catch(() => null)
    const headers = { 'content-type': res?.headers.get('content-type') ?? '' }
    if (res?.ok && res.body) {
      const done = new TransformStream({ flush: () => void free() })
      return new Response(res.body.pipeThrough(done), { headers })
    }
    free()
    const text = (await res?.text().catch(() => '')) ?? ''
    const code = Number(/"code"\s*:\s*"?(\d+)/.exec(text)?.[1] ?? 0)
    last = res && new Response(text, { status: res.status, headers })
    if (vault('lease_step', res?.status ?? 0, code, i + 1) === KV.LS_ANSWER)
      break
  }
  return last
}
