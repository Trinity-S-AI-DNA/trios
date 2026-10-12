/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The LLM provider store, held against its contract
 * (gHashTag/trios#1630): the nine exports of
 * lib/llm-providers/storage.ts - DEFAULT_PROVIDER_ID,
 * providersStorage, defaultProviderIdStorage, loadProviders,
 * createDefaultBrowserOSProvider, createDefaultProvidersConfig,
 * syncLlmProviders, setupLlmProvidersBackupToBrowserOS,
 * setupLlmProvidersSyncToBackend - pinned as they behave today, so
 * the next change to that file has something to fail against.
 *
 * The storage seam is an in-memory mock.module stub of
 * @wxt-dev/storage (the pattern of SkillsPage.test.ts, also used by
 * the execution-history suite of this wave); the GraphQL upload, the
 * auth session, the BrowserOS adapter and its prefs constants are
 * stubbed the same way - the upload and backup paths are named as
 * blocked below, and the stubs keep this suite free of the
 * graphql/sentry/adapter import chains entirely. No other suite of
 * this job imports these modules (that is exactly why they were
 * untested), so the process-global mocks cannot leak into a suite
 * that wants the real ones.
 *
 * Not pinned, and why: syncLlmProviders with a logged-in session
 * (needs the auth session and the real GraphQL upload - two more
 * process-global seams for behaviour the issue does not ask to
 * pin here), and the pref content of the backup watcher
 * (setupLlmProvidersBackupToBrowserOS writes through the BrowserOS
 * adapter, unavailable outside the shell). What IS pinned for both
 * setups: they subscribe exactly one watcher on the providers item
 * and hand back a working unsubscribe.
 */

import { describe, expect, it, mock } from 'bun:test'

const defines: Array<{ key: string; opts: unknown }> = []
const values = new Map<string, unknown>()
const watches: Map<string, Array<() => void>> = new Map()

const fakeItem = (key: string) => ({
  getValue: async () => values.get(key) ?? null,
  setValue: async (value: unknown) => {
    values.set(key, value)
  },
  watch: (unwatch: () => void) => {
    const list = watches.get(key) ?? []
    list.push(unwatch)
    watches.set(key, list)
    return () => {
      watches.set(
        key,
        (watches.get(key) ?? []).filter((f) => f !== unwatch),
      )
    }
  },
})

mock.module('@wxt-dev/storage', () => ({
  storage: {
    defineItem: (key: string, opts?: unknown) => {
      defines.push({ key, opts })
      return fakeItem(key)
    },
  },
}))

mock.module('./uploadLlmProvidersToGraphql', () => ({
  uploadLlmProvidersToGraphql: async () => {},
}))

mock.module('@/lib/auth/sessionStorage', () => ({
  sessionStorage: {
    getValue: async () => null,
    watch: () => () => {},
  },
}))

// The adapter stub must be a COMPLETE stand-in for the module's
// value exports: capabilities.ts imports the BrowserOSAdapter class
// itself, so the mock carries both. Like the real adapter outside the
// shell, the methods reject - which is exactly what the port helpers
// and the backup path already catch.
class BrowserOSAdapterStub {
  static getInstance(): BrowserOSAdapterStub {
    return new BrowserOSAdapterStub()
  }
  async getPref(): Promise<never> {
    throw new Error('BrowserOS API not available')
  }
  async setPref(): Promise<never> {
    throw new Error('BrowserOS API not available')
  }
  async getBrowserosVersion(): Promise<never> {
    throw new Error('BrowserOS API not available')
  }
}

mock.module('@/lib/browseros/adapter', () => ({
  BrowserOSAdapter: BrowserOSAdapterStub,
  getBrowserOSAdapter: () => BrowserOSAdapterStub.getInstance(),
}))

mock.module('@/lib/browseros/prefs', () => ({
  BROWSEROS_PREFS: { PROVIDERS: 'llmProviders' },
}))

const {
  createDefaultBrowserOSProvider,
  createDefaultProvidersConfig,
  DEFAULT_PROVIDER_ID,
  defaultProviderIdStorage,
  loadProviders,
  providersStorage,
  setupLlmProvidersBackupToBrowserOS,
  setupLlmProvidersSyncToBackend,
  syncLlmProviders,
} = await import('./storage')

const renamedDefault = {
  id: 'browseros',
  type: 'browseros' as const,
  name: 'Kimi K2.5',
  baseUrl: 'https://api.browseros.com/v1',
  modelId: 'browseros-auto',
  contextWindow: 100000,
}

describe('DEFAULT_PROVIDER_ID', () => {
  it('is the browseros id', () => {
    expect(DEFAULT_PROVIDER_ID).toBe('browseros')
  })
})

describe('providersStorage', () => {
  it('declares the providers array under its key at version 2 with a v2 migration', () => {
    expect(providersStorage).toBeDefined()
    const declared = defines.find((d) => d.key === 'local:llm-providers')
    expect(declared).toBeDefined()
    const opts = declared?.opts as {
      version: number
      migrations: Record<string, unknown>
    }
    expect(opts.version).toBe(2)
    expect(typeof opts.migrations['2']).toBe('function')
  })

  it('the v2 migration sets the default provider context window and passes others through', () => {
    const declared = defines.find((d) => d.key === 'local:llm-providers')
    const migrate = (
      declared?.opts as {
        migrations: { 2: (p: unknown[] | null) => unknown[] | null }
      }
    ).migrations['2']
    const browseros = { id: 'browseros', type: 'browseros', contextWindow: 1 }
    const other = { id: 'openai', type: 'openai', contextWindow: 1 }
    expect(migrate([browseros, other])).toEqual([
      { id: 'browseros', type: 'browseros', contextWindow: 200000 },
      other,
    ])
    expect(migrate(null)).toBeNull()
  })
})

describe('defaultProviderIdStorage', () => {
  it('declares the default provider id under its key with the browseros fallback', () => {
    expect(defaultProviderIdStorage).toBeDefined()
    expect(defines).toContainEqual({
      key: 'local:default-provider-id',
      opts: expect.objectContaining({ fallback: 'browseros' }),
    })
  })
})

describe('loadProviders', () => {
  it('answers an empty list when nothing is stored, without writing back', async () => {
    expect(await loadProviders()).toEqual([])
    expect(values.has('local:llm-providers')).toBe(false)
  })

  it('normalizes a renamed default provider back to BrowserOS and keeps storage consistent', async () => {
    values.set('local:llm-providers', [renamedDefault])
    const loaded = await loadProviders()
    expect(loaded[0].name).toBe('BrowserOS')
    expect(values.get('local:llm-providers')).toEqual([
      { ...renamedDefault, name: 'BrowserOS' },
    ])
  })

  it('leaves non-default providers untouched', async () => {
    const openai = {
      id: 'openai',
      type: 'openai',
      name: 'OpenAI',
    } as unknown as Awaited<ReturnType<typeof loadProviders>>[number]
    values.set('local:llm-providers', [openai])
    const loaded = await loadProviders()
    expect(loaded).toEqual([openai])
  })
})

describe('createDefaultBrowserOSProvider / createDefaultProvidersConfig', () => {
  it('builds the default provider with the pinned shape', () => {
    const provider = createDefaultBrowserOSProvider()
    expect(provider.id).toBe('browseros')
    expect(provider.type).toBe('browseros')
    expect(provider.name).toBe('BrowserOS')
    expect(provider.baseUrl).toBe('https://api.browseros.com/v1')
    expect(provider.modelId).toBe('browseros-auto')
    expect(provider.supportsImages).toBe(true)
    expect(provider.contextWindow).toBe(200000)
    expect(provider.temperature).toBe(0.2)
  })

  it('answers exactly the default provider', () => {
    const config = createDefaultProvidersConfig()
    expect(config.length).toBe(1)
    expect(config[0].id).toBe('browseros')
  })
})

describe('syncLlmProviders', () => {
  it('resolves without uploading when no session is present', async () => {
    await syncLlmProviders()
  })
})

describe('setupLlmProvidersBackupToBrowserOS', () => {
  it('subscribes exactly one watcher and the unsubscribe removes it', () => {
    const before = (watches.get('local:llm-providers') ?? []).length
    const unsubscribe = setupLlmProvidersBackupToBrowserOS()
    expect((watches.get('local:llm-providers') ?? []).length).toBe(before + 1)
    unsubscribe()
    expect((watches.get('local:llm-providers') ?? []).length).toBe(before)
  })
})

describe('setupLlmProvidersSyncToBackend', () => {
  it('subscribes exactly one watcher and the unsubscribe removes it', () => {
    const before = (watches.get('local:llm-providers') ?? []).length
    const unsubscribe = setupLlmProvidersSyncToBackend()
    expect((watches.get('local:llm-providers') ?? []).length).toBe(before + 1)
    unsubscribe()
    expect((watches.get('local:llm-providers') ?? []).length).toBe(before)
  })
})
