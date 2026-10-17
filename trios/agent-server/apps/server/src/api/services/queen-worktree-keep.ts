/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The worktree-keep card (gHashTag/t27 specs/queen/worktree_keep.t27,
 * gHashTag/trios#2005) as the server calls it, the way queen-drain.ts calls
 * drain.t27. Every function is one call into the wasm; nothing here decides.
 * The constants come from queen-worktree-keep-card.gen.ts (t27c gen-ts).
 */

import { flag, loadCardWasm, u32 } from './queen-card-wasm'

export {
  CODE_MAX_LEN,
  EK_ABORT,
  EK_OTHER,
  EK_TIMEOUT,
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
  RV_RETHROW,
  RV_RETRY,
  SHAPE_MAX_COUNT,
  SHAPE_MAX_SEQUENCE,
  ST_NO,
  ST_UNKNOWN,
  ST_YES,
  WT_KEEP,
  WT_RELEASE,
} from './queen-worktree-keep-card.gen'

export const WORKTREE_KEEP_CARD = 'queen/worktree_keep.wasm'

const card = () => loadCardWasm(WORKTREE_KEEP_CARD)

/** worktree_verdict: WT_KEEP unless all five facts are proven. */
export const worktreeVerdict = (
  ownerKnown: number,
  leaseActive: number,
  writerAlive: number,
  dirty: number,
  archiveVerified: number,
): number =>
  card().call(
    'worktree_verdict',
    ownerKnown,
    leaseActive,
    writerAlive,
    dirty,
    archiveVerified,
  )

/** boot_releases: whether startup may release any worktree (it may not). */
export const bootReleases = (entries: number): boolean =>
  card().call('boot_releases', u32(entries)) !== 0

/** retry_verdict: RV_RETHROW or RV_RETRY for a failed request. */
export const retryVerdict = (
  callerAborted: boolean,
  kind: number,
  deliveredBytes: number,
  attempt: number,
  maxAttempts: number,
): number =>
  card().call(
    'retry_verdict',
    flag(callerAborted),
    kind,
    u32(deliveredBytes),
    u32(attempt),
    u32(maxAttempts),
  )

/** claims_again_at_once: whether a runner claims again without waiting for its poll. */
export const claimsAgainAtOnce = (started: boolean): boolean =>
  card().call('claims_again_at_once', flag(started)) !== 0

/** reap_verdict: WT_KEEP unless the disk reaper has all four proofs. */
export const reapVerdict = (
  running: number,
  dirtyWithIgnored: number,
  unpushed: number,
  readOk: number,
): number =>
  card().call('reap_verdict', running, dirtyWithIgnored, unpushed, readOk)

/** shape_count: a diagnostic count under the card's bound. */
export const shapeCount = (n: number): number =>
  card().call('shape_count', u32(n)) >>> 0

/** code_reportable: whether a provider code may appear in a log line. */
export const codeReportable = (length: number, allDigits: boolean): boolean =>
  card().call('code_reportable', u32(length), flag(allDigits)) !== 0
