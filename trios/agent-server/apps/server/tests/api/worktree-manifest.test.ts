/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * tools/queen-runner/worktree-manifest.mjs on a scratch repository: it passes
 * an untouched volume, fails closed on every kind of difference or doubt, and
 * prints counters only. --assume-quiescent is passed where /proc cannot be
 * read in full (macOS, or another user's processes): that is the operator's
 * statement, and the tests that need it say so.
 */

import { describe, it } from 'bun:test'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const TOOL = resolve(
  import.meta.dir,
  '../../../../tools/queen-runner/worktree-manifest.mjs',
)

function git(cwd: string, ...args: string[]) {
  const run = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  assert.strictEqual(run.status, 0, run.stderr)
}

function cli(...args: string[]) {
  const run = spawnSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf8',
  })
  return { status: run.status, out: run.stdout, err: run.stderr }
}

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'manifest-'))
  const repo = join(parent, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'dev')
  git(repo, 'config', 'user.email', 't@example.test')
  git(repo, 'config', 'user.name', 't')
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n*.secret\n')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'base')
  const tree = join(repo, '.worktrees', 'queen-1')
  git(repo, 'worktree', 'add', '-q', '-b', 'queen-1', tree)
  writeFileSync(join(tree, 'PRIVATE.secret'), 'PRIVATE-BYTES\n')
  writeFileSync(join(tree, 'blob.bin'), Buffer.from([0, 255, 3]))
  writeFileSync(join(tree, 'x.sh'), '#!/bin/sh\n')
  chmodSync(join(tree, 'x.sh'), 0o750)
  symlinkSync('a.txt', join(tree, 'link'))
  return { parent, repo, tree }
}

const QUIET = '--assume-quiescent'

const put = (repo: string, out: string) =>
  cli('write', '--root', repo, '--out', out, QUIET)

describe('worktree-manifest', () => {
  it('passes an untouched volume and prints counters only', () => {
    const { parent, repo } = fixture()
    try {
      const out = join(parent, 'private', 'm.json')
      const wrote = put(repo, out)
      assert.strictEqual(wrote.status, 0, wrote.err)
      assert.strictEqual(statSync(out).mode & 0o777, 0o600)
      const checked = cli('verify', '--root', repo, '--against', out, QUIET)
      assert.strictEqual(checked.status, 0, checked.out)
      const summary = JSON.parse(checked.out)
      assert.strictEqual(summary.identical, true)
      assert.strictEqual(summary.changed, 0)
      for (const text of [wrote.out, checked.out])
        assert.doesNotMatch(text, /PRIVATE|queen-1|\.secret|blob\.bin/)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('detects one changed byte, a changed mode, and a missing file', () => {
    const { parent, repo, tree } = fixture()
    try {
      const out = join(parent, 'm.json')
      assert.strictEqual(put(repo, out).status, 0)
      writeFileSync(join(tree, 'PRIVATE.secret'), 'PRIVATE-BYTEZ\n')
      chmodSync(join(tree, 'x.sh'), 0o700)
      rmSync(join(tree, 'blob.bin'))
      const details = join(parent, 'd.json')
      const checked = cli(
        'verify',
        '--root',
        repo,
        '--against',
        out,
        '--details',
        details,
        QUIET,
      )
      assert.strictEqual(checked.status, 1)
      const summary = JSON.parse(checked.out)
      assert.strictEqual(summary.identical, false)
      assert.strictEqual(summary.changed, 2)
      assert.strictEqual(summary.missing, 1)
      assert.doesNotMatch(checked.out, /PRIVATE|queen-1/)
      // names live only in the private details file
      assert.match(readFileSync(details, 'utf8'), /PRIVATE\.secret changed/)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('refuses an output inside the checkout, by any spelling', () => {
    const { parent, repo } = fixture()
    try {
      for (const bad of [
        join(repo, '.worktrees', 'm.json'),
        join(repo, 'm.json'),
        join(repo, 'sub', 'dir', 'm.json'),
      ]) {
        const run = cli('write', '--root', repo, '--out', bad, QUIET)
        assert.notStrictEqual(run.status, 0, bad)
      }
      // a symlinked PARENT that leads into the checkout
      const elsewhere = join(parent, 'elsewhere')
      mkdirSync(elsewhere)
      symlinkSync(join(repo, '.worktrees'), join(elsewhere, 'link'))
      const viaLink = join(elsewhere, 'link', 'm.json')
      const escaped = cli('write', '--root', repo, '--out', viaLink, QUIET)
      assert.notStrictEqual(escaped.status, 0)
      // and a symlinked FINAL component is never followed
      const target = join(parent, 'victim.txt')
      writeFileSync(target, 'victim\n')
      symlinkSync(target, join(parent, 'out-link.json'))
      const final = cli(
        'write',
        '--root',
        repo,
        '--out',
        join(parent, 'out-link.json'),
        QUIET,
      )
      assert.notStrictEqual(final.status, 0)
      assert.strictEqual(readFileSync(target, 'utf8'), 'victim\n')
      // nothing was written into the checkout by any refusal
      assert.deepStrictEqual(readdirSync(join(repo, '.worktrees')), ['queen-1'])
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('forces an existing output to mode 0600 before writing', () => {
    const { parent, repo } = fixture()
    try {
      const out = join(parent, 'existing.json')
      writeFileSync(out, 'old')
      chmodSync(out, 0o644)
      assert.strictEqual(put(repo, out).status, 0)
      assert.strictEqual(statSync(out).mode & 0o777, 0o600)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('fails closed on a symlink where a worktree should be', () => {
    const { parent, repo } = fixture()
    try {
      const other = join(parent, 'other')
      mkdirSync(other)
      writeFileSync(join(other, 'f.txt'), 'not ours\n')
      symlinkSync(other, join(repo, '.worktrees', 'queen-2'))
      const out = join(parent, 'm.json')
      const wrote = cli('write', '--root', repo, '--out', out, QUIET)
      const summary = JSON.parse(wrote.out)
      assert.strictEqual(summary.certifiable, false)
      assert.ok(summary.unreadable >= 1)
      const checked = cli('verify', '--root', repo, '--against', out, QUIET)
      assert.strictEqual(checked.status, 1)
      assert.strictEqual(JSON.parse(checked.out).identical, false)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('covers the shared git bytes: one flipped object byte fails', () => {
    const { parent, repo } = fixture()
    try {
      const out = join(parent, 'm.json')
      assert.strictEqual(put(repo, out).status, 0)
      const objects = join(repo, '.git', 'objects')
      const dir = readdirSync(objects).find((d) => /^[0-9a-f]{2}$/.test(d))
      assert.ok(dir)
      const file = join(objects, dir, readdirSync(join(objects, dir))[0] ?? '')
      chmodSync(file, 0o644)
      appendFileSync(file, 'x')
      for (const phase of ['exact', 'boot']) {
        const checked = cli(
          'verify',
          '--root',
          repo,
          '--against',
          out,
          '--phase',
          phase,
          QUIET,
        )
        assert.strictEqual(checked.status, 1, phase)
        assert.ok(JSON.parse(checked.out).changed >= 1)
      }
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('boot phase allows git growth and a moved root, exact phase does not', () => {
    const { parent, repo } = fixture()
    try {
      writeFileSync(join(repo, 'dirty.txt'), 'root edit\n')
      const out = join(parent, 'm.json')
      const wrote = cli('write', '--root', repo, '--out', out, QUIET)
      assert.strictEqual(JSON.parse(wrote.out).rootEditsPresent, true)
      // what a boot does: new objects, a moved branch, a changed root file
      writeFileSync(join(repo, 'a.txt'), 'moved\n')
      git(repo, 'add', 'a.txt')
      git(repo, 'commit', '-q', '-m', 'moved')
      const boot = cli(
        'verify',
        '--root',
        repo,
        '--against',
        out,
        '--phase',
        'boot',
        QUIET,
      )
      assert.strictEqual(boot.status, 0, boot.out)
      const summary = JSON.parse(boot.out)
      assert.ok(summary.gitAddedAtBoot >= 1)
      assert.ok(summary.rootChangedAtBoot >= 1)
      assert.strictEqual(summary.rootEditsPresent, true)
      const exact = cli('verify', '--root', repo, '--against', out, QUIET)
      assert.strictEqual(exact.status, 1)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('boot phase still fails when a worktree byte changes', () => {
    const { parent, repo, tree } = fixture()
    try {
      const out = join(parent, 'm.json')
      assert.strictEqual(put(repo, out).status, 0)
      writeFileSync(join(tree, 'PRIVATE.secret'), 'changed\n')
      const boot = cli(
        'verify',
        '--root',
        repo,
        '--against',
        out,
        '--phase',
        'boot',
        QUIET,
      )
      assert.strictEqual(boot.status, 1)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('without --assume-quiescent it passes only where /proc is fully readable', () => {
    const { parent, repo } = fixture()
    try {
      const out = join(parent, 'm.json')
      const wrote = cli('write', '--root', repo, '--out', out)
      const summary = JSON.parse(wrote.out)
      // never certifiable on a platform that cannot prove it
      assert.strictEqual(
        summary.certifiable,
        summary.writersKnown === true &&
          summary.writers === 0 &&
          summary.holders === 0 &&
          summary.unreadable === 0 &&
          summary.unstable === 0,
      )
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
