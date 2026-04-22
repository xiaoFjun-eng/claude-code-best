import { z } from 'zod/v4'
import type { TaskStateBase } from 'src/Task.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { stopTask } from 'src/tasks/stopTask.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { DESCRIPTION, TASK_STOP_TOOL_NAME } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    task_id: z
      .string()
      .optional()
      .describe('要停止的后台任务的 ID'),
    // 保留 shell_id 是为了与已弃用的 KillShell 工具保持向后兼容
    shell_id: z.string().optional().describe('已弃用：请改用 task_id'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('关于操作的状态消息'),
    task_id: z.string().describe('已停止的任务的 ID'),
    task_type: z.string().describe('已停止的任务的类型'),
    // 可选：工具输出会被持久化到对话记录中，并在 --resume 时回放，而不会重新验证，
    // 因此在此字段添加之前的会话可能没有该字段。
    command: z
      .string()
      .optional()
      .describe('已停止任务的命令或描述'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const TaskStopTool = buildTool({
  name: TASK_STOP_TOOL_NAME,
  searchHint: '终止正在运行的后台任务',
  // KillShell 是已弃用的名称 - 保留作为别名，用于与现有对话记录和 SDK 用户保持向后兼容
  aliases: ['KillShell'],
  maxResultSizeChars: 100_000,
  userFacingName: () => (process.env.USER_TYPE === 'ant' ? '' : '停止任务'),
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.task_id ?? input.shell_id ?? ''
  },
  async validateInput({ task_id, shell_id }, { getAppState }) {
    // 同时支持 task_id 和 shell_id（已弃用的 KillShell 兼容）
    const id = task_id ?? shell_id
    if (!id) {
      return {
        result: false,
        message: '缺少必需参数：task_id',
        errorCode: 1,
      }
    }

    const appState = getAppState()
    const task = appState.tasks?.[id] as TaskStateBase | undefined

    if (!task) {
      return {
        result: false,
        message: `未找到 ID 为 ${id} 的任务`,
        errorCode: 1,
      }
    }

    if (task.status !== 'running') {
      return {
        result: false,
        message: `任务 ${id} 未在运行（状态：${task.status}）`,
        errorCode: 3,
      }
    }

    return { result: true }
  },
  async description() {
    return `按 ID 停止正在运行的后台任务`
  },
  async prompt() {
    return DESCRIPTION
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(
    { task_id, shell_id },
    { getAppState, setAppState, abortController },
  ) {
    // 同时支持 task_id 和 shell_id（已弃用的 KillShell 兼容）
    const id = task_id ?? shell_id
    if (!id) {
      throw new Error('缺少必需参数：task_id')
    }

    const result = await stopTask(id, {
      getAppState,
      setAppState,
    })

    return {
      data: {
        message: `成功停止任务：${result.taskId}（${result.command}）`,
        task_id: result.taskId,
        task_type: result.taskType,
        command: result.command,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)