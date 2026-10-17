# T27 exceptions: files that stay hand-written Rust

**Status: proposed, pending owner decision D11.** Nothing in this list is
approved yet. Until it is, every file below is still counted as "not ported".

Plan: every file of `crates/trios-chat` is either written once in `.t27` and
swapped for `t27c gen-rust` output (see `T27_PIN`), or listed here with a
reason. Law L0 PURPOSE (`docs/T27-CONSTITUTION.md` in gHashTag/t27) names the
seed (t27c) and the interface as the exceptions; the rows below argue why each
file is interface, glue or an acceptance gate rather than logic.

Line counts: `git show 8b229e9489ee:crates/trios-chat/<file> | wc -l`.

| File (under `crates/trios-chat/`) | Category | Reason | What would lift it | Lines of Rust kept |
|---|---|---|---|---:|
| `rings/BR-IO-CHAT-05/src/entities/chat_envelope.rs` | io-plumbing | SeaORM `DeriveEntityModel` struct for the `chat_envelope` table; the derive macros are the interface to SeaORM, no decision logic. Stage-9 (I/O) dependency. | t27c support for emitting SeaORM entities, or a generated schema module the ring includes. | 46 |
| `rings/BR-IO-CHAT-05/src/entities/mod.rs` | glue | One `pub mod` line plus docs. | Nothing to port; it disappears if the entities move to generated code. | 6 |
| `rings/BR-IO-CHAT-05/src/lib.rs` | glue | Module declarations and re-exports of `Migrator`, `AsyncStore`, `PgChatStore`. | Nothing to port. | 31 |
| `rings/BR-IO-CHAT-05/src/migrations/m2026_05_09_000001_create_chat_envelope.rs` | migration | sea-orm-migration `MigrationTrait` (async DDL). Stage-9 (I/O) dependency; migrations are append-only history. | t27c support for async/DDL output; a new migration written in .t27 from then on. | 87 |
| `rings/BR-IO-CHAT-05/src/migrations/mod.rs` | io-plumbing | `MigratorTrait` impl listing the migrations (async-trait). | Same as the migration row. | 22 |
| `rings/CR-CHAT-06/src/lib.rs` | glue | 42 `pub mod` lines and their `pub use` re-exports; no functions, no tests. | Nothing to port. | 254 |
| `src/lib.rs` | glue | The shim: `pub use trios_chat_br_output::*;` plus docs. | Nothing to port. | 29 |
| `src/bin/e2e_chat_25.rs` | bin gate | The acceptance binary (25 PASS/FAIL checks over OsRng keys) that proves a swap kept behaviour; it must stay independent of the code it judges. | Never, while it is the swap gate. | 265 |
| **Total** | | | | **740** |

Not in this list yet (decided in later waves, see the trios epic): crypto call
sites inside the adapters (x25519-dalek, ed25519-dalek, chacha20poly1305,
ml-kem, hkdf/hmac, sha2, subtle, zeroize, rand_core) and the injection deny
table, if its flat-table probe fails.
