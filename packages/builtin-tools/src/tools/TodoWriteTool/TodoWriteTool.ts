import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getSessionId } from 'src/bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { isTodoV2Enabled } from 'src/utils/tasks.js'
import { TodoListSchema } from 'src/utils/todo/types.js'
import { VERIFICATION_AGENT_TYPE } from '../AgentTool/constants.js'
import { TODO_WRITE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    todos: TodoListSchema().describe('更新后的待办事项列表'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    oldTodos: TodoListSchema().describe('更新前的待办事项列表'),
    newTodos: TodoListSchema().describe('更新后的待办事项列表'),
    verificationNudgeNeeded: z.boolean().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const TodoWriteTool = buildTool({
  name: TODO_WRITE_TOOL_NAME,
  searchHint: '管理会话任务清单',
  maxResultSizeChars: 100_000,
  strict: true,
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
  userFacingName() {
    return ''
  },
  shouldDefer: true,
  isEnabled() {
    return !isTodoV2Enabled()
  },
  toAutoClassifierInput(input) {
    return `${input.todos.length} 项`
  },
  async checkPermissions(input) {
    // 待办事项操作无需权限检查
    return { behavior: 'allow', updatedInput: input }
  },
  renderToolUseMessage() {
    return null
  },
  async call({ todos }, context) {
    const appState = context.getAppState()
    const todoKey = context.agentId ?? getSessionId()
    const oldTodos = appState.todos[todoKey] ?? []
    const allDone = todos.every(_ => _.status === 'completed')
    const newTodos = allDone ? [] : todos

    // 结构性提示：如果主线程代理正在结束一个包含 3 项以上任务的列表，
    // 且其中没有一项是验证步骤，则在工具结果中附加一个提醒。
    // 在循环退出的确切时刻触发（“当最后一个任务关闭时，循环退出”）。
    let verificationNudgeNeeded = false
    if (
      feature('VERIFICATION_AGENT') &&
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false) &&
      !context.agentId &&
      allDone &&
      todos.length >= 3 &&
      !todos.some(t => /verif/i.test(t.content))
    ) {
      verificationNudgeNeeded = true
    }

    context.setAppState(prev => ({
      ...prev,
      todos: {
        ...prev.todos,
        [todoKey]: newTodos,
      },
    }))

    return {
      data: {
        oldTodos,
        newTodos: todos,
        verificationNudgeNeeded,
      },
    }
  },
  mapToolResultToToolResultBlockParam({ verificationNudgeNeeded }, toolUseID) {
    const base = `待办事项已成功修改。请确保继续使用待办事项列表来跟踪您的进度。如果适用，请继续执行当前任务。`
    const nudge = verificationNudgeNeeded
      ? `\n\n注意：您刚刚完成了 3 个以上的任务，其中没有一个任务是验证步骤。在编写最终总结之前，请生成验证代理（subagent_type="${VERIFICATION_AGENT_TYPE}"）。您不能通过在总结中列出免责条款来自行分配 PARTIAL 结果——只有验证代理可以发布判定。`
      : ''
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: base + nudge,
    }
  },
} satisfies ToolDef<InputSchema, Output>)