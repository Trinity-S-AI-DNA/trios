/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The feed card (gHashTag/trios#1756, slice 2a): gHashTag/t27
 * specs/hosting/feed.t27, vendored byte-identical under specs/hosting with its
 * wasm (specs/PIN). Every decision the feed makes is one call here: when to
 * ask GitHub, when to feed a head, whether a toolchain is the same, why a
 * spec's half is sharded or carried, when a receipt is complete, and how it
 * stands against the lab's.
 *
 * WHY A CARD OF ITS OWN: the feed runs in the Queen only. The host agent's
 * binary embeds every card of HOSTING_CARDS (hosting-cards.ts); this one it
 * never calls, so it stays out of that list and out of the binary.
 */

import { flag, loadCardWasm, u32, u64 } from './queen-card-wasm'

export const FEED_CARD = 'hosting/feed.wasm'

const feed = () => loadCardWasm(FEED_CARD)
const yes = (n: number | bigint) => Number(n) !== 0

// --- 1. which commits are fed -------------------------------------------------

export const pollDue = (polledBefore: boolean, secondsSince: number): boolean =>
  yes(feed().call('poll_due', flag(polledBefore), u32(secondsSince)))

export const feedDue = (
  headIsNew: boolean,
  headAgeSeconds: number,
  feedOpen: boolean,
  startedLastHour: number,
): boolean =>
  yes(
    feed().call(
      'feed_due',
      flag(headIsNew),
      u32(headAgeSeconds),
      flag(feedOpen),
      u32(startedLastHour),
    ),
  )

// --- 2. the toolchain -----------------------------------------------------------

export const toolchainPart = (allRead: boolean, allEqual: boolean): number =>
  feed().call('toolchain_part', flag(allRead), flag(allEqual)) >>> 0

export const comparable = (reference: number, t27b: number): boolean =>
  yes(feed().call('comparable', reference & 0xff, t27b & 0xff))

// --- 3. which specs need shards ------------------------------------------------

export const shardReason = (
  inBase: boolean,
  toolchain: number,
  voided: boolean,
  sameInput: boolean,
  baseVotes: boolean,
  audited: boolean,
): number =>
  feed().call(
    'shard_reason',
    flag(inBase),
    toolchain & 0xff,
    flag(voided),
    flag(sameInput),
    flag(baseVotes),
    flag(audited),
  ) >>> 0

export const shards = (reason: number): boolean =>
  yes(feed().call('shards', reason & 0xff))

export const auditPick = (pathWord: number, round: number): boolean =>
  yes(feed().call('audit_pick', u32(pathWord), u32(round)))

// --- 4. the receipt ------------------------------------------------------------

export const halfState = (
  reason: number,
  jobFound: boolean,
  jobVerdict: number,
): number =>
  feed().call(
    'half_state',
    reason & 0xff,
    flag(jobFound),
    jobVerdict & 0xff,
  ) >>> 0

export const rowSettled = (reference: number, t27b: number): boolean =>
  yes(feed().call('row_settled', reference & 0xff, t27b & 0xff))

export const auditOutcome = (
  reason: number,
  state: number,
  equalToCarried: boolean,
): number =>
  feed().call(
    'audit_outcome',
    reason & 0xff,
    state & 0xff,
    flag(equalToCarried),
  ) >>> 0

export const voidsNext = (poisonedInHalf: number): boolean =>
  yes(feed().call('voids_next', u32(poisonedInHalf)))

// --- 5. complete ----------------------------------------------------------------

export const feedState = (openHalves: number, ageSeconds: number): number =>
  feed().call('feed_state', u32(openHalves), u32(ageSeconds)) >>> 0

export const baseUsable = (state: number, toolchain: number): boolean =>
  yes(feed().call('base_usable', state & 0xff, toolchain & 0xff))

// --- 6. against the lab -----------------------------------------------------------

export const rowCompare = (
  ours: boolean,
  lab: boolean,
  labVotes: boolean,
  equal: boolean,
): number =>
  feed().call(
    'row_compare',
    flag(ours),
    flag(lab),
    flag(labVotes),
    flag(equal),
  ) >>> 0

export const labVerdict = (
  state: number,
  labFound: boolean,
  isComparable: boolean,
  different: number,
  missing: number,
  extra: number,
): number =>
  feed().call(
    'lab_verdict',
    state & 0xff,
    flag(labFound),
    flag(isComparable),
    u32(different),
    u32(missing),
    u32(extra),
  ) >>> 0

// --- 7. capacity --------------------------------------------------------------------

export const slotMsPerHour = (rowsPerHour: number, runMs: number): number =>
  Number(feed().call64('slot_ms_per_hour', u64(rowsPerHour), u64(runMs)))

export const slotsToKeepUp = (slotMs: number): number =>
  Number(feed().call64('slots_to_keep_up', u64(slotMs)))
