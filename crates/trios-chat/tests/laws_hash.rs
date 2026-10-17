//! Pins the exact value of `trios_chat::r_chat::laws_hash()`.
//!
//! `r_chat_guard.rs` checks the law count, the titles and that the hash is
//! stable within one run. This test fixes the hash itself, so a later swap of
//! CR-CHAT-LAWS to generated code is checked against the same value without
//! adding a new test to the frozen test-name list (golden/test-names/).

use trios_chat::r_chat::laws_hash;

/// SHA-256 over the 12 R-CHAT laws, each followed by one zero byte
/// (recomputed 2026-10-10 at trios 8b229e9).
const EXPECTED_LAWS_HASH: &str = "d8c962d0cfe111bf72f9d59f2296baf015ff5c9f0390cf807b7cc08c706f3a98";

#[test]
fn laws_hash_matches_pinned_value() {
    let hex: String = laws_hash().iter().map(|b| format!("{:02x}", b)).collect();
    assert_eq!(hex, EXPECTED_LAWS_HASH, "R-CHAT laws hash changed; update only via ADR-CHAT-*");
}
