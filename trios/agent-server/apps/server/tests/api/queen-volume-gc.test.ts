import { describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  prepareWorktree,
  reapWorktrees,
  volumeUsedPercent,
} from '../../src/api/services/queen-dispatch'

// WHY THIS EXISTS.
//
// 2026-09-05: /workspace reached 100% - 71 MB of 46 GB, sixty worktrees - and
// every dispatch died in its first second with
// `git worktree add failed: unable to write file docs/images/...`.
//
// A reaper existed and had not run, because it lived OUTSIDE the container: it
// reached the volume through `railway ssh`, and railway refuses a connection
// while the application is unhealthy - which it was, BECAUSE the volume was
// full. The collector depended on the thing whose failure it collects for.
//
// These pin the properties that make the in-container collector safe. Most of
// them read the source, because the removal path needs a real filesystem and a
// real git. The one property a reading could not pin - WHOSE tree is removed -
// runs against a real scratch repository at the bottom of this file: a review
// deleted the `continue` after `keptRunning.push` and every text assertion
// stayed green while a running bee's tree was removed and reported as kept.

describe('volumeUsedPercent', () => {
  it('measures a directory that exists', () => {
    const used = volumeUsedPercent(process.cwd())
    expect(used).not.toBeNull()
    expect(used).toBeGreaterThanOrEqual(0)
    expect(used).toBeLessThanOrEqual(100)
  })

  it('returns null - not zero - when it cannot measure', () => {
    // UNKNOWN IS NOT ROOM. A guard that reads an unmeasurable disk as empty
    // disables itself exactly when the filesystem is unwell, which is the one
    // moment it is needed.
    expect(
      volumeUsedPercent('/definitely/not/a/path/on/this/machine'),
    ).toBeNull()
  })
})

describe('the reaper refuses the things that would lose work', () => {
  const source = Bun.file(
    new URL('../../src/api/services/queen-dispatch.ts', import.meta.url)
      .pathname,
  )

  it('never removes a worktree holding uncommitted work', async () => {
    // This container carries no push credential by design, so unpublished work
    // in a tree is the ONLY copy of it. A dirty tree is somebody's unfinished
    // turn and the disk is never worth it.
    const text = await source.text()
    const fn = text.slice(text.indexOf('export async function reapWorktrees'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toContain('keptDirty')
    // the card decides (worktree_keep.t27 reap_verdict); ignored files count
    expect(body).toContain('await dirtyFactOf(c.path)')
    expect(text).toContain("['status', '--porcelain', '--ignored']")
  })

  it('asks whether a bee is running BEFORE it asks whether the tree is dirty', async () => {
    // A running bee's tree is kept whatever its status reads, and the status
    // call is a subprocess per tree that a protected tree should not cost.
    const text = await source.text()
    const fn = text.slice(text.indexOf('export async function reapWorktrees'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body.indexOf('opts.protect?.has(')).toBeGreaterThan(-1)
    expect(body.indexOf('opts.protect?.has(')).toBeLessThan(
      body.indexOf('dirtyFactOf(c.path)'),
    )
  })

  it('never passes --force to git worktree remove', async () => {
    const text = await source.text()
    const code = text
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    expect(code).not.toMatch(/worktree['"\],\s]+remove[^\n]*--force/)
  })

  it('keeps the newest worktrees, which are the ones likely to be running', async () => {
    const text = await source.text()
    const fn = text.slice(text.indexOf('export async function reapWorktrees'))
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain('keepNewest')
  })

  it('stops at the low watermark rather than emptying the volume', async () => {
    const text = await source.text()
    const fn = text.slice(text.indexOf('export async function reapWorktrees'))
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toMatch(/now <= low\) break/)
  })
})

describe('the dispatch refuses before it dies half-way', () => {
  it('checks the volume BEFORE the fetch, and names the number when it refuses', async () => {
    // The dispatch that exposed this died with "cannot update the ref ... unable
    // to write file", which sent every reader looking at git rather than at df.
    const text = await Bun.file(
      new URL('../../src/api/services/queen-dispatch.ts', import.meta.url)
        .pathname,
    ).text()
    const prep = text.slice(
      text.indexOf('export async function prepareWorktree'),
    )
    const beforeFetch = prep.slice(0, prep.indexOf("['fetch'"))
    expect(beforeFetch).toContain('volumeUsedPercent')
    expect(beforeFetch).toContain('reapWorktrees')
    expect(beforeFetch).toMatch(/volume \$\{still\}% full after reaping/)
  })
})

/**
 * A real repository with real worktrees, because "whose tree was removed" is a
 * fact about a filesystem. `origin.git` is bare, `BrowserOS` is the Queen's
 * checkout - the name `workspaceRoot()` derives - and every name given becomes
 * a clean worktree under `.worktrees/`, which is where dispatch cuts them.
 */
function scratchRepository(branches: string[]): {
  root: string
  tree: (branch: string) => string
  restore: () => void
} {
  const REAL_GIT = Bun.which('git') || '/usr/bin/git'
  const git = (cwd: string, args: string[]): void => {
    const done = Bun.spawnSync([REAL_GIT, ...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    })
    if (done.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${done.stderr.toString()}`)
    }
  }
  const previous = {
    WORKSPACE_DIR: process.env.WORKSPACE_DIR,
    TRIOS_REPO_REF: process.env.TRIOS_REPO_REF,
    TRIOS_REPO_URL: process.env.TRIOS_REPO_URL,
    QUEEN_VOLUME_KEEP: process.env.QUEEN_VOLUME_KEEP,
    // The marks the cases below are written against (80 and 55). Left as the
    // shell has them, QUEEN_VOLUME_HIGH=90 makes "85% reaps" a lie.
    QUEEN_VOLUME_HIGH: process.env.QUEEN_VOLUME_HIGH,
    QUEEN_VOLUME_LOW: process.env.QUEEN_VOLUME_LOW,
  }
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'queen-reap-')))
  const origin = join(scratch, 'origin.git')
  git(scratch, ['init', '-q', '--bare', 'origin.git'])
  const seed = join(scratch, 'seed')
  mkdirSync(seed)
  git(seed, ['init', '-q', '-b', 'dev'])
  git(seed, ['config', 'user.email', 'bee@example.com'])
  git(seed, ['config', 'user.name', 'Bee'])
  writeFileSync(join(seed, 'README.md'), 'one good branch\n')
  git(seed, ['add', '.'])
  git(seed, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'first'])
  git(seed, ['push', '-q', origin, 'dev'])
  git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/dev'])
  const root = join(scratch, 'BrowserOS')
  git(scratch, ['clone', '-q', origin, 'BrowserOS'])
  const tree = (branch: string) => join(root, '.worktrees', branch)
  for (const branch of branches) {
    git(root, [
      'worktree',
      'add',
      '-q',
      '-b',
      branch,
      tree(branch),
      'origin/dev',
    ])
  }
  process.env.WORKSPACE_DIR = scratch
  process.env.TRIOS_REPO_REF = 'origin/dev'
  delete process.env.TRIOS_REPO_URL
  // The default keeps the newest six whoever they belong to, which in a
  // repository of three trees is all of them: nothing would be a candidate and
  // the test would pass with the protection deleted.
  process.env.QUEEN_VOLUME_KEEP = '0'
  delete process.env.QUEEN_VOLUME_HIGH
  delete process.env.QUEEN_VOLUME_LOW
  return {
    root,
    tree,
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    },
  }
}

describe('the reaper, on a real repository', () => {
  it('keeps the clean tree of a running bee and removes the one nobody is running', async () => {
    const repo = scratchRepository(['queen-3', 'queen-7'])
    try {
      const gc = await reapWorktrees({
        high: 0,
        low: 0,
        volumeUsed: () => 90,
        protect: new Set(['queen-7']),
      })
      expect(gc.keptRunning).toEqual([repo.tree('queen-7')])
      expect(gc.removed).toEqual([repo.tree('queen-3')])
      expect(existsSync(repo.tree('queen-7'))).toBe(true)
      expect(existsSync(repo.tree('queen-3'))).toBe(false)
    } finally {
      repo.restore()
    }
  })

  it('keeps a tree whose only content is IGNORED files, under pressure, and prints nothing of them', async () => {
    // gHashTag/trios#2005: `git status --porcelain` does not list ignored
    // files, so a tree holding only an ignored secret and a binary read as
    // clean and was removed. With every tree held the reap ends with the
    // volume still full and removes nothing.
    const repo = scratchRepository(['queen-3', 'queen-7'])
    try {
      // The shared exclude file makes both files ignored in every tree, so
      // the only thing that differs from a clean tree is the ignored files.
      const exclude = join(repo.root, '.git', 'info', 'exclude')
      mkdirSync(dirname(exclude), { recursive: true })
      writeFileSync(exclude, 'keep.secret\nkeep.bin\n')
      for (const branch of ['queen-3', 'queen-7']) {
        writeFileSync(join(repo.tree(branch), 'keep.secret'), 'PRIVATE-BYTES\n')
        writeFileSync(
          join(repo.tree(branch), 'keep.bin'),
          Buffer.from([0, 1, 2, 255]),
        )
      }
      const gc = await reapWorktrees({
        high: 0,
        low: 0,
        volumeUsed: () => 90,
      })
      const logged = [JSON.stringify(gc)]
      expect(gc.removed).toEqual([])
      expect(gc.keptDirty.sort()).toEqual(
        [repo.tree('queen-3'), repo.tree('queen-7')].sort(),
      )
      for (const branch of ['queen-3', 'queen-7']) {
        expect(
          readFileSync(join(repo.tree(branch), 'keep.secret'), 'utf8'),
        ).toBe('PRIVATE-BYTES\n')
        expect([...readFileSync(join(repo.tree(branch), 'keep.bin'))]).toEqual([
          0, 1, 2, 255,
        ])
      }
      expect(logged.join('')).not.toContain('PRIVATE')
    } finally {
      repo.restore()
    }
  })

  it('keeps a tree whose git status cannot be read, and removes the clean one beside it', async () => {
    // UNKNOWN IS NOT CLEAN. A tree whose state cannot be read might hold the
    // only copy of a turn's work. The worktree's `.git` pointer is broken, so
    // `git status` there exits non-zero; the tree and its bytes must survive
    // the reap while an ordinary clean tree beside it is still reaped.
    const repo = scratchRepository(['queen-3', 'queen-7'])
    try {
      const unreadable = repo.tree('queen-3')
      writeFileSync(join(unreadable, 'work.txt'), 'UNSAVED-WORK\n')
      writeFileSync(join(unreadable, '.git'), 'gitdir: /definitely/not/here\n')
      const gc = await reapWorktrees({
        high: 0,
        low: 0,
        volumeUsed: () => 90,
      })
      expect(gc.keptDirty).toEqual([unreadable])
      expect(gc.removed).toEqual([repo.tree('queen-7')])
      expect(existsSync(repo.tree('queen-7'))).toBe(false)
      expect(readFileSync(join(unreadable, 'work.txt'), 'utf8')).toBe(
        'UNSAVED-WORK\n',
      )
      expect(JSON.stringify(gc)).not.toContain('UNSAVED')
    } finally {
      repo.restore()
    }
  })

  it('protects them in the reap prepareWorktree runs, which fires before the container guard does', async () => {
    // 85% used: above QUEEN_VOLUME_HIGH, and on a 50 GB volume still 7.5 GB
    // free - room as far as the guard is concerned. This reap was the
    // unprotected one: two running bees lost their trees to it in a scratch
    // reproduction before `running` existed.
    const repo = scratchRepository(['queen-3', 'queen-7'])
    try {
      let asked = 0
      const prepared = await prepareWorktree(99, {
        volumeUsed: () => 85,
        running: async () => {
          asked += 1
          return new Set(['queen-7'])
        },
      })
      expect(prepared.ok).toBe(true)
      expect(asked).toBe(1)
      expect(existsSync(repo.tree('queen-7'))).toBe(true)
      expect(existsSync(repo.tree('queen-3'))).toBe(false)
      expect(existsSync(repo.tree('queen-99'))).toBe(true)
    } finally {
      repo.restore()
    }
  })

  it('reaps nothing when it cannot find out who is running', async () => {
    // Null is "the registry could not be read". It used to arrive as an empty
    // set - "nobody is running" - and the reap went ahead unprotected.
    const repo = scratchRepository(['queen-3', 'queen-7'])
    try {
      const prepared = await prepareWorktree(97, {
        volumeUsed: () => 85,
        running: async () => null,
      })
      expect(prepared.ok).toBe(true)
      expect(existsSync(repo.tree('queen-3'))).toBe(true)
      expect(existsSync(repo.tree('queen-7'))).toBe(true)
      // And a volume that is truly full still refuses, saying why nothing went.
      const full = await prepareWorktree(96, {
        volumeUsed: () => 97,
        running: async () => null,
      })
      expect(full.ok).toBe(false)
      expect(full.detail).toContain('volume 97% full and nothing was reaped')
    } finally {
      repo.restore()
    }
  })

  it('does not ask who is running when there is nothing to reap', async () => {
    const repo = scratchRepository(['queen-3'])
    try {
      let asked = 0
      const prepared = await prepareWorktree(98, {
        volumeUsed: () => 40,
        running: async () => {
          asked += 1
          return new Set()
        },
      })
      expect(prepared.ok).toBe(true)
      expect(asked).toBe(0)
      expect(existsSync(repo.tree('queen-3'))).toBe(true)
    } finally {
      repo.restore()
    }
  })
})
