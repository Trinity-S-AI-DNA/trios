/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * THE CLAIM CARD (gHashTag/t27 specs/queen/claim.t27, t27#8765;
 * gHashTag/trios#1767), proven equal to the rule it replaced before the round
 * was handed to it.
 *
 * What is REAL here: the wasm the card generates (specs/queen/claim.wasm),
 * called through the same loader the round uses, and stateOfDispatch as the
 * round and the board call it. What is the REFERENCE: stateOfDispatch's
 * hand-written body as it stood on queen at 82bcc934, copied below verbatim
 * with its comments, and the constants it read, written as the values they
 * had there. The reference calls the review valve's HAND mirror
 * (queen-review-valve.ts), never the card, so the two sides share nothing but
 * the inputs.
 *
 * The grid is the round's whole input space at every boundary that matters:
 * each review_state word the column holds and words it does not, idle clocks
 * a minute and a millisecond either side of every floor (and unreadable,
 * negative and huge ones), and every counter either side of its ceiling.
 * A grid that agrees could still be blind, so each mutant of the reference
 * below (a floor moved by a minute, a ceiling or a default moved by one, a
 * word the boundary forgets) must disagree with the card somewhere in it.
 */

import { describe, expect, it, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadCardWasm } from '../../src/api/services/queen-card-wasm'
import {
  CLAIM_CARD,
  claimOf,
  claimWord,
  idleMinutes,
  verdictCode,
} from '../../src/api/services/queen-claim'
import * as card from '../../src/api/services/queen-claim-card.gen'
import * as valve from '../../src/api/services/queen-review-valve'
import {
  dispatchRowState,
  stateOfDispatch,
} from '../../src/api/services/queen-tick'
import { DEFAULT_SPECS_ROOT } from '../../src/inngest/spec-catalog'
import { logger } from '../../src/lib/logger'

// --- The reference: the hand-written rule, as it stood -----------------------
//
// `let`, not `const`: a mutant below moves one of them and puts it back.

let EMPTY_ATTEMPT_FLOOR_MS = valve.RETRY_FLOOR_MINUTES * 60 * 1000
let SEND_BACK_IDLE_FLOOR_MS = 60 * 60 * 1000
let WAIT_FROZEN_FLOOR_MS = 6 * 60 * 60 * 1000
let FREE_ATTEMPT_CEILING = 3
let REVIEWER_MISS_CEILING = 3
const OBSOLETE_STATE = valve.OBSOLETE_STATE
const KIND_SEND_BACK_CEILING = valve.KIND_SEND_BACK_CEILING
let nextStep = valve.nextStep
const escalationKind = valve.escalationKind
const stateOfStep = valve.stateOfStep

function handWrittenStateOfDispatch(
  finished: boolean,
  reviewState: unknown,
  lease: {
    idleMs?: number
    sendBacks?: number
    ceiling?: number
    /** How many times this issue's ceiling has already been handed back. */
    releases?: number
    /** The escalation's kind is read from these (specs/queen/review_valve.t27). */
    criteria?: number
    freeAttempts?: number
    reviewerMisses?: number
  } = {},
):
  | 'running'
  | 'accepted'
  | 'rejected'
  | 'awaitingReview'
  | 'failed'
  | 'cancelled' {
  if (!finished) return 'running'
  const verdict = String(reviewState ?? '')
  if (verdict === 'accept') return 'accepted'
  const idleMs = lease.idleMs ?? 0
  const sendBacks = lease.sendBacks ?? 0
  const releases = lease.releases ?? 0
  // Read from QueenRetryPolicy.maximumRealAttempts rather than restated, so
  // there is one ceiling and not two that agree until someone edits one.
  const ceiling = lease.ceiling ?? 2

  // A verdict that SAYS failed is a failure. This case was missing, so
  // `review_state = 'failed'` fell through to `awaitingReview` at the bottom -
  // a LIVE claim in `QueenDelegationPolicy.claimOnIssue` - and the issue stayed
  // held by the very row that recorded its release.
  //
  // Measured 2026-09-04: five dispatches were deliberately set to `failed` to
  // return their issues to the pool (#1133, #1175, #1216, #1240, #1311). All
  // five stayed in `claimed`, the tick kept refusing with "nothing to choose"
  // against 22 candidates, and the swarm sat at zero bees of four. The write
  // was correct; the reader had no case for it.
  //
  // The function already RETURNS 'failed' two lines below for a send-back that
  // outlived its floor. It could produce the state and not recognise it.
  if (verdict === 'failed' || verdict === 'cancelled') return 'failed'
  // An EMPTY attempt committed nothing and said nothing, so there is no work
  // to hold files for and no bee expected back to them. Measured 2026-09-17,
  // most of the live waits on the board were exactly this - turns killed by a
  // deploy or ended in seconds by a 1302 - each holding its boundary for six
  // hours before the wait valve let go, while 30 of 32 worker lanes sat idle.
  //
  // Released after a SHORT floor, not at once. With no floor the same issue
  // was chosen again in the same round, and a bee's close asks for the next
  // round immediately: during a z.ai quota window (1308/1316, hours long)
  // three empty attempts - and an escalation no timer releases - took
  // minutes, and every lane moved one issue a cycle out of the backlog into
  // needs-you. Half an hour lets a rate limit pass and a quota window be
  // retried a handful of times, not a hundred.
  if (verdict === 'empty') {
    return idleMs >= EMPTY_ATTEMPT_FLOOR_MS ? 'failed' : 'rejected'
  }

  // THE CONTRACT IT WAS JUDGED AGAINST IS GONE. An issue's criteria are frozen
  // onto the dispatch row so a bee is judged by what it was told, and that is
  // right - but when the ISSUE's criteria are rewritten, the verdict on the old
  // row answers a question nobody is asking any more. Measured 2026-09-19: 126
  // open issues quoted a compiler a bee does not have and criteria the container
  // could never satisfy; after they were rewritten, 72 of the 86 rows still
  // holding their issues had been judged against the old text. Released at
  // once, with no floor: there is nothing to wait for.
  if (verdict === 'stale-contract') return 'failed'

  // CLOSED BY THE REVIEW VALVE: the reason is in judged_note, the files are
  // free, and the round does not take the issue again while the row stands.
  if (verdict === OBSOLETE_STATE) return 'cancelled'
  const idleMinutes = Math.floor(idleMs / 60_000)

  if (verdict === 'sendBack') {
    if (idleMs >= SEND_BACK_IDLE_FLOOR_MS && sendBacks < ceiling)
      return 'failed'
    // AT THE CEILING, THE ISSUE STOPS BEING THE SWARM'S - BUT ITS FILES MUST
    // NOT STAY HELD.
    //
    // `rejected` had no clock at all, so an issue that spent its two attempts
    // pinned its boundary until the dispatch row fell out of the 7-day window.
    // Measured 2026-09-20, the morning after the adversarial review began
    // refusing work the compiler cannot build: 71 of the swarm's issues were
    // claimed, 0 of 8 lanes ran, and the tick refused 673 candidates with
    // "nothing to choose". Every one of those refusals was honest - the Zig the
    // bees generated did not compile - and the swarm still had to stop.
    //
    // A ceiling is a statement about ATTEMPTS, and the old rule read it as a
    // lease with no clock: "a person decides, not a timer". That is right the
    // second time it happens and wrong the first, because the person is asleep
    // and the swarm is not. So the ceiling is spent ONCE more - after the same
    // hour a single send-back waits out - and the count of those releases is
    // itself bounded: past `MAX_CEILING_RELEASES` the row stays `rejected` and
    // the issue really is a person's.
    // The review valve (specs/queen/review_valve.t27) decides from here: once
    // after the ceiling floor, then closed rather than held for a person.
    return stateOfStep(
      nextStep(KIND_SEND_BACK_CEILING, idleMinutes, releases),
      'rejected',
    )
  }
  // AN ESCALATION HAS A NEXT STEP AND A CLOCK. It used to fall through to
  // `awaitingReview` - "a timer is not a person" - and measured 2026-10-05 that
  // was 144 of 219 review cards, each holding its files (fileConflict 108,
  // 25 of 70 workers active). The owner's rule is that no person is needed, so
  // specs/queen/review_valve.t27 decides: release, criteria backfill, or close.
  if (verdict === 'escalate') {
    const kind = escalationKind(
      lease.criteria ?? 1,
      sendBacks >= ceiling,
      (lease.freeAttempts ?? 0) >= FREE_ATTEMPT_CEILING,
      (lease.reviewerMisses ?? 0) >= REVIEWER_MISS_CEILING,
    )
    return stateOfStep(nextStep(kind, idleMinutes, releases), 'awaitingReview')
  }
  // A wait that has outlasted the frozen floor was never judged and never will
  // be, because nothing about its input can change. (`escalate` is handled
  // above, by the review valve.)
  if (verdict === '' || verdict === 'wait') {
    if (idleMs >= WAIT_FROZEN_FLOOR_MS && sendBacks < ceiling) return 'failed'
  }
  return 'awaitingReview'
}

// --- The grid ----------------------------------------------------------------

type Lease = NonNullable<Parameters<typeof stateOfDispatch>[2]>
type Rule = (finished: boolean, reviewState: unknown, lease: Lease) => string

const MINUTE = 60_000
const WORDS: unknown[] = [
  undefined,
  null,
  '',
  'accept',
  'sendBack',
  'escalate',
  'wait',
  'failed',
  'cancelled',
  'empty',
  'stale-contract',
  OBSOLETE_STATE,
  'Accept',
  'escalated',
  '__proto__',
  0,
]
const FLOORS_MIN = [30, 60, 120, 360, 2880]
const IDLE_MS: Array<number | undefined> = [
  undefined,
  Number.NaN,
  -MINUTE,
  0,
  MINUTE,
  ...FLOORS_MIN.flatMap((f) => [
    (f - 1) * MINUTE,
    f * MINUTE - 1,
    f * MINUTE,
    (f + 1) * MINUTE,
  ]),
  1e12,
  Number.POSITIVE_INFINITY,
]
const COUNTS: Array<number | undefined> = [undefined, 0, 1, 2, 3]
const CEILINGS: Array<number | undefined> = [undefined, 1, 2, 3]
const RELEASES: Array<number | undefined> = [undefined, 0, 1, 2]
const CRITERIA: Array<number | undefined | null> = [undefined, null, 0, 2]
const MISSES: Array<number | undefined> = [undefined, 0, 2, 3]

/** The grid's axes, outermost first. */
const AXES: ReadonlyArray<readonly unknown[]> = [
  WORDS,
  IDLE_MS,
  COUNTS,
  CEILINGS,
  RELEASES,
  CRITERIA,
  MISSES,
  MISSES,
]
const GRID_SIZE = AXES.reduce((n, axis) => n * axis.length, 1)

/** Every finished row of the grid, in a fixed order: a mixed-radix count. */
function* finishedGrid(): Generator<[unknown, Lease]> {
  const at = AXES.map(() => 0)
  for (let n = 0; n < GRID_SIZE; n++) {
    const [
      word,
      idleMs,
      sendBacks,
      ceiling,
      releases,
      criteria,
      freeAttempts,
      reviewerMisses,
    ] = at.map((i, axis) => AXES[axis][i])
    yield [
      word,
      {
        idleMs,
        sendBacks,
        ceiling,
        releases,
        criteria,
        freeAttempts,
        reviewerMisses,
      } as Lease,
    ]
    for (let axis = AXES.length - 1; axis >= 0; axis--) {
      if (++at[axis] < AXES[axis].length) break
      at[axis] = 0
    }
  }
}

const CLAIM_CODE: Record<string, number> = {
  running: card.CL_RUNNING,
  accepted: card.CL_ACCEPTED,
  rejected: card.CL_REJECTED,
  awaitingReview: card.CL_AWAITING_REVIEW,
  failed: card.CL_FAILED,
  cancelled: card.CL_CANCELLED,
}

/** The card's answer for every finished row, computed once. */
const cardAnswers = (() => {
  const out = new Uint8Array(GRID_SIZE)
  let i = 0
  for (const [word, lease] of finishedGrid())
    out[i++] =
      CLAIM_CODE[
        stateOfDispatch(true, word, { ...lease, releaseDeadClaims: false })
      ]
  return out
})()

/** The first rows where `rule` disagrees with the card, up to `limit`. */
function disagreements(rule: Rule, limit = 3): string[] {
  const out: string[] = []
  let i = 0
  for (const [word, lease] of finishedGrid()) {
    const want = cardAnswers[i++]
    const got = rule(true, word, lease)
    if (CLAIM_CODE[got] !== want) {
      out.push(
        `${JSON.stringify(word)} ${JSON.stringify(lease)}: rule ${got}, card ${claimWord(want)}`,
      )
      if (out.length >= limit) break
    }
  }
  return out
}

describe('the vendored claim card is the one PIN names', () => {
  const sha = (file: string) =>
    createHash('sha256')
      .update(readFileSync(join(DEFAULT_SPECS_ROOT, file)))
      .digest('hex')
  const pin = readFileSync(join(DEFAULT_SPECS_ROOT, 'PIN'), 'utf8')

  it('claim.t27, the review_valve.t27 it imports and claim.wasm match', () => {
    expect(pin).toContain(`queen/claim.t27 sha256 ${sha('queen/claim.t27')}`)
    expect(pin).toContain(
      `queen/review_valve.t27 sha256 ${sha('queen/review_valve.t27')}`,
    )
    expect(pin).toContain(`queen/claim.wasm sha256 ${sha('queen/claim.wasm')}`)
  })

  it('imports nothing and exports the card and what it imports', () => {
    const module = new WebAssembly.Module(
      readFileSync(join(DEFAULT_SPECS_ROOT, CLAIM_CARD)),
    )
    expect(WebAssembly.Module.imports(module)).toEqual([])
    const names = WebAssembly.Module.exports(module).map((e) => e.name)
    for (const fn of [
      'claim_of',
      'claim_of_step',
      'criteria_read_as',
      'escalation_kind_of',
      'escalation_kind',
      'next_step',
      'wants_backfill',
    ])
      expect(names).toContain(fn)
  })
})

// Every assert in claim.t27's test blocks, read out of the vendored spec and
// run against the wasm. A wasm built from another card, or a spec edited
// without a rebuild, fails here. The grammar is the one those asserts use:
// calls, constants, integers, true/false, + and -.
describe('the generated card answers its own spec', () => {
  const spec = readFileSync(join(DEFAULT_SPECS_ROOT, 'queen/claim.t27'), 'utf8')
  const wasm = loadCardWasm(CLAIM_CARD)
  const consts = card as unknown as Record<string, number>

  function evaluate(src: string): number {
    const tokens = src.match(/[A-Za-z_]\w*|\d+|==|[(),+-]/g) ?? []
    let at = 0
    const take = () => tokens[at++]
    const term = (): number => {
      const t = take()
      if (t === undefined) throw new Error(`ran out in ${src}`)
      if (/^\d+$/.test(t)) return Number(t)
      if (t === 'true') return 1
      if (t === 'false') return 0
      if (tokens[at] === '(') {
        take()
        const args: number[] = []
        while (tokens[at] !== ')') {
          args.push(expr())
          if (tokens[at] === ',') take()
        }
        take()
        return wasm.call(t, ...args)
      }
      if (!(t in consts)) throw new Error(`unknown name ${t} in ${src}`)
      return consts[t]
    }
    const expr = (): number => {
      let v = term()
      while (tokens[at] === '+' || tokens[at] === '-')
        v = take() === '+' ? v + term() : v - term()
      return v
    }
    const left = expr()
    if (take() !== '==') throw new Error(`not an equality: ${src}`)
    const right = expr()
    if (at !== tokens.length) throw new Error(`trailing tokens in ${src}`)
    return left === right ? 1 : 0
  }

  const blocks = [...spec.matchAll(/^test (\w+) \{\n([\s\S]*?)^\}/gm)]
  it('has test blocks to read', () => {
    expect(blocks.length).toBe(11)
  })
  for (const [, name, body] of blocks) {
    it(name, () => {
      const asserts = body
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, '').trim())
        .filter((line) => line.startsWith('assert '))
        .map((line) => line.slice('assert '.length).replace(/;$/, ''))
      expect(asserts.length).toBeGreaterThan(0)
      for (const a of asserts) expect([a, evaluate(a)]).toEqual([a, 1])
    })
  }
})

describe('the card answers what the hand-written rule answered', () => {
  it('on every finished row of the grid', () => {
    expect(GRID_SIZE).toBe(2_211_840)
    expect(cardAnswers.length).toBe(GRID_SIZE)
    expect(disagreements(handWrittenStateOfDispatch)).toEqual([])
  })

  it('reaches every claim, so the grid is not one-sided', () => {
    const seen = new Set(cardAnswers)
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5])
  })

  it('a bee that has not ended claims, whatever its row says', () => {
    for (const word of WORDS)
      for (const idleMs of IDLE_MS)
        for (const releases of RELEASES) {
          const lease = { idleMs, releases, sendBacks: 3, criteria: 0 }
          expect(stateOfDispatch(false, word, lease)).toBe('running')
          expect(handWrittenStateOfDispatch(false, word, lease)).toBe('running')
        }
  })

  it('reads a dispatch row the same way for the board', () => {
    const now = Date.parse('2026-10-10T20:00:00Z')
    for (const row of [
      { finished_at: null, review_state: 'accept' },
      { finished_at: '2026-10-10T19:30:00Z', review_state: 'empty' },
      { finished_at: '2026-10-10T19:29:59Z', review_state: 'empty' },
      {
        finished_at: '2026-10-10T18:00:00Z',
        review_state: 'sendBack',
        send_backs: 2,
        ceiling_releases: 1,
      },
      {
        finished_at: '2026-10-10T17:59:00Z',
        review_state: 'escalate',
        criteria: [],
      },
      { finished_at: 'not a date', review_state: 'wait' },
    ]) {
      const ms = Date.parse(String(row.finished_at))
      const want = handWrittenStateOfDispatch(
        row.finished_at != null,
        row.review_state,
        {
          idleMs: Number.isFinite(ms) ? Math.max(0, now - ms) : 0,
          sendBacks: Number(row.send_backs ?? 0) || 0,
          releases: Number(row.ceiling_releases ?? 0) || 0,
          criteria: Array.isArray(row.criteria)
            ? row.criteria.length
            : undefined,
          freeAttempts: 0,
          reviewerMisses: 0,
        },
      )
      expect(dispatchRowState(row, now)).toBe(want)
    }
  })
})

// The one check in front of the card: TRIOS_QUEEN_RELEASE_DEAD_CLAIMS
// (holds.t27 send_back_claim, #1893). It frees a send-back under the ceiling
// at once and asks nothing else. With the flag on, every row of the grid must
// still answer what the hand-written rule answered, except exactly the finished
// send-backs under their ceiling, which are `failed` whatever their clock.
describe('the dead-claims check in front of the card', () => {
  const ceilingOf = (l: Lease) => l.ceiling ?? 2
  const under = (word: unknown, l: Lease) =>
    String(word ?? '') === 'sendBack' && (l.sendBacks ?? 0) < ceilingOf(l)

  it('with the flag on, changes exactly the send-backs under the ceiling', () => {
    const diverged: string[] = []
    let freed = 0
    let i = 0
    for (const [word, lease] of finishedGrid()) {
      const want = under(word, lease)
        ? 'failed'
        : handWrittenStateOfDispatch(true, word, lease)
      if (under(word, lease)) freed++
      const got = stateOfDispatch(true, word, {
        ...lease,
        releaseDeadClaims: true,
      })
      if (got !== want && diverged.length < 3)
        diverged.push(
          `${JSON.stringify(word)} ${JSON.stringify(lease)}: ${got} not ${want}`,
        )
      i++
    }
    expect(i).toBe(GRID_SIZE)
    expect(freed).toBeGreaterThan(0)
    expect(diverged).toEqual([])
  })

  it('with the flag off, frees nothing the card did not free', () => {
    expect(
      stateOfDispatch(true, 'sendBack', {
        idleMs: 0,
        sendBacks: 0,
        releaseDeadClaims: false,
      }),
    ).toBe('rejected')
    expect(
      stateOfDispatch(true, 'sendBack', {
        idleMs: 60 * MINUTE,
        sendBacks: 0,
        releaseDeadClaims: false,
      }),
    ).toBe('failed')
  })

  it('frees a send-back at once, and only under the ceiling', () => {
    const on = (sendBacks: number, ceiling?: number, idleMs = 0) =>
      stateOfDispatch(true, 'sendBack', {
        idleMs,
        sendBacks,
        ceiling,
        releaseDeadClaims: true,
      })
    expect(on(0)).toBe('failed')
    expect(on(1)).toBe('failed')
    expect(on(2)).toBe('rejected')
    expect(on(3)).toBe('rejected')
    expect(on(2, 3)).toBe('failed')
    expect(on(0, 0)).toBe('rejected')
  })

  it("asks only a finished send-back: a running bee still claims, other words are the card's", () => {
    for (const word of WORDS) {
      expect(
        stateOfDispatch(false, word, { sendBacks: 0, releaseDeadClaims: true }),
      ).toBe('running')
      if (String(word ?? '') === 'sendBack') continue
      expect(
        stateOfDispatch(true, word, {
          idleMs: 0,
          sendBacks: 0,
          releaseDeadClaims: true,
        }),
      ).toBe(
        stateOfDispatch(true, word, {
          idleMs: 0,
          sendBacks: 0,
          releaseDeadClaims: false,
        }),
      )
    }
  })

  it('reads the environment when the caller names no flag', () => {
    const was = process.env.TRIOS_QUEEN_RELEASE_DEAD_CLAIMS
    try {
      process.env.TRIOS_QUEEN_RELEASE_DEAD_CLAIMS = 'on'
      expect(stateOfDispatch(true, 'sendBack', { sendBacks: 0 })).toBe('failed')
      process.env.TRIOS_QUEEN_RELEASE_DEAD_CLAIMS = 'off'
      expect(stateOfDispatch(true, 'sendBack', { sendBacks: 0 })).toBe(
        'rejected',
      )
    } finally {
      if (was === undefined) delete process.env.TRIOS_QUEEN_RELEASE_DEAD_CLAIMS
      else process.env.TRIOS_QUEEN_RELEASE_DEAD_CLAIMS = was
    }
  })
})

// A grid that agrees could be blind. Each mutant is the reference with one
// thing moved, and the grid must find a row where it no longer agrees.
describe('the grid notices a reference that drifts', () => {
  const withInputs =
    (wrap: (word: unknown, lease: Lease) => [unknown, Lease]): Rule =>
    (finished, word, lease) =>
      handWrittenStateOfDispatch(finished, ...wrap(word, lease))

  const moved = (set: () => void, reset: () => void): Rule => {
    return (finished, word, lease) => {
      set()
      try {
        return handWrittenStateOfDispatch(finished, word, lease)
      } finally {
        reset()
      }
    }
  }

  const floors: Array<[string, (d: number) => void]> = [
    ['empty floor', (d) => (EMPTY_ATTEMPT_FLOOR_MS += d)],
    ['send-back floor', (d) => (SEND_BACK_IDLE_FLOOR_MS += d)],
    ['frozen-wait floor', (d) => (WAIT_FROZEN_FLOOR_MS += d)],
  ]
  for (const [name, shift] of floors)
    for (const d of [-MINUTE, MINUTE])
      it(`${name} moved by ${d / MINUTE} minute`, () => {
        expect(
          disagreements(
            moved(
              () => shift(d),
              () => shift(-d),
            ),
            1,
          ).length,
        ).toBe(1)
      })

  for (const d of [-1, 1])
    it(`the default send-back ceiling moved by ${d}`, () => {
      expect(
        disagreements(
          withInputs((w, l) => [w, { ...l, ceiling: l.ceiling ?? 2 + d }]),
          1,
        ).length,
      ).toBe(1)
    })

  it('unread criteria read as none', () => {
    expect(
      disagreements(
        withInputs((w, l) => [w, { ...l, criteria: l.criteria ?? 0 }]),
        1,
      ).length,
    ).toBe(1)
  })

  it("the valve's ceiling hour moved by a minute", () => {
    expect(
      disagreements(
        moved(
          () => {
            nextStep = (kind, idle, releases) =>
              valve.nextStep(
                kind,
                kind === KIND_SEND_BACK_CEILING ? idle - 1 : idle,
                releases,
              )
          },
          () => {
            nextStep = valve.nextStep
          },
        ),
        1,
      ).length,
    ).toBe(1)
  })

  for (const word of WORDS.filter(
    (w) => verdictCode(w) !== card.V_OTHER && w !== null && w !== undefined,
  ))
    it(`the boundary forgets the word ${JSON.stringify(word)}`, () => {
      expect(
        disagreements(
          withInputs((w, l) => [w === word ? 'unheard-of' : w, l]),
          1,
        ).length,
      ).toBe(1)
    })
})

// The dead-letter and reviewer-miss ceilings choose the escalation's KIND,
// and today the valve gives those kinds the step of an unrecorded one, so the
// claim cannot show them (tri mutate found exactly that). They are pinned
// where they act: the card's escalation_kind_of against the valve's hand
// mirror with the ceilings the reference read.
describe('the escalation kind', () => {
  const wasm = loadCardWasm(CLAIM_CARD)
  const handKind = (
    sendBacks: number,
    ceiling: number,
    criteria: number | undefined,
    free: number,
    misses: number,
  ) =>
    escalationKind(
      criteria ?? 1,
      sendBacks >= ceiling,
      free >= FREE_ATTEMPT_CEILING,
      misses >= REVIEWER_MISS_CEILING,
    )
  const cardKind = (
    sendBacks: number,
    ceiling: number,
    criteria: number | undefined,
    free: number,
    misses: number,
  ) =>
    wasm.call(
      'escalation_kind_of',
      sendBacks,
      ceiling,
      criteria === undefined ? 0 : 1,
      criteria ?? 0,
      free,
      misses,
    )
  const rows: Array<[number, number, number | undefined, number, number]> = []
  for (const sendBacks of [0, 1, 2, 3])
    for (const ceiling of [1, 2, 3])
      for (const criteria of [undefined, 0, 1, 2])
        for (const free of [0, 1, 2, 3, 4])
          for (const misses of [0, 1, 2, 3, 4])
            rows.push([sendBacks, ceiling, criteria, free, misses])
  const drift = () =>
    rows.filter((r) => handKind(...r) !== cardKind(...r)).length

  it('is the same from the counters on every row', () => {
    expect(rows.length).toBe(1200)
    expect(drift()).toBe(0)
  })

  for (const [name, set] of [
    ['free-attempt', (d: number) => (FREE_ATTEMPT_CEILING += d)],
    ['reviewer-miss', (d: number) => (REVIEWER_MISS_CEILING += d)],
  ] as const)
    for (const d of [-1, 1])
      it(`notices the ${name} ceiling moved by ${d}`, () => {
        set(d)
        try {
          expect(drift()).toBeGreaterThan(0)
        } finally {
          set(-d)
        }
      })
})

// The valve's functions are still mirrored by hand in queen-review-valve.ts
// for its other callers. The card carries the spec's own copies, compiled in,
// so the mirror can now be checked against them on its whole input space.
describe("the review valve's hand mirror is the spec's", () => {
  const wasm = loadCardWasm(CLAIM_CARD)
  it('escalation_kind', () => {
    for (let criteria = 0; criteria <= 4; criteria++)
      for (let bits = 0; bits < 8; bits++) {
        const [a, b, c] = [bits & 1, bits & 2, bits & 4].map(Boolean)
        expect(valve.escalationKind(criteria, a, b, c)).toBe(
          wasm.call('escalation_kind', criteria, +a, +b, +c),
        )
      }
  })
  it('next_step and wants_backfill', () => {
    const idles = [
      ...Array.from({ length: 182 }, (_, i) => i),
      2879,
      2880,
      2881,
      1_000_000,
    ]
    for (let kind = 0; kind <= 9; kind++) {
      expect(+valve.wantsBackfill(kind)).toBe(wasm.call('wants_backfill', kind))
      for (const idle of idles)
        for (let releases = 0; releases <= 3; releases++)
          expect(valve.nextStep(kind, idle, releases)).toBe(
            wasm.call('next_step', kind, idle, releases),
          )
    }
  })
})

describe('the boundary', () => {
  it('reads each word the card has a rule for, and nothing else', () => {
    expect(verdictCode(undefined)).toBe(card.V_NONE)
    expect(verdictCode(null)).toBe(card.V_NONE)
    expect(verdictCode('')).toBe(card.V_NONE)
    expect(verdictCode('accept')).toBe(card.V_ACCEPT)
    expect(verdictCode('sendBack')).toBe(card.V_SEND_BACK)
    expect(verdictCode('escalate')).toBe(card.V_ESCALATE)
    expect(verdictCode('wait')).toBe(card.V_WAIT)
    expect(verdictCode('failed')).toBe(card.V_FAILED)
    expect(verdictCode('cancelled')).toBe(card.V_CANCELLED)
    expect(verdictCode('empty')).toBe(card.V_EMPTY)
    expect(verdictCode('stale-contract')).toBe(card.V_STALE_CONTRACT)
    expect(verdictCode(OBSOLETE_STATE)).toBe(card.V_OBSOLETE)
    for (const other of ['Accept', 'SENDBACK', '__proto__', 'constructor', 0])
      expect(verdictCode(other)).toBe(card.V_OTHER)
  })

  it('names every claim the card can answer', () => {
    const words = new Set<string>()
    for (let code = 0; code < card.CLAIM_STATES; code++)
      words.add(claimWord(code))
    expect(words.size).toBe(card.CLAIM_STATES)
  })

  it('holds a code that is no claim, and says so once per code', () => {
    const error = spyOn(logger, 'error').mockImplementation(() => {})
    try {
      expect(claimWord(card.CLAIM_STATES)).toBe('awaitingReview')
      expect(claimWord(card.CLAIM_STATES)).toBe('awaitingReview')
      expect(claimWord(255)).toBe('awaitingReview')
      expect(error).toHaveBeenCalledTimes(2)
      expect(error.mock.calls[0][1]).toEqual({
        card: CLAIM_CARD,
        code: card.CLAIM_STATES,
        held: 'awaitingReview',
      })
    } finally {
      error.mockRestore()
    }
  })

  it('reads the clock in whole minutes, an unreadable one as 0', () => {
    expect(idleMinutes(undefined)).toBe(0)
    expect(idleMinutes(Number.NaN)).toBe(0)
    expect(idleMinutes(-MINUTE)).toBe(0)
    expect(idleMinutes(MINUTE - 1)).toBe(0)
    expect(idleMinutes(MINUTE)).toBe(1)
    expect(idleMinutes(Number.POSITIVE_INFINITY)).toBe(0xffff_ffff)
  })

  it('is what stateOfDispatch calls', () => {
    expect(stateOfDispatch(true, 'sendBack', { idleMs: 60 * MINUTE })).toBe(
      claimOf(true, 'sendBack', { idleMs: 60 * MINUTE }),
    )
  })
})
