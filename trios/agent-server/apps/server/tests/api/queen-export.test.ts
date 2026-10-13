/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The queen export route, held against its contract
 * (gHashTag/trios#1676): the single export of
 * queen-export.ts - createQueenExportRoute - pinned as it behaves
 * today, together with the exported bundleOfBranch helper it
 * serves, so the next change to that file has something to fail
 * against.
 *
 * A branch is exported as a git bundle relative to the base - the
 * commits themselves (shas, authors, dates) survive, and the bytes
 * are a real bundle: verified below by `git bundle verify` against
 * the same checkout. The route answers what is waiting to be
 * published (only branches AHEAD of the base, sorted by issue),
 * one branch's bundle as JSON with base64 bytes, 400 for a
 * non-positive-integer issue, and 404 for a branch this checkout
 * does not hold (the stored-bundle fallback is inert without
 * DATABASE_URL - measured).
 *
 * Everything runs against a real throwaway git repository steered
 * through the WORKSPACE_DIR / TRIOS_REPO_URL / TRIOS_REPO_REF
 * environment overrides (restored in afterAll) - real git, real
 * bundles, no mock.module, no network, no database, no container.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bundleOfBranch,
  createQueenExportRoute,
} from '../../src/api/routes/queen-export'

// --- the throwaway checkout -------------------------------------------------

const parent = mkdtempSync(join(tmpdir(), 'qexport-'))
const repo = join(parent, 'myrepo')

const git = (args: string) => execSync(`git -C "${repo}" ${args}`)

execSync(`git init -q -b main "${repo}"`)
git('config user.email t@example.invalid')
git('config user.name "Test Bee"')

git('commit -q --allow-empty -m "base commit"')
const baseSha = git('rev-parse HEAD').toString().trim()
git(`update-ref refs/remotes/origin/dev ${baseSha}`)

// Two branches ahead of the base, one level with it, one foreign name.
git('checkout -q -b queen-45')
execSync('echo forty-five > forty-five.txt', { cwd: repo })
git('add forty-five.txt')
git('commit -q -m "work on 45"')
const head45 = git('rev-parse HEAD').toString().trim()

git('checkout -q main')
git('checkout -q -b queen-123')
execSync('echo one-two-three > one.txt', { cwd: repo })
git('add one.txt')
git('commit -q -m "work on 123"')
git('checkout -q main')
git('checkout -q -b queen-77') // level with the base: no commits

git('checkout -q -b other-feature') // not a queen branch
execSync('echo other > other.txt', { cwd: repo })
git('add other.txt')
git('commit -q -m "unrelated work"')

process.env.WORKSPACE_DIR = parent
process.env.TRIOS_REPO_URL = 'https://example.com/myrepo.git'
process.env.TRIOS_REPO_REF = 'dev'
delete process.env.DATABASE_URL
delete process.env.RAILWAY_SSOT_URL

afterAll(() => {
  delete process.env.WORKSPACE_DIR
  delete process.env.TRIOS_REPO_URL
  delete process.env.TRIOS_REPO_REF
  rmSync(parent, { recursive: true, force: true })
})

// --- the suite ---------------------------------------------------------------

describe('bundleOfBranch', () => {
  it('answers 404 for a branch this checkout does not hold', async () => {
    const missing = await bundleOfBranch(999)
    expect(missing).toEqual({
      ok: false,
      status: 404,
      error: 'no branch queen-999 in this checkout',
    })
  })

  it('answers 409 for a branch level with the base', async () => {
    const level = await bundleOfBranch(77)
    expect(level).toEqual({
      ok: false,
      status: 409,
      error: 'queen-77 has no commits beyond origin/dev',
    })
  })

  it('bundles the branch as a real git bundle with its commit list', async () => {
    const made = await bundleOfBranch(45)
    if (!('bytes' in made)) throw new Error('expected a made bundle')
    expect(made.branch).toBe('queen-45')
    expect(made.base).toBe('origin/dev')
    expect(made.commits.length).toBe(1)
    expect(made.commits[0].sha).toBe(head45)
    expect(made.commits[0].author).toBe('Test Bee')
    expect(made.commits[0].subject).toBe('work on 45')
    expect(made.files).toEqual(['forty-five.txt'])

    // The bytes are a real bundle: git itself verifies them.
    const bundlePath = join(parent, 'probe.bundle')
    writeFileSync(bundlePath, made.bytes)
    const verified = execSync(
      `git -C "${repo}" bundle verify "${bundlePath}"`,
    ).toString()
    // Measured: this git prints the singular form for a 1-ref bundle.
    expect(verified).toContain('The bundle contains this ref:')
    expect(verified).toContain('refs/heads/queen-45')
  })
})

describe('createQueenExportRoute', () => {
  it('lists only the branches ahead of the base, sorted by issue', async () => {
    const response = await createQueenExportRoute().request('/')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      base: string
      count: number
      branches: Array<{
        issue: number
        branch: string
        commits: number
        files: number
        head: string
      }>
    }
    expect(body.base).toBe('origin/dev')
    expect(body.count).toBe(2)
    expect(body.branches.map((b) => b.issue)).toEqual([45, 123])
    const first = body.branches[0]
    expect(first.branch).toBe('queen-45')
    expect(first.commits).toBe(1)
    expect(first.files).toBe(1)
    expect(first.head).toBe(head45)
  })

  it('serves one branch as JSON with base64 bundle bytes', async () => {
    const response = await createQueenExportRoute().request('/123')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      issue: number
      branch: string
      base: string
      commits: Array<{ sha: string }>
      files: string[]
      bundleBase64: string
    }
    expect(body.issue).toBe(123)
    expect(body.branch).toBe('queen-123')
    expect(body.base).toBe('origin/dev')
    expect(body.commits.length).toBe(1)
    expect(body.files).toEqual(['one.txt'])
    const bytes = Buffer.from(body.bundleBase64, 'base64')
    // A git bundle is a text header first: '# v2 git bundle' or v3.
    expect(bytes.subarray(0, 3).toString('utf8')).toBe('# v')
  })

  it('answers 400 for an issue that is not a positive integer', async () => {
    const response = await createQueenExportRoute().request('/abc')
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'issue must be a positive integer',
    })
  })

  it('answers 404 for an issue this checkout does not hold', async () => {
    const response = await createQueenExportRoute().request('/999')
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: 'no branch queen-999 in this checkout',
    })
  })
})
