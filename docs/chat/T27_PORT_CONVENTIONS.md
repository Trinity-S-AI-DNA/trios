# T27 port conventions for trios-chat

Part of https://github.com/gHashTag/trios/issues/1812.

Every agent that writes a trios-chat spec or a swap follows one set of rules. Today the merged and open chat ports use five different ways to encode `Result` (enum with `Ok`, i32 codes, `{ok, error}` struct, `?Enum`, `Option`), three module-name forms, and constructs that pass the Zig acceptance but produce Rust that does not compile (3 of 8 merged and 5 of 9 open-PR chat ports, measured 2026-10-10). This document records the owner decisions and the single convention every port uses from now on.

Owner decisions of 2026-10-11 recorded here:

- **D5 (verdict convention):** a named verdict struct with a payload-free enum, `Ok` first.
- **D2 (lane):** own lane only. Every port is written by agents acting as `dmitrii-f-t27`; there is no Queen fallback.
- **D4 (adapters):** interim hand-written Rust adapters map the generated verdict back to `Result<(), E>` until `gen-rust` lowers more of the language.

## Spec location and module line

Each `.t27` spec lives in `gHashTag/t27` at `specs/port/trios/crates/trios-chat/<ring-or-common>/<path>.t27`, mirroring the Rust source path it ports (for example `crates/trios-chat/rings/CR-CHAT-03/src/external_commit.rs` → `specs/port/trios/crates/trios-chat/rings/CR-CHAT-03/src/external_commit.t27`).

The first line is always the fully-qualified module path, using `::` separators and the `port::` prefix:

```
module port::trios::crates::trios-chat::rings::CR-CHAT-03::src::external_commit;
```

The second line is a `use` of any shared module (common helpers live at `port::trios::crates::trios-chat::common::helpers`). Ring files declare only their own verdict types, rules and tests; shared scans and byte helpers live in the common module and are `use`d.

## Text language

t27 is not Zig and not Rust. Comments are `//` line comments only (no block comments). Numbers are decimal integer literals; `usize` is the size/index type. Slice reads use `[]const T` parameters indexed with `[]` and `.len` (not `.len()`). Arrays are fixed-size `[N]T` and are initialized with `[N]T{v1, v2, ...}`.

Const values declared at module level are compile-time constants; `pub const` exports them. Local `const` inside a function body names a fixed value.

## The verdict (D5)

Every gate returns a **named verdict struct**, never a raw enum and never `Result`. The verdict struct's first field is a payload-free enum named `<Gate>Code` whose first variant is `Ok`, followed by the original error variants in their original declaration order. Each variant carries every payload field the original `Result::Err` variant had.

```
pub enum ExtCode {
    Ok,
    EpochMismatch,
    LeafOccupied,
    SenderMismatch,
    OpsScopeViolation,
    GroupIdMismatch,
    InvalidSignature,
}

pub struct ExtVerdict {
    code: ExtCode,
    claimed: u64,
    actual: u64,
    leaf: u32,
    sender: u32,
    joining: u32,
    ops: [8]OpRec,
    ops_len: usize,
}
```

The decision function returns the verdict struct; callers match on `.code`. Interim Rust adapters (D4) map `code == Ok` to `Ok(())` and every other variant to `Err(...)`, carrying the payload fields.

Do not encode `Result` as an i32 code, a `{ok, error}` struct, `?Enum`, or `Option`. `Ok` is always the first variant of the code enum.

## Types, bytes and constructs

- Newtypes flatten to their bare integer: a 32-byte group id is `[32]u8`, an epoch is `u64`, a leaf index is `u32`.
- Enums become `pub enum` with plain variants (no payloads — payloads move to the verdict struct).
- Records become `pub struct` with plain fields.
- Loops are `for i in 0..N { ... }` and `for i in 0..slice.len { ... }`; `N` must be a compile-time constant for fixed arrays, `.len` for slices.
- Conditionals are `if (cond) { ... } else { ... }`; there is no `else if` chain — nest instead.
- `return` exits early from a function; there is no `?` operator — every error path explicitly builds and returns the verdict struct.
- Fixed-size arrays are passed by value; slices are passed as `[]const T` by reference.
- Array element access inside the generated Rust uses `a[(i) as usize]` style indexing — write t27 index expressions as plain `a[i]`; the backend lowers them.

Do not use constructs that pass Zig acceptance but fail `gen-rust` Rust compilation: no `match` on enums with payloads, no `Option`-typed fields, no `Result` returns, no generic type parameters, no closures, no `while` loops (use `for` with a bounded range), no `break`/`continue` inside `for` (use `return` instead).

## Tests

Every spec carries `test` blocks covering every verdict variant and every probe function, in the original's fixed rule order. Each test names the rule it exercises (EXT-01, EXT-02, …). Coverage must be complete:

```
t27c test-report specs/port/trios/crates/trios-chat/.../name.t27
```

must show `FAIL 0` and `vacuous passes 0 of N`. And:

```
t27c coverage specs/port/trios/crates/trios-chat/.../name.t27
```

must show `Untested: 0` — every function has at least one test.

Example test structure:

```
test ext_01_accepts_wellformed {
    const empty: [0]u32 = [0]u32{};
    const ops: [1]OpRec = [1]OpRec{ OpRec { kind: OpKind.Add, leaf: 5, }, };
    const v = check_external_commit(GOOD_GID, 7, 5, 5, &ops, &GOOD_SIGNATURE, GOOD_GID, 7, &empty);
    assert(v.code == ExtCode.Ok);
}

test ext_02_epoch_mismatch_rejected {
    const empty: [0]u32 = [0]u32{};
    const ops: [1]OpRec = [1]OpRec{ OpRec { kind: OpKind.Add, leaf: 5, }, };
    const v = check_external_commit(GOOD_GID, 3, 5, 5, &ops, &GOOD_SIGNATURE, GOOD_GID, 7, &empty);
    assert(v.code == ExtCode.EpochMismatch);
    assert(v.claimed == 3);
    assert(v.actual == 7);
}
```

## Behaviour fidelity

The port must reproduce the original Rust guard's behaviour exactly: the same fixed rule order, the same verdict variant for each input, and the same payload fields carried on rejection. Tests must cover the rejection ladder so that an earlier rule shadows a later one exactly as in the original (wrong group over forged epoch, forged epoch over occupied leaf, occupied leaf over sender mismatch, sender mismatch over scope-violating operations, those over empty signature).

The original `.rs` file is the oracle; do not restructure rules to suit t27. If the original cannot be expressed in t27 today (gen-rust limitation), leave it hand-written and record it in `crates/trios-chat/T27_EXCEPTIONS.md` rather than forcing a non-equivalent port.

## Checks before a PR

Before opening a PR on `gHashTag/t27` for a spec, run every check and paste the commands and outputs into the PR body:

```
t27c parse specs/port/trios/crates/trios-chat/.../name.t27                # exit 0
t27c spec-status specs/port/trios/crates/trios-chat/.../name.t27          # IMPLEMENTED
t27c test-report specs/port/trios/crates/trios-chat/.../name.t27          # FAIL 0, vacuous 0
t27c coverage specs/port/trios/crates/trios-chat/.../name.t27             # Untested: 0
t27c gen-rust specs/port/trios/crates/trios-chat/.../name.t27 > out.rs
rustc --edition 2021 --crate-type lib --out-dir out out.rs                # compile OK (warnings allowed)
```

Record the `t27c` binary's source commit (the `gHashTag/t27` SHA the release binary was built from) in the PR body.

The PR body starts with a `Closes #N` line for the issue it resolves. No CODEOWNERS file changes.

## Swap layout

In `gHashTag/trios`, the generated Rust is vendored at `crates/trios-chat/rings/<R>/src/t27gen/<stem>.rs` behind a thin hand-written adapter that maps the verdict struct back to `Result<(), E>`. The original `#[cfg(test)]` modules stay byte-identical and are the oracle, because `gen-rust` does not lower tests.

Swap order is innermost first: CR-CHAT-00 and LAWS, then CR-CHAT-04/07, CR-CHAT-03/05/06, CR-CHAT-02 and CR-CHAT-01 guards, crypto-adjacent decisions (CR-CHAT-01 `sealed.rs` after the CR-CHAT-04 swap), BR-IO rings, BR-OUTPUT and the shim.

## Crypto boundary

Do not port cryptographic primitives (hashes, signatures, AEAD, OpenMLS calls) into t27. The crypto boundary stays hand-written Rust; t27 specs port only the decision logic around the crypto calls — envelope guards, rule ladders, record scans, byte-layout checks. Signature verification, key derivation and encryption remain behind an `openmls`-style flag in the adapter.

## Words we do not use

Do not write these in spec comments or code: `match` (t27 has no match), `Result` (use the verdict struct), `Option` (use a bool + present flag), `?` (no propagate operator), `while` (use bounded `for`), `break`/`continue` (use `return`), generic type parameters, closures, block comments (`/* */`), `.len()` (use `.len`), `unwrap()`/`expect()` (t27 has no panicking accessors — bounds are checked by the caller).

## Toolchain traps

1. **Zig acceptance ≠ Rust compilation.** A spec that passes `t27c test-report` (Zig backend) may still fail `gen-rust` + `rustc`. Always run both.
2. **`gen-rust` emits declarations only.** Tests live in the Zig output; the generated `.rs` is not verified by `gen-rust` itself — compile it with `rustc` to check.
3. **Parentheses warnings.** `rustc` warns on unnecessary parentheses around `if` conditions and assigned values; these are warnings, not errors, but keep t27 expressions clean to minimise them.
4. **Binary version.** Record the `t27c` commit in the PR body; different binary versions can accept different constructs.
