//! Deterministic behaviour vectors for trios-chat.
//!
//! `cargo run -p trios-chat --bin golden_vectors` prints one vector per line.
//! The output is frozen in `crates/trios-chat/golden/vectors.txt`; every swap
//! of hand-written logic for generated code must reproduce it byte for byte.
//!
//! No randomness: every key, nonce and payload below is a fixed constant.
//! Ed25519 signing (RFC 8032) and X25519 are deterministic for fixed inputs.
//! Large buffers are summarised by FNV-1a 64 (a regression fingerprint, not a
//! security property) together with their readable fields.

#![forbid(unsafe_code)]

use ed25519_dalek::{Signer, SigningKey};
use x25519_dalek::{PublicKey, StaticSecret};

use trios_chat::{
    capability::{CapabilityToken, Scope, ToolManifest},
    identity::{PrekeyBundle, PrekeyBundleBody, MLKEM_PUB_LEN},
    injection::{validate_output, InjectionError},
    padding::{pad_class, unpad, CLASSES, MAX_PAYLOAD},
    r_chat::{laws_hash, R_CHAT_LAWS},
    ratchet::{Chain, MessageKey, RootKey, SKIPPED_KEYS_CAP},
    sealed::{dest_hash, SealedEnvelope},
    ANCHOR, PROTOCOL_VERSION,
};

/// The prompt-injection corpus, embedded at build time (no runtime I/O).
const CORPUS: &str = include_str!("../../corpus/prompt_injection.jsonl");

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Payload byte `i` is never zero, so truncation and zero fill are visible.
fn pattern(len: usize) -> Vec<u8> {
    (0..len).map(|i| ((i % 251) + 1) as u8).collect()
}

fn mk(m: &MessageKey) -> String {
    format!("key={} nonce={} counter={}", hex(&m.key), hex(&m.nonce), m.counter)
}

fn section(name: &str) {
    println!("## {name}");
}

fn laws() {
    section("laws");
    println!("laws.count = {}", R_CHAT_LAWS.len());
    println!("laws.hash = {}", hex(&laws_hash()));
    println!("protocol_version = {}", PROTOCOL_VERSION);
    println!("anchor = {:?}", ANCHOR);
}

fn padding() {
    section("padding");
    println!("padding.classes = {:?}", CLASSES);
    println!("padding.max_payload = {}", MAX_PAYLOAD);
    for len in [0usize, 1, 252, 253, 1020, 4093, 16380, 16381] {
        let payload = pattern(len);
        let buf = pad_class(&payload);
        let copied = std::cmp::min(len, buf.len().saturating_sub(4));
        let tail_nonzero = buf[4 + copied..].iter().filter(|b| **b != 0).count();
        let unpadded = match unpad(&buf) {
            Ok(s) => format!("Ok(len={} equal={})", s.len(), s == payload.as_slice()),
            Err(e) => format!("Err({:?})", e),
        };
        println!(
            "pad len={} class={} prefix={} copied={} tail_nonzero={} fnv1a64={:016x} unpad={}",
            len,
            buf.len(),
            hex(&buf[..4]),
            copied,
            tail_nonzero,
            fnv1a64(&buf),
            unpadded
        );
    }
    // unpad on buffers that are not produced by pad_class.
    let cases: [(&str, Vec<u8>); 4] = [
        ("len3", vec![0u8; 3]),
        ("len255", vec![0u8; 255]),
        ("class256_len253", {
            let mut b = vec![0u8; 256];
            b[..4].copy_from_slice(&253u32.to_be_bytes());
            b
        }),
        ("class256_len252", {
            let mut b = vec![0u8; 256];
            b[..4].copy_from_slice(&252u32.to_be_bytes());
            b
        }),
    ];
    for (name, buf) in cases {
        let r = match unpad(&buf) {
            Ok(s) => format!("Ok(len={})", s.len()),
            Err(e) => format!("Err({:?})", e),
        };
        println!("unpad {} = {}", name, r);
    }
}

fn dest_hashes() {
    section("dest_hash");
    let s = StaticSecret::from([0x11u8; 32]);
    let p = PublicKey::from(&s);
    println!("x25519.pub(secret=[0x11;32]) = {}", hex(p.as_bytes()));
    println!("dest_hash(pub(secret=[0x11;32])) = {}", hex(&dest_hash(&p)));
    let mut base = [0u8; 32];
    base[0] = 9;
    println!("dest_hash(basepoint 9) = {}", hex(&dest_hash(&PublicKey::from(base))));
}

fn sealed() {
    section("sealed");
    let a_s = StaticSecret::from([0x21u8; 32]);
    let a_p = PublicKey::from(&a_s);
    let b_s = StaticSecret::from([0x42u8; 32]);
    let b_p = PublicKey::from(&b_s);
    let c_s = StaticSecret::from([0x63u8; 32]);
    let c_p = PublicKey::from(&c_s);
    let payload = b"trinity golden vector";
    let env = SealedEnvelope::seal(&a_s, &a_p, &b_p, [1u8; 12], payload).expect("seal");
    println!("sealed.sender_pub = {}", hex(a_p.as_bytes()));
    println!("sealed.recipient_pub = {}", hex(b_p.as_bytes()));
    println!("sealed.dest_hash = {}", hex(&env.dest_hash));
    println!("sealed.src_x25519_pub = {}", hex(&env.src_x25519_pub));
    println!("sealed.nonce = {}", hex(&env.nonce));
    println!("sealed.ciphertext.len = {}", env.ciphertext.len());
    println!("sealed.ciphertext = {}", hex(&env.ciphertext));
    match env.unseal(&b_s, &b_p) {
        Ok(p) => println!("sealed.unseal(recipient) = Ok(equal={})", p == payload),
        Err(e) => println!("sealed.unseal(recipient) = Err({:?})", e),
    }
    match env.unseal(&c_s, &c_p) {
        Ok(_) => println!("sealed.unseal(other) = Ok"),
        Err(e) => println!("sealed.unseal(other) = Err({:?})", e),
    }
    let mut tampered = SealedEnvelope {
        dest_hash: env.dest_hash,
        src_x25519_pub: env.src_x25519_pub,
        nonce: env.nonce,
        ciphertext: env.ciphertext.clone(),
    };
    tampered.ciphertext[0] ^= 1;
    match tampered.unseal(&b_s, &b_p) {
        Ok(_) => println!("sealed.unseal(tampered) = Ok"),
        Err(e) => println!("sealed.unseal(tampered) = Err({:?})", e),
    }
    let big = SealedEnvelope::seal(&a_s, &a_p, &b_p, [1u8; 12], &pattern(1020)).expect("seal");
    println!(
        "sealed(payload=1020).ciphertext.len = {} fnv1a64={:016x}",
        big.ciphertext.len(),
        fnv1a64(&big.ciphertext)
    );
}

fn chain_state(tag: &str, c: &Chain) {
    println!(
        "{tag}.state root={} chain={} counter={} skipped={}",
        hex(c.root_key().as_bytes()),
        hex(c.chain_key().as_bytes()),
        c.counter(),
        c.skipped_len()
    );
}

fn recv(tag: &str, c: &mut Chain, counter: u64) {
    let r = match c.recv_accept(counter) {
        Ok(m) => format!("Ok({})", mk(&m)),
        Err(e) => format!("Err({:?})", e),
    };
    println!("{tag}.recv_accept({counter}) = {r} -> counter={} skipped={}", c.counter(), c.skipped_len());
}

fn ratchet() {
    section("ratchet");
    println!("ratchet.skipped_keys_cap = {}", SKIPPED_KEYS_CAP);

    // Sender chain from RootKey([7; 32]), label "send".
    let mut send = Chain::from_root(&RootKey::new([7u8; 32]), b"send");
    chain_state("send", &send);
    for i in 0..5 {
        let m = send.send_next();
        println!("send.send_next#{i} = {}", mk(&m));
    }
    chain_state("send", &send);

    // Same root, other label: a different chain key.
    let recv_chain = Chain::from_root(&RootKey::new([7u8; 32]), b"recv");
    chain_state("label_recv", &recv_chain);

    // DH step and hybrid DH+KEM step from identical starting chains.
    let my = StaticSecret::from([0x31u8; 32]);
    let their = PublicKey::from(&StaticSecret::from([0x32u8; 32]));
    let mut dh = Chain::from_root(&RootKey::new([7u8; 32]), b"send");
    dh.send_next();
    dh.dh_step(&my, &their);
    chain_state("dh_step", &dh);
    println!("dh_step.send_next#0 = {}", mk(&dh.send_next()));
    let mut kem = Chain::from_root(&RootKey::new([7u8; 32]), b"send");
    kem.send_next();
    kem.dh_kem_step(&my, &their, &[0x55u8; 32]);
    chain_state("dh_kem_step", &kem);
    println!("dh_kem_step.send_next#0 = {}", mk(&kem.send_next()));
    let mut kem0 = Chain::from_root(&RootKey::new([7u8; 32]), b"send");
    kem0.dh_kem_step(&my, &their, &[0u8; 32]);
    chain_state("dh_kem_step(kem_ss=0)", &kem0);

    // Receive: in order, then replays.
    let mut r = Chain::from_root(&RootKey::new([8u8; 32]), b"recv");
    for c in [0u64, 1, 1, 0, 2] {
        recv("replay", &mut r, c);
    }

    // Receive: rollback outside the 64-counter window.
    let mut r = Chain::from_root(&RootKey::new([9u8; 32]), b"recv");
    for c in 0u64..130 {
        r.recv_accept(c).expect("in-order accept");
    }
    chain_state("rollback", &r);
    for c in [0u64, 65, 66, 129, 130] {
        recv("rollback", &mut r, c);
    }

    // Receive: forward jump stores skipped keys; late arrivals use them.
    let mut r = Chain::from_root(&RootKey::new([8u8; 32]), b"recv");
    for c in [5u64, 2, 2, 0, 6, 4, 3, 1, 1] {
        recv("skipped", &mut r, c);
    }

    // Receive: jump beyond the skipped-keys cap, then a late counter that
    // is inside the window but was never stored.
    let mut r = Chain::from_root(&RootKey::new([8u8; 32]), b"recv");
    for c in [2000u64, 1990, 1990, 1023, 1937, 1936] {
        recv("cap", &mut r, c);
    }

    // DH step resets the receive counter and window.
    let mut r = Chain::from_root(&RootKey::new([8u8; 32]), b"recv");
    recv("reset", &mut r, 0);
    recv("reset", &mut r, 1);
    r.dh_step(&my, &their);
    chain_state("reset", &r);
    recv("reset", &mut r, 0);
}

fn prekey() {
    section("prekey");
    let lt = SigningKey::from_bytes(&[0x61u8; 32]);
    let x = PublicKey::from(&StaticSecret::from([0x62u8; 32]));
    let mut mlkem_pub = [0u8; MLKEM_PUB_LEN];
    mlkem_pub.copy_from_slice(&pattern(MLKEM_PUB_LEN));
    let body = PrekeyBundleBody {
        version: PROTOCOL_VERSION,
        lt_pub: lt.verifying_key().to_bytes(),
        x25519_pub: x.to_bytes(),
        mlkem_pub,
        issued_at_unix: 1_700_000_000,
        valid_for_secs: 7 * 24 * 60 * 60,
    };
    let bytes = body.canonical_bytes();
    println!("prekey.canonical_bytes.len = {}", bytes.len());
    println!("prekey.canonical_bytes = {}", hex(&bytes));
    let sig = lt.sign(&bytes).to_bytes();
    println!("prekey.signature = {}", hex(&sig));
    let bundle = PrekeyBundle { body, signature: sig };
    println!("prekey.verify = {:?}", bundle.verify());
    for now in [1_700_000_000u64, 1_700_604_800, 1_700_604_801] {
        println!("prekey.verify_at({now}) = {:?}", bundle.verify_at(now));
    }
    let mut bad = bundle.clone();
    bad.signature[0] ^= 1;
    println!("prekey.verify(tampered signature) = {:?}", bad.verify());
    let mut bad = bundle.clone();
    bad.body.valid_for_secs += 1;
    println!("prekey.verify(tampered body) = {:?}", bad.verify());
}

fn capability() {
    section("capability");
    let iss = SigningKey::from_bytes(&[0x71u8; 32]);
    let other = SigningKey::from_bytes(&[0x73u8; 32]);
    let mut tok = CapabilityToken {
        session_id: [1u8; 32],
        agent_id: [2u8; 32],
        scopes: vec![
            Scope::SendReply,
            Scope::ReadHistory,
            Scope::InvokeTool("fetch_url".to_string()),
            Scope::FetchUrl("example.org".to_string()),
        ],
        expires_at: 1_000_600,
        nonce: [3u8; 16],
        sig: Vec::new(),
    };
    let sb = tok.signing_bytes();
    println!("capability.signing_bytes.len = {}", sb.len());
    println!("capability.signing_bytes = {}", hex(&sb));
    tok.sig = iss.sign(&sb).to_bytes().to_vec();
    println!("capability.sig = {}", hex(&tok.sig));
    let vk = iss.verifying_key();
    let cases: [(&str, u64, Scope, bool); 6] = [
        ("send_reply", 1_000_100, Scope::SendReply, true),
        ("invoke_fetch_url", 1_000_599, Scope::InvokeTool("fetch_url".to_string()), true),
        ("invoke_other", 1_000_100, Scope::InvokeTool("exec".to_string()), true),
        ("fetch_other_domain", 1_000_100, Scope::FetchUrl("evil.example".to_string()), true),
        ("expired_at_boundary", 1_000_600, Scope::SendReply, true),
        ("wrong_issuer", 1_000_100, Scope::SendReply, false),
    ];
    for (name, now, scope, right_key) in cases {
        let key = if right_key { vk } else { other.verifying_key() };
        println!("capability.verify[{name}] = {:?}", tok.verify(&key, now, &scope));
    }
    let mut short = tok.clone();
    short.sig.truncate(63);
    println!("capability.verify[sig_len_63] = {:?}", short.verify(&vk, 1_000_100, &Scope::SendReply));

    let pk = SigningKey::from_bytes(&[0x72u8; 32]);
    let m = ToolManifest::sign("fetch_url", [9u8; 32], &pk);
    println!("tool_manifest.publisher = {}", hex(&m.publisher));
    println!("tool_manifest.signing_bytes = {}", hex(&m.signing_bytes()));
    println!("tool_manifest.sig = {}", hex(&m.sig));
    println!("tool_manifest.verify = {:?}", m.verify());
    let mut renamed = m.clone();
    renamed.name = "evil_exec".to_string();
    println!("tool_manifest.verify(renamed) = {:?}", renamed.verify());
    let mut rehashed = m.clone();
    rehashed.schema_hash[31] ^= 1;
    println!("tool_manifest.verify(schema_hash changed) = {:?}", rehashed.verify());
}

fn verdict(text: &str) -> String {
    match validate_output(text) {
        Ok(()) => "ok".to_string(),
        Err(InjectionError::Pattern(p)) => format!("block pattern={:?}", p),
        Err(InjectionError::TooLong) => "block too_long".to_string(),
    }
}

fn injection() {
    section("injection");
    let benign = [
        "",
        "ok",
        "Sure here is the answer.",
        "Sure, here is the recipe.",
        "The meeting moved to 15:00 on Thursday.",
        "\u{0417}\u{0434}\u{0440}\u{0430}\u{0432}\u{0441}\u{0442}\u{0432}\u{0443}\u{0439}\u{0442}\u{0435}, \u{043a}\u{0430}\u{043a} \u{0434}\u{0435}\u{043b}\u{0430}?",
        "IGNORE PREVIOUS instructions",
        "please Disregard Prior notes",
    ];
    for t in benign {
        println!("injection.fixed {:?} = {}", t, verdict(t));
    }
    let at_limit = "a".repeat(32 * 1024);
    let over_limit = "a".repeat(32 * 1024 + 1);
    println!("injection.fixed a*32768 = {}", verdict(&at_limit));
    println!("injection.fixed a*32769 = {}", verdict(&over_limit));
    let long_with_pattern = format!("{}ignore previous", "a".repeat(32 * 1024));
    println!("injection.fixed a*32768+\"ignore previous\" = {}", verdict(&long_with_pattern));

    // Every corpus line: the text field is "payload", or "prompt" in the
    // rows that falsifier_runner skips today.
    let (mut lines, mut blocked) = (0usize, 0usize);
    for (i, raw) in CORPUS.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        lines += 1;
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                println!("corpus L{} unparsed", i + 1);
                continue;
            }
        };
        let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("?");
        let (field, text) = match (v.get("payload").and_then(|x| x.as_str()), v.get("prompt").and_then(|x| x.as_str())) {
            (Some(t), _) => ("payload", t),
            (None, Some(t)) => ("prompt", t),
            (None, None) => {
                println!("corpus L{} {} no-text-field", i + 1, id);
                continue;
            }
        };
        let r = verdict(text);
        if r != "ok" {
            blocked += 1;
        }
        println!("corpus L{} {} {} {}", i + 1, id, field, r);
    }
    println!("corpus.lines = {lines} blocked = {blocked}");
}

fn main() {
    println!("# trios-chat golden vectors v1 (deterministic; regenerate only in a referenced fix PR)");
    laws();
    padding();
    dest_hashes();
    sealed();
    ratchet();
    prekey();
    capability();
    injection();
}
