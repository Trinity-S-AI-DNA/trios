// Type declarations for queen-review-valve.gen.js, so that a workspace that
// does not allow JavaScript (the extension's typecheck reaches this module
// through queen-tick.ts) can read its constants. Hand-written typing glue:
// the VALUES live in the generated .js (t27c gen-js of review_valve.t27) and
// are never restated here, only their types. tests/api/review-valve-types.test.ts
// fails when the two files name different exports or different literals.

export const KIND_UNRECORDED: 0
export const KIND_NO_CRITERIA: 1
export const KIND_SEND_BACK_CEILING: 2
export const KIND_DEAD_LETTER: 3
export const KIND_REVIEWER_GAVE_UP: 4
export const KIND_EMPTY_ACCEPT: 5
export const KIND_BEYOND_THE_PATCH: 6
export const KIND_BASE_TRUTH_ALONE: 7
export const STEP_HOLD: 0
export const STEP_RELEASE: 1
export const STEP_BACKFILL: 2
export const STEP_CLOSE: 3
export const OBSOLETE_STATE: 'obsolete'
export const RETRY_FLOOR_MINUTES: 30
export const CEILING_FLOOR_MINUTES: 60
export const BACKFILL_WINDOW_MINUTES: 120
export const MAX_RELEASES: 1
export const POLICY_HOLD_MINUTES: 2880
export const REVIEWER_LOGIN: 't27-bees[bot]'
export const QUEEN_BRANCH_PREFIX: 'queen-'
export const PR_FIX_ATTEMPTS: 2
export const PR_FIX_WINDOW_HOURS: 48
export const PR_NONE: 0
export const PR_JUDGE: 1
export const PR_WAIT_FIX: 2
export const PR_CLOSE: 3
export const __STRUCT_ORDER__: readonly string[]
export const __DECL_ORDER__: readonly string[]
export const __NOT_EMITTED__: readonly unknown[]
