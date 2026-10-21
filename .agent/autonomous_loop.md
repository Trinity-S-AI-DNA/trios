# Autonomous Loop — Trios Integration

## Context
**Operation**: Military-style parallel deployment
**Agent**: D (Trios Integration rings 5-8: crypto, kg, agents, training)
**Brothers in arms**:
- Agent A: Parameter Golf + GF16 prototype (Issue #21)
- Agent B: Parameter Golf competition + RunPod grant (#19)
- Agent C: Trios Integration rings 1-4 (golden-float, hdc, sacred, physics)
- Agent D: Trios Integration rings 5-8 (crypto, kg, agents, training)

## Pre-flight
1. cd ~/trios
2. git checkout main && git pull
3. cargo check --workspace || fail
4. Check: .trinity/experience/rings.md exists, read current ring number

## Merge rule (owner, 2026-10-02)
> "the Queen must not merge by herself!! the Queen only manages!" --
> "take the merge right away from the board merger too."

No automation merges on its own verdict -- this loop included. Green CI is
this loop's own verdict, so it is not a reason to merge. The loop OPENS the
pull request and HANDS IT OFF to a reviewer bee (a code-review agent with
real tools). A merge happens only after that review: an APPROVED review plus
the `bee-reviewed` label added after the head ARRIVED -- the latest of its
commit date, its first check run and the branch's last force-push (a commit
dated before the review but pushed after it is unreviewed code). Same gate as
gHashTag/t27#5526. A push after the review voids it; the reviewer bee
re-reviews and re-labels. So the RINGS.md "IN REVIEW" commit below goes in
BEFORE the hand-off, not after.

This loop NEVER runs `gh pr merge` (no `--squash`, no `--auto`, no `--admin`).

## Main Loop (run until all 4 rings are IN REVIEW or SEALED)
FOR ring IN [5, 6, 7, 8]:
  IF ring already SEALED or IN REVIEW in RINGS.md: CONTINUE

  CHECKOUT feat/trios-ring-<N>
  EXECUTE 10 stages from spec:
    - scaffold → ffi → build → unit → integration
    - e2e → example → docs → mcp → seal

  FOR EACH stage:
    - Make changes
    - RUN: cargo build -p <crate>
    - IF FAIL: fix errors, retry up to 3 times
    - RUN: cargo test -p <crate>
    - IF FAIL: fix errors, retry up to 3 times
    - git add <specific_files>
    - git commit -m "<stage_type>(<crate>): <description>"

  FINALIZE (open the PR and hand off -- do NOT merge):
    - gh pr create --title "feat(trios): ring <N> — <crate> complete"
    - Update RINGS.md on the ring branch: ring <N> IN REVIEW (PR #<num>)
    - Wait for CI green; IF red: fix on the branch, push, wait again
    - Hand off to a reviewer bee: state in the PR body that it is ready
      for review and that the author will not merge it; push nothing more
    - Move on to the next ring; do not wait for the merge
    - The ring becomes SEALED only after a reviewer bee's APPROVED review
      plus `bee-reviewed` label let it merge; record that seal in a later
      commit (`chore(rings): seal ring <N>`), never before the merge

## Completion Criteria
- All 4 rings have an open PR handed off to a reviewer bee (IN REVIEW),
  or are SEALED after a reviewer bee's review let them merge
- cargo build --workspace exits 0
- cargo test --workspace --all-features exits 0
- cargo clippy --workspace -- -D warnings exits 0
- trios-server --list-tools shows ≥ 40 tools (14 existing + 26+ new)

## Reporting Protocol
After each ring completion:
- Write ring-<N>-report.md to plans/
- Include: lines added, tests passed, coverage %, time taken
- Commit report separately

## Failure Protocol
IF any stage fails 3 times:
- Write .agent/blocker-ring-<N>.md with full error trace
- Skip to next ring
- DO NOT silently skip tests
- DO NOT comment out failing code

## Ring Order (Agent D - rings 5-8)

| Ring | Crate | Dependencies | Stages | Status |
|------|-------|-------------|---------|--------|
| 5 | trios-crypto | None | 10 | PENDING |
| 6 | trios-kg | HTTP client | 10 | PENDING |
| 7 | trios-agents | HTTP + MCP proxy | 10 | PENDING |
| 8 | trios-training | HTTP client (Railway) | 10 | PENDING |

## Integration Points (Stage 9)
Each ring's Stage 9 adds MCP tools to trios-server:

### Ring 5: trios-crypto
- crypto_mine_sha256d → tool: `crypto_mine_sha256`
- crypto_mine_keccak256 → tool: `crypto_mine_keccak`

### Ring 6: trios-kg
- kg_insert → tool: `kg_insert`
- kg_query → tool: `kg_query`
- kg_traverse → tool: `kg_traverse`

### Ring 7: trios-agents
- agents_spawn → tool: `agents_spawn`
- agents_status → tool: `agents_status`
- agents_terminate → tool: `agents_terminate`

### Ring 8: trios-training
- training_submit_job → tool: `training_submit_job`
- training_status → tool: `training_status`
- training_cancel → tool: `training_cancel`
