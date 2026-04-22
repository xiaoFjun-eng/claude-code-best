import { z } from 'zod/v4'
import {
  ensureConnectedClient,
  fetchResourcesForClient,
} from 'src/services/mcp/client.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { errorMessage } from 'src/utils/errors.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { logMCPError } from 'src/utils/log.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { isOutputLineTruncated } from 'src/utils/terminal.js'
import { DESCRIPTION, LIST_MCP_RESOURCES_TOOL_NAME, PROMPT } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.object({
    server: z
      .string()
      .optional()
      .describe('可选的服务器名称，用于按服务器筛选资源'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.array(
    z.object({
      uri: z.string().describe('资源 URI'),
      name: z.string().describe('资源名称'),
      mimeType: z.string().optional().describe('资源的 MIME 类型'),
      description: z.string().optional().describe('资源描述'),
      server: z.string().describe('提供此资源的服务器'),
    }),
  ),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const ListMcpResourcesTool = buildTool({
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.server ?? ''
  },
  shouldDefer: true,
  name: LIST_MCP_RESOURCES_TOOL_NAME,
  searchHint: '列出已连接 MCP 服务器中的资源',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async call(input, { options: { mcpClients } }) {
    const { server: targetServer } = input

    const clientsToProcess = targetServer
      ? mcpClients.filter(client => client.name === targetServer)
      : mcpClients

    if (targetServer && clientsToProcess.length === 0) {
      throw new Error(
        `未找到服务器“${targetServer}”。可用的服务器：${mcpClients.map(c => c.name).join(', ')}`,
      )
    }

    // fetchResourcesForClient 是 LRU 缓存的（按服务器名称），并且已经在启动预取时预热。
    // 缓存在 onclose 和 resources/list_changed 通知时失效，因此结果永远不会过时。
    // ensureConnectedClient 在健康状态下是无操作（命中 memoize），但在 onclose 后它会返回一个新的连接，以便重新获取成功。
    const results = await Promise.all(
      clientsToProcess.map(async client => {
        if (client.type !== 'connected') return []
        try {
          const fresh = await ensureConnectedClient(client)
          return await fetchResourcesForClient(fresh)
        } catch (error) {
          // 一个服务器的重连失败不应使整个结果失效。
          logMCPError(client.name, errorMessage(error))
          return []
        }
      }),
    )

    return {
      data: results.flat(),
    }
  },
  renderToolUseMessage,
  userFacingName: () => 'listMcpResources',
  renderToolResultMessage,
  isResultTruncated(output: Output): boolean {
    return isOutputLineTruncated(jsonStringify(output))
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    if (!content || content.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content:
          '未找到资源。即使没有资源，MCP 服务器可能仍然提供工具。',
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(content),
    }
  },
} satisfies ToolDef<InputSchema, Output>)