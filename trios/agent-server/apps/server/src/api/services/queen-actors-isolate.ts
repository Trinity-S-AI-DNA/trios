/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Where an isolated turn's work runs (actors.t27 section 8, t27#7900).
 * An OS thread, for CPU-bound work of this build. An OS process, for code a
 * bee wrote or a compiler on its work. The OS preempts both, so neither holds
 * the host's thread. Only the process is certain to stop: `stop` on a thread
 * is `worker.terminate()`, and a terminated worker thread that spins keeps
 * running (measured on Bun 1.3.11, still counting 200 ms after terminate), so
 * the card counts a thread kill as an abandon (kill_effect). The card decides
 * which one a turn gets (turn_isolation).
 */

import type { IsolatedWork } from './queen-actors'

const THREAD_ENTRY = new URL('./queen-actor-thread.ts', import.meta.url).href

/**
 * Run `fn` exported from `module` in a fresh worker thread. The thread is
 * terminated when the work ends or is stopped, so one turn never inherits
 * another's state. A terminate is not certain to stop it (see above).
 *
 * THE THREAD IS ENDED ONLY ONCE IT HAS LOADED (gHashTag/trios#1865). Bun
 * 1.3.6, the version CI and the production image pin, crashes the whole
 * process when a worker is terminated while its modules are still being
 * transpiled: a transpiler job writes into the source map table of the
 * worker that is gone (Segmentation fault at 0xFFFFFFFFFFFFFFF8, the crash
 * the PgLink beat thread hit, trios#1813). A stop within 30 ms of the start
 * did exactly that: 5 of 20 runs of queen-actors-thread-stop.test.ts crashed
 * on 1.3.6. So every terminate waits for the thread's word that its entry and
 * its work module are in, or for the error or close that ends a load that
 * failed, and the thread is terminated once. No timeout: those three are
 * every way a load ends, save a work module whose top-level await never
 * settles, and such a thread is never ended (no work module here has one).
 * A stop asked for during the load lands as soon as it ends. When to stop is
 * still the card's (kill_effect, escalation).
 */
export function threadWork(
  module: string,
  fn: string,
  arg: unknown,
): IsolatedWork {
  const worker = new Worker(THREAD_ENTRY)
  let loadEnded: () => void = () => {}
  const loaded = new Promise<void>((settle) => {
    loadEnded = settle
  })
  worker.addEventListener('error', () => loadEnded())
  worker.addEventListener('close', () => loadEnded())
  let ending = false
  const end = () => {
    if (ending) return
    ending = true
    void loaded.then(() => worker.terminate())
  }
  const result = new Promise<unknown>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as {
        loaded?: boolean
        ok: boolean
        value?: unknown
        error?: string
      }
      if (data.loaded) return loadEnded()
      end()
      if (data.ok) resolve(data.value)
      else reject(new Error(data.error ?? 'thread work failed'))
    }
    worker.onerror = (event) => {
      end()
      reject(new Error(event.message))
    }
  })
  worker.postMessage({ module, fn, arg })
  return { result, stop: end }
}

/**
 * Run `argv` as a child process. Its stdout is the result when it exits 0.
 *
 * THE CHILD LEADS ITS OWN PROCESS GROUP (`detached`), and every signal goes
 * to the group. A kill of the one pid spawned here used to leave that
 * process's own children running: `sh -c 'sleep 30 & wait'` killed with
 * SIGKILL to the shell left its sleep alive, holding whatever the turn held
 * (turn_stop.t27 escalation, ESC_KILL_GROUP). The turn's abort (`signal`) is
 * SIGTERM to the group, so the work may clean up; `stop`, the escalation, is
 * SIGKILL to the group.
 */
export function processWork(
  argv: string[],
  cwd?: string,
  signal?: AbortSignal,
): IsolatedWork {
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  })
  const group = (sig: 'SIGTERM' | 'SIGKILL') => {
    try {
      process.kill(-proc.pid, sig)
    } catch {
      // the group is gone: every member has exited
    }
  }
  const onAbort = () => group('SIGTERM')
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  const result = (async () => {
    try {
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (code !== 0) throw new Error(`exit ${code}: ${err.slice(0, 200)}`)
      return out
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  })()
  return { result, stop: () => group('SIGKILL') }
}
