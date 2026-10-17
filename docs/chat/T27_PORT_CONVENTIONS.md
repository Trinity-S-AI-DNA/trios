# trios-chat to .t27: port conventions

Applies to every spec under `specs/port/trios/crates/trios-chat/` in
gHashTag/t27 and to every swap under `crates/trios-chat/` in gHashTag/trios.

- Epic: https://github.com/gHashTag/trios/issues/1812
- Source facts: research of 2026-10-10 and 2026-10-11 (t27c from gHashTag/t27
  master, Zig 0.16.0, rustc 1.94.0).
- Every `.t27` snippet in this file was checked with t27c built from
  gHashTag/t27 master 67cbf82849e4 (2026-10-10), Zig 0.16.0 and rustc 1.94.0:
  `t27c test-report` passes with 0 vacuous tests, the `t27c gen-rust` output
  compiles with `rustc --edition 2021 --crate-type lib`, and `t27c coverage`
  prints `Untested: 0`. Section 12 has the commands.

## 0. Owner decisions in force (2026-10-11)

- D2, lane: own lane only. Every port and every swap is written by agents
  acting as dmitrii-f-t27, in their own PRs (t27: from the fork). There is no
  Queen fallback: a ring is never handed to the Queen. If a tracker claim
  fails, the file is still ported in an own PR. Never duplicate active bee
  work; an abandoned item (an empty branch, or a PR with no activity for
  48 h) is taken over with an own PR.
- D4, adapters: interim hand-written Rust adapters (section 8) map the
  generated verdict back to the original `Result<(), E>`. They shrink or
  disappear when gen-rust lowers `?T`, `Result` and slices itself.
- D5, verdict: a named verdict struct with a payload-free enum, `Ok` first
  (section 3).
- D6, quirks of the original: preserve them bit for bit, unless a separate
  trios PR fixes them first (section 6). Status: pending, no owner answer
  yet; recommendation: preserve. Until the owner answers, ports preserve.

## 1. Where the spec lives and what it is called

- One original file -> one spec:
  `specs/port/trios/crates/trios-chat/rings/<R>/src/<stem>.t27`
- A split file -> one spec per decision chunk, each with its own target:
  `specs/port/trios/crates/trios-chat/rings/<R>/src/<stem>/<part>.t27`.
  Never "part k of m" on one target. If the stage-6 feeder would file the
  original (it is not too big, has functions and is not a test or migration),
  the main chunk lives at the parent target `.../src/<stem>.t27` itself: once
  it is on master the feeder skips that target for good.
- First code line of a new spec, full path, unique:
  `module port::trios::crates::trios-chat::rings::<R>::src::<stem>;`
  (chunks: `...::src::<stem>::<part>;`).
  Merged specs with a short module name (`port::<stem>`) keep it: renaming a
  module renames its seal file.
- Why: the seal file name comes from the module name and the spec's
  directory. `t27c seal --save` writes
  `./.trinity/seals/<parent directory of the spec path>_<module>.json` in the
  current directory. A spec without a module line takes its file stem, so
  `lib.t27` became `src_lib.json` and collided with the trios-store ST-00
  seal. A chunk at `.../src/<stem>/<part>.t27` is sealed as
  `<stem>_port::...::src::<stem>::<part>.json`.

## 2. Language of the text

- English, ASCII only, in comments and strings. The t27c build panics with
  "LANGUAGE POLICY VIOLATION" on Cyrillic, which makes the required
  parse-ratchet check red.
- 12 originals carry Russian comments. Translate them:
  - CR-CHAT-01: identity_key_rotation_guard, prekey_bundle_freshness_guard;
  - CR-CHAT-02: forward_secrecy_key_wipe, skipped_message_key_exhaustion;
  - CR-CHAT-03: treekem_update_path_validation;
  - CR-CHAT-04: padding_class_downgrade_guard, padding_metadata_leak_guard;
  - CR-CHAT-05: store_integrity_hash_chain;
  - CR-CHAT-06: capability_scope_escalation_guard, tool_cot_leak_guard;
  - CR-CHAT-07: decoy_payload_indistinguishability,
    traffic_volume_correlation_guard.

## 3. The verdict (replaces Result<(), E>)

New ports use one shape (owner decision D5, 2026-10-11):

- a payload-free enum: `Ok` first, then the original error variants in their
  declaration order; unreachable ("dead") variants are kept;
- a named struct carrying the code and every payload field of every error
  variant the original can return, whether or not a test asserts it (idx,
  got, max, a 32-byte id, ...). The adapter rebuilds payloads only from these
  fields, caller inputs or original constants, never from a placeholder.

Template (checked, section 12):

```t27
module port::trios::crates::trios-chat::rings::CR-CHAT-99::src::xxx_guard;

// TEMPLATE ONLY. Ring CR-CHAT-99 does not exist.

pub const XXX_MAX: usize = 4;

pub enum XxxCode {
    Ok,
    TooMany,
    ZeroId,
    Duplicate,
}

pub struct XxxVerdict {
    code: XxxCode,
    idx: usize,
    a: u64,
    b: u64,
}

pub fn validate_xxx(ids: []const u64) -> XxxVerdict {
    if (ids.len > XXX_MAX) {
        return XxxVerdict { code: XxxCode.TooMany, idx: 0, a: @as(u64, ids.len), b: @as(u64, XXX_MAX), };
    }
    for (i in 0..ids.len) {
        if (ids[i] == 0) {
            return XxxVerdict { code: XxxCode.ZeroId, idx: i, a: 0, b: 0, };
        }
        for (j in 0..i) {
            if (ids[j] == ids[i]) {
                return XxxVerdict { code: XxxCode.Duplicate, idx: i, a: 0, b: 0, };
            }
        }
    }
    return XxxVerdict { code: XxxCode.Ok, idx: 0, a: 0, b: 0, };
}

test xxx_01_ok {
    var ids: [3]u64 = [3]u64{1, 2, 3};
    const v = validate_xxx(&ids);
    assert(v.code == XxxCode.Ok);
}

test xxx_02_too_many_reports_got_and_max {
    var ids: [5]u64 = [5]u64{1, 2, 3, 4, 5};
    const v = validate_xxx(&ids);
    assert(v.code == XxxCode.TooMany);
    assert(v.a == 5);
    assert(v.b == 4);
}

test xxx_03_zero_id_reports_index {
    var ids: [3]u64 = [3]u64{1, 0, 3};
    const v = validate_xxx(&ids);
    assert(v.code == XxxCode.ZeroId);
    assert(v.idx == 1);
}

test xxx_04_duplicate_reports_index {
    var ids: [3]u64 = [3]u64{7, 8, 7};
    const v = validate_xxx(&ids);
    assert(v.code == XxxCode.Duplicate);
    assert(v.idx == 2);
}
```

Not allowed in new ports:

- `?Enum` returns (gen-rust omits `Some()`: rustc E0308);
- payload enum variants such as `Gap(u32)` (garbage in both backends: an enum
  member literally named `u32`; `test-report` is BLOCKED while `spec-status`
  still says IMPLEMENTED);
- anonymous struct return types (Rust parse error "expected type, found
  keyword `struct`");
- bare i32 codes (legacy ports only).

## 4. Types, bytes and constructs

| Need | Write | Do not write | Why (measured 2026-10-11) |
|---|---|---|---|
| fixed bytes (keys, ids, digests) | `[N]u8` | `[]const u8` | a `[]const u8` parameter becomes `&'static str` when the file has no byte slicing |
| variable bytes | `[]u8` with typed (`var`) test arrays | `[]const u8` | same; `[]u8` becomes `Vec<u8>` |
| a slice of fixed-size records | `[]const Rec` where `Rec` is a struct holding `[N]u8` | `[]const [N]u8` | Zig BLOCKED and a Rust parse error (`Vec<const>, u8: `) |
| read-only slice of T | `[]const T`; the adapter takes the caller's `&[T]` and passes `.to_vec()` | - | gen-rust lowers it to `Vec<T>` by value: `ids: []const u64` becomes `ids: Vec<u64>` (section 8) |
| slice of slices | one flat buffer + a lengths (or offsets) array | `[]const []const u8` | Zig BLOCKED, Rust parse error: the parameter splits into `[]const` and a parameter named `u8` |
| string table | flat bytes + offsets | `[N][]const u8` | Rust gets `Vec<const u8>`: parse error |
| non-ASCII or control bytes in a test | a byte array | `"\x00"`, `"\u{202E}"`, raw UTF-8 in a string | escapes are escaped again (`\x00` becomes four characters) and UTF-8 is double-encoded, in both backends: `test-report` fails, the Rust compiles with the wrong bytes |
| u64::MAX | `0xFFFFFFFFFFFFFFFF` | `u64::MAX` | Zig BLOCKED "type 'u64' has no members" |
| widening to 128 bits | `@as(u128, x)` | `const y: u128 = x;` or `x as u128` | implicit widening: rustc E0308 (same for i128); `u128` is not an `as` target ("unknown cast target type") |
| a usize value into a u64 field | `@as(u64, x)` | the bare usize value | Zig passes, rustc fails with E0308 |
| narrowing (u128 -> u64, u32 -> u8 for byte extraction) | `@truncate(x)` into a typed variable, struct field, array slot or declared return | `@as(u64, x)` | Zig BLOCKED "expected type 'u64', found 'u128'" |
| a cast that must fit | `@truncate(x)`, or `@intCast(x)` when it provably fits | `@as(T, @intCast(x))` | rustc E0282 "type annotations needed" |
| log2 | an integer loop or a log2 helper in the file | `@log2` | float only in Zig (integer argument: BLOCKED); emitted verbatim into Rust (parse error) |
| local array | `var a: [3]u8 = [3]u8{9, 8, 7};` | `var a = [_]u8{9, 8, 7};` | the untyped literal lowers to a Zig tuple: BLOCKED "cannot cast pointer to tuple" |
| methods | free fns: `type_method(t: *T, ...)` | `fn` inside `struct { }`; a parameter named `self` | methods are dropped by gen-zig (spec-status NOFN); gen-rust keeps a parameter named `self` and rustc rejects it ("`self` parameter is only allowed in associated functions") |
| enum literal outside return | `E.Variant` | `.Variant` | Rust E0425 |
| map, set | O(n^2) scan over a bounded array; capacity from the original MAX constant | `HashMap`, `BTreeSet` | not in the language (parse error) |
| bool bitmap | only when the key range fits the array | `seen[256]` indexed by a u32 | the merged skipped-key port indexes 256 slots with values up to 1,000,000 |
| helpers (bytes_eq, is_zero, isqrt) | inline in each file, each with its own test | `use a::b` | see the note below the table |
| generics, closures, traits, async, I/O | port the decision only | - | not in the language (generics: BLOCKED; closures: parse error); plumbing stays in the Rust adapter |

Helpers and `use`: on master 67cbf82849e4 a cross-module `use x::a::f;`
resolves only when the spec path given to t27c has a `specs/` directory
above it; t27c then splices `f` into the generated file. Run from inside the
directory with a bare file name, `test-report` is BLOCKED ("use of undeclared
identifier") and `gen` only warns (t27 issue 7176 is open). Keep helpers
inline, each with its own test: every swapped file must stand alone, and an
untested helper makes the queen-feed-untested feeder file a bee task on the
spec. The advisory duplicate-bodies check may go red for inline helpers: name
it in the PR.

Every row of the "Write" column above, in one checked spec (section 12):

```t27
module port::trios::crates::trios-chat::rings::CR-CHAT-99::src::constructs_example;

// TEMPLATE ONLY. Ring CR-CHAT-99 does not exist.

pub const CX_U64_MAX: u64 = 0xFFFFFFFFFFFFFFFF;

pub enum CxKind {
    Small,
    Big,
}

pub struct CxRec {
    id: [4]u8,
    size: u64,
}

pub struct CxCounter {
    n: u64,
}

// fixed bytes: [N]u8
pub fn cx_first_byte(k: [4]u8) -> u8 {
    return k[0];
}

// variable bytes: []u8, typed (var) test arrays
pub fn cx_sum(xs: []u8) -> u64 {
    var s: u64 = 0;
    for (i in 0..xs.len) {
        s = s + @as(u64, xs[i]);
    }
    return s;
}

// a slice of fixed-size records: []const Rec, Rec holds [N]u8
pub fn cx_total_size(rs: []const CxRec) -> u64 {
    var t: u64 = 0;
    for (i in 0..rs.len) {
        t = t + rs[i].size;
    }
    return t;
}

// string table: flat bytes + offsets
pub fn cx_name_len(offs: [4]u32, k: usize) -> u32 {
    return offs[k + 1] - offs[k];
}

// widening to 128 bits: @as(u128, x)
pub fn cx_mul_wide(a: u64, b: u64) -> u128 {
    return @as(u128, a) * @as(u128, b);
}

// a usize value into a u64 field: @as(u64, x)
pub fn cx_make_rec(k: [4]u8, xs: []u8) -> CxRec {
    return CxRec { id: k, size: @as(u64, xs.len), };
}

// narrowing: @truncate(x) into a typed variable
pub fn cx_low_byte(x: u32) -> u8 {
    const b: u8 = @truncate(x);
    return b;
}

// enum literal outside return: E.Variant
pub fn cx_is_big(k: CxKind) -> bool {
    if (k == CxKind.Big) {
        return true;
    }
    return false;
}

// methods as free functions: type_method(t: *T, ...); never a parameter named self
pub fn cx_counter_bump(c: *CxCounter, by: u64) -> u64 {
    c.n = c.n + by;
    return c.n;
}

test cx_01_first_byte {
    var k: [4]u8 = [4]u8{9, 8, 7, 6};
    assert(cx_first_byte(k) == 9);
}

test cx_02_sum_typed_local_array {
    var a: [3]u8 = [3]u8{9, 8, 7};
    assert(cx_sum(&a) == 24);
}

test cx_03_total_size {
    var k: [4]u8 = [4]u8{1, 2, 3, 4};
    const rs = [2]CxRec{ CxRec { id: k, size: 10, }, CxRec { id: k, size: 5, } };
    assert(cx_total_size(&rs) == 15);
}

test cx_04_name_len {
    var offs: [4]u32 = [4]u32{0, 1, 3, 6};
    assert(cx_name_len(offs, 0) == 1);
    assert(cx_name_len(offs, 2) == 3);
}

test cx_05_mul_wide_u64_max {
    assert(cx_mul_wide(CX_U64_MAX, 2) == 36893488147419103230);
}

test cx_06_make_rec_len_into_u64 {
    var k: [4]u8 = [4]u8{1, 2, 3, 4};
    var a: [3]u8 = [3]u8{1, 1, 1};
    const r = cx_make_rec(k, &a);
    assert(r.size == 3);
    assert(r.id[3] == 4);
}

test cx_07_low_byte {
    assert(cx_low_byte(0x01020304) == 4);
}

test cx_08_is_big {
    assert(cx_is_big(CxKind.Big) == true);
    assert(cx_is_big(CxKind.Small) == false);
}

test cx_09_counter_bump {
    var c: CxCounter = CxCounter { n: 1, };
    assert(cx_counter_bump(&c, 2) == 3);
    assert(c.n == 3);
}
```

gen-rust lowers the parameters of this spec as: `[4]u8` -> `[u8; 4]`,
`[]u8` -> `Vec<u8>`, `[]const CxRec` -> `Vec<CxRec>`, `*CxCounter` ->
`&mut CxCounter`; `@truncate(x)` -> `(x as _)`; `@as(u64, n)` -> `(n as u64)`.

Casts in one more checked spec (section 12):

```t27
module port::trios::crates::trios-chat::rings::CR-CHAT-99::src::cast_example;

// TEMPLATE ONLY. Ring CR-CHAT-99 does not exist.

pub fn cex_widen_len(n: usize) -> u64 {
    return @as(u64, n);
}

pub fn cex_widen_mul(a: u64, b: u64) -> u128 {
    return @as(u128, a) * @as(u128, b);
}

pub fn cex_low_u64(p: u128) -> u64 {
    return @truncate(p);
}

pub fn cex_be_prefix(len: u32) -> [4]u8 {
    var out: [4]u8 = [4]u8{0, 0, 0, 0};
    out[0] = @truncate(len >> 24);
    out[1] = @truncate(len >> 16);
    out[2] = @truncate(len >> 8);
    out[3] = @truncate(len);
    return out;
}

test cex_01_widen_len {
    assert(cex_widen_len(7) == 7);
}

test cex_02_widen_mul {
    assert(cex_widen_mul(0xFFFFFFFFFFFFFFFF, 2) == 36893488147419103230);
}

test cex_03_low_u64 {
    assert(cex_low_u64(36893488147419103230) == 0xFFFFFFFFFFFFFFFE);
}

test cex_04_be_prefix {
    const p = cex_be_prefix(0x01020304);
    assert(p[0] == 1);
    assert(p[1] == 2);
    assert(p[2] == 3);
    assert(p[3] == 4);
}
```

`@intCast(x)` only where the value provably fits: Zig panics otherwise,
while Rust `as` truncates.

## 5. Tests

- Transcribe every original `#[test]` with an exact verdict assert: the code
  and every payload field the original asserts.
- List tautological originals (`assert_eq!(count, N)` summaries) in the PR.
  They are not ported and not counted.
- `t27c test-report` must show 0 FAIL, 0 BLOCKED, 0 vacuous.
- `t27c coverage` must show "Untested: 0": every function, helpers included,
  has a direct test.
- Split files and crypto-adjacent files: instead of "test blocks >= original
  #[test] count", the PR carries a test-mapping table, one row per original
  test: the spec test that transcribes it, or "stays Rust oracle: <crypto
  primitive | OsRng | glue | async | should_panic>".
- Never replace a computation with its precomputed result. The merged
  CR-CHAT-LAWS port returns a hard-coded SHA-256; a separate repair is
  tracked under the epic.
- A fixture that cannot be expressed (for example 1,000,001 elements) is
  named in the PR. The original Rust test still covers it after the swap.

## 6. Behaviour fidelity

- Same rule order; the first failing rule decides the verdict.
- Unreachable variants keep their codes.
- Known quirks of the original are preserved bit for bit unless a separate
  trios PR fixed them first (owner decision D6, pending; section 0). The list is tracked under
  the epic ("behaviour quirks").
- Bounded arrays must cover the original key range.
- Re-declare the original constants with their original types in the
  adapter (the ports drifted usize -> u32 and leaked a test constant NOW).

## 7. Checks before a PR (task type T-PORT, checks 0-14)

Each Bash call of an agent session is a fresh shell: put the exports of the
first block in a file and source it at the start of every call. Use bash,
not zsh. The blocks can be pasted into bash as they are after the six FILL
values are set; the expected result of each check is in its `# expected:`
comment. `grep -c` exits 1 when it prints 0: compare the printed number, not
the exit code.

```bash
# Setup. FILL the six values; the examples are for the CR-CHAT-02 epoch
# rollover guard.
export PATH="$HOME/local/zig-aarch64-macos-0.16.0:$PATH"
T27WT="$HOME/Documents/t27-wt-chat-cr02"     # FILL: the PR's own t27 worktree
R=CR-CHAT-02                                 # FILL: ring
STEM=epoch_rollover_wraparound_guard         # FILL: file stem of the original
NAMES='validate_epoch_rollover'              # FILL: the original's non-test fn names; several: 'f_one|f_two'
N_TEST=10                                    # FILL: number of #[test] in the original
OUT="$HOME/scratch/port-$STEM"               # FILL: own scratch directory
SPEC="specs/port/trios/crates/trios-chat/rings/$R/src/$STEM.t27"   # repo-relative
T27C="$T27WT/target/release/t27c"
mkdir -p "$OUT"
cd "$T27WT" && cargo build --release -p t27c # t27c from the PR's own tree
```

```bash
# Checks 0-11 and 14. Run from the t27 worktree root.
cd "$T27WT"
# 0  dedup, by hand: no other issue, no spec on master, no foreign PR, no queen-N branch
# 1  the spec exists
test -f "$SPEC" && echo present                                    # expected: present
# 2  every fn of the original is ported
grep -cE "^[[:space:]]*(pub )?fn (${NAMES})[(]" "$SPEC"            # expected: the number of names in NAMES
# 3  no unimplemented body
"$T27C" gen "$SPEC" > "$OUT/gen.zig"; grep -c 'not yet implemented' "$OUT/gen.zig"   # expected: 0
# 4  status (necessary, not sufficient)
"$T27C" spec-status "$SPEC"                                        # expected: IMPLEMENTED
# 5  test count
grep -cE '^[[:space:]]*test[[:space:]]+("|[A-Za-z_])' "$SPEC"      # expected: >= N_TEST (split and crypto-adjacent files: test-mapping table, section 5)
echo "N_TEST=$N_TEST"
# 6  Zig tests
"$T27C" test-report "$SPEC"; echo "exit=$?"                        # expected: exit=0 (1 = FAIL, 2 = BLOCKED); "vacuous passes  0"
# 7  parse
"$T27C" parse "$SPEC" > /dev/null && echo parses                   # expected: parses
# 8  the Rust compiles (never -o /dev/null: "couldn't create a temp dir")
"$T27C" gen-rust "$SPEC" > "$OUT/$STEM.rs" && rustc --edition 2021 --crate-type lib --out-dir "$OUT" "$OUT/$STEM.rs"; echo "exit=$?"   # expected: exit=0
# 8b no &'static str, no Vec<const in the Rust
grep -c "&'static str" "$OUT/$STEM.rs"                             # expected: 0
grep -c 'Vec<const' "$OUT/$STEM.rs"                                # expected: 0
# 9  full module line
grep -c "^module port::trios::crates::trios-chat::rings::$R::src::$STEM;" "$SPEC"   # expected: 1
# 10 ASCII only
LC_ALL=C grep -c $'[\x80-\xff]' "$SPEC"                            # expected: 0
# 11 banned constructs (section 4): review by hand; this grep is only a screen
grep -nE '@log2|::MAX|\[_\]|->[[:space:]]*\?|[(,][[:space:]]*self[[:space:]]*:' "$SPEC"   # expected: no output
# 14 every fn has a direct test
"$T27C" coverage "$SPEC" | grep -c '^Untested: *0$'                # expected: 1
```

```bash
# Check 12, seal. Only from the t27 worktree root, only with the
# repo-relative $SPEC: t27c seal --save writes ./.trinity/seals of the CURRENT
# directory (anywhere else it silently creates a stray .trinity/).
cd "$T27WT"
"$T27C" seal --save "$SPEC" && "$T27C" seal --verify "$SPEC"; echo "exit=$?"   # expected: exit=0, "all hashes MATCH"
git status --short --untracked-files=all .trinity/seals            # expected: exactly one line, the file below
SEAL=".trinity/seals/$(basename "$(dirname "$SPEC")")_$(sed -n 's/^module \(.*\);.*/\1/p' "$SPEC" | head -n 1).json"
echo "$SEAL"                                                       # expected: .trinity/seals/src_port::trios::crates::trios-chat::rings::<R>::src::<stem>.json
python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["tests"])' "$SEAL"
# expected: passed == total, failed 0, vacuous 0, no "blocked" key
# (seal --save on a BLOCKED spec also exits 0, so read this field)
```

Check 13 is a review: the fidelity rules of section 6, plus one line per
`Err` constructor of the original naming the source of each payload value.

## 8. Swap layout in gHashTag/trios

- `rings/<R>/src/t27gen/<stem>.rs`: byte-identical gen-rust output at the t27
  SHA in `crates/trios-chat/T27_PIN`. Never edited.
- `rings/<R>/src/<stem>.rs` keeps the original pub consts, types, docs,
  `#[non_exhaustive]` error enums with their derives and messages, and the
  original `#[cfg(test)]` module byte for byte. The logic becomes an interim
  adapter (owner decision D4). For the verdict template of section 3,
  gen-rust emits `pub fn validate_xxx(ids: Vec<u64>) -> XxxVerdict`, so the
  adapter keeps the original signature (`ids: &[u64]`) and passes
  `ids.to_vec()`: one copy per call, no other conversion. Checked: rustc
  builds it next to the generated file, and 4 tests over it pass
  (section 12):

```rust
#[allow(unused_parens, missing_docs, dead_code, unexpected_cfgs)]
mod t27gen { include!("t27gen/xxx_guard.rs"); }

pub fn validate_xxx(ids: &[u64]) -> Result<(), XxxError> {
    let v = t27gen::validate_xxx(ids.to_vec());
    match v.code {
        t27gen::XxxCode::Ok => Ok(()),
        t27gen::XxxCode::TooMany => Err(XxxError::TooMany { got: v.a as usize, max: v.b as usize }),
        t27gen::XxxCode::ZeroId => Err(XxxError::ZeroId(v.idx)),
        t27gen::XxxCode::Duplicate => Err(XxxError::Duplicate { idx: v.idx }),
    }
}
```

- Generated items stay private: `mod t27gen`, never `pub mod` (BR-OUTPUT-CHAT
  glob re-exports would leak them). gen-rust makes every fn `pub`, including
  helpers that are private in the spec.
- T27_PIN row: file, spec path, t27 SHA, t27c built_by, sha256 (always), and
  a separate column: seal file or "unsealed on master". `tests/t27_pin.rs`
  checks the hashes. No `.sh` files.
- Measured adapter size (5 scratch drafts, 2026-10-10): 22-35 non-blank lines
  in the minimal form; 49 non-blank (32 non-comment) in the in-tree form that
  re-declares the original docs and constants.

## 9. Crypto boundary

The audited crates stay in the adapter: x25519-dalek, ed25519-dalek,
chacha20poly1305, ml-kem, hkdf (with hkdf::hmac), sha2, subtle, zeroize,
rand_core / getrandom. Specs port the decision and the byte layout only.
Secret inputs reach generated code only as derived facts (an all-zero flag, a
length, an equality bit computed with subtle). The crypto boundary decision
is tracked under the epic.

## 10. Words we do not use about generated code

constant-time, side-channel-free, post-quantum, PQ-secure, sender-anonymous,
Coq-verified, "3600/3600". Write instead: "decision logic generated by t27c;
cryptographic operations by <crate>; no constant-time claim".

## 11. Toolchain traps

- Zig 0.16 first on PATH; `~/local/zig` (0.15) makes everything BLOCKED.
- Build t27c from the tree under test.
- `t27c seal --save` writes `./.trinity/seals` of the CURRENT directory
  without any error elsewhere (it creates a stray `.trinity/`): run it only
  from the repository root with the repo-relative spec path.
- `grep -c` exits 1 when it prints 0: compare the printed number.
- Restoring a file with `mv` keeps an old mtime: `touch` it, or cargo skips
  the rebuild.
- zsh does not word-split unquoted `$VAR` lists: use bash arrays.
- Read new master specs with `git show origin/master:<path>`; the local
  worktree may be older.
- `make t27-test` does not exist.
- gen-rust output says "NOT LOWERED BY THIS BACKEND: N test(s)": the tests
  run only on the Zig path, so check 8 (rustc) is the only Rust gate before a
  swap.

## 12. How the snippets were checked

Every fenced `t27` block of this file is extracted to its own file and run
through three commands (bash, Zig 0.16.0 first on PATH, t27c built from
gHashTag/t27 master 67cbf82849e4, rustc 1.94.0):

```bash
S=snippet1_xxx_guard                       # one file per t27 block
t27c test-report "$S.t27"; echo "exit=$?"  # expected: exit=0, FAIL 0, "vacuous passes  0"
t27c gen-rust "$S.t27" > "$S.rs" && rustc --edition 2021 --crate-type lib --out-dir out "$S.rs"; echo "exit=$?"   # expected: exit=0
t27c coverage "$S.t27" | grep -c '^Untested: *0$'   # expected: 1
```

The Rust adapter of section 8 is compiled with `rustc --edition 2021
--crate-type lib` and with `rustc --test` next to the gen-rust output of the
section 3 template, together with an `XxxError` enum and 4 tests; the 4
tests pass. The three bash blocks of section 7 were run as written on the
section 3 template, placed at its repo-relative path in a scratch git tree
(the cargo build line skipped: same t27c binary). Outputs are in the PR that
added this file.
