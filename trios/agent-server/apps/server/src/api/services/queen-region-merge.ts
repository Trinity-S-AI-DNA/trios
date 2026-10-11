/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE MERGE SIDE OF A DECLARED REGION (gHashTag/t27#9021, golden_chain.t27
 * section 5; behind TRIOS_QUEEN_REGIONS, off by default).
 *
 * WHY. With TRIOS_QUEEN_DISPATCH_BATCH on (production since 12:42Z on
 * 2026-10-11), a Boundary line `- path :: fn NAME` that resolves at the base
 * is admitted as the lines of that item, so two bees may edit one file at
 * once. Nothing checked afterwards that a bee kept to its region: a bee that
 * wandered into a neighbour's function was accepted all the same, and the
 * two branches met in git instead of in the scheduler. issue_shape.t27 (#9062)
 * states the contract: one hunk outside makes that file's edit whole again,
 * so nothing becomes less safe than a whole-file line.
 *
 * WHAT DECIDES, all as generated wasm:
 *   - policy/issue_shape.t27 reads the bee's Boundary and resolves each region
 *     at the dispatch's base commit (editsOf, item_span), and says whether a
 *     hunk lies inside a region (edit_inside, the #9062 insertion rule
 *     included);
 *   - queen/golden_chain.t27 gc_merge_kind makes a file with a hunk outside
 *     EDIT_WHOLE; gc_pair (actors.t27 edits_meet), through holds.t27
 *     held_part and control.t27 meets_pick (editsMeet), says whether that
 *     widened edit meets a live one; gc_region_step folds the files into one
 *     answer and gc_region_counts says whether a send-back is charged;
 *   - queen/holds.t27 says what each other dispatch still holds (heldPaths).
 * This file reads the issue, the diff, the base and the live rows, and
 * carries values. It asks gc_region_step with both values of a fact it has
 * not read yet and reads it only when the answers differ, so a verdict that
 * is not an accept costs no read at all.
 *
 * THE BASE. The bee's diff is `git diff -U0 <merge base> <branch head>`, so
 * its hunks count lines of the merge base, and the regions resolve in the
 * same file: both sides read one commit, as item_span requires. The merge
 * base is the commit the bee's branch was cut from, the dispatch's base.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Pool } from 'pg'
import { logger } from '../../lib/logger'
import {
  derivedFreeEnabled,
  type Edit,
  editsMeet,
  editsOf,
  type ReadBase,
  readBaseFile,
  regionsEnabled,
  stillHeld,
} from './queen-batch-choose'
import { flag, loadCardWasm, u32 } from './queen-card-wasm'
import { workspaceRoot } from './queen-dispatch'
import {
  EDIT_LINES,
  EDIT_WHOLE,
  GC_RV_STANDS,
} from './queen-golden-chain-card.gen'
import { heldPart, heldPaths } from './queen-holds'
import { HP_APART } from './queen-holds.gen'

const shape = () => loadCardWasm('policy/issue_shape.wasm')
const chain = () => loadCardWasm('queen/golden_chain.wasm')

/** One hunk on the base side: lines [lo, hi); lo === hi is an insertion before line lo. */
export interface Hunk {
  lo: number
  hi: number
}

/**
 * The hunks of `git diff -U0` text, as lines of the base side. Reading git's
 * header `@@ -a,b +c,d @@`: b lines from line a; b omitted is one line; b = 0
 * is an insertion AFTER line a, which is issue_shape.t27's insertion before
 * line a + 1. Nothing else in the text is read.
 */
export function hunksOf(diff: string): Hunk[] {
  const out: Hunk[] = []
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const a = Number(m[1])
    const b = m[2] === undefined ? 1 : Number(m[2])
    out.push(b === 0 ? { lo: a + 1, hi: a + 1 } : { lo: a, hi: a + b })
  }
  return out
}

/** issue_shape.t27 edit_inside: does the hunk lie inside the region's lines? */
export const editInside = (h: Hunk, region: Edit): boolean =>
  shape().call(
    'edit_inside',
    u32(h.lo),
    u32(h.hi),
    u32(region.lo),
    u32(region.hi),
  ) !== 0

/** golden_chain.t27 gc_merge_kind: the region while kept, the whole file once left. */
export const mergeKind = (kept: boolean): number =>
  chain().call('gc_merge_kind', flag(kept))

/** golden_chain.t27 gc_region_step: one file folded into the answer so far. */
export const regionStep = (
  soFar: number,
  accepting: boolean,
  read: boolean,
  kind: number,
  meetsLive: boolean,
): number =>
  chain().call(
    'gc_region_step',
    soFar,
    flag(accepting),
    flag(read),
    kind,
    flag(meetsLive),
  )

/** golden_chain.t27 gc_region_counts: is the answer a finding charged to the issue? */
export const regionCounts = (answer: number): boolean =>
  chain().call('gc_region_counts', answer) !== 0

/** A dispatch that still holds files, and the files (holds.t27). */
export interface LiveHolder {
  issue: number
  paths: string[]
}

/** Everything the check reads; each read answers null when it could not. */
export interface RegionDeps {
  /** TRIOS_QUEEN_REGIONS. Off, the check reads nothing and the verdict stands. */
  enabled: boolean
  derivedFree: boolean
  /** The bee's issue body. */
  issueBody: (issue: number) => Promise<string | null>
  /** One file at one commit. */
  readAt: (sha: string, path: string) => Promise<string | null>
  /** `git diff -U0` of one path between two commits. */
  diffOf: (base: string, head: string, path: string) => Promise<string | null>
  /** Every other dispatch that still holds files; null when unread. */
  liveHolders: (except: number) => Promise<LiveHolder[] | null>
  /** A holder's own regions resolve as admission resolved them: at the base ref. */
  readBase: ReadBase
}

export interface RegionCheckInput {
  issue: number
  /** The verdict the review reached: only an accept is gated. */
  accepting: boolean
  /** The branch head the review judged. */
  head: string | null
  /** The commit the branch was cut from; read only when needed. */
  mergeBase: () => Promise<string | null>
}

/** A file whose widened edit meets live work. */
export interface RegionFinding {
  path: string
  /** The regions the issue declared in this file. */
  regions: Edit[]
  /** The hunks that lie outside every one of them. */
  outside: Hunk[]
  /** The other dispatch whose edit it meets. */
  holder: number
}

export interface RegionCheck {
  /** golden_chain.t27 GC_RV_STANDS, GC_RV_WAIT or GC_RV_SEND_BACK. */
  answer: number
  /** gc_region_counts: a send-back is charged to the issue, a wait is not. */
  counts: boolean
  findings: RegionFinding[]
  /** What could not be read, when the answer waits. */
  unread: string[]
  /** The reason the bee and the record read; empty when the verdict stands. */
  note: string
}

const STANDS: RegionCheck = {
  answer: GC_RV_STANDS,
  counts: false,
  findings: [],
  unread: [],
  note: '',
}

/** No check at all (an injected review without one): every verdict stands. */
export const noRegionCheck = async (): Promise<RegionCheck> => STANDS

const lines = (lo: number, hi: number) =>
  hi - lo <= 1 ? `base line ${lo}` : `base lines ${lo}-${hi - 1}`
const hunkText = (h: Hunk) =>
  h.lo === h.hi ? `an insertion before base line ${h.lo}` : lines(h.lo, h.hi)

function noteOf(
  answer: number,
  findings: RegionFinding[],
  unread: string[],
  base: string,
): string {
  if (findings.length > 0)
    return [
      'Sent back by the region check (gHashTag/t27 specs/queen/golden_chain.t27 ' +
        `section 5), against the merge base ${base.slice(0, 12)}:`,
      ...findings.map(
        (f) =>
          `- ${f.path}: the issue declares ${f.regions
            .map((r) => `fn ${r.item ?? '?'} (${lines(r.lo, r.hi)})`)
            .join(', ')}, and the diff changes ${f.outside
            .slice(0, 5)
            .map(hunkText)
            .join(
              ', ',
            )}${f.outside.length > 5 ? ` and ${f.outside.length - 5} more` : ''} ` +
          `outside it. So this file's edit is the whole file again, and it ` +
          `meets the live edit of #${f.holder}.`,
      ),
      'Keep every change inside the declared fn, or name in the Boundary ' +
        'each fn the work must change.',
    ].join('\n')
  if (answer !== GC_RV_STANDS)
    return (
      `The region check could not read ${unread.join(', ')}, so this accept ` +
      'waits a round: a read that failed decides nothing.'
    )
  return ''
}

/**
 * Whether reading a fact can still change the card's answer: the card is
 * asked with every value of what is not read yet.
 */
const canChange = (soFar: number, accepting: boolean): boolean => {
  const answers = new Set<number>()
  for (const read of [false, true])
    for (const kind of [EDIT_LINES, EDIT_WHOLE])
      for (const meets of [false, true])
        answers.add(regionStep(soFar, accepting, read, kind, meets))
  return answers.size > 1
}

/**
 * The check, before an accept stands. Every read that fails is folded in as
 * unread, so a broken git or GitHub waits rather than passing work.
 */
export async function checkRegions(
  input: RegionCheckInput,
  deps: RegionDeps,
): Promise<RegionCheck> {
  if (!deps.enabled || !canChange(GC_RV_STANDS, input.accepting)) return STANDS
  const { accepting } = input
  let answer = GC_RV_STANDS as number
  const unread: string[] = []
  const findings: RegionFinding[] = []
  const unreadOne = (what: string) => {
    unread.push(what)
    answer = regionStep(answer, accepting, false, EDIT_LINES, false)
  }
  const body = await deps.issueBody(input.issue).catch(() => null)
  const base = await input.mergeBase().catch(() => null)
  const head = input.head
  if (body === null) unreadOne(`the body of #${input.issue}`)
  if (base === null) unreadOne(`the merge base of queen-${input.issue}`)
  if (head === null) unreadOne(`the head of queen-${input.issue}`)
  if (body === null || base === null || head === null)
    return finish(input, answer, findings, unread, base ?? '')
  // the regions the issue declares, at the commit its hunks count lines of
  const declared = await editsOf(
    body,
    (path) => deps.readAt(base, path),
    deps.derivedFree,
    true,
  )
  // a path also named whole, or derived, holds no region of its own to keep
  const files = [...new Set(declared.map((e) => e.path))].filter((path) =>
    declared.every((e) => e.path !== path || e.kind === EDIT_LINES),
  )
  let holders: LiveHolder[] | null | undefined
  const bodies = new Map<number, Promise<string | null>>()
  const bodyOf = (n: number) => {
    const read = bodies.get(n) ?? deps.issueBody(n).catch(() => null)
    bodies.set(n, read)
    return read
  }
  for (const path of files) {
    const regions = declared.filter((e) => e.path === path)
    const diff = await deps.diffOf(base, head, path).catch(() => null)
    if (diff === null) {
      unreadOne(`the diff of ${path}`)
      continue
    }
    const outside = hunksOf(diff).filter(
      (h) => !regions.some((r) => editInside(h, r)),
    )
    const kind = mergeKind(outside.length === 0)
    const without = regionStep(answer, accepting, true, kind, false)
    if (without === regionStep(answer, accepting, true, kind, true)) {
      answer = without
      continue
    }
    holders ??= await deps.liveHolders(input.issue).catch(() => null)
    if (holders === null) {
      unreadOne('the live dispatches')
      continue
    }
    const widened: Edit = { path, kind, lo: 0, hi: 0 }
    let holder: number | undefined
    for (const h of holders) {
      // a holder holds only its held paths; one sharing no file with this
      // path holds nothing of it (holds.t27 held_part)
      if (h.paths.every((p) => heldPart(p, path) === HP_APART)) continue
      const theirs = await bodyOf(h.issue)
      const own = theirs
        ? await editsOf(theirs, deps.readBase, deps.derivedFree, true)
        : []
      if (
        stillHeld(h.paths, own, deps.derivedFree).some((e) =>
          editsMeet(widened, e),
        )
      ) {
        holder = h.issue
        break
      }
    }
    answer = regionStep(answer, accepting, true, kind, holder !== undefined)
    if (holder !== undefined) findings.push({ path, regions, outside, holder })
  }
  return finish(input, answer, findings, unread, base)
}

function finish(
  input: RegionCheckInput,
  answer: number,
  findings: RegionFinding[],
  unread: string[],
  base: string,
): RegionCheck {
  const check: RegionCheck = {
    answer,
    counts: regionCounts(answer),
    findings,
    unread,
    note: noteOf(answer, findings, unread, base),
  }
  if (answer !== GC_RV_STANDS)
    logger.info('Queen region check held back an accept', {
      issue: input.issue,
      answer,
      files: findings.map((f) => f.path),
      holders: findings.map((f) => f.holder),
      unread,
    })
  return check
}

const run = promisify(execFile)
const git = (args: string[]) =>
  run('git', ['-C', workspaceRoot(), ...args], {
    maxBuffer: 64 << 20,
    timeout: 30_000,
  }).then(
    (r) => r.stdout,
    () => null,
  )

/**
 * The real reads. `--no-ext-diff --no-textconv` for the reason branchPatch
 * gives: the bee can write the worktrees' shared git config, and an external
 * diff driver would let it write the diff its own check reads.
 */
export function regionDeps(
  pool: Pool,
  issueBody: (issue: number) => Promise<string | null>,
  env: Record<string, string | undefined> = process.env,
): RegionDeps {
  return {
    enabled: regionsEnabled(env),
    derivedFree: derivedFreeEnabled(env),
    issueBody,
    readAt: (sha, path) => git(['show', `${sha}:${path}`]),
    diffOf: (base, head, path) =>
      git([
        'diff',
        '-U0',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        base,
        head,
        '--',
        path,
      ]),
    liveHolders: async (except) => {
      const rows = await pool.query(
        `SELECT issue, owned_paths, finished_at, review_state
           FROM queen_dispatch
          WHERE started = true
            AND coalesce(outcome, '') NOT LIKE 'reaped%'
            AND dispatched_at > now() - interval '7 days'
            AND issue <> $1`,
        [except],
      )
      const now = Date.now()
      return rows.rows
        .map((row) => ({
          issue: Number(row.issue),
          paths: heldPaths(row, now),
        }))
        .filter((h) => h.paths.length > 0)
    },
    readBase: readBaseFile(),
  }
}
