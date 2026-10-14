/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Rebuild the worktree-keep card's artifacts from its .t27 source
 * (gHashTag/trios#2005): `bun run card:worktree-keep` from trios/agent-server.
 *
 *   t27c gen-rust specs/queen/worktree_keep.t27 -> t27-core/worktree_keep.gen.rs
 *   t27c gen-ts   specs/queen/worktree_keep.t27 -> apps/server/src/api/services/queen-worktree-keep-card.gen.ts
 *   rustc (wasm32-unknown-unknown, cdylib) of t27-core/worktree_keep_wasm.rs
 *                                              -> specs/queen/worktree_keep.wasm
 *
 * Every output is generator or compiler output and is written as it came; the
 * only hand-written inputs are the card and the thin export shim, which holds
 * no rule. T27C names the compiler (default: t27c on PATH). Nothing is
 * installed and nothing is fetched. A failed step stops the run and leaves the
 * earlier outputs in place; a failed step never writes a partial file.
 */

import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const t27c = process.env.T27C || 't27c'
const card = join(root, 'specs/queen/worktree_keep.t27')

function run(cmd: string[]): string {
  const done = Bun.spawnSync(cmd, { cwd: root })
  if (done.exitCode !== 0) {
    console.error(`${cmd.join(' ')} failed (${done.exitCode})`)
    console.error(done.stderr.toString())
    process.exit(1)
  }
  return done.stdout.toString()
}

function emit(path: string, text: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

emit(join(root, 't27-core/worktree_keep.gen.rs'), run([t27c, 'gen-rust', card]))
emit(
  join(root, 'apps/server/src/api/services/queen-worktree-keep-card.gen.ts'),
  run([t27c, 'gen-ts', card]),
)
run([
  'rustc',
  '--target',
  'wasm32-unknown-unknown',
  '--crate-type',
  'cdylib',
  '--edition',
  '2021',
  '-C',
  'panic=abort',
  '-O',
  join(root, 't27-core/worktree_keep_wasm.rs'),
  '-o',
  join(root, 'specs/queen/worktree_keep.wasm'),
])

for (const file of [
  'specs/queen/worktree_keep.t27',
  'specs/queen/worktree_keep.wasm',
]) {
  const sha = createHash('sha256')
    .update(readFileSync(join(root, file)))
    .digest('hex')
  console.log(`${sha}  ${file}`)
}
