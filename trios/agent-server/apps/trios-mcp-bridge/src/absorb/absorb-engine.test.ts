/**
 * @license AGPL-3.0-or-later
 * Copyright 2026 TRIOS
 *
 * The absorb engine, held against its contract (gHashTag/trios#1642):
 * the three exports of absorb-engine.ts - planAbsorb, executeAbsorb,
 * absorbSmart - pinned as they behave today, so the next change to
 * that file has something to fail against.
 *
 * planAbsorb reads the workspace through the GitButler client and
 * answers a sorting plan without touching anything; a path listed in
 * both staged and unstaged keeps its staged status. executeAbsorb
 * creates each planned branch and stages its files, in plan order,
 * refuses an empty plan, and reports failure when every branch
 * creation fails. absorbSmart with dryRun answers the plan and
 * creates nothing; without dryRun it executes.
 *
 * No network, no database, no container: the client is a recording
 * fake (the same cast pattern as bridge-server.test.ts), and only the
 * real in-repo strategies run.
 */

import { describe, expect, it } from 'bun:test'
import type { GitButlerMcpClient } from '../clients/gitbutler-client.js'
import { absorbSmart, executeAbsorb, planAbsorb } from './absorb-engine.js'
import type { AbsorbPlan } from './types.js'

interface RecordingFake {
  client: GitButlerMcpClient
  calls: string[]
  failCreateFor: Set<string>
}

const recordingFake = (status: {
  staged: {
    path: string
    status: 'added' | 'modified' | 'deleted' | 'renamed'
  }[]
  unstaged: {
    path: string
    status: 'added' | 'modified' | 'deleted' | 'renamed'
  }[]
  untracked: string[]
}): RecordingFake => {
  const calls: string[] = []
  const failCreateFor = new Set<string>()
  const client = {
    getStatus: async () => ({
      branch: 'main',
      ahead: 0,
      behind: 0,
      conflicted: [],
      ...status,
    }),
    getBranches: async () => [
      { name: 'main', isCurrent: true, isRemote: false, ahead: 0, behind: 0 },
    ],
    createBranch: async (name: string) => {
      if (failCreateFor.has(name)) throw new Error('branch refused')
      calls.push(`create:${name}`)
      return name
    },
    stage: async (files: string[]) => {
      calls.push(`stage:${files.join('+')}`)
      return 'Files staged'
    },
  }
  return {
    client: client as unknown as GitButlerMcpClient,
    calls,
    failCreateFor,
  }
}

const WORKSPACE = {
  staged: [
    { path: 'src/dup.ts', status: 'modified' as const },
    { path: 'src/a.ts', status: 'added' as const },
  ],
  unstaged: [
    { path: 'src/dup.ts', status: 'added' as const },
    { path: 'docs/x.md', status: 'modified' as const },
  ],
  untracked: ['notes/new.txt'],
}

describe('planAbsorb', () => {
  it('plans branches from staged, unstaged and untracked files without touching the workspace', async () => {
    const { client, calls } = recordingFake(WORKSPACE)
    const plan = await planAbsorb({ gitbutler: client }, 'by-directory')
    expect(plan.branches.map((b) => b.branchName).sort()).toEqual([
      'main/docs',
      'main/notes',
      'main/src',
    ])
    expect(plan.unassigned).toEqual([])
    expect(calls).toEqual([])
  })

  it('keeps one entry per path, preferring the staged status', async () => {
    const { client } = recordingFake(WORKSPACE)
    const plan = await planAbsorb({ gitbutler: client }, 'by-directory')
    const src = plan.branches.find((b) => b.branchName === 'main/src')
    const dup = src?.files.filter((f) => f.path === 'src/dup.ts')
    expect(dup?.length).toBe(1)
    expect(dup?.[0].status).toBe('modified')
  })

  it('answers a clean plan for an empty workspace', async () => {
    const { client } = recordingFake({
      staged: [],
      unstaged: [],
      untracked: [],
    })
    const plan = await planAbsorb({ gitbutler: client }, 'by-directory')
    expect(plan.branches).toEqual([])
    expect(plan.unassigned).toEqual([])
    expect(plan.summary).toContain('workspace is clean')
  })
})

describe('executeAbsorb', () => {
  it('creates each branch and stages its files, in plan order', async () => {
    const { client, calls } = recordingFake(WORKSPACE)
    const plan = await planAbsorb({ gitbutler: client }, 'by-directory')
    calls.length = 0
    const result = await executeAbsorb({ gitbutler: client }, plan)
    expect(calls).toEqual([
      'create:main/src',
      'stage:src/dup.ts+src/a.ts',
      'create:main/docs',
      'stage:docs/x.md',
      'create:main/notes',
      'stage:notes/new.txt',
    ])
    expect(result.ok).toBe(true)
    expect(result.branchesCreated?.length).toBe(3)
    expect(result.filesStaged).toBe(4)
  })

  it('refuses to execute a plan with no branches', async () => {
    const { client } = recordingFake(WORKSPACE)
    const empty: AbsorbPlan = {
      strategy: 'by-directory',
      branches: [],
      unassigned: [],
      summary: '',
    }
    const result = await executeAbsorb({ gitbutler: client }, empty)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('nothing to execute')
  })

  it('reports failure when every branch creation fails', async () => {
    const { client, calls, failCreateFor } = recordingFake(WORKSPACE)
    failCreateFor.add('main/src')
    failCreateFor.add('main/docs')
    failCreateFor.add('main/notes')
    const plan = await planAbsorb({ gitbutler: client }, 'by-directory')
    calls.length = 0
    const result = await executeAbsorb({ gitbutler: client }, plan)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('All branches failed')
    // A failed branch never stages its files.
    expect(calls.filter((c) => c.startsWith('stage:'))).toEqual([])
  })
})

describe('absorbSmart', () => {
  it('dry-run answers the plan without creating anything', async () => {
    const { client, calls } = recordingFake(WORKSPACE)
    const result = await absorbSmart(
      { gitbutler: client },
      'by-directory',
      true,
    )
    expect(result.ok).toBe(true)
    expect(result.reason).toContain('Dry run')
    expect(result.plan?.branches?.length).toBe(3)
    expect(calls).toEqual([])
  })

  it('a live run executes the plan', async () => {
    const { client, calls } = recordingFake(WORKSPACE)
    const result = await absorbSmart(
      { gitbutler: client },
      'by-directory',
      false,
    )
    expect(result.ok).toBe(true)
    expect(calls.filter((c) => c.startsWith('create:')).length).toBe(3)
  })
})
