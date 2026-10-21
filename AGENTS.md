# AGENTS.md — trios (корневой контракт)

## ⛔ СТОП. ПРОЧТИ ДО ЛЮБОГО ДЕЙСТВИЯ.

Это **конституция репозитория**. Нарушение = провал задачи, откат PR, потеря доверия.
Перед написанием кода прочти этот файл целиком. Перед коммитом — ещё раз.

---

## Agent Protocol

All agents working in this workspace follow the AIP (Agent Interaction Protocol).

## Agent Codenames

| Codename | Domain |
|----------|--------|
| ALPHA | trios-ipc |
| BETA | trios-server |
| GAMMA | trios-ui |
| DELTA | trios-doctor |
| EPSILON | trios-ext |
| ZETA | trios-a2a |
| LEAD | orchestration |

## Invariant I-SCOPE: Agent Scope Isolation

**Агент работает ТОЛЬКО внутри своего крейта.**

- ❌ НИКОГДА не трогать файлы за пределами своего `crates/<X>/`
- ❌ НИКОГДА не удалять, переименовывать или перемещать кольца других крейтов
- ❌ НИКОГДА не менять корневой `Cargo.toml` без явного задания на это
- ✅ Если нужно добавить зависимость от другого крейта — только `path =` в своём `Cargo.toml`

**Исключение:** корневой `Cargo.toml` может быть изменён только по явному заданию (например, "добавить кольца в workspace members").

## Commit Convention

Every commit MUST include an `Agent: <CODENAME>` trailer.

```
feat(trios-doctor): implement DR-01..03

Agent: DELTA
```

---

## 🔒 ARCH-EXT INVARIANT (абсолютный запрет)

`crates/trios-ext/` содержит ТОЛЬКО кольца: EX-00, EX-01, EX-02, EX-03, BR-EXT.

При работе с UI разрешено трогать **ТОЛЬКО**:
- `crates/trios-ext/src/dom.rs` (≤ 15 строк, вызывает `trios_ui::mount_app_with_mcp`)
- `crates/trios-ext/Cargo.toml` (+1 строка: зависимость `trios-ui`)
- `crates/trios-ext/style.css` (только удаление)

**ЗАПРЕЩЕНО трогать (git diff должен быть пуст):**
- `crates/trios-ext/src/lib.rs`
- `crates/trios-ext/src/bg.rs`
- `crates/trios-ext/src/mcp.rs`
- `crates/trios-ext/src/bridge/**`
- `crates/trios-ext/extension/manifest.json`
- `crates/trios-ext/extension/background.js`
- `crates/trios-ext/extension/content.js`

См. issue #243 — пункт "🚫 Запрещено" и инвариант **ARCH-EXT**.
См. issue #238 — ring-архитектура 36 crates.

---

## 🔒 ARCH-UI INVARIANT

`crates/trios-ui/` **не импортирует ничего** из `trios-ext`.
Зависимость строго однонаправленная: `trios-ext → trios-ui`.

В `trios-ui` ЗАПРЕЩЕНО:
- `document.create_element` и любой raw `web-sys` DOM
- `set_inner_html` со строками
- handwritten JS (инвариант I15)
- wasm-pack (только `wasm-bindgen-cli`)

Разрешено: Dioxus RSX, Signal, use_context.

---

## 🔒 RING-АРХИТЕКТУРА (issue #238)

Каждый crate = `crates/<name>/rings/XX-NN/` со структурой:
- `src/lib.rs`
- `Cargo.toml`
- `README.md` — назначение, API, зависимости
- `TASK.md` — статус
- `AGENTS.md` — локальные запреты

Инвариант **I5**: отсутствие любого из трёх `.md` файлов = нарушение.

Нумерация колец:
- `XX-00` — identity / core types
- `XX-01..N` — последовательные слои (dependency order = ring number)
- `BR-OUTPUT` / `BR-APP` / `BR-BIN` / `BR-MODEL` — финальный артефакт

---

## 🚫 Глобальные запреты (для всех агентов)

1. ❌ Не создавать новые файлы в `trios-ext/src/` кроме `dom.rs`
2. ❌ Не переименовывать кольца (XX-00..XX-N — монотонно)
3. ❌ Не сливать кольца в один `src/lib.rs`
4. ❌ Не удалять `AGENTS.md`, `README.md`, `TASK.md` в кольцах
5. ❌ Не коммитить без прохождения `arch-guard` CI
6. ❌ Не использовать `cargo install wasm-pack` — только `wasm-bindgen-cli`
7. ❌ Не писать бизнес-логику на JS в WASM crates (I15)
8. ❌ Не эскейпить HTML в raw-строках `r##"..."##`

---

## ✅ Обязательная проверка ПЕРЕД коммитом

```bash
# 1. ARCH-EXT guard
FORBIDDEN=$(git diff --cached --name-only \
  | grep '^crates/trios-ext/' \
  | grep -vE '(src/dom\.rs|Cargo\.toml|style\.css)$')
if [ -n "$FORBIDDEN" ]; then
  echo "❌ ARCH-EXT VIOLATION: $FORBIDDEN"; exit 1
fi

# 2. Ring I5 guard
for ring in $(find crates -type d -path '*/rings/*' -mindepth 3 -maxdepth 3); do
  for f in README.md TASK.md AGENTS.md; do
    [ -f "$ring/$f" ] || { echo "❌ I5 VIOLATION: $ring/$f missing"; exit 1; }
  done
done

# 3. Build + lint
cargo build --all || exit 1
cargo clippy --all-targets -- -D warnings || exit 1
```

---

## 📎 Источники истины

- Ring-архитектура 36 crates: **issue #238**
- UI ring-план (UR-00..UR-08 + BR-APP): **issue #243**
- LAWS.md (I1–I20): **issue #235**
- Эталон: `crates/trios-a2a/` (8 SR-rings + BR-OUTPUT, 84 tests)

---

## 🧭 Агент, если ты дочитал до сюда

Перед тем как написать первую строку кода, ответь себе письменно в PR-описании:

1. Какие файлы я СОБИРАЮСЬ изменить?
2. Попадает ли хоть один в раздел "🚫 ЗАПРЕЩЕНО трогать"?
3. Если да — **ОСТАНОВИСЬ** и открой обсуждение в issue.

Если пропустил этот шаг — PR будет закрыт автоматически.

## Own language first

When this project publishes something about itself, it publishes in **this
project's own language and format** -- not translated into somebody else's.

Owner's rule, 2026-09-20: stop writing in other people's languages, we have our
own.

This bites on any file whose only reason to exist is that an outside tool
expects that shape: `llms.txt`, `agents.json`, `ai.txt`, `.well-known/*.json`,
A2A agent cards, `ai-plugin` manifests, OpenAPI stubs, JSON-LD blocks, a README
that restates a spec. The reflex is to write four of them in four foreign
formats, and the reflex is wrong: a project whose claim is "here is a language
worth writing" and which then describes itself in three of other people's
formats has published three documents that are not true of it.

**The move:** find the address the outside world already fetches, then serve our
own language at it. `/llms.txt` at t27.ai **is** a t27 module -- `llms.txt`
requires nothing but text, and every prose line of a `.t27` file is a `;`
comment, so it stays readable to anything that cannot compile it.

**Three qualifications, so the rule stays honest:**

- A format a resolver genuinely parses -- a sitemap, `package.json`, a lockfile
  -- is machinery, not a description. **Generate** it from our own source; never
  hand-write it into a second home for the truth.
- Code against someone else's API uses their types. Prose for a human who has
  never heard of the project uses that human's language.
- If a format demands a claim we cannot back, **publish nothing**. An A2A card
  with no A2A server behind it is a false claim, and a missing file is more
  honest than a lying one.

The test: *is this file the project speaking about itself?* If yes, it speaks
our language. If it is plumbing, it speaks the plumbing's.

**Worked example, compiler-checked rather than asserted:** in `gHashTag/trinity`,
`apps/website/public/t27/files/specs/catalog/onboarding.t27` generates
`/llms.txt` and `/agents.t27` byte-identically, gated in CI as
`check:onboarding`. The generator evaluates the spec's own `test` blocks --
`typecheck.ok` stays true for `assert 1 > 2`, so a compiler saying "this parses"
is not a compiler saying "this is true" -- and re-compiles the rendered document
before writing it.

**The full rule lives in exactly one place: the `own-language-first` skill**
(`~/.claude/skills/own-language-first/SKILL.md`). It carries the consent gate for
documents addressed to other people's agents, the six negative controls, and the
`;`-alone-on-a-line trap that silently discards a `module` declaration. This
section is a pointer, not a copy -- the recorded defect in this codebase family
is the hand-copied rule that only two of its three homes knew about.

## Actors, not threads (owner rule, 2026-10-08)

The Queen and the swarm move to the actor model.

- Everything that runs at the same time is an actor. That covers a round, a reviewer, a poller and a runner lane. Each one has a pid, a bounded mailbox and a supervisor.
- Queen or swarm work gets no new `setInterval` loop, thread pool or worker counter.
- An existing loop is replaced only after an MVP, its tests, and a benchmark against the current loop on the same input. The numbers are posted on gHashTag/t27#7851.

The Queen server lives in gHashTag/trios, on branches `queen` and `queen-runners`. The gHashTag/BrowserOS fork holds the browser extension and nothing else.

The full rule is in [gHashTag/t27 `AGENTS.md`, "Actors, not threads"](https://github.com/gHashTag/t27/blob/master/AGENTS.md#actors-not-threads-owner-rule-2026-10-08). This section points to it; it is not a copy.
