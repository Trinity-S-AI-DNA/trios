/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * gHashTag/trios#2005: the container's startup must keep every bee worktree,
 * byte for byte. These tests run the ACTUAL text of docker-entrypoint.sh - the
 * slice between its BEGIN/END keep_bee_worktrees markers, and then the whole
 * script as a startup against a local origin - on scratch git fixtures, and
 * compare a manifest (path, type, owner, mode, size, sha256, link target)
 * taken before and after. Nothing here mirrors the script. The only fakes are
 * a `chown` that logs instead of changing owners (the test user is not root),
 * a `stat` that reports a wrong workspace owner, a `su` that runs the command
 * as the current user, and a local bare repository standing in for the origin.
 */

import { describe, it } from 'bun:test'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'

const ENTRYPOINT = resolve(import.meta.dir, '../../../../docker-entrypoint.sh')

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  assert.strictEqual(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`)
  return run.stdout
}

/** path, type, owner, mode, size, sha256 (or link target) of everything under root. */
function manifest(root: string): string[] {
  const lines: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      const st = lstatSync(full)
      const rel = full.slice(root.length)
      const mode = `${st.uid}:${st.gid} ${(st.mode & 0o7777).toString(8)}`
      if (st.isSymbolicLink()) {
        lines.push(`${rel} L ${mode} -> ${readlinkSync(full)}`)
      } else if (st.isDirectory()) {
        lines.push(`${rel} D ${mode}`)
        walk(full)
      } else {
        const sha = createHash('sha256')
          .update(readFileSync(full))
          .digest('hex')
        lines.push(`${rel} F ${mode} ${st.size} ${sha}`)
      }
    }
  }
  walk(root)
  return lines
}

function slice(): string {
  const text = readFileSync(ENTRYPOINT, 'utf8')
  const begin = text.indexOf('# BEGIN keep_bee_worktrees')
  const end = text.indexOf('# END keep_bee_worktrees')
  assert.ok(
    begin >= 0 && end > begin,
    'markers present in docker-entrypoint.sh',
  )
  return text.slice(begin, end)
}

/** A repo on branch dev with one commit; .worktrees/ ignored. */
function baseRepo(parent: string): string {
  const repo = join(parent, 'src')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'dev')
  git(repo, 'config', 'user.email', 't@example.test')
  git(repo, 'config', 'user.name', 't')
  writeFileSync(join(repo, '.gitignore'), 'ignored.log\n.worktrees/\n')
  writeFileSync(join(repo, 'same.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'base')
  return repo
}

/** A bee worktree holding every kind of user data. Returns its path. */
function dirtyWorktree(repo: string): string {
  const tree = join(repo, '.worktrees', 'queen-1')
  git(repo, 'worktree', 'add', '-q', '-b', 'queen-1', tree)
  writeFileSync(join(tree, 'local.txt'), 'local commit\n')
  git(tree, 'add', 'local.txt')
  git(tree, 'commit', '-q', '-m', 'local')
  // staged and unstaged change on the SAME path
  writeFileSync(join(tree, 'same.txt'), 'staged\n')
  git(tree, 'add', 'same.txt')
  writeFileSync(join(tree, 'same.txt'), 'staged\nunstaged\n')
  writeFileSync(join(tree, 'untracked.txt'), 'untracked\n')
  writeFileSync(join(tree, 'ignored.log'), 'ignored secret\n')
  writeFileSync(join(tree, 'blob.bin'), Buffer.from([0, 255, 1, 254, 0, 0, 7]))
  writeFileSync(join(tree, 'run.sh'), '#!/bin/sh\n')
  chmodSync(join(tree, 'run.sh'), 0o750)
  symlinkSync('same.txt', join(tree, 'link'))
  return tree
}

function runSlice(
  repo: string,
  extra = '',
): { status: number | null; out: string; env?: undefined } {
  const run = spawnSync('sh', ['-c', `${slice()}\n${extra}`, 'sh', repo], {
    encoding: 'utf8',
  })
  return { status: run.status, out: run.stdout + run.stderr }
}

/** An origin, a clone of it as the workspace checkout, and a dirty worktree. */
function startupFixture(parent: string) {
  const src = baseRepo(parent)
  const origin = join(parent, 'trios.git')
  spawnSync('git', ['clone', '-q', '--bare', src, origin])
  const workspace = join(parent, 'ws')
  mkdirSync(workspace)
  const repo = join(workspace, 'trios')
  const cloned = spawnSync('git', [
    'clone',
    '-q',
    '--branch',
    'dev',
    origin,
    repo,
  ])
  assert.strictEqual(cloned.status, 0)
  git(repo, 'config', 'user.email', 't@example.test')
  git(repo, 'config', 'user.name', 't')
  const tree = dirtyWorktree(repo)
  return { origin, workspace, repo, tree }
}

describe('docker-entrypoint keep_bee_worktrees', () => {
  it('leaves a dirty worktree and the whole repo byte-identical', () => {
    const parent = mkdtempSync(join(tmpdir(), 'entrypoint-wt-'))
    try {
      const repo = baseRepo(parent)
      const tree = dirtyWorktree(repo)
      const before = manifest(repo)
      const statusBefore = git(tree, 'status', '--porcelain=v2', '--ignored')
      const result = runSlice(repo, 'keep_bee_worktrees "$1"')
      assert.strictEqual(result.status, 0)
      assert.match(result.out, /keeping 1 bee worktree/)
      assert.deepStrictEqual(manifest(repo), before)
      assert.strictEqual(
        git(tree, 'status', '--porcelain=v2', '--ignored'),
        statusBefore,
      )
      assert.match(git(repo, 'worktree', 'list'), /queen-1/)
      assert.match(git(repo, 'log', '--format=%s', 'queen-1'), /local/)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('is a no-op without .worktrees and with an empty one', () => {
    const repo = mkdtempSync(join(tmpdir(), 'entrypoint-wt-'))
    try {
      assert.strictEqual(runSlice(repo, 'keep_bee_worktrees "$1"').status, 0)
      mkdirSync(join(repo, '.worktrees'))
      const result = runSlice(repo, 'keep_bee_worktrees "$1"')
      assert.strictEqual(result.status, 0)
      assert.doesNotMatch(result.out, /keeping/)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('never chowns kept worktrees or the git admin records of worktrees', () => {
    const parent = mkdtempSync(join(tmpdir(), 'entrypoint-wt-'))
    try {
      const repo = baseRepo(parent)
      dirtyWorktree(repo)
      const bin = join(parent, 'bin')
      const log = join(parent, 'chown.log')
      mkdirSync(bin)
      writeFileSync(
        join(bin, 'chown'),
        `#!/bin/sh\nshift\nfor p in "$@"; do echo "$p" >> '${log}'; done\n`,
      )
      chmodSync(join(bin, 'chown'), 0o755)
      const before = manifest(join(repo, '.worktrees'))
      const adminBefore = manifest(join(repo, '.git', 'worktrees'))
      // an owner no file has (a numeric uid): every file reads as foreign
      const foreign = String((process.getuid?.() ?? 1000) + 1)
      const run = spawnSync(
        'sh',
        [
          '-c',
          `PATH="${bin}:$PATH"\n${slice()}\nrepair_checkout_ownership "$1" ${foreign}`,
          'sh',
          repo,
        ],
        { encoding: 'utf8' },
      )
      assert.strictEqual(run.status, 0)
      assert.ok(existsSync(log), 'ordinary checkout files are still repaired')
      const touched = readFileSync(log, 'utf8')
      assert.match(touched, /same\.txt/)
      assert.doesNotMatch(touched, /\.worktrees/)
      assert.doesNotMatch(touched, /\.git\/worktrees/)
      assert.deepStrictEqual(manifest(join(repo, '.worktrees')), before)
      assert.deepStrictEqual(
        manifest(join(repo, '.git', 'worktrees')),
        adminBefore,
      )
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('a whole startup against a local origin keeps worktrees and admin records', () => {
    const parent = mkdtempSync(join(tmpdir(), 'entrypoint-wt-'))
    try {
      const { origin, workspace, repo, tree } = startupFixture(parent)
      const treesBefore = manifest(join(repo, '.worktrees'))
      const adminBefore = manifest(join(repo, '.git', 'worktrees'))
      const statusBefore = git(tree, 'status', '--porcelain=v2', '--ignored')

      const run = spawnSync('sh', [ENTRYPOINT, 'true'], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          HOME: parent,
          TRIOS_REPO_URL: origin,
          TRIOS_REPO_REF: 'dev',
          WORKSPACE_DIR: workspace,
          LIVENESS_GRACE: '1',
        },
      })
      const out = run.stdout + run.stderr
      assert.match(out, /keeping 1 bee worktree/, out)
      assert.doesNotMatch(out, /removing .* bee worktree/)
      assert.deepStrictEqual(manifest(join(repo, '.worktrees')), treesBefore)
      assert.deepStrictEqual(
        manifest(join(repo, '.git', 'worktrees')),
        adminBefore,
      )
      assert.strictEqual(
        git(tree, 'status', '--porcelain=v2', '--ignored'),
        statusBefore,
      )
      assert.match(git(repo, 'log', '--format=%s', 'queen-1'), /local/)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('a startup on a volume whose workspace owner is wrong never walks into kept data', () => {
    // A restored snapshot is root-owned: the workspace directory reads as not
    // owned by the tool user. The old code ran `chown -R` over the whole
    // workspace, owners and modes of every kept worktree included. The
    // unprivileged-account branch is taken with fakes for the three programs a
    // non-root test cannot run for real; the entrypoint text is the real one.
    const parent = mkdtempSync(join(tmpdir(), 'entrypoint-wt-'))
    try {
      const { origin, workspace, repo, tree } = startupFixture(parent)
      const bin = join(parent, 'bin')
      const log = join(parent, 'chown.log')
      mkdirSync(bin)
      const realStat = spawnSync('which', ['stat'], {
        encoding: 'utf8',
      }).stdout.trim()
      assert.ok(realStat, 'stat is on PATH')
      writeFileSync(
        join(bin, 'stat'),
        `#!/bin/sh\nif [ "$1" = "-c" ] && [ "$2" = "%U" ]; then echo root; exit 0; fi\nexec '${realStat}' "$@"\n`,
      )
      writeFileSync(join(bin, 'chown'), `#!/bin/sh\necho "$*" >> '${log}'\n`)
      writeFileSync(join(bin, 'su'), '#!/bin/sh\nshift 4\nexec sh -c "$1"\n')
      for (const name of ['stat', 'chown', 'su'])
        chmodSync(join(bin, name), 0o755)

      // the nested owners and modes, plus a mode a recursive chmod would touch
      chmodSync(join(tree, 'run.sh'), 0o750)
      const treesBefore = manifest(join(repo, '.worktrees'))
      const adminBefore = manifest(join(repo, '.git', 'worktrees'))
      const statusBefore = git(tree, 'status', '--porcelain=v2', '--ignored')

      const run = spawnSync('sh', [ENTRYPOINT, 'true'], {
        encoding: 'utf8',
        env: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          HOME: parent,
          TRIOS_REPO_URL: origin,
          TRIOS_REPO_REF: 'dev',
          WORKSPACE_DIR: workspace,
          TRIOS_TOOL_SHELL_USER: userInfo().username,
          LIVENESS_GRACE: '1',
        },
      })
      const out = run.stdout + run.stderr
      assert.match(out, /settling the directory itself \(not recursive\)/, out)
      assert.match(out, /keeping 1 bee worktree/, out)

      // the workspace directory alone was chowned: no -R, no path inside it
      const calls = readFileSync(log, 'utf8').trim().split('\n')
      assert.deepStrictEqual(calls, [`${userInfo().username} ${workspace}`])

      assert.deepStrictEqual(manifest(join(repo, '.worktrees')), treesBefore)
      assert.deepStrictEqual(
        manifest(join(repo, '.git', 'worktrees')),
        adminBefore,
      )
      assert.strictEqual(
        git(tree, 'status', '--porcelain=v2', '--ignored'),
        statusBefore,
      )
      assert.match(git(repo, 'log', '--format=%s', 'queen-1'), /local/)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('has no remaining command that deletes or prunes worktrees', () => {
    const live = readFileSync(ENTRYPOINT, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    assert.doesNotMatch(live, /rm -rf[^\n]*\.worktrees/)
    assert.doesNotMatch(live, /worktree prune/)
    assert.doesNotMatch(live, /chown -R/)
  })
})
