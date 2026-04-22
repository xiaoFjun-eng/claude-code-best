import { z } from 'zod/v4'
import { setScheduledTasksEnabled } from 'src/bootstrap/state.js'
import type { ValidationResult } from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { cronToHuman, parseCronExpression } from 'src/utils/cron.js'
import {
  addCronTask,
  getCronFilePath,
  listAllCronTasks,
  nextCronRunMs,
} from 'src/utils/cronTasks.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { semanticBoolean } from 'src/utils/semanticBoolean.js'
import { getTeammateContext } from 'src/utils/teammateContext.js'
import {
  buildCronCreateDescription,
  buildCronCreatePrompt,
  CRON_CREATE_TOOL_NAME,
  DEFAULT_MAX_AGE_DAYS,
  isDurableCronEnabled,
  isKairosCronEnabled,
} from './prompt.js'
import { renderCreateResultMessage, renderCreateToolUseMessage } from './UI.js'

const MAX_JOBS = 50

const inputSchema = lazySchema(() =>
  z.strictObject({
    cron: z
      .string()
      .describe(
        '标准 5 字段 cron 表达式，使用本地时间："M H DoM Mon DoW"（例如 "*/5 * * * *" = 每 5 分钟，"30 14 28 2 *" = 2 月 28 日下午 2:30 本地时间一次）。',
      ),
    prompt: z.string().describe('每次触发时要入队执行的提示词。'),
    recurring: semanticBoolean(z.boolean().optional()).describe(
      `true（默认）= 每次 cron 匹配时触发，直到删除或 ${DEFAULT_MAX_AGE_DAYS} 天后自动过期。false = 仅在下一次匹配时触发一次，然后自动删除。对于“在 X 时间提醒我”的单次请求（固定分钟/小时/日期/月份）使用 false。`,
    ),
    durable: semanticBoolean(z.boolean().optional()).describe(
      'true = 持久化到 .claude/scheduled_tasks.json，重启后仍然存在。false（默认）= 仅内存中，此 Claude 会话结束时消失。仅当用户要求任务跨会话持久化时使用 true。',
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    humanSchedule: z.string(),
    recurring: z.boolean(),
    durable: z.boolean().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type CreateOutput = z.infer<OutputSchema>

export const CronCreateTool = buildTool({
  name: CRON_CREATE_TOOL_NAME,
  searchHint: '计划一个周期性或单次运行的提示词',
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
    return `${input.cron}: ${input.prompt}`
  },
  async description() {
    return buildCronCreateDescription(isDurableCronEnabled())
  },
  async prompt() {
    return buildCronCreatePrompt(isDurableCronEnabled())
  },
  getPath() {
    return getCronFilePath()
  },
  async validateInput(input): Promise<ValidationResult> {
    if (!parseCronExpression(input.cron)) {
      return {
        result: false,
        message: `无效的 cron 表达式 '${input.cron}'。应为 5 个字段：M H DoM Mon DoW。`,
        errorCode: 1,
      }
    }
    if (nextCronRunMs(input.cron, Date.now()) === null) {
      return {
        result: false,
        message: `cron 表达式 '${input.cron}' 在未来一年内不匹配任何日历日期。`,
        errorCode: 2,
      }
    }
    const tasks = await listAllCronTasks()
    if (tasks.length >= MAX_JOBS) {
      return {
        result: false,
        message: `计划任务过多（最多 ${MAX_JOBS} 个）。请先取消一个。`,
        errorCode: 3,
      }
    }
    // 队友不跨会话持久化，因此持久的队友 cron 会在重启后成为孤儿（agentId 会指向一个不存在的队友）。
    if (input.durable && getTeammateContext()) {
      return {
        result: false,
        message:
          '队友不支持 durable cron（队友不跨会话持久化）',
        errorCode: 4,
      }
    }
    return { result: true }
  },
  async call({ cron, prompt, recurring = true, durable = false }) {
    // 终止开关强制为仅会话模式；模式保持稳定，以便当门控在会话中途翻转时模型不会看到验证错误。
    const effectiveDurable = durable && isDurableCronEnabled()
    const id = await addCronTask(
      cron,
      prompt,
      recurring,
      effectiveDurable,
      getTeammateContext()?.agentId,
    )
    // 启用调度器，以便任务在此会话中触发。
    // useScheduledTasks 钩子会轮询此标志，并在下一个 tick 开始监视。对于 durable: false 的任务，文件从不改变
    // — check() 直接读取会话存储 — 但启用标志仍然是启动 tick 循环的因素。
    setScheduledTasksEnabled(true)
    return {
      data: {
        id,
        humanSchedule: cronToHuman(cron),
        recurring,
        durable: effectiveDurable,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const where = output.durable
      ? '已持久化到 .claude/scheduled_tasks.json'
      : '仅会话内存（不写入磁盘，Claude 退出时消失）'
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.recurring
        ? `已计划周期性任务 ${output.id}（${output.humanSchedule}）。${where}。将在 ${DEFAULT_MAX_AGE_DAYS} 天后自动过期。如需提前取消，请使用 CronDelete。`
        : `已计划单次任务 ${output.id}（${output.humanSchedule}）。${where}。它将触发一次后自动删除。`,
    }
  },
  renderToolUseMessage: renderCreateToolUseMessage,
  renderToolResultMessage: renderCreateResultMessage,
} satisfies ToolDef<InputSchema, CreateOutput>)