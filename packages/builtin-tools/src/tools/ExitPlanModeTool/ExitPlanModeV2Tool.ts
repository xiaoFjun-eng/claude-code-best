import { feature } from 'bun:bundle'
import { writeFile } from 'fs/promises'
import { z } from 'zod/v4'
import {
  getAllowedChannels,
  hasExitedPlanModeInSession,
  setHasExitedPlanMode,
  setNeedsAutoModeExitAttachment,
  setNeedsPlanModeExitAttachment,
} from 'src/bootstrap/state.js'
import { logEvent } from 'src/services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/metadata.js'
import {
  buildTool,
  type Tool,
  type ToolDef,
  toolMatchesName,
} from 'src/Tool.js'
import { formatAgentId, generateRequestId } from 'src/utils/agentId.js'
import { isAgentSwarmsEnabled } from 'src/utils/agentSwarmsEnabled.js'
import { logForDebugging } from 'src/utils/debug.js'
import {
  findInProcessTeammateTaskId,
  setAwaitingPlanApproval,
} from 'src/utils/inProcessTeammateHelpers.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { logError } from 'src/utils/log.js'
import {
  getPlan,
  getPlanFilePath,
  persistFileSnapshotIfRemote,
} from 'src/utils/plans.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import {
  getAgentName,
  getTeamName,
  isPlanModeRequired,
  isTeammate,
} from 'src/utils/teammate.js'
import { writeToMailbox } from 'src/utils/teammateMailbox.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { TEAM_CREATE_TOOL_NAME } from '../TeamCreateTool/constants.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from './constants.js'
import { EXIT_PLAN_MODE_V2_TOOL_PROMPT } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('src/utils/permissions/autoModeState.js') as typeof import('src/utils/permissions/autoModeState.js'))
  : null
const permissionSetupModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('src/utils/permissions/permissionSetup.js') as typeof import('src/utils/permissions/permissionSetup.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 基于提示的权限请求的模式。
 * 由 Claude 在退出计划模式时用于请求语义权限。
 */
const allowedPromptSchema = lazySchema(() =>
  z.object({
    tool: z.enum(['Bash']).describe('此提示适用的工具'),
    prompt: z
      .string()
      .describe(
        '动作的语义描述，例如“运行测试”、“安装依赖”',
      ),
  }),
)

export type AllowedPrompt = z.infer<ReturnType<typeof allowedPromptSchema>>

const inputSchema = lazySchema(() =>
  z
    .strictObject({
      // 计划请求的基于提示的权限
      allowedPrompts: z
        .array(allowedPromptSchema())
        .optional()
        .describe(
          '实现计划所需的基于提示的权限。这些权限描述的是动作的类别，而不是具体的命令。',
        ),
    })
    .passthrough(),
)
type InputSchema = ReturnType<typeof inputSchema>

/**
 * SDK 面向的输入模式 - 包含由 normalizeToolInput 注入的字段。
 * 内部的 inputSchema 没有这些字段，因为计划是从磁盘读取的，
 * 但 SDK/钩子会看到包含计划和文件路径的规范化版本。
 */
export const _sdkInputSchema = lazySchema(() =>
  inputSchema().extend({
    plan: z
      .string()
      .optional()
      .describe('计划内容（由 normalizeToolInput 从磁盘注入）'),
    planFilePath: z
      .string()
      .optional()
      .describe('计划文件路径（由 normalizeToolInput 注入）'),
  }),
)

export const outputSchema = lazySchema(() =>
  z.object({
    plan: z
      .string()
      .nullable()
      .describe('呈现给用户的计划'),
    isAgent: z.boolean(),
    filePath: z
      .string()
      .optional()
      .describe('保存计划文件的路径'),
    hasTaskTool: z
      .boolean()
      .optional()
      .describe('当前上下文中是否可用 Agent 工具'),
    planWasEdited: z
      .boolean()
      .optional()
      .describe(
        '当用户编辑了计划时为 true（CCR Web UI 或 Ctrl+G）；决定是否在 tool_result 中回显计划',
      ),
    awaitingLeaderApproval: z
      .boolean()
      .optional()
      .describe(
        '当 true 时，表示队友已向团队负责人发送了计划审批请求',
      ),
    requestId: z
      .string()
      .optional()
      .describe('计划审批请求的唯一标识符'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const ExitPlanModeV2Tool: Tool<InputSchema, Output> = buildTool({
  name: EXIT_PLAN_MODE_V2_TOOL_NAME,
  searchHint: '提交计划供审批并开始编码（仅限计划模式）',
  maxResultSizeChars: 100_000,
  async description() {
    return '提示用户退出计划模式并开始编码'
  },
  async prompt() {
    return EXIT_PLAN_MODE_V2_TOOL_PROMPT
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
    // 当 --channels 激活时，用户可能在使用 Telegram/Discord，没有查看 TUI。
    // 计划审批对话框会挂起。与 EnterPlanMode 上的相同门控配对，以免计划模式成为一个陷阱。
    if (
      (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
      getAllowedChannels().length > 0
    ) {
      return false
    }
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return false // 现在会写入磁盘
  },
  requiresUserInteraction() {
    // 对于所有队友，不需要本地用户交互：
    // - 如果 isPlanModeRequired() 为 true：团队负责人通过邮箱审批
    // - 否则：本地退出，无需审批（自愿计划模式）
    if (isTeammate()) {
      return false
    }
    // 对于非队友，需要用户确认才能退出计划模式
    return true
  },
  async validateInput(_input, { getAppState, options }) {
    // 队友的 AppState 可能显示领导者的模式（runAgent.ts 在 acceptEdits/bypassPermissions/auto 中跳过覆盖）；
    // isPlanModeRequired() 是真实来源
    if (isTeammate()) {
      return { result: true }
    }
    // 延迟工具列表会无视模式始终公布此工具，以便模型在计划审批后（压缩/清除后的新增量）可以调用它。
    // 在 checkPermissions 之前拒绝，以避免显示审批对话框。
    const mode = getAppState().toolPermissionContext.mode
    if (mode !== 'plan') {
      logEvent('tengu_exit_plan_mode_called_outside_plan', {
        model:
          options.mainLoopModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        hasExitedPlanModeInSession: hasExitedPlanModeInSession(),
      })
      return {
        result: false,
        message:
          '您当前不在计划模式。此工具仅用于在编写计划后退出计划模式。如果您的计划已获批准，请继续实施。',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  async checkPermissions(input, context) {
    // 对于所有队友，绕过权限 UI，避免发送 permission_request
    // call() 方法会处理适当的行为：
    // - 如果 isPlanModeRequired() 为 true：向领导者发送 plan_approval_request
    // - 否则：本地退出计划模式（自愿计划模式）
    if (isTeammate()) {
      return {
        behavior: 'allow' as const,
        updatedInput: input,
      }
    }

    // 对于非队友，需要用户确认才能退出计划模式
    return {
      behavior: 'ask' as const,
      message: '退出计划模式？',
      updatedInput: input,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  async call(input, context) {
    const isAgent = !!context.agentId

    const filePath = getPlanFilePath(context.agentId)
    // CCR Web UI 可能通过 permissionResult.updatedInput 发送编辑后的计划。
    // queryHelpers.ts 会完全替换 finalInput，因此当 CCR 发送 {}（无编辑）时，
    // input.plan 为 undefined -> 回退到磁盘。内部的 inputSchema 省略了 `plan`（通常由 normalizeToolInput 注入），因此进行类型收窄。
    const inputPlan =
      'plan' in input && typeof input.plan === 'string' ? input.plan : undefined
    const plan = inputPlan ?? getPlan(context.agentId)

    // 同步磁盘，以便 VerifyPlanExecution / Read 能看到编辑。在之后重新快照：
    // 另一个 persistFileSnapshotIfRemote 调用（api.ts）在 normalizeToolInput 中运行，位于权限之前 —— 它捕获的是旧计划。
    if (inputPlan !== undefined && filePath) {
      await writeFile(filePath, inputPlan, 'utf-8').catch(e => logError(e))
      void persistFileSnapshotIfRemote()
    }

    // 检查这是否是需要领导者审批的队友
    if (isTeammate() && isPlanModeRequired()) {
      // 对于 plan_mode_required 的队友，计划是必需的
      if (!plan) {
        throw new Error(
          `在 ${filePath} 未找到计划文件。请在调用 ExitPlanMode 之前将您的计划写入此文件。`,
        )
      }
      const agentName = getAgentName() || 'unknown'
      const teamName = getTeamName()
      const requestId = generateRequestId(
        'plan_approval',
        formatAgentId(agentName, teamName || 'default'),
      )

      const approvalRequest = {
        type: 'plan_approval_request',
        from: agentName,
        timestamp: new Date().toISOString(),
        planFilePath: filePath,
        planContent: plan,
        requestId,
      }

      await writeToMailbox(
        'team-lead',
        {
          from: agentName,
          text: jsonStringify(approvalRequest),
          timestamp: new Date().toISOString(),
        },
        teamName,
      )

      // 更新任务状态以显示等待审批（对于进程内队友）
      const appState = context.getAppState()
      const agentTaskId = findInProcessTeammateTaskId(agentName, appState)
      if (agentTaskId) {
        setAwaitingPlanApproval(agentTaskId, context.setAppState, true)
      }

      return {
        data: {
          plan,
          isAgent: true,
          filePath,
          awaitingLeaderApproval: true,
          requestId,
        },
      }
    }

    // 注意：后台验证钩子在 REPL.tsx 中注册，位于上下文清除之后
    // 通过 registerPlanVerificationHook()。在此处注册会被上下文清除时清掉。

    // 确保退出计划模式时更改模式。
    // 这处理了权限流程未设置模式的情况
    // （例如，当 PermissionRequest 钩子自动批准而未提供 updatedPermissions 时）。
    const appState = context.getAppState()
    // 在 setAppState 之前计算门控回退，以便通知用户。
    // 电路断路器防御：如果 prePlanMode 是类似自动的模式但门控现已关闭（电路断路器或设置禁用），
    // 则恢复为 'default'。如果没有这个，ExitPlanMode 会通过直接调用 setAutoModeActive(true) 绕过电路断路器。
    let gateFallbackNotification: string | null = null
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      const prePlanRaw = appState.toolPermissionContext.prePlanMode ?? 'default'
      if (
        prePlanRaw === 'auto' &&
        !(permissionSetupModule?.isAutoModeGateEnabled() ?? false)
      ) {
        const reason =
          permissionSetupModule?.getAutoModeUnavailableReason() ??
          'circuit-breaker'
        gateFallbackNotification =
          permissionSetupModule?.getAutoModeUnavailableNotification(reason) ??
          'auto mode unavailable'
        logForDebugging(
          `[auto-mode gate @ ExitPlanModeV2Tool] prePlanMode=${prePlanRaw} ` +
            `但门控已关闭（reason=${reason}）— 退出计划时回退到 default`,
          { level: 'warn' },
        )
      }
    }
    if (gateFallbackNotification) {
      context.addNotification?.({
        key: 'auto-mode-gate-plan-exit-fallback',
        text: `计划退出 → default · ${gateFallbackNotification}`,
        priority: 'immediate',
        color: 'warning',
        timeoutMs: 10000,
      })
    }

    context.setAppState(prev => {
      if (prev.toolPermissionContext.mode !== 'plan') return prev
      setHasExitedPlanMode(true)
      setNeedsPlanModeExitAttachment(true)
      let restoreMode = prev.toolPermissionContext.prePlanMode ?? 'default'
      if (feature('TRANSCRIPT_CLASSIFIER')) {
        if (
          restoreMode === 'auto' &&
          !(permissionSetupModule?.isAutoModeGateEnabled() ?? false)
        ) {
          restoreMode = 'default'
        }
        const finalRestoringAuto = restoreMode === 'auto'
        // 捕获恢复前的状态 — isAutoModeActive() 是权威信号
        // （prePlanMode/strippedDangerousRules 在 transitionPlanAutoMode 于计划中途停用后会过时）。
        const autoWasUsedDuringPlan =
          autoModeStateModule?.isAutoModeActive() ?? false
        autoModeStateModule?.setAutoModeActive(finalRestoringAuto)
        if (autoWasUsedDuringPlan && !finalRestoringAuto) {
          setNeedsAutoModeExitAttachment(true)
        }
      }
      // 如果恢复到非自动模式且权限曾被剥离（无论是从自动进入计划，还是因为 shouldPlanUseAutoMode），则恢复它们。
      // 如果恢复到自动模式，则保持剥离状态。
      const restoringToAuto = restoreMode === 'auto'
      let baseContext = prev.toolPermissionContext
      if (restoringToAuto) {
        baseContext =
          permissionSetupModule?.stripDangerousPermissionsForAutoMode(
            baseContext,
          ) ?? baseContext
      } else if (prev.toolPermissionContext.strippedDangerousRules) {
        baseContext =
          permissionSetupModule?.restoreDangerousPermissions(baseContext) ??
          baseContext
      }
      return {
        ...prev,
        toolPermissionContext: {
          ...baseContext,
          mode: restoreMode,
          prePlanMode: undefined,
        },
      }
    })

    const hasTaskTool =
      isAgentSwarmsEnabled() &&
      context.options.tools.some(t => toolMatchesName(t, AGENT_TOOL_NAME))

    return {
      data: {
        plan,
        isAgent,
        filePath,
        hasTaskTool: hasTaskTool || undefined,
        planWasEdited: inputPlan !== undefined || undefined,
      },
    }
  },
  mapToolResultToToolResultBlockParam(
    {
      isAgent,
      plan,
      filePath,
      hasTaskTool,
      planWasEdited,
      awaitingLeaderApproval,
      requestId,
    },
    toolUseID,
  ) {
    // 处理等待领导者审批的队友
    if (awaitingLeaderApproval) {
      return {
        type: 'tool_result',
        content: `您的计划已提交给团队负责人审批。

计划文件：${filePath}

**接下来会发生什么：**
1. 等待团队负责人审核您的计划
2. 您将在收件箱中收到批准/拒绝的消息
3. 如果批准，您可以继续实施
4. 如果拒绝，请根据反馈完善您的计划

**重要提示：** 在收到批准之前不要继续。请检查您的收件箱以获取回复。

请求 ID：${requestId}`,
        tool_use_id: toolUseID,
      }
    }

    if (isAgent) {
      return {
        type: 'tool_result',
        content:
          '用户已批准计划。您现在不需要再做任何其他事情。请回复“ok”',
        tool_use_id: toolUseID,
      }
    }

    // 处理空计划
    if (!plan || plan.trim() === '') {
      return {
        type: 'tool_result',
        content: '用户已批准退出计划模式。您现在可以继续了。',
        tool_use_id: toolUseID,
      }
    }

    const teamHint = hasTaskTool
      ? `\n\n如果此计划可以分解为多个独立任务，请考虑使用 ${TEAM_CREATE_TOOL_NAME} 工具创建团队并并行处理工作。`
      : ''

    // 始终包含计划 — Ultraplan CCR 流程中的 extractApprovedPlan() 会解析 tool_result 以获取本地 CLI 的计划文本。
    // 标记编辑过的计划，以便模型知道用户更改了某些内容。
    const planLabel = planWasEdited
      ? '已批准的计划（用户已编辑）'
      : '已批准的计划'

    return {
      type: 'tool_result',
      content: `用户已批准您的计划。您现在可以开始编码。如果适用，请先更新您的待办事项列表

您的计划已保存到：${filePath}
在实施过程中如有需要可以随时查阅。${teamHint}

## ${planLabel}：
${plan}`,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)