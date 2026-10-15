/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The New Provider dialog, held against its contract
 * (gHashTag/trios#1490): the two exports of
 * entrypoints/app/ai-settings/NewProviderDialog.tsx -
 * providerFormSchema and NewProviderDialog - pinned as they behave
 * today, so the next change to that file has something to fail
 * against.
 *
 * The adapter seam: this group runs every file in one bun process,
 * where mock.module is process-global, and the llm-providers
 * storage suite of the same job replaces @/lib/browseros/adapter
 * with a stand-in that carries no getVersion - while metrics/track.ts,
 * which this subject imports, calls adapter.getVersion() at module
 * scope. Whichever of the two suites runs first, this file must
 * still load, so it installs its own complete stand-in before
 * importing the subject: every value export of the adapter module,
 * with every instance method any consumer in the app calls. Outside
 * the BrowserOS shell the real adapter rejects, and every caller
 * catches that, so the stand-in rejects the same way.
 *
 * Not pinned, and why (issue User Story 2): NewProviderDialog
 * itself. The component renders through Radix UI portals and lives
 * in the BrowserOS shell - the useCapabilities and useAgentServerUrl
 * hooks, and the chrome.tabs call the setup guide makes - and this
 * group has no DOM renderer, so the dialog's rendering cannot be
 * exercised here. What every submit of that dialog passes through,
 * the schema, is pinned below: which provider kinds it admits, the
 * credentials each kind demands, and the bounds on the shared
 * fields.
 */

import { describe, expect, it, mock } from 'bun:test'

class AdapterStandIn {
  static getInstance(): AdapterStandIn {
    return new AdapterStandIn()
  }
  async getVersion(): Promise<never> {
    throw new Error('BrowserOS API not available')
  }
  async getBrowserosVersion(): Promise<never> {
    throw new Error('BrowserOS API not available')
  }
  async logMetric(): Promise<never> {
    throw new Error('BrowserOS API not available')
  }
  async getPref(): Promise<never> {
    throw new Error('BrowserOS API not available')
  }
  async setPref(): Promise<never> {
    throw new Error('BrowserOS API not available')
  }
}

mock.module('@/lib/browseros/adapter', () => ({
  SCREENSHOT_SIZES: { small: 512, medium: 768, large: 1028 },
  BrowserOSAdapter: AdapterStandIn,
  getBrowserOSAdapter: () => AdapterStandIn.getInstance(),
}))

const { providerFormSchema } = await import('./NewProviderDialog')

const openaiFixture = {
  type: 'openai',
  name: 'Work OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  modelId: 'gpt-4o',
  apiKey: 'sk-test',
  supportsImages: false,
  contextWindow: 128000,
  temperature: 0.2,
}

const parse = (values: unknown) => providerFormSchema.safeParse(values)

const acceptedValues = (values: unknown) => {
  const result = parse(values)
  expect(result.success).toBe(true)
  if (result.success) {
    return result.data
  }
  throw new Error('expected the schema to accept these values')
}

const refusedIssues = (values: unknown) => {
  const result = parse(values)
  expect(result.success).toBe(false)
  if (!result.success) {
    return result.error.issues
  }
  throw new Error('expected the schema to refuse these values')
}

describe('NewProviderDialogTsxContract', () => {
  it('pins providerFormSchema: a complete provider passes and round-trips, each provider kind is gated on the credentials that kind needs, and the shared field bounds hold', () => {
    // A complete standard provider is accepted, values intact.
    const good = acceptedValues(openaiFixture)
    expect(good.type).toBe('openai')
    expect(good.name).toBe('Work OpenAI')
    expect(good.baseUrl).toBe('https://api.openai.com/v1')
    expect(good.modelId).toBe('gpt-4o')
    expect(good.supportsImages).toBe(false)
    expect(good.contextWindow).toBe(128000)
    expect(good.temperature).toBe(0.2)

    // A standard provider without a base URL is refused at that field.
    expect(refusedIssues({ ...openaiFixture, baseUrl: undefined })).toEqual([
      expect.objectContaining({
        message: 'Base URL is required',
        path: ['baseUrl'],
      }),
    ])

    // A base URL that is not http(s) is refused as invalid.
    const ftpIssues = refusedIssues({
      ...openaiFixture,
      baseUrl: 'ftp://example.com/v1',
    })
    expect(ftpIssues[0]?.message).toBe('Must be a valid URL')
    expect(ftpIssues[0]?.path).toEqual(['baseUrl'])

    // Azure: a resource name can stand in for the base URL...
    acceptedValues({
      ...openaiFixture,
      type: 'azure',
      baseUrl: undefined,
      resourceName: 'my-resource',
      apiKey: 'az-key',
    })

    // ...and so can a base URL, but neither spares the API key.
    acceptedValues({
      ...openaiFixture,
      type: 'azure',
      apiKey: 'az-key',
    })
    expect(
      refusedIssues({
        ...openaiFixture,
        type: 'azure',
        baseUrl: undefined,
        resourceName: 'my-resource',
        apiKey: undefined,
      }),
    ).toEqual([
      expect.objectContaining({
        message: 'API Key is required for Azure',
        path: ['apiKey'],
      }),
    ])

    // Azure with neither a resource name nor a base URL is refused
    // at the resource name field.
    const azureNothing = refusedIssues({
      ...openaiFixture,
      type: 'azure',
      baseUrl: undefined,
      apiKey: 'az-key',
    })
    expect(azureNothing[0]?.message).toBe(
      'Either Resource Name or Base URL is required',
    )
    expect(azureNothing[0]?.path).toEqual(['resourceName'])

    // Bedrock demands all three AWS credentials, each at its own field.
    expect(
      refusedIssues({
        ...openaiFixture,
        type: 'bedrock',
        baseUrl: undefined,
      }).map((issue) => [issue.path, issue.message]),
    ).toEqual([
      [['accessKeyId'], 'Access Key ID is required'],
      [['secretAccessKey'], 'Secret Access Key is required'],
      [['region'], 'Region is required'],
    ])
    acceptedValues({
      ...openaiFixture,
      type: 'bedrock',
      baseUrl: undefined,
      accessKeyId: 'AKIA-EXAMPLE',
      secretAccessKey: 'secret',
      region: 'us-east-1',
    })

    // OAuth providers need no credentials at all: the server holds
    // the token, so even without a base URL they pass.
    for (const type of [
      'chatgpt-pro',
      'github-copilot',
      'qwen-code',
    ] as const) {
      acceptedValues({
        ...openaiFixture,
        type,
        baseUrl: undefined,
        apiKey: undefined,
      })
    }

    // The schema itself does not demand an API key from the
    // keyless local kinds once a base URL is present.
    acceptedValues({
      ...openaiFixture,
      type: 'ollama',
      baseUrl: 'http://localhost:11434',
      apiKey: undefined,
    })

    // Only the fifteen provider kinds the dialog knows are admitted.
    const typeIssue = refusedIssues({
      ...openaiFixture,
      type: 'not-a-provider',
    })[0] as
      | { path: Array<string | number>; options?: Array<string> }
      | undefined
    expect(typeIssue?.path).toEqual(['type'])
    expect([...(typeIssue?.options ?? [])].sort()).toEqual(
      [
        'anthropic',
        'azure',
        'bedrock',
        'browseros',
        'chatgpt-pro',
        'github-copilot',
        'google',
        'lmstudio',
        'moonshot',
        'ollama',
        'openai',
        'openai-compatible',
        'openrouter',
        'qwen-code',
        'zai',
      ].sort(),
    )

    // The name is required and capped at fifty characters.
    const emptyName = refusedIssues({ ...openaiFixture, name: '' })[0]
    expect(emptyName?.message).toBe('Provider name is required')
    expect(emptyName?.path).toEqual(['name'])
    expect(
      refusedIssues({ ...openaiFixture, name: 'x'.repeat(51) })[0]?.path,
    ).toEqual(['name'])

    // The model id is required.
    expect(refusedIssues({ ...openaiFixture, modelId: '' })[0]?.path).toEqual([
      'modelId',
    ])

    // The context window is an integer between 1 000 and 2 000 000.
    for (const contextWindow of [999, 1000.5, 2000001]) {
      refusedIssues({ ...openaiFixture, contextWindow })
    }
    for (const contextWindow of [1000, 2000000]) {
      acceptedValues({ ...openaiFixture, contextWindow })
    }

    // The temperature stays between 0 and 2.
    for (const temperature of [-0.1, 2.5]) {
      refusedIssues({ ...openaiFixture, temperature })
    }
    for (const temperature of [0, 2]) {
      acceptedValues({ ...openaiFixture, temperature })
    }

    // The image support flag must be a real boolean.
    refusedIssues({
      ...openaiFixture,
      supportsImages: 'yes' as unknown as boolean,
    })
  })
})
