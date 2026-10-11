/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * ONE CHOOSER CALL FILLS EVERY FREE LANE WITH EDITS THAT DO NOT MEET
 * (gHashTag/t27#9021; behind TRIOS_QUEEN_DISPATCH_BATCH, off by default).
 *
 * WHY. Measured 2026-10-11: 63 of 70 lanes idle and the round chose nothing.
 * The round already asks queend again after every pick, so the tick was never
 * the cap; the cap was queend's one-bit rule "a held path skips the issue".
 * 122 issues waited on one holder of bootstrap/src/compiler.rs as a WHOLE
 * file, and 13 on a held `.trinity/seals/`, which two writers never compete
 * for.
 *
 * WHAT DECIDES, all as generated wasm:
 *   - queend still decides claims, completion, the spec rule, capacity, money
 *     and who holds what (its first answer, unchanged);
 *   - policy/issue_shape.t27 reads each Boundary line's path and region and
 *     resolves a region to its lines at the base commit (item_span);
 *   - ci/derived_data.t27 says which paths are derived records, marked
 *     GC_EDIT_DERIVED only with TRIOS_QUEEN_DERIVED_FREE;
 *   - queen/holds.t27 held_part says whether two paths share files;
 *   - queen/golden_chain.t27 gc_pair (actors.t27 edits_meet inside) says
 *     whether two edits of shared files meet;
 *   - queen/actors.t27 file_admit says whether an edit runs or queues behind
 *     an older one it meets (it never overtakes an edit it would block);
 *   - queen/control.t27 batch_quota and pick_admits fill the free lanes with
 *     picks that meet no other pick.
 * This file reads queend's sentences and carries paths in and picks out.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EDIT_LINES, EDIT_WHOLE, FA_QUEUE } from './queen-actors-card.gen'
import { dispatchByActors } from './queen-bee-actors-round'
import { flag, loadCardWasm, u32 } from './queen-card-wasm'
import { baseRef, workspaceRoot } from './queen-dispatch'
import { GC_EDIT_DERIVED, GC_PAIR_MEET } from './queen-golden-chain-card.gen'
import { heldPart } from './queen-holds'
import { HP_APART } from './queen-holds.gen'

const shape = () => loadCardWasm('policy/issue_shape.wasm')
const derived = () => loadCardWasm('ci/derived_data.wasm')
const chain = () => loadCardWasm('queen/golden_chain.wasm')
const actors = () => loadCardWasm('queen/actors.wasm')
const control = () => loadCardWasm('queen/control.wasm')

/** TRIOS_QUEEN_DISPATCH_BATCH=on: the round's dispatch step is this chooser. */
export const dispatchBatchEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => (env.TRIOS_QUEEN_DISPATCH_BATCH ?? '').trim() === 'on'

/** TRIOS_QUEEN_DERIVED_FREE=on: derived records are GC_EDIT_DERIVED. */
export const derivedFreeEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => (env.TRIOS_QUEEN_DERIVED_FREE ?? '').trim() === 'on'

/** One edit a Boundary line asks for: a path, a kind, and lines for EDIT_LINES. */
export interface Edit {
  path: string
  kind: number
  lo: number
  hi: number
}

const half = (v: bigint): [number, number] => [
  Number(v >> 32n),
  Number(v & 0xffff_ffffn),
]

/** The base file's text, or null; one read per path per round. */
export type ReadBase = (path: string) => Promise<string | null>

const run = promisify(execFile)
export function readBaseFile(): ReadBase {
  const seen = new Map<string, Promise<string | null>>()
  return (path) => {
    const hit = seen.get(path)
    if (hit) return hit
    const read = run(
      'git',
      ['-C', workspaceRoot(), 'show', `${baseRef()}:${path}`],
      { maxBuffer: 64 << 20, timeout: 20_000 },
    ).then(
      (r) => r.stdout,
      () => null,
    )
    seen.set(path, read)
    return read
  }
}

/** The lines of `fn NAME` in `text`, or null when the card resolves nothing. */
export function itemSpan(text: string, name: string): [number, number] | null {
  const card = shape()
  const [t, n] = card.put(text, name)
  const v = BigInt(card.call64('item_span', t.at, t.len, n.at, n.len))
  return v === 0n ? null : half(v)
}

/**
 * The edits an issue body's Boundary asks for, in its own order. A region
 * that does not resolve at the base is the whole file (issue_shape.t27).
 */
export async function editsOf(
  body: string,
  readBase: ReadBase,
  derivedFree: boolean,
): Promise<Edit[]> {
  const lines: Array<{ path: string; region: string | null }> = []
  const card = shape()
  const [b] = card.put(body)
  for (let k = 0; ; k++) {
    const line = BigInt(card.call64('boundary_line', b.at, b.len, u32(k)))
    if (line === 0n) break
    const [f, t] = half(line)
    const [pf, pt] = half(
      BigInt(card.call64('line_path', b.at, f, t)) as bigint,
    )
    const [rf, rt] = half(BigInt(card.call64('line_region', b.at, f, t)))
    lines.push({
      path: card.read(b.at + pf, pt - pf),
      region: rt > rf ? card.read(b.at + rf, rt - rf) : null,
    })
  }
  const edits: Edit[] = []
  for (const { path, region } of lines) {
    const text = region === null ? null : await readBase(path)
    const span =
      text === null || region === null ? null : itemSpan(text, region)
    edits.push(
      span && !(derivedFree && isDerived(path))
        ? { path, kind: EDIT_LINES, lo: span[0], hi: span[1] }
        : wholeEdit(path, derivedFree),
    )
  }
  return edits
}

/** ci/derived_data.t27: is this Boundary path a derived record? */
export const isDerived = (path: string): boolean => {
  const card = derived()
  const [p] = card.put(path)
  return card.call('is_derived_path', p.at, p.len) !== 0
}

/** A path with no region: a derived record (with the flag), or the whole file. */
export const wholeEdit = (path: string, derivedFree: boolean): Edit => ({
  path,
  kind: derivedFree && isDerived(path) ? GC_EDIT_DERIVED : EDIT_WHOLE,
  lo: 0,
  hi: 0,
})

/** Whether two edits meet: their paths share files (held_part) and gc_pair says MEET. */
export function editsMeet(a: Edit, b: Edit): boolean {
  const shared = heldPart(a.path, b.path) !== HP_APART
  const pair = Number(
    chain().call64(
      'gc_pair',
      1n,
      a.kind,
      u32(a.lo),
      u32(a.hi),
      1n,
      b.kind,
      u32(b.lo),
      u32(b.hi),
    ),
  )
  // control.t27 meets_pick: one file owner when the paths share files
  return (
    Number(
      control().call64(
        'meets_pick',
        1n,
        shared ? 1n : 2n,
        flag(pair === GC_PAIR_MEET),
      ),
    ) !== 0
  )
}

const meetsAny = (mine: Edit[], others: Edit[]): boolean =>
  mine.some((a) => others.some((b) => editsMeet(a, b)))

/** The edits of `mine` that meet one of `others`: what waits in those files' owners' queues. */
const metBy = (mine: Edit[], others: Edit[]): Edit[] =>
  mine.filter((a) => others.some((b) => editsMeet(a, b)))

/** What queend's first answer said about each candidate. */
export interface Reading {
  eligible: Set<number>
  /** A candidate skipped for held files, and the tasks it named as holders (owner/repo#n). */
  held: Map<number, string[]>
  /** Every sentence, by the issue it leads with. */
  lines: Map<number, string[]>
}

/** Read queend's answer: chosen and `not first` are eligible; ` held by ` names holders. */
export function readAnswer(answer: {
  chosen?: number | null
  skipped?: string[] | null
}): Reading {
  const eligible = new Set<number>()
  const held = new Map<number, string[]>()
  const lines = new Map<number, string[]>()
  if (typeof answer.chosen === 'number') eligible.add(answer.chosen)
  for (const line of answer.skipped ?? []) {
    const n = Number(/^#(\d+):/.exec(line)?.[1] ?? Number.NaN)
    if (!Number.isFinite(n)) continue
    lines.set(n, [...(lines.get(n) ?? []), line])
    if (line.endsWith(': not first')) eligible.add(n)
    const at = line.indexOf(' held by ')
    if (at >= 0)
      held.set(
        n,
        [...line.slice(at + 9).matchAll(/([^\s,]+#\d+)/g)].map((m) => m[1]),
      )
  }
  return { eligible, held, lines }
}

export interface Batch {
  picks: number[]
  /** The tick's sentences: queend's, with the chooser's in place of what it changed. */
  skipped: string[]
  /** Candidates freed from a hold by regions or derived paths. */
  relaxed: number[]
}

/**
 * The batch, in the round's order. `quota` is control.t27 batch_quota of the
 * free lanes; `edits` are a candidate's, `holderEdits` what a holder still
 * holds of its own.
 *
 * A queue is a FILE OWNER's (actors.t27 section 10): an edit that meets a
 * running edit or a pick waits in the queue of the file where it met it, and
 * a later candidate may not overtake it there (file_admit's meets_queued).
 * Its edits of other files are queued nowhere, so they shut nobody out.
 */
export function chooseBatch(input: {
  candidates: number[]
  reading: Reading
  edits: Map<number, Edit[]>
  holderEdits: (holder: string) => Edit[]
  quota: number
}): Batch {
  const { candidates, reading, edits, quota } = input
  const picks: Array<{ issue: number; edits: Edit[] }> = []
  const queued: Array<{ issue: number; edits: Edit[] }> = []
  const skipped: string[] = []
  const relaxed: number[] = []
  const paths = (issue: number) =>
    (edits.get(issue) ?? []).map((e) => e.path).join(', ')
  for (const issue of candidates) {
    const mine = edits.get(issue) ?? []
    const holders = reading.held.get(issue)
    let eligible = reading.eligible.has(issue)
    if (holders && !eligible) {
      eligible = !holders.some((h) => meetsAny(mine, input.holderEdits(h)))
      if (eligible) relaxed.push(issue)
    }
    const own = (reading.lines.get(issue) ?? []).filter(
      (l) =>
        !l.endsWith(': not first') && (!eligible || !l.includes(' held by ')),
    )
    if (!eligible) {
      skipped.push(...own)
      if (holders)
        queued.push({
          issue,
          edits: metBy(
            mine,
            holders.flatMap((h) => input.holderEdits(h)),
          ),
        })
      continue
    }
    skipped.push(...own)
    const ahead = queued.find((q) => meetsAny(mine, q.edits))
    const pick = picks.find((p) => meetsAny(mine, p.edits))
    const answer = Number(
      actors().call64('file_admit', 0, flag(ahead !== undefined), 0n, 0),
    )
    if (
      control().call(
        'pick_admits',
        u32(picks.length),
        u32(quota),
        answer,
        flag(pick !== undefined),
      ) !== 0
    ) {
      picks.push({ issue, edits: mine })
      continue
    }
    const by = ahead ?? pick
    if (by || answer === FA_QUEUE) {
      queued.push({ issue, edits: metBy(mine, by?.edits ?? []) })
      skipped.push(`#${issue}: ${paths(issue)} held by #${by?.issue}`)
    } else skipped.push(`#${issue}: not first`)
  }
  return { picks: picks.map((p) => p.issue), skipped, relaxed }
}

/** control.t27 batch_quota: every free lane, up to the eligible candidates. */
export const batchQuota = (cap: number, running: number, eligible: number) =>
  control().call('batch_quota', u32(cap), u32(running), u32(eligible))

/** A task on the round's board, as boardTask writes it. */
interface BoardTask {
  issue?: { owner?: string; repo?: string; number?: number }
  state?: string
  ownedPaths?: string[]
}

const slugOf = (t: BoardTask) =>
  `${t.issue?.owner}/${t.issue?.repo}#${t.issue?.number}`

/**
 * The whole step: read queend's first answer, take every candidate's edits
 * and every named holder's, and choose. `cap` is the configured lane count
 * (TRIOS_QUEEN_MAX_WORKERS, the number queend reads); a task running or
 * queued on the board takes a lane.
 */
export async function planBatch(input: {
  candidates: number[]
  answer: { chosen?: number | null; skipped?: string[] | null }
  bodies: Record<string, string>
  board: unknown[]
  /** owner/repo of the issues the round reads, for a holder's own body */
  repo: string
  cap: number
  derivedFree: boolean
  readBase: ReadBase
}): Promise<Batch & { paths: Map<number, string[]> }> {
  const reading = readAnswer(input.answer)
  const board = input.board as BoardTask[]
  const edits = new Map<number, Edit[]>()
  for (const n of input.candidates)
    if (reading.eligible.has(n) || reading.held.has(n))
      edits.set(
        n,
        await editsOf(
          input.bodies[String(n)] ?? '',
          input.readBase,
          input.derivedFree,
        ),
      )
  const holders = new Map<string, Edit[]>()
  for (const slug of new Set([...reading.held.values()].flat())) {
    const held = board
      .filter((t) => slugOf(t) === slug)
      .flatMap((t) => t.ownedPaths ?? [])
    const [own, number] = slug.split('#')
    const body = own === input.repo ? input.bodies[number ?? ''] : undefined
    const declared = body
      ? await editsOf(body, input.readBase, input.derivedFree)
      : []
    // what it still holds: its declared edits of a held path, else the whole path
    holders.set(
      slug,
      held.flatMap((path) => {
        const mine = declared.filter((e) => heldPart(e.path, path) !== HP_APART)
        return mine.length > 0 ? mine : [wholeEdit(path, input.derivedFree)]
      }),
    )
  }
  const running = board.filter(
    (t) => t.state === 'running' || t.state === 'queued',
  ).length
  const eligible = input.candidates.filter(
    (n) => reading.eligible.has(n) || reading.held.has(n),
  ).length
  const batch = chooseBatch({
    candidates: input.candidates,
    reading,
    edits,
    holderEdits: (slug) => holders.get(slug) ?? [],
    quota: batchQuota(input.cap, running, eligible),
  })
  const paths = new Map(
    batch.picks.map((n) => [
      n,
      [...new Set((edits.get(n) ?? []).map((e) => e.path))],
    ]),
  )
  return { ...batch, paths }
}

/** The answer shape the round reads; queend's own, or one pick of a batch. */
export interface ChoiceLike {
  allowed: boolean
  chosen?: number | null
  chosenPaths?: string[] | null
  refusal?: string | null
  skipped?: string[] | null
}

/**
 * What the round asks for its dispatch step. Flag off: queend's first answer,
 * then queend again on the grown board, exactly as before. Flag on: the batch,
 * one pick per ask, and the tick records the batch's sentences.
 */
export async function roundChooser<C extends ChoiceLike>(
  first: C,
  ctx: {
    candidates: number[]
    bodies: Record<string, string>
    board: unknown[]
    repo: string
    ask: (board: unknown[]) => Promise<C>
    env?: Record<string, string | undefined>
    readBase?: ReadBase
    onBatch?: (batch: Batch) => void
  },
): Promise<{ decision: C; first: C; next: (board: unknown[]) => Promise<C> }> {
  const env = ctx.env ?? process.env
  // the bee actors dispatch on their own (TRIOS_QUEEN_DISPATCH=actors), and a
  // refusal without sentences (capacity, money) stands as queend gave it
  if (
    !dispatchBatchEnabled(env) ||
    dispatchByActors(env) ||
    (!first.allowed && !first.skipped?.length)
  )
    return { decision: first, first, next: ctx.ask }
  const batch = await planBatch({
    candidates: ctx.candidates,
    answer: first,
    bodies: ctx.bodies,
    board: ctx.board,
    repo: ctx.repo,
    cap: Number(env.TRIOS_QUEEN_MAX_WORKERS ?? '') || 4,
    derivedFree: derivedFreeEnabled(env),
    readBase: ctx.readBase ?? readBaseFile(),
  })
  ctx.onBatch?.(batch)
  const at = (i: number): C =>
    (i < batch.picks.length
      ? {
          ...first,
          allowed: true,
          chosen: batch.picks[i],
          chosenPaths: batch.paths.get(batch.picks[i] as number) ?? [],
          refusal: null,
        }
      : {
          ...first,
          allowed: false,
          chosen: null,
          chosenPaths: null,
          refusal:
            batch.picks.length === 0
              ? 'nothing to choose'
              : `the batch of ${batch.picks.length} is spent`,
        }) as C
  let taken = 0
  return {
    decision: { ...at(0), skipped: batch.skipped } as C,
    first: at(0),
    next: async () => at(++taken),
  }
}
