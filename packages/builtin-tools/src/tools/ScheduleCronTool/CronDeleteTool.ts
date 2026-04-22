import { z } from 'zod/v4'
import type { ValidationResult } from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import {
  getCronFilePath,
  listAllCronTasks,
  removeCronTasks,
} from 'src/utils/cronTasks.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { getTeammateContext } from 'src/utils/teammateContext.js'
import {
  buildCronDeletePrompt,
  CRON_DELETE_DESCRIPTION,
  CRON_DELETE_TOOL_NAME,
  isDurableCronEnabled,
  isKairosCronEnabled,
} from './prompt.js'
import { renderDeleteResultMessage, renderDeleteToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    id: z.string().describe('CronCreate 返回的任务 ID。'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    id: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type DeleteOutput = z.infer<OutputSchema>

export const CronDeleteTool = buildTool({
  name: CRON_DELETE_TOOL_NAME,
  searchHint: '取消一个已计划的 cron 任务',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isKairosCronEnabled()
  },
  toAutoClassifierInput(input) {
    return input.id
  },
  async description() {
    return CRON_DELETE_DESCRIPTION
  },
  async prompt() {
    return buildCronDeletePrompt(isDurableCronEnabled())
  },
  getPath() {
    return getCronFilePath()
  },
  async validateInput(input): Promise<ValidationResult> {
    const tasks = await listAllCronTasks()
    const task = tasks.find(t => t.id === input.id)
    if (!task) {
      return {
        result: false,
        message: `不存在 ID 为 '${input.id}' 的计划任务`,
        errorCode: 1,
      }
    }
    // 队友只能删除自己的 cron 任务。
    const ctx = getTeammateContext()
    if (ctx && task.agentId !== ctx.agentId) {
      return {
        result: false,
        message: `无法删除 cron 任务 '${input.id}'：由其他代理拥有`,
        errorCode: 2,
      }
    }
    return { result: true }
  },
  async call({ id }) {
    await removeCronTasks([id])
    return { data: { id } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `已取消任务 ${output.id}。`,
    }
  },
  renderToolUseMessage: renderDeleteToolUseMessage,
  renderToolResultMessage: renderDeleteResultMessage,
} satisfies ToolDef<InputSchema, DeleteOutput>)