# RINGS source rules — extracted, not invented

Extraction date: 2026-11-16. Sources read (local checkouts):
- `/Users/playra/t27/rings/` (ring crates + COMPILE_STATUS.md)
- `/Users/playra/t27/.trinity/seals/src_port::trios::crates::trios-chat::rings::CR-CHAT-04::*`
- `/Users/playra/trios/.trios/agents/guard/SOUL.md`
- `/Users/playra/trios/.trios/skills/wave-research-loop/skill.md`
- `trios CLAUDE.md` (GitHub remote: Trinity-S-AI-DNA/trios, blob main)

| Правило RING | Источник в trios/t27 | Формулировка | Перенос в .t27 | Статус |
|---|---|---|---|---|
| R1 Ring = нумерованный crate, реализующий .t27-спеку | `t27/rings/ring-088-rust/README.md` ("implementation of specs/numeric/gf16.t27") | Ring реализует ровно одну спеку; имя `ring-NNN-rust` | `ring_registry.t27`: записи ring → spec | confirmed |
| R2 Status ladder scaffold→check→test | `t27/rings/COMPILE_STATUS.md` (Legend) | Только 3 статуса; «claimed-only» = источника нет | `ring_lifecycle.t27` consts | confirmed |
| R3 Identity witness φ²+1/φ²=3 обязателен | `ring-088-rust/README.md` ("Required of every t27 ring crate") | Каждый ring-крейт содержит witness | `ring_contract.t27`: ANCHOR + WITNESS_REQUIRED | confirmed |
| R4 Honest scope: запрет непроверяемых претензий | `ring-088-rust/README.md` ("Honest scope", R5-HONEST) | README ring декларирует только реальное | `ring_guard.t27` (документальное правило) | confirmed |
| R5 Crate hygiene ring-088: no_std, forbid unsafe, no deps | `ring-088-rust/README.md` | Правила ЭТОГО крейта, не универсальный закон | NOT переносится в контракт (ring-local) | confirmed (ring-local) |
| R6 Wave gates + CI matrix rings-rust | `t27/rings/COMPILE_STATUS.md` (Wave 13 gate) | Компиляция в CI, run summary = измеренное | `ring_lifecycle.t27` комментарий | confirmed |
| R7 Seal = хеш-манифест: spec_hash, gen_hash_{c,rust,verilog,zig}, ring номер, seal_schema, config gen/tests | `t27/.trinity/seals/…CR-CHAT-04…json` | Seal фиксирует спеку и все ген-таргеты | `ring_evidence.t27` consts | confirmed |
| R8 Ring-модуль = `port::…::rings::CR-CHAT-NN`, поле `"ring": N` | тот же seal | Ring имеет номер в иерархии порта | `ring_registry.t27` | confirmed |
| R9 Commit format `ring-NNN-type: desc (Closes #N)` | `trios/.trios/agents/guard/SOUL.md#L68` | Формат коммитов ring-работы | `ring_guard.t27` consts | confirmed |
| R10 PHI LOOP: spec→seal→gen→test→verdict→experience→commit→push | trios CLAUDE.md (GitHub, remote) | Цикл изменения спеки | `ring_contract.t27` (этапы) | confirmed (remote source) |
| R11 Тесты до merge; новый код = новые тесты; PR закрывает issue | trios CLAUDE.md (GitHub, remote) | Приёмка | `ring_guard.t27` | confirmed (remote source) |
| Ring registry (центральный реестр рингов как модуль) | NOT_FOUND_IN_SOURCE | — | registry = только data-консты подтверждённых рингов | needs-owner-decision |
| Ring lifecycle стадии за пределами ladder | NOT_FOUND_IN_SOURCE | — | не переносится | needs-owner-decision |
| Ring guard как runtime-механизм | NOT_FOUND_IN_SOURCE | — | не переносится | needs-owner-decision |
| Ring chat: аватары, партнёры, платежи, персонализация | NOT_FOUND_IN_SOURCE | — | не входит в контракт | needs-owner-decision |
