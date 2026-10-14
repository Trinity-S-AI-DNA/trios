# worktree_keep card (gHashTag/trios issue #2005)

Canonical source: gHashTag/t27 `specs/queen/worktree_keep.t27`, commit
1530131bfacbdad8eb1ea09a8449dc3823fbed37 on the owner's fork branch
codex/bee-safe-restart-20261014 (push completed; pull request head
c7f281a6be5970c525d2564a2f5200f610b9efbd (a commit-message amend adding
"Closes #9552"; file bytes unchanged; previous head 291e131); spec git blob
9cf42f0ea88cfb7669d272855752db39eda10fa8, which is a git object id and not the
file sha256 below),
proposed as https://github.com/gHashTag/t27/pull/9553 (upstream issue
gHashTag/t27#9552, open). It is not on t27 master until that pull request
merges. Status reported by the executor: typecheck of all packages exits 0; biome
over 1652 files: 0 errors, 120 warnings, 9 infos; `sh -n` passed; live
rollout pending. The copy in
`specs/queen/worktree_keep.t27` here is byte-identical (sha256
2684225bc4e87d79b5d5846324d6171620f681c44ed9ccf8cf3957abdbbeae89); compare it
with the line in `specs/PIN`. #2005 is an issue, not a pull request.

Seal: `t27c seal specs/queen/worktree_keep.t27 --save` ran natively on a Linux
runner (t27c 0.5.2, reference d06eaedc9fb59cda13c3529e1c6ed5bc510f3e08,
Zig 0.16.0) on the source carried byte-exact from the canonical commit, without
FORCE: 11 of 11 tests pass, 0 failed, 0 vacuous, and the four generated-output
hashes match the local generation. The tool's raw seal JSON is kept unedited in
the t27 checkout; its `built_by` "unknown" and `test_runner` "missing" are
unexplained (reason unverified; no runtime layout is claimed). Tests passing natively is not
cryptographic provenance of the compiler binary or its reference.

What it decides: when a bee worktree or the disk reaper may release a tree
(default: keep; unknown keeps), when a failed request is retried (never after
a caller abort or a delivered byte), whether a runner claims again at once,
and the closed sets and bounds of a request diagnostic.

Rebuild (from `trios/agent-server`, needs `t27c` and a rust toolchain with the
`wasm32-unknown-unknown` target; no network, no installs):

    T27C=/path/to/t27c bun run card:worktree-keep

Outputs, all generator or compiler output, never edited by hand:

- `t27-core/worktree_keep.gen.rs` (t27c gen-rust)
- `apps/server/src/api/services/queen-worktree-keep-card.gen.ts` (t27c gen-ts)
- `specs/queen/worktree_keep.wasm` (rustc of `t27-core/worktree_keep_wasm.rs`,
  a forward-only export shim that holds no rule)

Tests that execute the wasm: `apps/server/tests/api/worktree-keep-card.test.ts`
and every test that goes through `queen-worktree-keep.ts`.

Read-only volume tool: `tools/queen-runner/worktree-manifest.mjs` writes and
verifies a byte manifest of `.worktrees/*` and `.git/worktrees/*` to a private
file outside the checkout; its stdout is counters only.
