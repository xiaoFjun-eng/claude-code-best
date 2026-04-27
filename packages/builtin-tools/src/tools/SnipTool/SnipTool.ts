import { z } from 'zod/v4'
import type { ToolResultBlockParam } from 'src/Tool.js'
import { buildTool } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { SNIP_TOOL_NAME } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    message_ids: z
      .array(z.string())
      .describe(
        '从历史记录中裁剪的消息ID。裁剪后的消息会被替换为简短摘要。',
      ),
    reason: z
      .string()
      .optional()
      .describe(
        '这些消息被裁剪的原因。用于替换摘要中。',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type SnipInput = z.infer<InputSchema>

type SnipOutput = { snipped_count: number; summary: string }

export const SnipTool = buildTool({
  name: SNIP_TOOL_NAME,
  searchHint: '裁剪 修剪 历史记录 移除旧消息 压缩上下文',
  maxResultSizeChars: 5_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return '从对话历史中裁剪消息以释放上下文空间'
  },
  async prompt() {
    return `从对话历史中裁剪消息以释放上下文窗口空间。裁剪后的消息会被替换为紧凑摘要，这样你无需完整内容也能了解发生了什么。\n\n在以下情况使用：\n- 上下文快满了，需要腾出空间\n- 较早的消息包含不再需要完整保留的大型工具输出\n- 你想将较长的探索序列压缩成摘要\n\n使用指南：\n- 只裁剪你确信不再需要逐字查看的消息\n- 替换摘要会保留关键事实（文件路径、决策、发现的错误）\n- 裁剪操作不可逆——原始内容将从上下文中移除`
  },

  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },

  userFacingName() {
    return 'Snip'
  },

  renderToolUseMessage(input: Partial<SnipInput>) {
    const count = input.message_ids?.length ?? 0
    return `裁剪：${count} 条消息${count !== 1 ? 's' : ''}`
  },

  mapToolResultToToolResultBlockParam(
    content: SnipOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `已裁剪 ${content.snipped_count} 条消息。摘要：${content.summary}`,
    }
  },

  async call(input: SnipInput) {
    // 裁剪实现由查询引擎的投影系统处理。工
    // 具调用本身记录意图；查询引擎拦截裁
    // 剪工具结果并相应调整其消息投影。
    return {
      data: {
        snipped_count: input.message_ids.length,
        summary: input.reason ?? `已裁剪 ${input.message_ids.length} 条消息`,
      },
    }
  },
})
