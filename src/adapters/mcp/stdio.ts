import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { workflowAccessErrorShape } from '../../access/index.js'
import { isJsonObject, snapshotJsonObject, snapshotJsonValue, stableJsonStringify, type JsonObject, type JsonValue } from '../../core/index.js'
import type { WorkflowMcpCallContext, WorkflowMcpGateway } from './index.js'

export interface WorkflowMcpSdkServerOptions {
  readonly name?: string
  readonly version?: string
  readonly context: (request: { readonly toolName: string; readonly signal: AbortSignal }) => WorkflowMcpCallContext | Promise<WorkflowMcpCallContext>
}

export function createWorkflowMcpSdkServer(gateway: WorkflowMcpGateway, options: WorkflowMcpSdkServerOptions): Server {
  const server = new Server(
    { name: options.name ?? 'agent-dag-workflow', version: options.version ?? '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions: 'Search and describe one published workflow before running its exact id@revision. Tool count is constant and independent of catalog size.',
    },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: gateway.listTools().map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object'; properties?: Record<string, unknown>; required?: string[] },
      outputSchema: tool.outputSchema as { type: 'object'; properties?: Record<string, unknown>; required?: string[] },
      annotations: { readOnlyHint: tool.name === 'workflow_search' || tool.name === 'workflow_describe' || tool.name === 'workflow_run_get' || tool.name === 'workflow_trace' || tool.name === 'workflow_nodes_list' || tool.name === 'workflow_validate' || tool.name === 'workflow_draft_get' || tool.name === 'workflow_diff' },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const context = await options.context({ toolName: request.params.name, signal: extra.signal })
      const args = snapshotJsonObject(request.params.arguments ?? {})
      const result = snapshotJsonValue(await gateway.callTool(request.params.name, args, context))
      const structured = isJsonObject(result) ? result : { value: result }
      return {
        content: [{ type: 'text' as const, text: stableJsonStringify(result) }],
        structuredContent: structured as Record<string, unknown>,
      }
    } catch (error: unknown) {
      const shape = snapshotJsonObject(workflowAccessErrorShape(error) as unknown as JsonObject)
      return {
        isError: true,
        content: [{ type: 'text' as const, text: stableJsonStringify(shape) }],
        structuredContent: shape as Record<string, unknown>,
      }
    }
  })
  return server
}

export async function serveWorkflowMcpStdio(gateway: WorkflowMcpGateway, options: WorkflowMcpSdkServerOptions): Promise<Server> {
  const server = createWorkflowMcpSdkServer(gateway, options)
  await server.connect(new StdioServerTransport())
  return server
}
