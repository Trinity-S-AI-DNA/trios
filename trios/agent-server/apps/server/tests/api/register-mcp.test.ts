/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The MCP tool registration, held against its contract
 * (gHashTag/trinos#1651): the single export of
 * api/services/mcp/register-mcp.ts - registerTools - pinned as it
 * behaves today, so the next change to that file has something to
 * fail against.
 *
 * registerTools walks the registry and registers every tool on the
 * MCP server with its description and schemas. The handler it wraps
 * each tool in carries the pinned contract: the per-request
 * defaultWindowId from the context is injected only when the tool's
 * zod schema accepts a windowId and the caller did not set one
 * (an explicit windowId wins); the observer hears tool start and
 * end with the tool name; a throwing handler answers isError with
 * the internal-error text (measured: "Internal error in <tool>:
 * <message>"); an already-aborted signal answers the framework's
 * abort text as an error. The registry itself refuses duplicate
 * tool names.
 *
 * The MCP server is a recording fake that hands back the registered
 * handlers, which the suite invokes directly. No network, no
 * database, no container.
 */

import { describe, expect, it } from 'bun:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { registerTools } from '../../src/api/services/mcp/register-mcp'
import type { ToolDefinition } from '../../src/tools/framework'
import { defineTool } from '../../src/tools/framework'
import { createRegistry } from '../../src/tools/tool-registry'

interface Registered {
  name: string
  description: string
  handler: (
    args: Record<string, unknown>,
    extra: { signal: AbortSignal },
  ) => Promise<{ content: unknown; isError?: boolean }>
}

interface FakeServer {
  server: McpServer
  registered: Registered[]
}

const fakeServer = (): FakeServer => {
  const registered: Registered[] = []
  return {
    registered,
    server: {
      registerTool: (
        name: string,
        config: { description: string },
        handler: Registered['handler'],
      ) => {
        registered.push({ name, description: config.description, handler })
      },
    } as unknown as McpServer,
  }
}

const windowTool = (name = 'win-tool') =>
  defineTool({
    name,
    description: `The ${name} tool`,
    approvalCategory: 'low' as never,
    input: z.object({ windowId: z.number() }),
    handler: async (
      args: unknown,
      ctx: unknown,
      response: { text: (t: string) => void },
    ) => {
      const { windowId } = args as { windowId?: number }
      void ctx
      response.text(`window:${windowId}`)
    },
  })

const plainTool = (name: string) =>
  defineTool({
    name,
    description: `The ${name} tool`,
    approvalCategory: 'low' as never,
    input: z.object({}),
    handler: async (
      args: unknown,
      ctx: unknown,
      response: { text: (t: string) => void },
    ) => {
      void args
      void ctx
      response.text(`${name} ran`)
    },
  })

const baseCtx = { browser: {} as never, directories: {} }

describe('registerTools', () => {
  it('registers every registry tool on the server with its description', () => {
    const { server, registered } = fakeServer()
    registerTools(
      server,
      createRegistry([
        windowTool('tool-a'),
        plainTool('tool-b'),
      ] as ToolDefinition[]),
      baseCtx as never,
    )
    expect(registered.map((r) => r.name)).toEqual(['tool-a', 'tool-b'])
    expect(registered[0].description).toBe('The tool-a tool')
  })

  it('injects the default windowId only when the schema accepts one and none was set', async () => {
    const { server, registered } = fakeServer()
    registerTools(server, createRegistry([windowTool()] as ToolDefinition[]), {
      ...baseCtx,
      defaultWindowId: 42,
    } as never)
    const injected = (await registered[0].handler(
      {},
      { signal: new AbortController().signal },
    )) as { content: Array<{ text: string }> }
    expect(injected.content[0].text).toBe('window:42')
  })

  it('lets an explicit windowId win over the default', async () => {
    const { server, registered } = fakeServer()
    registerTools(server, createRegistry([windowTool()] as ToolDefinition[]), {
      ...baseCtx,
      defaultWindowId: 42,
    } as never)
    const explicit = (await registered[0].handler(
      { windowId: 7 },
      { signal: new AbortController().signal },
    )) as { content: Array<{ text: string }> }
    expect(explicit.content[0].text).toBe('window:7')
  })

  it('does not inject into a tool whose schema has no windowId field', async () => {
    const { server, registered } = fakeServer()
    registerTools(
      server,
      createRegistry([plainTool('no-window')] as ToolDefinition[]),
      { ...baseCtx, defaultWindowId: 42 } as never,
    )
    const result = (await registered[0].handler(
      {},
      { signal: new AbortController().signal },
    )) as { content: Array<{ text: string }> }
    expect(result.content[0].text).toBe('no-window ran')
  })

  it('answers a throwing handler with isError and the internal-error text', async () => {
    const { server, registered } = fakeServer()
    const throwing = defineTool({
      name: 'boom',
      description: 'The boom tool',
      approvalCategory: 'low' as never,
      input: z.object({}),
      handler: async () => {
        throw new Error('kaboom')
      },
    })
    registerTools(
      server,
      createRegistry([throwing as ToolDefinition[]] as never),
      baseCtx as never,
    )
    const result = await registered[0].handler(
      {},
      { signal: new AbortController().signal },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      { type: 'text', text: 'Internal error in boom: kaboom' },
    ])
  })

  it('answers an already-aborted signal with the framework abort text', async () => {
    const { server, registered } = fakeServer()
    registerTools(
      server,
      createRegistry([plainTool('aborted-tool')] as ToolDefinition[]),
      baseCtx as never,
    )
    const controller = new AbortController()
    controller.abort()
    const result = await registered[0].handler(
      {},
      { signal: controller.signal },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      { type: 'text', text: 'Request was aborted' },
    ])
  })

  it('tells the observer about tool start and end', async () => {
    const events: string[] = []
    const { server, registered } = fakeServer()
    registerTools(
      server,
      createRegistry([plainTool('observed')] as ToolDefinition[]),
      {
        ...baseCtx,
        observer: {
          onToolStart: async (e: { toolName: string }) => {
            events.push(`start:${e.toolName}`)
          },
          onToolEnd: async (e: { error?: string }) => {
            events.push(`end:${e.error ?? 'ok'}`)
          },
        },
      } as never,
    )
    await registered[0].handler({}, { signal: new AbortController().signal })
    expect(events).toEqual(['start:observed', 'end:ok'])
  })
})
