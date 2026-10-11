/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * A runner that claims several orders at once cuts every one of them.
 *
 * Measured 2026-10-11 12:58:39Z on trios-bee-runner-1: the round's batch
 * queued 11 orders, the runner claimed all 11 in the same millisecond and
 * started ONE (#8408). The other ten were refused inside runClaimedBee, which
 * ends the order (recordDispatch started=false), so the next round found their
 * issues free and queued them again - #8396 six times in three minutes. The
 * board was right each time: a refused order claims nothing. The refusal was
 * wrong: every claimed order ran `git fetch --quiet origin` in the runner's one
 * checkout at the same moment, and concurrent fetches that move the same
 * remote-tracking refs fail with
 *
 *   error: cannot lock ref 'refs/remotes/origin/queen-1': is at ... but expected ...
 *
 * Reproduced on a scratch repository: 1 fetch at a time, 0 of 5 failed; 2 at
 * once, 5 of 10; 11 at once, 55 of 55.
 *
 * Held against real git, as queen-attempt-start.test.ts is: a scratch origin
 * whose branches all move after the clone, and N cuts started together.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { prepareWorktree } from '../../src/api/services/queen-dispatch'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Bee',
      GIT_AUTHOR_EMAIL: 'bee@example.com',
      GIT_COMMITTER_NAME: 'Bee',
      GIT_COMMITTER_EMAIL: 'bee@example.com',
    },
  }).trim()
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** Issues the burst cuts; none has a queen-<issue> branch, so each cuts from the base. */
const BURST = [8394, 8396, 8397, 8398, 8399, 8400, 8404, 8405]

/** Other bees' branches on the origin, all of which move after the clone. */
const OTHER_BEES = 10

describe('a burst of claimed orders, one checkout', () => {
  let scratch = ''
  let seed = ''
  let origin = ''
  const saved = { ...process.env }

  // Inside each test, not a beforeEach: git on a loaded host outruns a hook's
  // five seconds, and a test has its own, longer clock.
  const setUp = (): void => {
    scratch = mkdtempSync(join(tmpdir(), 'queen-runner-burst-'))
    origin = join(scratch, 'origin.git')
    git(scratch, ['init', '-q', '--bare', 'origin.git'])
    seed = join(scratch, 'seed')
    mkdirSync(seed)
    git(seed, ['init', '-q', '-b', 'dev'])
    write(join(seed, 'README.md'), 'the root\n')
    git(seed, ['add', '.'])
    git(seed, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'first'])
    // Other bees' branches, as the real origin carries thousands of queen-*.
    for (let i = 1; i <= OTHER_BEES; i++)
      git(seed, ['branch', '-q', `queen-${i}`])
    git(seed, ['push', '-q', origin, 'refs/heads/*:refs/heads/*'])
    git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/dev'])
    git(scratch, ['clone', '-q', origin, 'BrowserOS'])
    // Everything moves after the clone, so every fetch has refs to update.
    for (let i = 1; i <= OTHER_BEES; i++) {
      git(seed, ['checkout', '-q', `queen-${i}`])
      write(join(seed, `bee-${i}.md`), `bee ${i}\n`)
      git(seed, ['add', '.'])
      git(seed, ['-c', 'commit.gpgsign=false', 'commit', '-qm', `bee ${i}`])
    }
    git(seed, ['checkout', '-q', 'dev'])
    write(join(seed, 'README.md'), 'the root, moved\n')
    git(seed, ['-c', 'commit.gpgsign=false', 'commit', '-qam', 'moved'])
    git(seed, ['push', '-q', '-f', origin, 'refs/heads/*:refs/heads/*'])

    process.env.WORKSPACE_DIR = scratch
    process.env.TRIOS_REPO_REF = 'origin/dev'
    delete process.env.TRIOS_REPO_URL
    delete process.env.TRIOS_REPO_SUBDIR
    process.env.TRIOS_MODULE_STORE = join(scratch, 'no-such-store')
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  }

  afterEach(() => {
    process.env = { ...saved }
    if (scratch) rmSync(scratch, { recursive: true, force: true })
    scratch = ''
  })

  it('cuts every order it claimed at once, none refused for a lock', async () => {
    setUp()
    const cuts = await Promise.all(
      BURST.map((issue) => prepareWorktree(issue, { volumeUsed: () => 10 })),
    )
    const refused = cuts.filter((c) => !c.ok).map((c) => c.detail)
    expect(refused).toEqual([])
    const base = git(seed, ['rev-parse', 'dev'])
    for (const cut of cuts) {
      expect(cut.detail).toContain('cut from origin/dev')
      // each cut stands on the base as it is NOW, not as the clone saw it
      expect(git(cut.path, ['rev-parse', 'HEAD'])).toBe(base)
    }
  }, 120_000)

  it('a cut that arrives after the burst still sees what moved since', async () => {
    setUp()
    await Promise.all(
      BURST.slice(0, 3).map((issue) =>
        prepareWorktree(issue, { volumeUsed: () => 10 }),
      ),
    )
    // the base moves again after the burst
    write(join(seed, 'README.md'), 'the root, moved twice\n')
    git(seed, ['-c', 'commit.gpgsign=false', 'commit', '-qam', 'moved again'])
    git(seed, ['push', '-q', origin, 'dev'])
    const late = await prepareWorktree(9999, { volumeUsed: () => 10 })
    expect(late.ok).toBe(true)
    expect(git(late.path, ['rev-parse', 'HEAD'])).toBe(
      git(seed, ['rev-parse', 'dev']),
    )
  }, 120_000)
})
