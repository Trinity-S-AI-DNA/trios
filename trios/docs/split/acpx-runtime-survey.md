# Split survey: `trios/agent-server/apps/server/src/lib/agents/acpx-runtime.ts`

Issue gHashTag/trios#1974. The file is 905 lines, and the repository's
pre-commit hook has warned about its length (threshold: 400) on every commit
that touched it, changing nothing. This document is the survey a split would
have to be argued from: what the file actually contains, which parts have no
dependency on the rest, and which single extraction would remove the most
lines for the least risk. It splits nothing. Whether and when to split stays
with a person.

## How it was produced

- Tool: `trios/tools/acpx-runtime-split-survey.mjs` - Node standard library
  only. It reads and reports; it writes nothing, invokes no TypeScript
  compiler, no `make`, no build.
- Commands: `node trios/tools/acpx-runtime-split-survey.mjs` (plain report)
  and `node trios/tools/acpx-runtime-split-survey.mjs --markdown` (the
  rendering embedded below), both run from the repository root.
- Tree: branch `zcode/survey-1974-acpx-runtime`, commit `f62869e2`, where
  HEAD is identical to `origin/queen` - the tree this survey measures the
  file's 905 lines on, the same count the issue counted on its tree (the
  issue's `feat/queen-supervisor` branch no longer exists on the remote at
  survey time; its `feat/queen-supervisor-merge` successor does not carry
  this file at this path). No tracked file differs from that commit; this
  survey's two files are the only additions.
- Every number below was measured during the run. Nothing is copied from
  the issue.

## Method

- Declarations are found by parsing the source text with a TypeScript-aware
  scanner: strings, template literals (including `${...}` interpolations),
  line and block comments, regex literals, and brace/paren/bracket depth
  are all tracked, so text inside strings or comments never miscounts a
  block. Statement ends are found structurally.
- A declaration's `lines` is its code plus the comment block attached
  immediately above it: contiguous comment lines, with a blank line
  breaking the attachment.
- A reference is an occurrence of another top-level declaration's name in
  the declaration's code, with comments and template-literal text
  stripped. Property accesses (`x.name`, `x?.name`) are not references.
- Call sites outside the file are files containing a module specifier that
  ends in `/acpx-runtime` - covering static and dynamic imports - that
  also use a moved exported name in code. This run found none: the file
  exports two names, and the moved set (the nineteen independently
  extractable declarations) contains neither of them, so no file outside
  `acpx-runtime.ts` needs an import change for the recommended move.
- Anything the parser could not classify is reported as `unparsed` with its
  line. This run found five constructs, seven lines: the
  `export type { OpenclawGatewayAccessor } from './openclaw/acp-command'`
  re-export at line 49 (a statement form the parser does not classify), and
  the four continuation lines of the two multi-line `Extract<...>` type
  aliases - their first lines (292 and 296) are classified as
  `AcpxUserContent` and `AcpxAgentMessage`, the continuation lines
  (293-295, 297-299) are not. They are counted in the accounting below,
  never dropped.

## Determinism

The tool prints no clock and no randomness and iterates every collection in
sorted order. Two consecutive runs, compared:

    $ node trios/tools/acpx-runtime-split-survey.mjs | shasum
    0a2639dce01320ce0864fb128c22f2c6120dabc5  -
    $ node trios/tools/acpx-runtime-split-survey.mjs | shasum
    0a2639dce01320ce0864fb128c22f2c6120dabc5  -

Identical bytes. The `--markdown` rendering compares the same way:
`c4636a66fc490522259b0b980ed5f5d9af16fa56` twice. Any future run against
an edited file changes the numbers only as the file changed.

## The survey

Target: `trios/agent-server/apps/server/src/lib/agents/acpx-runtime.ts` - 905 lines, measured this run.

Declarations found: **34** (2 exported, 32 not; unparsed: 5).

## What the file contains

Every top-level declaration, sorted by length descending. `lines` is code plus attached doc comments; `refs` names the other top-level declarations of this file it references - what would travel with it.

| lines | code | doc | kind | exported | name | span | refs in this file |
|---:|---:|---:|---|---|---|---|---|
| 211 | 211 | 0 | class | yes | `AcpxRuntime` | 79-289 | `AcpxRuntimeOptions`, `PreparedRuntimeContext`, `createAcpxEventStream`, `createBrowserosAgentRegistry`, `createBrowserosMcpServers`, `extractLastUserMessage`, `mapAcpxSessionRecordToHistory`, `parseRecordTimestamp` |
| 91 | 91 | 0 | function | no | `createAcpxEventStream` | 569-659 | `applyRuntimeControls`, `mapRuntimeEvent`, `mapTurnResult` |
| 56 | 56 | 0 | function | no | `applyRuntimeControls` | 740-795 | `applyPermissionBypass` |
| 49 | 49 | 0 | function | no | `createBrowserosAgentRegistry` | 675-723 | `resolveBrowserosHostAcpAdapterCommand` |
| 48 | 48 | 0 | function | no | `mapAcpxSessionRecordToHistory` | 304-351 | `mapAgentMessageToHistoryEntry`, `parseRecordTimestamp`, `userContentToText` |
| 48 | 48 | 0 | function | no | `applyPermissionBypass` | 797-844 | (none) |
| 43 | 43 | 0 | function | no | `mapAgentMessageToHistoryEntry` | 353-395 | `AcpxAgentMessage`, `mapToolUseToHistoryToolCall` |
| 41 | 41 | 0 | function | no | `mapRuntimeEvent` | 846-886 | (none) |
| 40 | 20 | 20 | function | yes | `unwrapBrowserosAcpUserMessage` | 428-467 | `decodeBasicEntities`, `stripBrowserContextHeader`, `stripOuterRoleEnvelope`, `stripOuterRuntimeEnvelope`, `stripSelectedTextBlock`, `unwrapUserQuery` |
| 23 | 23 | 0 | function | no | `mapToolUseToHistoryToolCall` | 397-419 | `AcpxToolResult`, `AcpxToolUse`, `stringifyToolError`, `toolResultValue` |
| 19 | 14 | 5 | function | no | `extractLastUserMessage` | 544-562 | `userContentToText` |
| 18 | 18 | 0 | function | no | `mapTurnResult` | 888-905 | (none) |
| 14 | 7 | 7 | function | no | `resolveBrowserosHostAcpAdapterCommand` | 725-738 | `CLAUDE_ACP_ADAPTER_COMMAND`, `CODEX_ACP_ADAPTER_COMMAND` |
| 13 | 13 | 0 | function | no | `createBrowserosMcpServers` | 661-673 | (none) |
| 12 | 12 | 0 | type | no | `AcpxRuntimeOptions` | 55-66 | (none) |
| 12 | 12 | 0 | function | no | `stripOuterRoleEnvelope` | 469-480 | (none) |
| 11 | 11 | 0 | function | no | `decodeBasicEntities` | 515-525 | (none) |
| 10 | 10 | 0 | interface | no | `PreparedRuntimeContext` | 68-77 | (none) |
| 9 | 9 | 0 | function | no | `stringifyToolError` | 534-542 | (none) |
| 8 | 8 | 0 | function | no | `stripBrowserContextHeader` | 489-496 | (none) |
| 8 | 8 | 0 | function | no | `stripSelectedTextBlock` | 498-505 | (none) |
| 7 | 7 | 0 | function | no | `unwrapUserQuery` | 507-513 | (none) |
| 6 | 6 | 0 | function | no | `userContentToText` | 421-426 | `AcpxUserContent`, `unwrapBrowserosAcpUserMessage` |
| 6 | 6 | 0 | function | no | `stripOuterRuntimeEnvelope` | 482-487 | (none) |
| 6 | 6 | 0 | function | no | `toolResultValue` | 527-532 | `AcpxToolResult` |
| 4 | 4 | 0 | function | no | `parseRecordTimestamp` | 564-567 | (none) |
| 2 | 2 | 0 | const | no | `CLAUDE_ACP_ADAPTER_COMMAND` | 51-52 | (none) |
| 1 | 1 | 0 | const | no | `CODEX_ACP_ADAPTER_COMMAND` | 53-53 | (none) |
| 1 | 1 | 0 | type | no | `AcpxSessionMessage` | 291-291 | (none) |
| 1 | 1 | 0 | type | no | `AcpxUserContent` | 292-292 | (none) |
| 1 | 1 | 0 | type | no | `AcpxAgentMessage` | 296-296 | (none) |
| 1 | 1 | 0 | type | no | `AcpxAgentContent` | 300-300 | `AcpxAgentMessage` |
| 1 | 1 | 0 | type | no | `AcpxToolUse` | 301-301 | `AcpxAgentContent` |
| 1 | 1 | 0 | type | no | `AcpxToolResult` | 302-302 | `AcpxAgentMessage` |

## Independently extractable

**19** declarations reference nothing else in this file and account for **213** of 822 declaration lines (25.9%):

- `AcpxAgentMessage` (type, 1 lines, 296-296)
- `AcpxRuntimeOptions` (type, 12 lines, 55-66)
- `AcpxSessionMessage` (type, 1 lines, 291-291)
- `AcpxUserContent` (type, 1 lines, 292-292)
- `CLAUDE_ACP_ADAPTER_COMMAND` (const, 2 lines, 51-52)
- `CODEX_ACP_ADAPTER_COMMAND` (const, 1 lines, 53-53)
- `PreparedRuntimeContext` (interface, 10 lines, 68-77)
- `applyPermissionBypass` (function, 48 lines, 797-844)
- `createBrowserosMcpServers` (function, 13 lines, 661-673)
- `decodeBasicEntities` (function, 11 lines, 515-525)
- `mapRuntimeEvent` (function, 41 lines, 846-886)
- `mapTurnResult` (function, 18 lines, 888-905)
- `parseRecordTimestamp` (function, 4 lines, 564-567)
- `stringifyToolError` (function, 9 lines, 534-542)
- `stripBrowserContextHeader` (function, 8 lines, 489-496)
- `stripOuterRoleEnvelope` (function, 12 lines, 469-480)
- `stripOuterRuntimeEnvelope` (function, 6 lines, 482-487)
- `stripSelectedTextBlock` (function, 8 lines, 498-505)
- `unwrapUserQuery` (function, 7 lines, 507-513)

## Unparsed

- lines 49
- lines 293-294
- lines 295
- lines 297-298
- lines 299

## Closed groups (data, not recommendations)

A closed group is a declaration plus everything it references, transitively - the smallest set that could move to one new module together. Groups covering the whole file are marked: they are not extractions, they are the file.

| lines | members | whole file | group ([anchors] -> members) |
|---:|---:|---|---|
| 821 | 33 | no | [AcpxRuntime] `AcpxRuntime`, `createAcpxEventStream`, `applyRuntimeControls`, `createBrowserosAgentRegistry`, `mapAcpxSessionRecordToHistory`, `applyPermissionBypass`, `mapAgentMessageToHistoryEntry`, `mapRuntimeEvent`, `unwrapBrowserosAcpUserMessage`, `mapToolUseToHistoryToolCall`, `extractLastUserMessage`, `mapTurnResult`, `resolveBrowserosHostAcpAdapterCommand`, `createBrowserosMcpServers`, `AcpxRuntimeOptions`, `stripOuterRoleEnvelope`, `decodeBasicEntities`, `PreparedRuntimeContext`, `stringifyToolError`, `stripBrowserContextHeader`, `stripSelectedTextBlock`, `unwrapUserQuery`, `userContentToText`, `stripOuterRuntimeEnvelope`, `toolResultValue`, `parseRecordTimestamp`, `CLAUDE_ACP_ADAPTER_COMMAND`, `CODEX_ACP_ADAPTER_COMMAND`, `AcpxUserContent`, `AcpxAgentMessage`, `AcpxAgentContent`, `AcpxToolUse`, `AcpxToolResult` |
| 254 | 5 | no | [createAcpxEventStream] `createAcpxEventStream`, `applyRuntimeControls`, `applyPermissionBypass`, `mapRuntimeEvent`, `mapTurnResult` |
| 236 | 19 | no | [mapAcpxSessionRecordToHistory] `mapAcpxSessionRecordToHistory`, `mapAgentMessageToHistoryEntry`, `unwrapBrowserosAcpUserMessage`, `mapToolUseToHistoryToolCall`, `stripOuterRoleEnvelope`, `decodeBasicEntities`, `stringifyToolError`, `stripBrowserContextHeader`, `stripSelectedTextBlock`, `unwrapUserQuery`, `userContentToText`, `stripOuterRuntimeEnvelope`, `toolResultValue`, `parseRecordTimestamp`, `AcpxUserContent`, `AcpxAgentMessage`, `AcpxAgentContent`, `AcpxToolUse`, `AcpxToolResult` |
| 118 | 10 | no | [extractLastUserMessage] `unwrapBrowserosAcpUserMessage`, `extractLastUserMessage`, `stripOuterRoleEnvelope`, `decodeBasicEntities`, `stripBrowserContextHeader`, `stripSelectedTextBlock`, `unwrapUserQuery`, `userContentToText`, `stripOuterRuntimeEnvelope`, `AcpxUserContent` |
| 104 | 2 | no | [applyRuntimeControls] `applyRuntimeControls`, `applyPermissionBypass` |
| 99 | 9 | no | [userContentToText] `unwrapBrowserosAcpUserMessage`, `stripOuterRoleEnvelope`, `decodeBasicEntities`, `stripBrowserContextHeader`, `stripSelectedTextBlock`, `unwrapUserQuery`, `userContentToText`, `stripOuterRuntimeEnvelope`, `AcpxUserContent` |
| 92 | 7 | no | [unwrapBrowserosAcpUserMessage] `unwrapBrowserosAcpUserMessage`, `stripOuterRoleEnvelope`, `decodeBasicEntities`, `stripBrowserContextHeader`, `stripSelectedTextBlock`, `unwrapUserQuery`, `stripOuterRuntimeEnvelope` |
| 85 | 8 | no | [mapAgentMessageToHistoryEntry] `mapAgentMessageToHistoryEntry`, `mapToolUseToHistoryToolCall`, `stringifyToolError`, `toolResultValue`, `AcpxAgentMessage`, `AcpxAgentContent`, `AcpxToolUse`, `AcpxToolResult` |
| 66 | 4 | no | [createBrowserosAgentRegistry] `createBrowserosAgentRegistry`, `resolveBrowserosHostAcpAdapterCommand`, `CLAUDE_ACP_ADAPTER_COMMAND`, `CODEX_ACP_ADAPTER_COMMAND` |
| 48 | 1 | no | [applyPermissionBypass] `applyPermissionBypass` |
| 42 | 7 | no | [mapToolUseToHistoryToolCall] `mapToolUseToHistoryToolCall`, `stringifyToolError`, `toolResultValue`, `AcpxAgentMessage`, `AcpxAgentContent`, `AcpxToolUse`, `AcpxToolResult` |
| 41 | 1 | no | [mapRuntimeEvent] `mapRuntimeEvent` |
| 18 | 1 | no | [mapTurnResult] `mapTurnResult` |
| 17 | 3 | no | [resolveBrowserosHostAcpAdapterCommand] `resolveBrowserosHostAcpAdapterCommand`, `CLAUDE_ACP_ADAPTER_COMMAND`, `CODEX_ACP_ADAPTER_COMMAND` |
| 13 | 1 | no | [createBrowserosMcpServers] `createBrowserosMcpServers` |
| 12 | 1 | no | [AcpxRuntimeOptions] `AcpxRuntimeOptions` |
| 12 | 1 | no | [stripOuterRoleEnvelope] `stripOuterRoleEnvelope` |
| 11 | 1 | no | [decodeBasicEntities] `decodeBasicEntities` |
| 10 | 1 | no | [PreparedRuntimeContext] `PreparedRuntimeContext` |
| 9 | 1 | no | [stringifyToolError] `stringifyToolError` |
| 8 | 1 | no | [stripBrowserContextHeader] `stripBrowserContextHeader` |
| 8 | 1 | no | [stripSelectedTextBlock] `stripSelectedTextBlock` |
| 8 | 3 | no | [toolResultValue] `toolResultValue`, `AcpxAgentMessage`, `AcpxToolResult` |
| 7 | 1 | no | [unwrapUserQuery] `unwrapUserQuery` |
| 6 | 1 | no | [stripOuterRuntimeEnvelope] `stripOuterRuntimeEnvelope` |
| 4 | 1 | no | [parseRecordTimestamp] `parseRecordTimestamp` |
| 3 | 3 | no | [AcpxToolUse] `AcpxAgentMessage`, `AcpxAgentContent`, `AcpxToolUse` |
| 2 | 2 | no | [AcpxAgentContent] `AcpxAgentMessage`, `AcpxAgentContent` |
| 2 | 2 | no | [AcpxToolResult] `AcpxAgentMessage`, `AcpxToolResult` |
| 2 | 1 | no | [CLAUDE_ACP_ADAPTER_COMMAND] `CLAUDE_ACP_ADAPTER_COMMAND` |
| 1 | 1 | no | [AcpxAgentMessage] `AcpxAgentMessage` |
| 1 | 1 | no | [AcpxSessionMessage] `AcpxSessionMessage` |
| 1 | 1 | no | [AcpxUserContent] `AcpxUserContent` |
| 1 | 1 | no | [CODEX_ACP_ADAPTER_COMMAND] `CODEX_ACP_ADAPTER_COMMAND` |

## The one recommended extraction

**The largest independently extractable group**: every declaration that references nothing else in this file, moved together into one new module. It removes **213 lines** (23.5% of the file's 905; 213 of them code) and severs no internal dependency.

Declarations that move (19):

- `applyPermissionBypass` (function, 48 lines, 797-844)
- `mapRuntimeEvent` (function, 41 lines, 846-886)
- `mapTurnResult` (function, 18 lines, 888-905)
- `createBrowserosMcpServers` (function, 13 lines, 661-673)
- `AcpxRuntimeOptions` (type, 12 lines, 55-66)
- `stripOuterRoleEnvelope` (function, 12 lines, 469-480)
- `decodeBasicEntities` (function, 11 lines, 515-525)
- `PreparedRuntimeContext` (interface, 10 lines, 68-77)
- `stringifyToolError` (function, 9 lines, 534-542)
- `stripBrowserContextHeader` (function, 8 lines, 489-496)
- `stripSelectedTextBlock` (function, 8 lines, 498-505)
- `unwrapUserQuery` (function, 7 lines, 507-513)
- `stripOuterRuntimeEnvelope` (function, 6 lines, 482-487)
- `parseRecordTimestamp` (function, 4 lines, 564-567)
- `CLAUDE_ACP_ADAPTER_COMMAND` (const, 2 lines, 51-52)
- `CODEX_ACP_ADAPTER_COMMAND` (const, 1 lines, 53-53)
- `AcpxSessionMessage` (type, 1 lines, 291-291)
- `AcpxUserContent` (type, 1 lines, 292-292)
- `AcpxAgentMessage` (type, 1 lines, 296-296)

References inside `acpx-runtime.ts` that become imports of the new module:

- `AcpxAgentMessage` <- `AcpxAgentContent`, `AcpxToolResult`, `mapAgentMessageToHistoryEntry`
- `AcpxRuntimeOptions` <- `AcpxRuntime`
- `AcpxUserContent` <- `userContentToText`
- `CLAUDE_ACP_ADAPTER_COMMAND` <- `resolveBrowserosHostAcpAdapterCommand`
- `CODEX_ACP_ADAPTER_COMMAND` <- `resolveBrowserosHostAcpAdapterCommand`
- `PreparedRuntimeContext` <- `AcpxRuntime`
- `applyPermissionBypass` <- `applyRuntimeControls`
- `createBrowserosMcpServers` <- `AcpxRuntime`
- `decodeBasicEntities` <- `unwrapBrowserosAcpUserMessage`
- `mapRuntimeEvent` <- `createAcpxEventStream`
- `mapTurnResult` <- `createAcpxEventStream`
- `parseRecordTimestamp` <- `AcpxRuntime`, `mapAcpxSessionRecordToHistory`
- `stringifyToolError` <- `mapToolUseToHistoryToolCall`
- `stripBrowserContextHeader` <- `unwrapBrowserosAcpUserMessage`
- `stripOuterRoleEnvelope` <- `unwrapBrowserosAcpUserMessage`
- `stripOuterRuntimeEnvelope` <- `unwrapBrowserosAcpUserMessage`
- `stripSelectedTextBlock` <- `unwrapBrowserosAcpUserMessage`
- `unwrapUserQuery` <- `unwrapBrowserosAcpUserMessage`

Call sites outside this file that would need an import change:

- none - no file outside `acpx-runtime.ts` imports any moved exported name

## Line accounting

| bucket | lines |
|---|---:|
| declaration code | 790 |
| attached doc comments | 32 |
| import statements | 41 |
| blank | 30 |
| standalone comments | 5 |
| export lists | 0 |
| unparsed | 7 |
| **total** | **905** |
| file lines (measured) | 905 |

Declaration lines plus unparsed = 822 + 7 = 829 of 905; the remaining 76 are imports (41), blanks (30), standalone comments (5) and export lists (0). The accounting agrees with the file's own line count.

