import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { isAgentSwarmsEnabled } from 'src/utils/agentSwarmsEnabled.js'
import {
  executeTaskCompletedHooks,
  getTaskCompletedHookMessage,
} from 'src/utils/hooks.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import {
  blockTask,
  deleteTask,
  getTask,
  getTaskListId,
  isTodoV2Enabled,
  listTasks,
  type TaskStatus,
  TaskStatusSchema,
  updateTask,
} from 'src/utils/tasks.js'
import {
  getAgentId,
  getAgentName,
  getTeammateColor,
  getTeamName,
} from 'src/utils/teammate.js'
import { writeToMailbox } from 'src/utils/teammateMailbox.js'
import { VERIFICATION_AGENT_TYPE } from '../AgentTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

const inputSchema = lazySchema(() => {
  // 扩展的状态模式，包含作为特殊操作的 'deleted'
  const TaskUpdateStatusSchema = TaskStatusSchema().or(z.literal('deleted'))

  return z.strictObject({
    taskId: z.string().describe('要更新的任务 ID'),
    subject: z.string().optional().describe('任务的新标题'),
    description: z.string().optional().describe('任务的新描述'),
    activeForm: z
      .string()
      .optional()
      .describe(
        '当状态为 in_progress 时，在加载指示器中显示的现在进行时形式（例如“正在运行测试”）',
      ),
    status: TaskUpdateStatusSchema.optional().describe(
      '任务的新状态',
    ),
    addBlocks: z
      .array(z.string())
      .optional()
      .describe('此任务所阻塞的任务 ID'),
    addBlockedBy: z
      .array(z.string())
      .optional()
      .describe('阻塞此任务的任务 ID'),
    owner: z.string().optional().describe('任务的新负责人'),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        '要合并到任务中的元数据键值对。将键设为 null 可删除该键。',
      ),
  })
})
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    taskId: z.string(),
    updatedFields: z.array(z.string()),
    error: z.string().optional(),
    statusChange: z
      .object({
        from: z.string(),
        to: z.string(),
      })
      .optional(),
    verificationNudgeNeeded: z.boolean().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const TaskUpdateTool = buildTool({
  name: TASK_UPDATE_TOOL_NAME,
  searchHint: '更新任务',
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
  userFacingName() {
    return 'TaskUpdate'
  },
  shouldDefer: true,
  isEnabled() {
    return isTodoV2Enabled()
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    const parts = [input.taskId]
    if (input.status) parts.push(input.status)
    if (input.subject) parts.push(input.subject)
    return parts.join(' ')
  },
  renderToolUseMessage() {
    return null
  },
  async call(
    {
      taskId,
      subject,
      description,
      activeForm,
      status,
      owner,
      addBlocks,
      addBlockedBy,
      metadata,
    },
    context,
  ) {
    const taskListId = getTaskListId()

    // 更新任务时自动展开任务列表
    context.setAppState(prev => {
      if (prev.expandedView === 'tasks') return prev
      return { ...prev, expandedView: 'tasks' as const }
    })

    // 检查任务是否存在
    const existingTask = await getTask(taskListId, taskId)
    if (!existingTask) {
      return {
        data: {
          success: false,
          taskId,
          updatedFields: [],
          error: '未找到任务',
        },
      }
    }

    const updatedFields: string[] = []

    // 如果提供了基本字段且与当前值不同，则更新
    const updates: {
      subject?: string
      description?: string
      activeForm?: string
      status?: TaskStatus
      owner?: string
      metadata?: Record<string, unknown>
    } = {}
    if (subject !== undefined && subject !== existingTask.subject) {
      updates.subject = subject
      updatedFields.push('subject')
    }
    if (description !== undefined && description !== existingTask.description) {
      updates.description = description
      updatedFields.push('description')
    }
    if (activeForm !== undefined && activeForm !== existingTask.activeForm) {
      updates.activeForm = activeForm
      updatedFields.push('activeForm')
    }
    if (owner !== undefined && owner !== existingTask.owner) {
      updates.owner = owner
      updatedFields.push('owner')
    }
    // 当队友将任务标记为 in_progress 而没有显式提供负责人时，自动设置负责人。
    // 这确保任务列表可以将待办项匹配到队友，以显示活动状态。
    if (
      isAgentSwarmsEnabled() &&
      status === 'in_progress' &&
      owner === undefined &&
      !existingTask.owner
    ) {
      const agentName = getAgentName()
      if (agentName) {
        updates.owner = agentName
        updatedFields.push('owner')
      }
    }
    if (metadata !== undefined) {
      const merged = { ...(existingTask.metadata ?? {}) }
      for (const [key, value] of Object.entries(metadata)) {
        if (value === null) {
          delete merged[key]
        } else {
          merged[key] = value
        }
      }
      updates.metadata = merged
      updatedFields.push('metadata')
    }
    if (status !== undefined) {
      // 处理删除操作 - 删除任务文件并提前返回
      if (status === 'deleted') {
        const deleted = await deleteTask(taskListId, taskId)
        return {
          data: {
            success: deleted,
            taskId,
            updatedFields: deleted ? ['deleted'] : [],
            error: deleted ? undefined : '删除任务失败',
            statusChange: deleted
              ? { from: existingTask.status, to: 'deleted' }
              : undefined,
          },
        }
      }

      // 对于常规状态更新，如果不同则验证并应用
      if (status !== existingTask.status) {
        // 当将任务标记为完成时，运行 TaskCompleted 钩子
        if (status === 'completed') {
          const blockingErrors: string[] = []

          const generator = executeTaskCompletedHooks(
            taskId,
            existingTask.subject,
            existingTask.description,
            getAgentName(),
            getTeamName(),
            undefined,
            context?.abortController?.signal,
            undefined,
            context,
          )

          for await (const result of generator) {
            if (result.blockingError) {
              blockingErrors.push(
                getTaskCompletedHookMessage(result.blockingError),
              )
            }
          }

          if (blockingErrors.length > 0) {
            return {
              data: {
                success: false,
                taskId,
                updatedFields: [],
                error: blockingErrors.join('\n'),
              },
            }
          }
        }

        updates.status = status
        updatedFields.push('status')
      }
    }

    if (Object.keys(updates).length > 0) {
      await updateTask(taskListId, taskId, updates)
    }

    // 当负责人变更时，通过邮箱通知新负责人
    if (updates.owner && isAgentSwarmsEnabled()) {
      const senderName = getAgentName() || 'team-lead'
      const senderColor = getTeammateColor()
      const assignmentMessage = JSON.stringify({
        type: 'task_assignment',
        taskId,
        subject: existingTask.subject,
        description: existingTask.description,
        assignedBy: senderName,
        timestamp: new Date().toISOString(),
      })
      await writeToMailbox(
        updates.owner,
        {
          from: senderName,
          text: assignmentMessage,
          timestamp: new Date().toISOString(),
          color: senderColor,
        },
        taskListId,
      )
    }

    // 如果提供了阻塞关系且尚未存在，则添加
    if (addBlocks && addBlocks.length > 0) {
      const newBlocks = addBlocks.filter(
        id => !existingTask.blocks.includes(id),
      )
      for (const blockId of newBlocks) {
        await blockTask(taskListId, taskId, blockId)
      }
      if (newBlocks.length > 0) {
        updatedFields.push('blocks')
      }
    }

    // 如果提供了 blockedBy 且尚未存在，则添加（反向：阻塞者阻塞此任务）
    if (addBlockedBy && addBlockedBy.length > 0) {
      const newBlockedBy = addBlockedBy.filter(
        id => !existingTask.blockedBy.includes(id),
      )
      for (const blockerId of newBlockedBy) {
        await blockTask(taskListId, blockerId, taskId)
      }
      if (newBlockedBy.length > 0) {
        updatedFields.push('blockedBy')
      }
    }

    // 结构验证提示：如果主线程代理刚刚完成了 3 个以上的任务列表，且这些任务中没有一个是验证步骤，
    // 则在工具结果中附加一个提醒。在循环退出的时刻触发（“当最后一个任务关闭时，循环退出”）。
    // 类似于 TodoWriteTool 对 V1 会话的提示；此代码覆盖 V2（交互式 CLI）。TaskUpdateToolOutput 是 @internal，
    // 因此该字段不会触及公共 SDK 表面。
    let verificationNudgeNeeded = false
    if (
      feature('VERIFICATION_AGENT') &&
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false) &&
      !context.agentId &&
      updates.status === 'completed'
    ) {
      const allTasks = await listTasks(taskListId)
      const allDone = allTasks.every(t => t.status === 'completed')
      if (
        allDone &&
        allTasks.length >= 3 &&
        !allTasks.some(t => /verif/i.test(t.subject))
      ) {
        verificationNudgeNeeded = true
      }
    }

    return {
      data: {
        success: true,
        taskId,
        updatedFields,
        statusChange:
          updates.status !== undefined
            ? { from: existingTask.status, to: updates.status }
            : undefined,
        verificationNudgeNeeded,
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const {
      success,
      taskId,
      updatedFields,
      error,
      statusChange,
      verificationNudgeNeeded,
    } = content as Output
    if (!success) {
      // 返回非错误，以免在 StreamingToolExecutor 中触发兄弟工具取消。
      // “未找到任务”是一种良性情况（例如任务列表已被清理），模型可以处理。
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: error || `未找到任务 #${taskId}`,
      }
    }

    let resultContent = `已更新任务 #${taskId}，更新的字段：${updatedFields.join('、')}`

    // 当队友完成任务时添加提醒（支持进程内队友）
    if (
      statusChange?.to === 'completed' &&
      getAgentId() &&
      isAgentSwarmsEnabled()
    ) {
      resultContent +=
        '\n\n任务已完成。请立即调用 TaskList 查找您的下一个可用任务，或查看您的工作是否解除了对其他任务的阻塞。'
    }

    if (verificationNudgeNeeded) {
      resultContent += `\n\n注意：您刚刚完成了 3 个以上的任务，其中没有一个任务是验证步骤。在编写最终总结之前，请生成验证代理（subagent_type="${VERIFICATION_AGENT_TYPE}"）。您不能通过在总结中列出免责条款来自行分配 PARTIAL 结果——只有验证代理可以发布判定。`
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: resultContent,
    }
  },
} satisfies ToolDef<InputSchema, Output>)