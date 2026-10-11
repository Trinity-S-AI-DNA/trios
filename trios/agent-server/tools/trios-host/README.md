# trios-host

`trios-host` lends a computer to the Queen. It runs shards of the t27 corpus
and earns TRI credit, off-chain, for every result another host agrees with.
A shard is one half of the t27b lab's row for one spec at a pinned commit:
the reference (`t27c test-report`) or t27b (`t27b corpus`, arm64 hosts
only). Self-hosting: gHashTag/trios#1756, slices 1 (#1757) and 1b (#1761,
lane A #1762).

Every decision it makes, and that the Queen makes about it, is a card built
from gHashTag/t27 `specs/hosting/*.t27` (`host`, `placement`, `proof`,
`credit`, `row`). The toolchain pins and the sandbox's profile are data in
`toolchain.t27`.

## One command

There is no installer script. On a Mac with Apple silicon, from any empty directory:

```
curl -fLo trios-host https://github.com/gHashTag/trios/releases/download/trios-host-v0.1.0/trios-host-darwin-arm64 && echo "b1f072f4589eef53a3235c7be5fa6a4b3aa26832794d7762809acb2c83224164  trios-host" | shasum -a 256 -c - && chmod +x trios-host && ./trios-host join --queen <queen URL>
```

On Linux, use `trios-host-linux-x64` (digest `d415acec061626600a8fbf88fd9de4a3b0088e47f2220c27b1dd6635d2b8b8fc`) or `trios-host-linux-arm64` (`9f4300cfd8e7fe37ea50ccc33d04e26788336278885530e25f9a71c2a2c067a1`), with `sha256sum -c -`. The linux t27c and t27b need glibc 2.34 or newer. The digests are `TRIOS_HOST_SHA256` in gHashTag/t27 `specs/hosting/toolchain.t27`, the release `trios-host-v0.1.0` of this repository.

`join` does the following, with no path given by hand:
- it makes `~/.trios-host/` (mode 0700) and the host key `~/.trios-host/key` (mode 0600). Only the public key and signatures ever leave the machine;
- it downloads zig 0.16.0 from ziglang.org, and t27c and (on arm64) t27b from the release, into `~/.trios-host/tools/`. It keeps each file only when its SHA-256 and size are the pinned ones; a file that is not is refused by name and nothing is kept. A kept tool is checked again on every start;
- it measures the sandbox with a planted job (below), registers with the level it measured, beats every 5 s, and runs one shard at a time.

`--t27c`, `--t27b` and `--zig` name binaries of your own instead. Their digests go into every receipt as `model_hash`.

## Commands

| command | what it does |
|---|---|
| `trios-host key` | make or read the key; print the host id (16 hex) and the public key |
| `trios-host join --queen <url> [--tier public\|trusted\|owner] [--slots <n>] [--t27c <path>] [--zig <path>] [--t27-repo <dir>] [--once]` | run as a host. `--tier` is a claim: the Queen grants at most what the owner's allowlist names for this key, and public otherwise. `--t27-repo` reads a shard's files from a local t27 clone instead of raw.githubusercontent.com. `--once` runs one shard and exits |
| `trios-host probe [--zig <path>] [--no-sandbox]` | run the planted job in this machine's sandbox and print what it reached; `--no-sandbox` runs it bare (the negative control) |
| `trios-host job --queen <url> --t27-repo <dir> --commit <sha> --spec <path>[,<path>...] [--half reference\|t27b\|both] [--secret] [--personal]` | owner key only: ask the Queen to run each spec at one commit, both halves of its lab row unless `--half` names one; every file of its `use` closure is pinned by SHA-256 |
| `trios-host rows --queen <url> --commit <sha> [--lab <url>]` | the Queen's complete rows for the commit beside the t27b lab's rows of the same commit: every key that differs, and how many rows are equal |
| `trios-host status --queen <url>` | this host's row of the public ledger |
| `trios-host statement --queen <url> --epoch <n> [--queen-key <64 hex>]` | check that this host's credit for epoch `n` is inside that epoch's signed root: the Queen's signature, the leaf names this host, the path's shape, the root (`statement.t27`). Pin the Queen's ledger key with `--queen-key`. It exits 0 only when every leaf of this host checks. |

`TRIOS_HOST_HOME` moves `~/.trios-host`.

## What a shard can see

- **Files:** only the files the job pins. Each is checked against its
  SHA-256 before it is written to disk.
- **Environment:** built from nothing: `PATH` to zig and the system tools, a
  scratch `HOME` and `TMPDIR`, zig's caches, and `T27C_TEST_REPORT_EXIT_ZERO`.
  No variable of your shell reaches it.
- **The OS sandbox** (`host.t27` section 8). On macOS, `sandbox-exec` with a
  deny-default profile. On Linux, `bwrap`. Under either, a job can read the
  tools, its own directory and the system's libraries. It can write only its
  own directory and zig's cache, and it has no network. Without bwrap, Linux
  uses `unshare --user --map-root-user --net`, which takes the network away
  and confines no file.
- **The level is measured.** Before it registers, the agent builds a planted
  job with the job's own zig, inside the sandbox. The job tries to open a
  socket to a listener the agent holds, and to create a file in your home
  directory. The agent reports the sandbox's level only when both attempts
  failed. A public job needs "no network, no write outside the job dir", so a
  host without it gets no public job. `--no-sandbox` turns the sandbox off and
  reports isolation none.

The shared zig cache (`~/.trios-host/cache/zig`) is writable by every job. A
job could plant an artifact there. That can change only a later job's
result, which k-of-n agreement checks; it cannot reach your files.

## What a host earns

Credit is 1 mTRI per job that two hosts agree on, recorded in the Queen's
public ledger (`GET /hosting/ledger`). Each credit is named by its kind
(`statement.t27`): the first agreeing receipt of a job earns `executor_fee`,
and every later one `verifier_fee`. On a job with a known answer, every
receipt earns `verifier_fee`. The credit is off-chain:
- it is not a token;
- it is not transferable: nothing moves it from one key to another;
- it claims no value;
- settlement is shut. `statement.t27` opens it only after counsel. Any value
  flow also needs a device-bound identity that no host has, and TON
  (`tri-bridge.t27`) is the only chain of record.

A host whose receipt is tampered, or whose result dissents from an agreed
one, gets a strike. Three strikes, and it is placed nothing more.

With `TRIOS_HOSTING_SYBIL=on` the Queen also applies `sybil.t27`:
- **Anchored quorum:** a public job is believed only through an owner or
  trusted host, or a known answer.
- **Canaries:** one public lease in ten carries a known answer; a wrong
  answer is slashed and struck at once.
- **Probation:** a new key earns nothing for its first 10 agreeing jobs.
- **Cap:** a public key earns at most 24 mTRI per epoch, or 96 when the owner
  marks it attested.
- **Slash:** it takes the epoch's credit and moves it nowhere.

Each epoch (a day, from 2026-10-10T00:00Z) closes into one signed statement:
`GET /hosting/ledger/epochs`, and `GET /hosting/ledger/epochs/<n>/proof?key=<host id>`
for one key's leaves and their paths. `trios-host statement` checks your own leaf.

## For the owner

- **Server:** the Queen serves `/hosting/*` only with `TRIOS_HOSTING=on` (503
  otherwise). Off, the boot migration builds no hosting table. On, it
  migrates them idempotently at boot (`pg-migrate.ts`, under an advisory
  lock), and over slice 1's tables it keeps their rows.
- **Ledger key:** `TRIOS_HOSTING_LEDGER_KEY` (`statement.t27`
  `LEDGER_KEY_VARIABLE`) is the Queen's Ed25519 seed, 64 lowercase hex
  characters. Without it every epoch stays open and unsigned, and one log
  line says so; its value is never logged.
- **Sybil rules:** `TRIOS_HOSTING_SYBIL=on` turns them on.
  `TRIOS_HOSTING_ATTESTED=<host id>,...` lists the keys you attest (the
  higher cap).
- **The feed (slice 2a):** `TRIOS_HOSTING_FEED=on` lets the Queen feed t27
  master to the hosts itself (`specs/hosting/feed.t27`). It submits shards
  only for specs whose `use` closure changed, plus a 1-in-128 audit sample,
  carries every other row, and serves the receipt at
  `GET /hosting/corpus/<sha>`, with the comparison against the lab at
  `GET /hosting/corpus/<sha>/lab`. The hosts run the toolchain of
  `toolchain.t27` `T27_COMMIT`, so a commit with another t27c or t27b is
  `not_comparable` with the lab. `TRIOS_GITHUB_API_TOKEN`, a read-only token,
  is used when it is set; `TRIOS_HOSTING_FEED_LAB` names another lab.
- **Allowlist:** `TRIOS_HOSTING_ALLOWLIST=<host id>=owner,<host id>=trusted`
  names your own machines and the people you trust. Every other key is public,
  and a public host only ever receives shards that declare no secret and no
  personal data.
- **Build:**

  ```
  bun build --compile --target=bun-darwin-arm64 tools/trios-host/trios-host.ts --outfile trios-host-darwin-arm64
  bun build --compile --target=bun-linux-x64    tools/trios-host/trios-host.ts --outfile trios-host-linux-x64
  bun build --compile --target=bun-linux-arm64  tools/trios-host/trios-host.ts --outfile trios-host-linux-arm64
  ```

  `bun build --compile` output is not byte-reproducible: two builds give two
  digests. A release therefore pins the digest of the file it uploads.
- **Demo:** the demo runs as tests, all local:
  `cd apps/server && bun test tests/api/hosting.test.ts tests/api/hosting-row.test.ts`.
  With `T27C`, `T27B` and `ZIG` set, the last blocks run the real tools in the sandbox.
