/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE BEAT (specs/queen/netlink.t27 section 3, trios#1712): the entry of the
 * worker thread that renews a node's lease, with a connection of its own.
 *
 * WHY A THREAD. The lease was renewed by a timer on the event loop the actors
 * run on, so a turn that held the loop for a whole lease made a live node look
 * dead, and its peers started its children elsewhere (reproduced: a 25 s turn,
 * one false node-down). Erlang keeps its tick apart from the data for the same
 * reason. Here no turn and no slice can hold the beat up.
 *
 * WHAT IT SHARES. Three slots of one SharedArrayBuffer, read and written with
 * Atomics: the time the actors' loop last turned (the loop writes it), the
 * time the last confirmed renewal was SENT (this thread writes it), and a
 * refused flag (this thread sets it when the store refused a renewal). The
 * card decides from them: beat_renews here, must_fence on the loop.
 */

import { createQueenPool } from '../../lib/db/queen-pool'
import {
  BEAT_REFUSED,
  BEAT_RENEWED,
  BEAT_TICK,
  monoNow,
  RENEW_SQL,
} from './queen-actors-pg'
import { loadCardWasm, u32 } from './queen-card-wasm'
import {
  NODE_HEARTBEAT_SECONDS,
  NODE_TTL_SECONDS,
} from './queen-netlink-card.gen'

const port = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: (value: unknown) => void
}

/** What createPgLink posts to start the beat of one node. */
export interface BeatStart {
  url: string
  node: number
  inc: number
  host: string
  shared: SharedArrayBuffer
}

/**
 * One node's beat. Each call renews the lease once, unless the actors' loop
 * has stalled (beat_renews) or the last renewal still waits on the store.
 * `post` tells the loop what went wrong; `now` is monoNow in the thread.
 *
 * WHY A FUNCTION OF ITS OWN. The live test calls the beat itself, with a
 * clock it holds, so the time a renewal was sent and the time the test
 * compares it with come from one clock. It used to fire the interval on fake
 * timers, and on Linux CI (Bun 1.3.6) the send time read under them came out
 * 56 s before the test's start read on the real clock (trios#1730).
 */
export function nodeBeat(
  start: BeatStart,
  post: (message: unknown) => void,
  now: () => number = monoNow,
): () => Promise<void> {
  const { url, node, inc, host, shared } = start
  const slots = new BigInt64Array(shared)
  const card = loadCardWasm('queen/netlink.wasm')
  // one connection; a renewal that has not answered within a heartbeat failed
  const pool = createQueenPool(url, {
    max: 1,
    statement_timeout: NODE_HEARTBEAT_SECONDS * 1000,
  })
  let busy = false
  return async () => {
    if (busy) return
    busy = true
    try {
      const stall = (now() - Number(Atomics.load(slots, BEAT_TICK))) / 1000
      if (card.call('beat_renews', u32(stall)) === 0) {
        post({ stalled: stall })
        return
      }
      const sentAt = now()
      const r = await pool.query(RENEW_SQL, [node, inc, host, NODE_TTL_SECONDS])
      if (r.rowCount === 1)
        Atomics.store(slots, BEAT_RENEWED, BigInt(Math.floor(sentAt)))
      else {
        Atomics.store(slots, BEAT_REFUSED, 1n)
        post({ refused: true })
      }
    } catch (error) {
      // an unanswered renewal is no renewal; the loop's must_fence counts it
      post({
        failed: error instanceof Error ? error.message : String(error),
      })
    } finally {
      busy = false
    }
  }
}

port.onmessage = (event: MessageEvent) => {
  const beat = nodeBeat(event.data as BeatStart, (message) =>
    port.postMessage(message),
  )
  setInterval(() => void beat(), NODE_HEARTBEAT_SECONDS * 1000)
}

// LOADED. Every module of this thread is in by the time this line runs, so a
// terminate from now on cannot land on a load: createPgLink ends the thread
// only after this word (`endBeat`, gHashTag/trios#1813). Not on the main
// thread, where the live test imports nodeBeat.
if (!Bun.isMainThread) port.postMessage({ loaded: true })
