// 模型提供者包的核心消息类型。从 src/t
// ypes/message.ts 移出，以解耦 API 层与主项目。

import type { UUID } from 'crypto'
import type {
  ContentBlockParam,
  ContentBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

/** * 基础消息类型，包含判别字段 `type` 和通用属性。
 * 各个消息子类型（UserMessage、AssistantMessage 等）通过更具体的 `type` 字面量和额外字段扩展此类型。 */
export type MessageType = 'user' | 'assistant' | 'system' | 'attachment' | 'progress' | 'grouped_tool_use' | 'collapsed_read_search'

/** 消息内容数组 message.content 中的单个内容元素。
 * ContentBlockParam代表发送的消息内容，ContentBlock代表接收的消息内容 */
export type ContentItem = ContentBlockParam | ContentBlock

export type MessageContent = string | ContentBlockParam[] | ContentBlock[]

/** * 类型化内容数组 —— 用于更具体的消息子类型，以便 `message.content[0]` 解析为 `ContentItem` 而非 `string | ContentBlockParam | ContentBlock`。 */
export type TypedMessageContent = ContentItem[]

export type Message = {
  type: MessageType // 判别消息形态：决定 UI 渲染、是否送入模型、以及 `normalizeMessagesForAPI` 等路径（user 含真人输入与 tool_result 等）
  uuid: UUID // 会话内稳定 id：合并相邻轮次、内容里 `[id:…]` 引用、去重/剥离块、压缩边界锚点（compactMetadata）等
  isMeta?: boolean // 合成用户消息（恢复提示、停止钩子注入、PTL 重试标记等）：Messages 列表常过滤；`isHumanTurn` 排除；与另一消息合并时可继承 uuid
  isCompactSummary?: boolean // 上下文压缩产生的摘要用户消息：`sessionStorage`/恢复流程跳过或特殊处理，避免当作用户原话
  toolUseResult?: unknown // 与 `type:'user'` 并存时表示工具结果侧信道：和 `message.content` 里 tool_result 块对应；用于 `isHumanTurn` 判别、MCP 包装、工具结果截断检测、GroupedToolUse 展示
  isVisibleInTranscriptOnly?: boolean // 仅转录/导出可见：映射到 analytics/SDK 的 synthetic，与 `isMeta` 类似但可见性策略不同（如压缩边界提示）
  attachment?: {
    // `type:'attachment'` 的载荷；主工程中有更细的联合类型（记忆、计划、钩子等）
    type: string // 附件语义子类型（如 deferred_tools_delta、mcp_instructions_delta、hook 事件名等）
    toolUseID?: string // 与对应 `tool_use` 或 PreToolUse/PostToolUse 钩子消息配对
    [key: string]: unknown
    addedNames: string[] // 本轮新增的工具名或 MCP 资源名（delta 附件）
    addedLines: string[] // 与 addedNames 对应的可读展示行（如格式化的指令块），供扫描/渲染
    removedNames: string[] // 本轮移除的名称列表（与 added* 对称）
  }
  message?: {
    role?: string // Anthropic/API 角色：user / assistant（序列化进请求体）
    id?: string // 服务商返回的消息 id（流式 delta 关联、续写等）
    content?: MessageContent // 文本或内容块数组（text、tool_use、tool_result、thinking 等），即 API `messages[].content`
    usage?: BetaUsage | Record<string, unknown> // 助手消息上的 token 用量（input/output/cache 等），stats、预算、权限 UI 会读
    [key: string]: unknown
  }
  [key: string]: unknown // 允许各子类型扩展字段而不破坏结构（与主工程 `src/types/message.ts` 的交叉类型配合）
}

export type AssistantMessage = Message & {
  type: 'assistant'
  message: NonNullable<Message['message']>
}
export type AttachmentMessage<T = { type: string; [key: string]: unknown }> = Message & { type: 'attachment'; attachment: T }
export type ProgressMessage<T = unknown> = Message & { type: 'progress'; data: T }
// 特指 subtype: 'local_command'，能进模型上下文。
export type SystemLocalCommandMessage = Message & { type: 'system' }
// 通常的系统信息
export type SystemMessage = Message & { type: 'system' }
export type UserMessage = Message & {
  type: 'user'
  message: NonNullable<Message['message']>
  imagePasteIds?: number[]
}
export type NormalizedUserMessage = UserMessage
export type RequestStartEvent = { type: string; [key: string]: unknown }
export type StreamEvent = { type: string; [key: string]: unknown }
export type SystemCompactBoundaryMessage = Message & {
  type: 'system'
  compactMetadata: {
    preservedSegment?: {
      headUuid: UUID
      tailUuid: UUID
      anchorUuid: UUID
      [key: string]: unknown
    }
    [key: string]: unknown
  }
}
export type TombstoneMessage = Message
export type ToolUseSummaryMessage = Message
export type MessageOrigin = string
export type CompactMetadata = Record<string, unknown>
export type SystemAPIErrorMessage = Message & { type: 'system' }
export type SystemFileSnapshotMessage = Message & { type: 'system' }
export type NormalizedAssistantMessage<T = unknown> = AssistantMessage
export type NormalizedMessage = Message
export type PartialCompactDirection = string

export type StopHookInfo = {
  command?: string
  durationMs?: number
  [key: string]: unknown
}

export type SystemAgentsKilledMessage = Message & { type: 'system' }
export type SystemApiMetricsMessage = Message & { type: 'system' }
export type SystemAwaySummaryMessage = Message & { type: 'system' }
export type SystemBridgeStatusMessage = Message & { type: 'system' }
export type SystemInformationalMessage = Message & { type: 'system' }
export type SystemMemorySavedMessage = Message & { type: 'system' }
export type SystemMessageLevel = string
export type SystemMicrocompactBoundaryMessage = Message & { type: 'system' }
export type SystemPermissionRetryMessage = Message & { type: 'system' }
export type SystemScheduledTaskFireMessage = Message & { type: 'system' }

export type SystemStopHookSummaryMessage = Message & {
  type: 'system'
  subtype: string
  hookLabel: string
  hookCount: number
  totalDurationMs?: number
  hookInfos: StopHookInfo[]
}

export type SystemTurnDurationMessage = Message & { type: 'system' }

export type GroupedToolUseMessage = Message & {
  type: 'grouped_tool_use'
  toolName: string
  messages: NormalizedAssistantMessage[]
  results: NormalizedUserMessage[]
  displayMessage: NormalizedAssistantMessage | NormalizedUserMessage
}

// CollapsibleMessage 由主项目的 CollapsedReadSearchGroup 使用。
export type CollapsibleMessage =
  | AssistantMessage
  | UserMessage
  | GroupedToolUseMessage

export type HookResultMessage = Message
export type SystemThinkingMessage = Message & { type: 'system' }
