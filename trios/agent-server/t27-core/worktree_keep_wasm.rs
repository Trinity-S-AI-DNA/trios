// worktree_keep_wasm - the wasm face of specs/queen/worktree_keep.t27.
//
// THIS FILE IS PLUMBING, NOT A RULE. Every decision is a call into the
// generated worktree_keep.gen.rs (t27c gen-rust of the card). Nothing here
// compares, branches on a threshold, or holds a word table: it forwards
// numbers across the C ABI. The only conversions are the ABI's own: a u32
// that does not fit a u8 is passed as 255, a value no card state or kind
// uses (so the card reads it as unknown), and a bool is "u32 is not zero".
//
// Build (see `bun run card:worktree-keep` in apps/server, or the recipe in
// docs/worktree-keep-card.md), from trios/agent-server:
//
//   t27c gen-rust specs/queen/worktree_keep.t27 > t27-core/worktree_keep.gen.rs
//   rustc --target wasm32-unknown-unknown --crate-type cdylib --edition 2021 \
//         -C panic=abort -O t27-core/worktree_keep_wasm.rs \
//         -o specs/queen/worktree_keep.wasm

#![allow(dead_code)]

#[path = "worktree_keep.gen.rs"]
#[allow(unused_variables, unused_parens, non_upper_case_globals)]
mod card;

fn byte(x: u32) -> u8 {
    u8::try_from(x).unwrap_or(255)
}

fn flag(x: u32) -> bool {
    x != 0
}

#[no_mangle]
pub extern "C" fn worktree_verdict(
    owner_known: u32,
    lease_active: u32,
    writer_alive: u32,
    dirty: u32,
    archive_verified: u32,
) -> u32 {
    card::worktree_verdict(
        byte(owner_known),
        byte(lease_active),
        byte(writer_alive),
        byte(dirty),
        byte(archive_verified),
    ) as u32
}

#[no_mangle]
pub extern "C" fn boot_releases(entries: u32) -> u32 {
    card::boot_releases(entries) as u32
}

#[no_mangle]
pub extern "C" fn retry_verdict(
    caller_aborted: u32,
    kind: u32,
    delivered_bytes: u32,
    attempt: u32,
    max_attempts: u32,
) -> u32 {
    card::retry_verdict(
        flag(caller_aborted),
        byte(kind),
        delivered_bytes,
        attempt,
        max_attempts,
    ) as u32
}

#[no_mangle]
pub extern "C" fn claims_again_at_once(started: u32) -> u32 {
    card::claims_again_at_once(flag(started)) as u32
}

#[no_mangle]
pub extern "C" fn reap_verdict(
    running: u32,
    dirty_with_ignored: u32,
    unpushed: u32,
    read_ok: u32,
) -> u32 {
    card::reap_verdict(
        byte(running),
        byte(dirty_with_ignored),
        byte(unpushed),
        byte(read_ok),
    ) as u32
}

#[no_mangle]
pub extern "C" fn shape_count(n: u32) -> u32 {
    card::shape_count(n)
}

#[no_mangle]
pub extern "C" fn code_reportable(length: u32, all_digits: u32) -> u32 {
    card::code_reportable(length, flag(all_digits)) as u32
}
