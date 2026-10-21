# Provider Endpoint Policy Specification

Issue: https://github.com/gHashTag/trios/issues/2051
Task: PROVIDER-ENDPOINT-001
Owner: Chat Runtime
Extends: `model-control-center.md`, `context-length-routing.md`

## Purpose

Let TriOS use NVIDIA API Catalog keys and Standard Z.ai API keys for app
features, never send a request to a Z.ai Coding Plan endpoint, keep every
existing Z.ai configuration and key unchanged (including legacy setups that
already target the general API), and never report a key or model healthy
without an authenticated response whose body was read.

## Sources (read 2026-10-21)

- NVIDIA hosted endpoint `https://integrate.api.nvidia.com/v1`,
  `POST /chat/completions`, `Authorization: Bearer nvapi-...`
  (https://docs.api.nvidia.com/nim/reference/llm-apis). `GET /v1/models` is
  public: HTTP 200 without a key, 83 ids on 2026-10-21, including embedding,
  safety, reward and parsing models that do not serve chat.
- Z.ai general API `https://api.z.ai/api/paas/v4`
  (https://docs.z.ai/api-reference/introduction). Coding Plan endpoint
  `https://api.z.ai/api/coding/paas/v4` is limited to the officially supported
  tools listed at https://docs.z.ai/devpack/tool/others; TriOS is not listed.
- Since 2026-10-16 Standard and Coding Plan keys are managed separately; a
  pre-existing Compatible key is billed by endpoint
  (https://docs.z.ai/devpack/notice/api-key-management).
- Z.ai business codes: https://docs.z.ai/api-reference/api-code.
- Agent server wire providers: `packages/shared/src/schemas/llm.ts` admits
  `openai-compatible` and `zai`, not `nvidia`; `provider-factory.ts` throws on an
  unknown provider and wraps `openai-compatible` in an overload-retrying fetch.

## Providers

| Case | Raw value (Keychain scope) | Display | Default base URL | Wire provider |
|---|---|---|---|---|
| `nvidia` | `nvidia` | NVIDIA | `https://integrate.api.nvidia.com/v1` | `openai-compatible` |
| `zaiStandard` | `zai-standard` | Z.AI API | `https://api.z.ai/api/paas/v4` | `zai` |
| `zai` | `zai` (legacy bucket) | Z.AI (legacy keys) | `https://api.z.ai/api/coding/paas/v4` (unchanged legacy default) | `zai` |

The legacy `zai` bucket is not evidence of a key type: it may hold Standard,
Compatible or Coding Plan keys. Only the route (base URL) decides.

Every other provider keeps its raw value, base URL and wire provider.

## Behavior

### Endpoint classification

- A base URL is a Z.ai Coding Plan endpoint when its host is `api.z.ai` or
  `open.bigmodel.cn` and its path contains `/coding/` (trailing slashes and case
  ignored).
- A base URL is a Z.ai general endpoint when the host matches and the path is
  `/api/paas/v4`.

### Usage block

- TriOS refuses a (provider, base URL) pair when, and only when, the base URL
  is a Z.ai Coding Plan endpoint, for every provider. The refusal carries one
  fixed, secret-free reason that names the Z.ai supported-tools rule and tells
  the user to add a Standard API key under "Z.AI API".
- A legacy `zai` configuration whose stored base URL is the general API keeps
  working exactly as before. A legacy `zai` configuration without a stored base
  URL keeps the legacy default (the Coding Plan host) and is therefore refused;
  it is never rewritten to the general host, where a Compatible key would be
  billed to the account balance.
- A refused pair is never sent: chat requests fail before any network call,
  and the pair is excluded from cross-provider failover, warmup, predictive
  selection, background probes, model probes and key tests.
- Keys and stored base URLs stay unchanged. TriOS never moves, deletes or
  copies a key between buckets and never changes a stored base URL on its own.
  Only an explicit user edit changes a route.

### Credential scope

- Keychain account `p` is the legacy entry of provider `p`; `p#id` (or the dev
  store spelling `p_id`) is entry `id` of provider `p`.
- An account belonging to one provider is never parsed as an entry of another,
  in particular `zai-standard*` is not a `zai` entry and `zai*` is not a
  `zai-standard` entry.
- Environment fallbacks: `TRIOS_NVIDIA_API_KEY`, `TRIOS_ZAI_STANDARD_API_KEY`;
  `TRIOS_ZAI_API_KEY` keeps addressing the legacy scope only.

### Model catalog

- NVIDIA: `GET <base>/models` lists ids; ids naming a non-chat family
  (`embed`, `rerank`, `retriever`, `safety`, `guard`, `reward`, `parse`, `clip`,
  `detector`, `deplot`) are dropped. A catalog response never validates a key.
- Z.ai Standard: no public catalog; the suggested list is used.

### Key test and health probe

- NVIDIA key test sends one authenticated `POST <base>/chat/completions` with
  `max_tokens: 1` to the selected (or default) model.
- A completion probe is healthy only when the status is 2xx AND the body is a
  JSON object with a non-empty `choices` array and no `error` object.
- Outcomes and their failure kinds:
  - 2xx with `error` object, or 4xx/5xx with an error envelope: classified by
    status and provider code (below), never healthy.
  - 2xx with empty, non-JSON or `choices`-less body: unknown ("unexpected
    response"), never healthy.
  - Non-JSON body on an error status (for example an HTML 502): gateway or
    provider error by status, never healthy.
- Provider bodies and keys never appear in a result message; a message names
  only the status, the provider code and a fixed description.

### Z.ai error codes

| Codes | Meaning | Retry |
|---|---|---|
| 1000, 1001, 1002, 1003, 1005 | authentication | terminal |
| 1113 | balance or resource package exhausted | terminal |
| 1302 | rate limit | retryable |
| 1305 | provider overloaded | retryable |
| 1308, 1310, 1316-1321 | plan usage limit reached | terminal until reset |
| 1309, 1314 | plan or package expired | terminal |
| 1311 | plan does not include the model | terminal |
| 1313 | fair-use restriction | terminal |
| 1315 | key belongs to another product type | terminal |

## Tests

1. Every provider has a non-empty display name, default model, suggested
   models and a valid default base URL.
2. `nvidia` and `zaiStandard` require keys; raw values are `nvidia` and
   `zai-standard`; `zai` keeps `zai`.
3. Wire providers: `nvidia` -> `openai-compatible`, `zaiStandard` and `zai` ->
   `zai`, every other provider -> its raw value; `apply(to:)` writes the wire
   provider and preserves base URL, model and key.
4. Endpoint classification accepts the coding host with and without trailing
   slash or upper case, and does not classify the general host or another
   host as coding.
5. Usage block: any provider with a coding host is refused (legacy `zai`
   default, `zaiStandard`, `openai`); legacy `zai` with its pre-existing
   general-API base URL is allowed (regression test); `zaiStandard` with the
   general host, `nvidia` and `openai` are allowed; the reason contains no key
   material.
6. Keychain scope: `zai-standard#a` and `zai-standard_a` are not `zai` entries;
   `zai#a` and `zai_a` are not `zai-standard` entries; own entries round-trip.
7. Completion classifier negatives: empty 200, non-JSON 200, `{}` 200,
   `{"choices":[]}` 200, error object inside 200, HTML 502, error envelope 429
   are never healthy; a 200 with one choice is healthy.
8. Z.ai codes map as in the table, including 1316 and 1321.
9. NVIDIA catalog filter drops embedding, safety, guard, reward, parse, clip and
   detector ids and keeps chat ids, sorted and de-duplicated.
10. `ChatRequestBuilder` throws a provider-blocked error for a refused pair and
    builds a body whose `provider` is `openai-compatible` for NVIDIA.

## Not covered here

- Live requests with the owner's keys (needs the owner to store a key in the
  TriOS Keychain scope; tracked in the PR).
- Queen agent-server key pools and billing mode.
