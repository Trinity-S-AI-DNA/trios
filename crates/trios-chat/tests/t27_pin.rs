//! T27_PIN check: every vendored t27c gen-rust file still has the SHA-256
//! recorded in `crates/trios-chat/T27_PIN`.
//!
//! The table format is described in the header of T27_PIN. With an empty
//! table this test only checks the header. It is a Rust test because
//! ROADMAP operational invariant L1 forbids `.sh` files in this crate.

use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Component, Path};

const HEADER: [&str; 6] = ["file", "spec path", "t27 SHA", "t27c built_by", "sha256", "seal file"];
const UNSEALED: &str = "unsealed on master";

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{:02x}", b)).collect()
}

fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[test]
fn pinned_files_match_sha256() {
    // Known-answer check of the hash helper (FIPS 180-2 "abc").
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );

    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let table = std::fs::read_to_string(root.join("T27_PIN")).expect("read T27_PIN");
    let mut rows = table
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'));

    let header: Vec<&str> = rows.next().expect("T27_PIN header row").split('|').map(str::trim).collect();
    assert_eq!(header, HEADER, "T27_PIN header changed");

    let mut seen = BTreeSet::new();
    let mut checked = 0usize;
    for row in rows {
        let cols: Vec<&str> = row.split('|').map(str::trim).collect();
        assert_eq!(cols.len(), HEADER.len(), "T27_PIN row needs {} columns: {row}", HEADER.len());
        assert!(cols.iter().all(|c| !c.is_empty()), "T27_PIN row has an empty column: {row}");
        let (file, spec, t27_sha, built_by, sha, seal) = (cols[0], cols[1], cols[2], cols[3], cols[4], cols[5]);

        let rel = Path::new(file);
        assert!(
            rel.components().all(|c| matches!(c, Component::Normal(_))),
            "T27_PIN file must be a plain relative path inside crates/trios-chat: {file}"
        );
        assert!(seen.insert(file.to_string()), "T27_PIN lists {file} twice");
        assert!(spec.ends_with(".t27"), "T27_PIN spec path must end with .t27: {spec}");
        assert!(is_lower_hex(t27_sha, 40), "T27_PIN t27 SHA must be 40 lowercase hex: {t27_sha}");
        assert!(!built_by.is_empty(), "T27_PIN t27c built_by is empty for {file}");
        assert!(is_lower_hex(sha, 64), "T27_PIN sha256 must be 64 lowercase hex: {sha}");
        assert!(
            seal == UNSEALED || seal.ends_with(".json"),
            "T27_PIN seal file must be a .json name or \"{UNSEALED}\": {seal}"
        );

        let bytes = std::fs::read(root.join(rel)).unwrap_or_else(|e| panic!("read {file}: {e}"));
        assert_eq!(sha256_hex(&bytes), sha, "sha256 of {file} differs from T27_PIN");
        checked += 1;
    }
    println!("T27_PIN: {checked} vendored file(s) checked");
}
