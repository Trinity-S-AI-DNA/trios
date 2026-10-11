/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The entry of a worker thread that runs one isolated turn's work
 * (queen-actors-isolate.ts threadWork). It runs one call, posts the result,
 * and is terminated by its parent.
 */

const port = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: (value: unknown) => void
}

// LOADED. Every module of this turn is in once its work module's import has
// settled, either way: this entry ran, and the import was the last load. A
// terminate from then on cannot land on a load, and threadWork terminates
// only after this word (gHashTag/trios#1865).
const sayLoaded = () => port.postMessage({ loaded: true })

port.onmessage = async (event: MessageEvent) => {
  const { module, fn, arg } = event.data as {
    module: string
    fn: string
    arg: unknown
  }
  try {
    const loaded = (await import(module).finally(sayLoaded)) as Record<
      string,
      unknown
    >
    const call = loaded[fn]
    if (typeof call !== 'function')
      throw new Error(`${module} exports no ${fn}`)
    const value = await (call as (a: unknown) => unknown)(arg)
    port.postMessage({ ok: true, value })
  } catch (error) {
    port.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
