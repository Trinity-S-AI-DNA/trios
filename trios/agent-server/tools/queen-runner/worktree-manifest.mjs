// Read-only inventory and byte manifest of a runner volume's bee worktrees.
// gHashTag/trios#2005. Run with bun or node; no dependencies.
//
//   worktree-manifest.mjs write  --root <checkout> --out <private.json>
//   worktree-manifest.mjs verify --root <checkout> --against <private.json>
//                                [--phase exact|boot] [--details <private.json>]
//   both: [--allow-pid <pid>]... [--assume-quiescent]
//
// WHAT IT READS (bytes, streamed sha256 plus mode, size, link target):
//   - every file under <root>/.worktrees/*         ("trees")
//   - every file under <root>/.git/worktrees/*     ("admin": index, HEAD, ...)
//   - every file under <root>/.git except worktrees ("git": objects, refs,
//     packed-refs, config, root index - the shared Git bytes)
//   - the root working tree without .git and .worktrees ("rootTree")
// WHAT IT NEVER DOES: write anywhere but --out/--details, read the
// environment or command line of any process, read a transcript, print a path
// or a byte of content. stdout is aggregate counters only; paths live in the
// private file.
//
// PHASES of verify.
//   exact: restore proof (a copy against its source, or nothing started):
//          trees, admin, git and rootTree must all be identical.
//   boot:  after a real startup. The boot fetches and may move the root
//          checkout, so git may GROW and rootTree may change. Required:
//          trees and admin identical; every object file present before is
//          present with the same bytes; every refs/heads/queen-* ref and its
//          log unchanged. Root edits are NOT proven by this phase: when the
//          manifest says the root held edits (rootEditsPresent), the full
//          platform snapshot is the gate for them.
//
// FAIL CLOSED. Anything that makes a claim weaker makes certifiable/identical
// false: a file that changed while it was hashed (unstable), anything that
// could not be read or is a symlink where a directory was expected
// (unreadable), a process with a file open for WRITE under the root
// (writers), a process whose cwd or read-only files are under the root
// (holders; --allow-pid names the operator's own shell, and only holders are
// excused, never a writer), a /proc that could not be read in full
// (writersKnown false; --assume-quiescent is the operator's statement then).
//
// OUT and DETAILS are checked BEFORE anything is read or written: the parent
// is canonicalized, a path that resolves into the checkout or through a
// symlink out of a checkout path is refused, an existing file must be a plain
// file and is forced to mode 0600 before any byte is written.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  createReadStream,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const SKIP_ROOT = new Set(['.git', '.worktrees'])

function sha256File(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', fail)
      .on('end', () => done(hash.digest('hex')))
  })
}

function newCounters() {
  return {
    files: 0,
    dirs: 0,
    links: 0,
    other: 0,
    bytes: 0,
    unstable: 0,
    unreadable: 0,
  }
}

function add(into, from) {
  for (const key of Object.keys(from)) into[key] += from[key]
}

async function entryOf(full, st, counters) {
  const mode = st.mode & 0o7777
  if (st.isSymbolicLink()) {
    counters.links++
    try {
      return { type: 'link', mode, target: readlinkSync(full) }
    } catch {
      counters.unreadable++
      return { type: 'link', mode, unreadable: true }
    }
  }
  if (st.isFile()) {
    try {
      const sha = await sha256File(full)
      const after = lstatSync(full)
      const unstable = after.size !== st.size || after.mtimeMs !== st.mtimeMs
      counters.files++
      counters.bytes += st.size
      if (unstable) counters.unstable++
      return { type: 'file', mode, size: st.size, sha, unstable }
    } catch {
      counters.unreadable++
      return { type: 'file', mode, unreadable: true }
    }
  }
  counters.other++
  return { type: 'other', mode }
}

/** Every entry under `dir`, recursively, stable order, never following links. */
export async function walk(dir, base, entries, counters, skip = null) {
  let names
  try {
    names = readdirSync(dir).sort()
  } catch {
    counters.unreadable++
    return
  }
  for (const name of names) {
    if (skip && dir === base && skip.has(name)) continue
    const full = join(dir, name)
    let st
    try {
      st = lstatSync(full)
    } catch {
      counters.unreadable++
      continue
    }
    const rel = relative(base, full)
    if (st.isDirectory()) {
      entries[rel] = { type: 'dir', mode: st.mode & 0o7777 }
      counters.dirs++
      await walk(full, base, entries, counters, skip)
    } else {
      entries[rel] = await entryOf(full, st, counters)
    }
  }
}

/** A directory that must be a real directory, not a link and not missing. */
function realDirectory(path, counters) {
  try {
    const st = lstatSync(path)
    if (st.isDirectory()) return true
    counters.unreadable++ // a symlink or file where a directory belongs
    return false
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    counters.unreadable++
    return false
  }
}

const gone = (error) => Boolean(error) && error.code === 'ENOENT'

/** One open file of one process: whether it is under the root, and for write. */
function inspectFd(pid, fd, under) {
  try {
    if (!under(readlinkSync(`/proc/${pid}/fd/${fd}`)))
      return { holds: false, writes: false, unreadable: 0 }
    const info = readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8')
    const flags = /^flags:\s*([0-7]+)/m.exec(info)
    if (!flags) return { holds: true, writes: false, unreadable: 1 }
    const writes = (Number.parseInt(flags[1], 8) & 3) !== 0
    return { holds: true, writes, unreadable: 0 }
  } catch (error) {
    return { holds: false, writes: false, unreadable: gone(error) ? 0 : 1 }
  }
}

/** One process: holds the root (cwd or file), writes under it, what was unreadable. */
function inspectProcess(pid, under) {
  const out = { holds: false, writes: false, unreadable: 0, vanished: false }
  try {
    if (under(readlinkSync(`/proc/${pid}/cwd`))) out.holds = true
  } catch (error) {
    if (gone(error)) return { ...out, vanished: true }
    out.unreadable++
  }
  let fds = []
  try {
    fds = readdirSync(`/proc/${pid}/fd`)
  } catch (error) {
    if (gone(error)) return { ...out, vanished: true }
    out.unreadable++
  }
  for (const fd of fds) {
    const one = inspectFd(pid, fd, under)
    out.holds = out.holds || one.holds
    out.writes = out.writes || one.writes
    out.unreadable += one.unreadable
  }
  return out
}

/** Processes with the root as cwd or open file, from /proc alone. Counts only. */
export function liveProcesses(root, allowed = new Set()) {
  const out = { writers: 0, holders: 0, unreadable: 0, known: true }
  let pids
  try {
    pids = readdirSync('/proc').filter((d) => /^[0-9]+$/.test(d))
  } catch {
    return { ...out, known: false }
  }
  const prefix = root.endsWith(sep) ? root : root + sep
  const under = (target) => target === root || target.startsWith(prefix)
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue
    const one = inspectProcess(pid, under)
    out.unreadable += one.unreadable
    if (one.vanished) continue
    if (one.writes) out.writers++
    else if (one.holds && !allowed.has(Number(pid))) out.holders++
  }
  out.known = out.unreadable === 0
  return out
}

/** Counts about the root checkout a boot stash or set-aside could touch. No names. */
export function rootInventory(root) {
  const git = (...args) =>
    spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        GIT_OPTIONAL_LOCKS: '0',
        HOME: '/nonexistent',
      },
      maxBuffer: 256 * 1024 * 1024,
    })
  const count = (run) =>
    run.status === 0 ? run.stdout.split('\n').filter(Boolean).length : null
  return {
    trackedDirty: count(git('status', '--porcelain', '--untracked-files=no')),
    untracked: count(git('ls-files', '--others', '--exclude-standard')),
    stashEntries: count(git('stash', 'list')),
  }
}

export async function buildManifest(root, allowedPids = new Set()) {
  const real = realpathSync(root)
  const counters = newCounters()
  const trees = {}
  const admin = {}
  const git = {}
  const rootTree = {}

  const worktrees = join(real, '.worktrees')
  let treeNames = []
  if (realDirectory(worktrees, counters)) {
    try {
      treeNames = readdirSync(worktrees).sort()
    } catch {
      counters.unreadable++
    }
  }
  for (const name of treeNames) {
    const full = join(worktrees, name)
    const c = newCounters()
    const entries = {}
    let st
    try {
      st = lstatSync(full)
    } catch {
      counters.unreadable++
      continue
    }
    if (st.isDirectory()) await walk(full, full, entries, c)
    else {
      // a symlink or file at the top of .worktrees is recorded, never followed
      c.unreadable++
      entries['.'] = await entryOf(full, st, c)
    }
    trees[name] = entries
    add(counters, c)
  }

  const gitDir = join(real, '.git')
  const adminDir = join(gitDir, 'worktrees')
  if (realDirectory(adminDir, counters))
    await walk(adminDir, adminDir, admin, counters)
  if (realDirectory(gitDir, counters))
    await walk(gitDir, gitDir, git, counters, new Set(['worktrees']))
  await walk(real, real, rootTree, counters, SKIP_ROOT)

  const procs = liveProcesses(real, allowedPids)
  const inventory = rootInventory(real)
  return {
    version: 2,
    takenAt: new Date().toISOString(),
    trees,
    admin,
    git,
    rootTree,
    root: inventory,
    summary: {
      trees: treeNames.length,
      ...counters,
      writers: procs.writers,
      holders: procs.holders,
      procUnreadable: procs.unreadable,
      writersKnown: procs.known,
      rootEditsPresent:
        inventory.trackedDirty === null ||
        inventory.untracked === null ||
        inventory.trackedDirty > 0 ||
        inventory.untracked > 0,
    },
  }
}

/** Whether a manifest may be used as proof. Fail closed on every doubt. */
export function certifiable(summary, assumeQuiescent) {
  return (
    summary.unstable === 0 &&
    summary.unreadable === 0 &&
    summary.writers === 0 &&
    summary.holders === 0 &&
    (summary.writersKnown === true || assumeQuiescent === true)
  )
}

const same = (a, b) =>
  JSON.stringify({ ...a, unstable: undefined }) ===
  JSON.stringify({ ...b, unstable: undefined })

/** Aggregate difference between two path maps. Names go to `details` only. */
function compareSet(label, before, now, tally, details) {
  for (const [path, entry] of Object.entries(before)) {
    const other = now[path]
    if (!other) {
      tally.missing++
      details.push(`${label}/${path} missing`)
    } else if (same(entry, other)) tally.same++
    else {
      tally.changed++
      details.push(`${label}/${path} changed`)
    }
  }
  for (const path of Object.keys(now)) {
    if (!before[path]) {
      tally.added++
      details.push(`${label}/${path} added`)
    }
  }
}

/** The part of the shared git bytes a boot must not change. */
function bootKept(path) {
  return (
    path.startsWith('objects/') ||
    path.startsWith('refs/heads/queen-') ||
    path.startsWith('logs/refs/heads/queen-')
  )
}

export function compareManifests(before, now, phase = 'exact') {
  const details = []
  const tally = { same: 0, changed: 0, missing: 0, added: 0 }
  const names = new Set([
    ...Object.keys(before.trees),
    ...Object.keys(now.trees),
  ])
  for (const name of names)
    compareSet(
      `.worktrees/${name}`,
      before.trees[name] ?? {},
      now.trees[name] ?? {},
      tally,
      details,
    )
  compareSet('.git/worktrees', before.admin, now.admin, tally, details)

  const shared = { missing: 0, changed: 0, added: 0 }
  const rootSide = { missing: 0, changed: 0, added: 0 }
  if (phase === 'exact') {
    compareSet('.git', before.git, now.git, tally, details)
    compareSet('root', before.rootTree, now.rootTree, tally, details)
  } else {
    // boot: kept files must survive byte for byte; growth is expected
    const keptBefore = Object.fromEntries(
      Object.entries(before.git).filter(([path]) => bootKept(path)),
    )
    const keptNow = Object.fromEntries(
      Object.entries(now.git).filter(([path]) => bootKept(path)),
    )
    const t = { same: 0, changed: 0, missing: 0, added: 0 }
    compareSet('.git', keptBefore, keptNow, t, details)
    tally.same += t.same
    tally.changed += t.changed
    tally.missing += t.missing
    shared.added = t.added // new objects and new queen refs: not a failure
    const u = { same: 0, changed: 0, missing: 0, added: 0 }
    compareSet('root', before.rootTree, now.rootTree, u, [])
    rootSide.changed = u.changed
    rootSide.missing = u.missing
    rootSide.added = u.added
  }
  return { ...tally, shared, root: rootSide, details }
}

// --- command line -----------------------------------------------------------

function option(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

function options(name) {
  const out = []
  process.argv.forEach((arg, i) => {
    if (arg === `--${name}` && process.argv[i + 1] !== undefined)
      out.push(process.argv[i + 1])
  })
  return out
}

/** The nearest existing ancestor of `path`, canonicalized, plus the rest. */
function canonical(path) {
  let head = resolve(path)
  const rest = []
  for (;;) {
    try {
      return join(realpathSync(head), ...rest.reverse())
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
      rest.push(head.slice(dirname(head).length + 1))
      const parent = dirname(head)
      if (parent === head) throw error
      head = parent
    }
  }
}

/** Refuse an output that is, or resolves to, a place inside the checkout. */
export function checkedOutput(root, out) {
  if (!out) throw new Error('an output file is required')
  const real = realpathSync(root)
  const target = canonical(out)
  if (target === real || target.startsWith(real + sep))
    throw new Error('the output must be outside the checkout')
  try {
    // lstat of the path as GIVEN: a symlink is refused, never followed
    const st = lstatSync(resolve(out))
    if (!st.isFile()) throw new Error('the output exists and is not a file')
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
  return target
}

/** Create the private file: no symlink followed, mode 0600 before any byte. */
function writePrivate(target, text) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  const fd = openSync(
    target,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o600,
  )
  try {
    fchmodSync(fd, 0o600)
    if (!fstatSync(fd).isFile()) throw new Error('the output is not a file')
    writeSync(fd, text)
  } finally {
    closeSync(fd)
  }
}

async function main() {
  const mode = process.argv[2]
  const root = option('root')
  if (!root || (mode !== 'write' && mode !== 'verify')) {
    console.error(
      'usage: worktree-manifest.mjs write|verify --root <checkout> --out|--against <file>',
    )
    process.exit(2)
  }
  const assume = process.argv.includes('--assume-quiescent')
  const allowed = new Set(options('allow-pid').map(Number))
  // validated before anything is read or written
  const target =
    mode === 'write' ? checkedOutput(root, option('out')) : undefined
  const detailsTo = option('details')
    ? checkedOutput(root, option('details'))
    : undefined

  const now = await buildManifest(root, allowed)
  const ok = certifiable(now.summary, assume)
  if (mode === 'write') {
    writePrivate(target, JSON.stringify(now))
    console.log(
      JSON.stringify({ mode, ...now.summary, root: now.root, certifiable: ok }),
    )
    process.exit(0)
  }

  const phase = option('phase') === 'boot' ? 'boot' : 'exact'
  const against = resolve(option('against') ?? '')
  const before = JSON.parse(readFileSync(against, 'utf8'))
  const diff = compareManifests(before, now, phase)
  const rootMoved = diff.root.changed + diff.root.missing + diff.root.added
  if (detailsTo) writePrivate(detailsTo, JSON.stringify(diff.details))
  const beforeOk = certifiable(before.summary, assume)
  const identical =
    diff.changed === 0 &&
    diff.missing === 0 &&
    (phase === 'boot' || diff.added === 0) &&
    beforeOk &&
    ok
  console.log(
    JSON.stringify({
      mode,
      phase,
      same: diff.same,
      changed: diff.changed,
      missing: diff.missing,
      added: diff.added,
      gitAddedAtBoot: diff.shared.added,
      rootChangedAtBoot: rootMoved,
      rootEditsPresent: before.summary.rootEditsPresent === true,
      beforeCertifiable: beforeOk,
      nowCertifiable: ok,
      unreadableNow: now.summary.unreadable,
      unstableNow: now.summary.unstable,
      writersNow: now.summary.writers,
      holdersNow: now.summary.holders,
      identical,
    }),
  )
  process.exit(identical ? 0 : 1)
}

if (import.meta.main) await main()
