import { feature } from 'bun:bundle'
import type {
  ContentBlockParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources'
import { randomUUID } from 'crypto'
import { setPromptId } from 'src/bootstrap/state.js'
import {
  builtInCommandNames,
  type Command,
  type CommandBase,
  findCommand,
  getCommand,
  getCommandName,
  hasCommand,
  type PromptCommand,
} from 'src/commands.js'
import { NO_CONTENT_MESSAGE } from 'src/constants/messages.js'
import type { SetToolJSXFn, ToolUseContext } from 'src/Tool.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  NormalizedUserMessage,
  ProgressMessage,
  UserMessage,
} from 'src/types/message.js'
import { addInvokedSkill, getSessionId } from '../../bootstrap/state.js'
import { COMMAND_MESSAGE_TAG, COMMAND_NAME_TAG } from '../../constants/xml.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../../services/analytics/index.js'
import { getDumpPromptsPath } from '../../services/api/dumpPrompts.js'
import { buildPostCompactMessages } from '../../services/compact/compact.js'
import { resetMicrocompactState } from '../../services/compact/microCompact.js'
import type { Progress as AgentProgress } from '@claude-code-best/builtin-tools/tools/AgentTool/AgentTool.js'
import { runAgent } from '@claude-code-best/builtin-tools/tools/AgentTool/runAgent.js'
import { renderToolUseProgressMessage } from '@claude-code-best/builtin-tools/tools/AgentTool/UI.js'
import type { CommandResultDisplay } from '../../types/command.js'
import { createAbortController } from '../abortController.js'
import { getAgentContext } from '../agentContext.js'
import {
  createAttachmentMessage,
  getAttachmentMessages,
} from '../attachments.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { AbortError, MalformedCommandError } from '../errors.js'
import { getDisplayPath } from '../file.js'
import {
  extractResultText,
  prepareForkedCommandContext,
} from '../forkedAgent.js'
import { getFsImplementation } from '../fsOperations.js'
import { isFullscreenEnvEnabled } from '../fullscreen.js'
import { toArray } from '../generators.js'
import { registerSkillHooks } from '../hooks/registerSkillHooks.js'
import { logError } from '../log.js'
import { enqueuePendingNotification } from '../messageQueueManager.js'
import {
  createCommandInputMessage,
  createSyntheticUserCaveatMessage,
  createSystemMessage,
  createUserInterruptionMessage,
  createUserMessage,
  formatCommandInputTags,
  isCompactBoundaryMessage,
  isSystemLocalCommandMessage,
  normalizeMessages,
  prepareUserContent,
} from '../messages.js'
import type { ModelAlias } from '../model/aliases.js'
import { parseToolListFromCLI } from '../permissions/permissionSetup.js'
import { hasPermissionsToUseTool } from '../permissions/permissions.js'
import {
  isOfficialMarketplaceName,
  parsePluginIdentifier,
} from '../plugins/pluginIdentifier.js'
import {
  isRestrictedToPluginOnly,
  isSourceAdminTrusted,
} from '../settings/pluginOnlyPolicy.js'
import { parseSlashCommand } from '../slashCommandParsing.js'
import { sleep } from '../sleep.js'
import { recordSkillUsage } from '../suggestions/skillUsageTracking.js'
import { logOTelEvent, redactIfDisabled } from '../telemetry/events.js'
import { buildPluginCommandTelemetryFields } from '../telemetry/pluginTelemetry.js'
import { getAssistantMessageContentLength } from '../tokens.js'
import { createAgentId } from '../uuid.js'
import { getWorkload } from '../workloadContext.js'
import type {
  ProcessUserInputBaseResult,
  ProcessUserInputContext,
} from './processUserInput.js'

type SlashCommandResult = ProcessUserInputBaseResult & {
  command: Command
}

// 在启动后台分叉子代理之前，MCP 连接稳定所需的轮询间隔和截止
// 时间。MCP 服务器通常在启动后 1-3 秒内连接；10 秒的
// 余量可覆盖较慢的 SSE 握手过程。
const MCP_SETTLE_POLL_MS = 200
const MCP_SETTLE_TIMEOUT_MS = 10_000

/** * 在上下文中执行斜杠命令：在子代理中分叉执行。 */
async function executeForkedSlashCommand(
  command: CommandBase & PromptCommand,
  args: string,
  context: ProcessUserInputContext,
  precedingInputBlocks: ContentBlockParam[],
  setToolJSX: SetToolJSXFn,
  canUseTool: CanUseToolFn,
): Promise<SlashCommandResult> {
  const agentId = createAgentId()

  const pluginMarketplace = command.pluginInfo
    ? parsePluginIdentifier(command.pluginInfo.repository).marketplace
    : undefined
  logEvent('tengu_slash_command_forked', {
    command_name:
      command.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    invocation_trigger:
      'user-slash' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(command.pluginInfo && {
      _PROTO_plugin_name: command.pluginInfo.pluginManifest
        .name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      ...(pluginMarketplace && {
        _PROTO_marketplace_name:
          pluginMarketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      ...buildPluginCommandTelemetryFields(command.pluginInfo),
    }),
  })

  const { skillContent, modifiedGetAppState, baseAgent, promptMessages } =
    await prepareForkedCommandContext(command, args, context)

  // 将技能的工作量合并到代理定义中，以便 runAgent 应用它
  const agentDefinition =
    command.effort !== undefined
      ? { ...baseAgent, effort: command.effort }
      : baseAgent

  logForDebugging(
    `正在使用代理 ${agentDefinition.agentType} 执行分叉斜杠命令 /${command.name}`,
  )

  // 助手模式：发射后不管。在后台启动子代理，立即返回，完成
  // 后将结果作为 isMeta 提示重新加入队列。若不
  // 这样做，启动时的 N 个计划任务 = N 个串行（子代
  // 理 + 主代理轮次）周期，会阻塞用户输入。这样做后，N
  // 个子代理并行运行，结果在完成时陆续进入队列。
  //
  // 受 kairosEnabled（而非 CLAUDE_CODE_BRIEF
  // ）控制，因为闭环依赖于助手模式的不变量：scheduled_task
  // s.json 存在，主代理知道通过 SendUserMessage
  // 传递结果，且 isMeta 提示是隐藏的。在助手模式之外，context
  // :fork 命令是用户调用的技能（如 /commit 等），应同步运行
  // 并显示进度 UI。
  if (feature('KAIROS') && (await context.getAppState()).kairosEnabled) {
    // 独立的 abortController —— 后台子代理在主线程 ESC 时
    // 仍存活（与 AgentTool 异步路径的策略相同）。它们是 cron 驱
    // 动的；如果在运行中被终止，它们只会在下一个计划时间重新触发。
    const bgAbortController = createAbortController()
    const commandName = getCommandName(command)

    // 工作负载：handlePromptSubmit 将整个轮次包装在 runW
    // ithWorkload（AsyncLocalStorage）中。当这个
    // `void` 触发时，ALS 上下文被捕获，并在内部的每个 aw
    // ait 中存活 —— 与父级的延续隔离。分离的闭包中的 runAgent
    // 调用会自动看到 cron 标签。我们仍然在这里捕获该值，仅用于下
    // 面重新入队的结果提示：第二个轮次在新的 handlePromptSub
    // mit → 新的 runWithWorkload 边界中运行（即使对于
    // `undefined`，也总是建立新的上下文）→ 因此它需要自己的 Q
    // ueuedCommand.workload 标签来保留归属。
    const spawnTimeWorkload = getWorkload()

    // 作为隐藏提示重新进入队列。isMeta：在队列预览、占
    // 位符和记录中隐藏。skipSlashCommands：
    // 如果结果文本恰好以 '/' 开头，则防止重新解析。当
    // 被处理时，这会触发一个主代理轮次，该轮次看到结果并决定是
    // 否 SendUserMessage。传播工作负载，以
    // 便第二个轮次也被标记。
    const enqueueResult = (value: string): void =>
      enqueuePendingNotification({
        value,
        mode: 'prompt',
        priority: 'later',
        isMeta: true,
        skipSlashCommands: true,
        workload: spawnTimeWorkload,
      })

    void (async () => {
      // 等待 MCP 服务器稳定。计划任务在启动时触发，所有 N 个任务在约
      // 1 毫秒内完成（因为我们立即返回），在 MCP 连接之前捕获
      // context.options.tools。同步路径意外
      // 地避免了这一点 —— 任务串行化，因此任务 N 的完成发生在任务
      // N-1 的 30 秒运行之后，到那时 MCP 已经启动。轮
      // 询直到没有 'pending' 客户端剩余，然后刷新。
      const deadline = Date.now() + MCP_SETTLE_TIMEOUT_MS
      while (Date.now() < deadline) {
        const s = context.getAppState()
        if (!s.mcp.clients.some(c => c.type === 'pending')) break
        await sleep(MCP_SETTLE_POLL_MS)
      }
      const freshTools =
        context.options.refreshTools?.() ?? context.options.tools

      const agentMessages: Message[] = []
      for await (const message of runAgent({
        agentDefinition,
        promptMessages,
        toolUseContext: {
          ...context,
          getAppState: modifiedGetAppState,
          abortController: bgAbortController,
        },
        canUseTool,
        isAsync: true,
        querySource: 'agent:custom',
        model: command.model as ModelAlias | undefined,
        availableTools: freshTools,
        override: { agentId },
      })) {
        agentMessages.push(message)
      }
      const resultText = extractResultText(agentMessages, '命令已完成')
      logForDebugging(
        `后台分叉命令 /${commandName} 已完成（代理 ${agentId}）`,
      )
      enqueueResult(
        `<scheduled-task-result command="/${commandName}">
${resultText}
</scheduled-task-result>`,
      )
    })().catch(err => {
      logError(err)
      enqueueResult(
        `<scheduled-task-result command="/${commandName}" status="failed">
${err instanceof Error ? err.message : String(err)}
</scheduled-task-result>`,
      )
    })

    // 无需渲染，无需查询 —— 后台运行器按照自己
    // 的计划重新进入队列。
    return { messages: [], shouldQuery: false, command }
  }

  // 从分叉代理收集消息
  const agentMessages: Message[] = []

  // 为代理进度 UI 构建进度消息
  const progressMessages: ProgressMessage<AgentProgress>[] = []
  const parentToolUseID = `forked-command-${command.name}`
  let toolUseCounter = 0

  // 从代理消息创建进度消息的辅助函数
  const createProgressMessage = (
    message: AssistantMessage | NormalizedUserMessage,
  ): ProgressMessage<AgentProgress> => {
    toolUseCounter++
    return {
      type: 'progress',
      data: {
        message,
        type: 'agent_progress',
        prompt: skillContent,
        agentId,
      },
      parentToolUseID,
      toolUseID: `${parentToolUseID}-${toolUseCounter}`,
      timestamp: new Date().toISOString(),
      uuid: randomUUID(),
    }
  }

  // 使用代理进度 UI 更新进度显示的辅助函数
  const updateProgress = (): void => {
    setToolJSX({
      jsx: renderToolUseProgressMessage(progressMessages, {
        tools: context.options.tools,
        verbose: false,
      }),
      shouldHidePromptInput: false,
      shouldContinueAnimation: true,
      showSpinner: true,
    })
  }

  // 显示初始的“正在初始化…”状态
  updateProgress()

  // 运行子代理
  try {
    for await (const message of runAgent({
      agentDefinition,
      promptMessages,
      toolUseContext: {
        ...context,
        getAppState: modifiedGetAppState,
      },
      canUseTool,
      isAsync: false,
      querySource: 'agent:custom',
      model: command.model as ModelAlias | undefined,
      availableTools: context.options.tools,
    })) {
      agentMessages.push(message)
      const normalizedNew = normalizeMessages([message])

      // 为助手消息（包含工具使用）添加进度消息
      if (message.type === 'assistant') {
        // 为助手消息增加微调器的令牌计数
        const contentLength = getAssistantMessageContentLength(message as AssistantMessage)
        if (contentLength > 0) {
          context.setResponseLength(len => len + contentLength)
        }

        const normalizedMsg = normalizedNew[0]
        if (normalizedMsg && normalizedMsg.type === 'assistant') {
          progressMessages.push(createProgressMessage(message as AssistantMessage))
          updateProgress()
        }
      }

      // 为用户消息（包含工具结果）添加进度消息
      if (message.type === 'user') {
        const normalizedMsg = normalizedNew[0]
        if (normalizedMsg && normalizedMsg.type === 'user') {
          progressMessages.push(createProgressMessage(normalizedMsg as AssistantMessage))
          updateProgress()
        }
      }
    }
  } finally {
    // 清除进度显示
    setToolJSX(null)
  }

  let resultText = extractResultText(agentMessages, '命令已完成')

  logForDebugging(
    `分叉斜杠命令 /${command.name} 已通过代理 ${agentId} 完成`,
  )

  // 为 ant 用户添加调试日志前缀，使其出现在命令输出内部
  if (process.env.USER_TYPE === 'ant') {
    resultText = `[仅限 ANT] API 调用：${getDisplayPath(getDumpPromptsPath(agentId))}
${resultText}`
  }

  // 将结果作为用户消息返回（模拟代理的输出）
  const messages: UserMessage[] = [
    createUserMessage({
      content: prepareUserContent({
        inputString: `/${getCommandName(command)} ${args}`.trim(),
        precedingInputBlocks,
      }),
    }),
    createUserMessage({
      content: `<本地命令标准输出>
${resultText}
</本地命令标准输出>`,
    }),
  ]

  return {
    messages,
    shouldQuery: false,
    command,
    resultText,
  }
}

/**
 * Determines if a string looks like a valid command name.
 * Valid command names only contain letters, numbers, colons, hyphens, and underscores.
 *
 * @param commandName - The potential command name to check
 * @returns true if it looks like a command name, false if it contains non-command characters
 */
export function looksLikeCommand(commandName: string): boolean {
  // 命令名称应仅包含 [a-zA-Z0-9
  // :_-] 字符。若包含其他字符，则可能是文件路径或其他输入
  return !/[^a-zA-Z0-9:\-_]/.test(commandName)
}

export async function processSlashCommand(
  inputString: string,
  precedingInputBlocks: ContentBlockParam[],
  imageContentBlocks: ContentBlockParam[],
  attachmentMessages: AttachmentMessage[],
  context: ProcessUserInputContext,
  setToolJSX: SetToolJSXFn,
  uuid?: string,
  isAlreadyProcessing?: boolean,
  canUseTool?: CanUseToolFn,
): Promise<ProcessUserInputBaseResult> {
  const parsed = parseSlashCommand(inputString)
  if (!parsed) {
    logEvent('tengu_input_slash_missing', {})
    const errorMessage = 'Commands are in the form `/command [args]`'
    return {
      messages: [
        createSyntheticUserCaveatMessage(),
        ...attachmentMessages,
        createUserMessage({
          content: prepareUserContent({
            inputString: errorMessage,
            precedingInputBlocks,
          }),
        }),
      ],
      shouldQuery: false,
      resultText: errorMessage,
    }
  }

  const { commandName, args: parsedArgs, isMcp } = parsed

  const sanitizedCommandName = isMcp
    ? 'mcp'
    : !builtInCommandNames().has(commandName)
      ? 'custom'
      : commandName

  // 处理前检查是否为真实命令
  if (!hasCommand(commandName, context.options.commands)) {
    // 检查输入是命令名称还是文件路径或其他输入，
    // 同时检查是否为实际存在的文件路径
    let isFilePath = false
    try {
      await getFsImplementation().stat(`/${commandName}`)
      isFilePath = true
    } catch {
      // 非文件路径 — 视为命令名称
    }
    if (looksLikeCommand(commandName) && !isFilePath) {
      logEvent('tengu_input_slash_invalid', {
        input:
          commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      const unknownMessage = `未知技能：${commandName}`
      return {
        messages: [
          createSyntheticUserCaveatMessage(),
          ...attachmentMessages,
          createUserMessage({
            content: prepareUserContent({
              inputString: unknownMessage,
              precedingInputBlocks,
            }),
          }),
          // gh-32591: preserve args so the user can copy/resubmit without
          // retyping. System warning is UI-only (filtered before API).
          ...(parsedArgs
            ? [
                createSystemMessage(
                  `来自未知技能的参数：${parsedArgs}`,
                  'warning',
                ),
              ]
            : []),
        ],
        shouldQuery: false,
        resultText: unknownMessage,
      }
    }

    const promptId = randomUUID()
    setPromptId(promptId)
    logEvent('tengu_input_prompt', {})
    // 为 OTLP 记录用户提示事件
    void logOTelEvent('user_prompt', {
      prompt_length: String(inputString.length),
      prompt: redactIfDisabled(inputString),
      'prompt.id': promptId,
    })
    return {
      messages: [
        createUserMessage({
          content: prepareUserContent({ inputString, precedingInputBlocks }),
          uuid: uuid,
        }),
        ...attachmentMessages,
      ],
      shouldQuery: true,
    }
  }

  // 跟踪斜杠命令使用情况以进行功能发现

  const {
    messages: newMessages,
    shouldQuery: messageShouldQuery,
    allowedTools,
    model,
    effort,
    command: returnedCommand,
    resultText,
    nextInput,
    submitNextInput,
  } = await getMessagesForSlashCommand(
    commandName,
    parsedArgs,
    setToolJSX,
    context,
    precedingInputBlocks,
    imageContentBlocks,
    isAlreadyProcessing,
    canUseTool,
    uuid,
  )

  // 跳过消息的本地斜杠命令
  if (newMessages.length === 0) {
    const eventData: Record<string, boolean | number | undefined> = {
      input:
        sanitizedCommandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }

    // 若为插件命令，则添加插件元数据
    if (returnedCommand.type === 'prompt' && returnedCommand.pluginInfo) {
      const { pluginManifest, repository } = returnedCommand.pluginInfo
      const { marketplace } = parsePluginIdentifier(repository)
      const isOfficial = isOfficialMarketplaceName(marketplace)
      // _PROTO_* 路由到 PII 标记的 plugin_name/marketplace_na
      // me BQ 列（未脱敏，所有用户可见）；plugin_name/plugin_repo
      // sitory 保留在 additional_metadata 中作为脱敏变体供通用访问仪表板使用。
      eventData._PROTO_plugin_name =
        pluginManifest.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED
      if (marketplace) {
        eventData._PROTO_marketplace_name =
          marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED
      }
      eventData.plugin_repository = (
        isOfficial ? repository : 'third-party'
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      eventData.plugin_name = (
        isOfficial ? pluginManifest.name : 'third-party'
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      if (isOfficial && pluginManifest.version) {
        eventData.plugin_version =
          pluginManifest.version as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      }
      Object.assign(
        eventData,
        buildPluginCommandTelemetryFields(returnedCommand.pluginInfo),
      )
    }

    logEvent('tengu_input_command', {
      ...eventData,
      invocation_trigger:
        'user-slash' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(process.env.USER_TYPE === 'ant' && {
        skill_name:
          commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...(returnedCommand.type === 'prompt' && {
          skill_source:
            returnedCommand.source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...(returnedCommand.loadedFrom && {
          skill_loaded_from:
            returnedCommand.loadedFrom as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...(returnedCommand.kind && {
          skill_kind:
            returnedCommand.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
      }),
    })
    return {
      messages: [],
      shouldQuery: false,

      model,
      nextInput,
      submitNextInput,
    }
  }

  // 对于无效命令，同时保留用户消息和错误信息
  if (
    newMessages.length === 2 &&
    newMessages[1]!.type === 'user' &&
    typeof newMessages[1]!.message.content === 'string' &&
    newMessages[1]!.message.content.startsWith('Unknown command:')
  ) {
    // 若输入类似常见文件路径，则不记录为无效命令
    const looksLikeFilePath =
      inputString.startsWith('/var') ||
      inputString.startsWith('/tmp') ||
      inputString.startsWith('/private')

    if (!looksLikeFilePath) {
      logEvent('tengu_input_slash_invalid', {
        input:
          commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }

    return {
      messages: [createSyntheticUserCaveatMessage(), ...newMessages],
      shouldQuery: messageShouldQuery,
      allowedTools,

      model,
    }
  }

  // 有效命令
  const eventData: Record<string, boolean | number | undefined> = {
    input:
      sanitizedCommandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  }

  // 若为插件命令，则添加插件元数据
  if (returnedCommand.type === 'prompt' && returnedCommand.pluginInfo) {
    const { pluginManifest, repository } = returnedCommand.pluginInfo
    const { marketplace } = parsePluginIdentifier(repository)
    const isOfficial = isOfficialMarketplaceName(marketplace)
    eventData._PROTO_plugin_name =
      pluginManifest.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED
    if (marketplace) {
      eventData._PROTO_marketplace_name =
        marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED
    }
    eventData.plugin_repository = (
      isOfficial ? repository : 'third-party'
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    eventData.plugin_name = (
      isOfficial ? pluginManifest.name : 'third-party'
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    if (isOfficial && pluginManifest.version) {
      eventData.plugin_version =
        pluginManifest.version as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    }
    Object.assign(
      eventData,
      buildPluginCommandTelemetryFields(returnedCommand.pluginInfo),
    )
  }

  logEvent('tengu_input_command', {
    ...eventData,
    invocation_trigger:
      'user-slash' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(process.env.USER_TYPE === 'ant' && {
      skill_name:
        commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(returnedCommand.type === 'prompt' && {
        skill_source:
          returnedCommand.source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(returnedCommand.loadedFrom && {
        skill_loaded_from:
          returnedCommand.loadedFrom as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(returnedCommand.kind && {
        skill_kind:
          returnedCommand.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    }),
  })

  // 检查是否为紧凑结果，此类结果自行处理其合成的注意事项消息排序
  const isCompactResult =
    newMessages.length > 0 &&
    newMessages[0] &&
    isCompactBoundaryMessage(newMessages[0])

  return {
    messages:
      messageShouldQuery ||
      newMessages.every(isSystemLocalCommandMessage) ||
      isCompactResult
        ? newMessages
        : [createSyntheticUserCaveatMessage(), ...newMessages],
    shouldQuery: messageShouldQuery,
    allowedTools,
    model,
    effort,
    resultText,
    nextInput,
    submitNextInput,
  }
}

async function getMessagesForSlashCommand(
  commandName: string,
  args: string,
  setToolJSX: SetToolJSXFn,
  context: ProcessUserInputContext,
  precedingInputBlocks: ContentBlockParam[],
  imageContentBlocks: ContentBlockParam[],
  _isAlreadyProcessing?: boolean,
  canUseTool?: CanUseToolFn,
  uuid?: string,
): Promise<SlashCommandResult> {
  const command = getCommand(commandName, context.options.commands)

  // 跟踪技能使用情况以进行排名（仅适用于用户可调用的提示命令）
  if (command.type === 'prompt' && command.userInvocable !== false) {
    recordSkillUsage(commandName)
  }

  // 检查命令是否可由用户调用。userIn
  // vocable === false 的技能只能通过 SkillTool 由模型调用
  if (command.userInvocable === false) {
    return {
      messages: [
        createUserMessage({
          content: prepareUserContent({
            inputString: `/${commandName}`,
            precedingInputBlocks,
          }),
        }),
        createUserMessage({
          content: `此技能只能由 Claude 调用，用户无法直接调用。请让 Claude 为您使用“${commandName}”技能。`,
        }),
      ],
      shouldQuery: false,
      command,
    }
  }

  try {
    switch (command.type) {
      case 'local-jsx': {
        return new Promise<SlashCommandResult>(resolve => {
          let doneWasCalled = false
          const onDone = (
            result?: string,
            options?: {
              display?: CommandResultDisplay
              shouldQuery?: boolean
              metaMessages?: string[]
              nextInput?: string
              submitNextInput?: boolean
            },
          ) => {
            doneWasCalled = true
            // 若显示模式为 'skip'，则不向对话添加任何消息
            if (options?.display === 'skip') {
              void resolve({
                messages: [],
                shouldQuery: false,
                command,
                nextInput: options?.nextInput,
                submitNextInput: options?.submitNextInput,
              })
              return
            }

            // 元消息对模型可见，但对用户隐藏
            const metaMessages = (options?.metaMessages ?? []).map(
              (content: string) => createUserMessage({ content, isMeta: true }),
            )

            // 在全屏模式下，命令仅显示为居中的模态窗格 — 瞬时通知已
            // 足够提供反馈。“❯ /config” + “⎿ dism
            // issed” 转录条目类型为 type:syst
            // em subtype:local_command（用户可见
            // 但不会发送给模型），因此跳过它们不会影响模型上下文。非全屏模
            // 式下保留这些条目，以便滚动历史显示已执行内容。仅跳过“<
            // 名称> dismissed”模态关闭通知 — 在显示模
            // 态前提前退出的命令（/ultraplan 使用、/rena
            // me、/proactive）使用 display:sys
            // tem 处理必须到达转录的实际输出。
            const skipTranscript =
              isFullscreenEnvEnabled() &&
              typeof result === 'string' &&
              result.endsWith(' dismissed')

            void resolve({
              messages:
                options?.display === 'system'
                  ? skipTranscript
                    ? metaMessages
                    : [
                        createCommandInputMessage(
                          formatCommandInput(command, args),
                        ),
                        createCommandInputMessage(
                          `<local-command-stdout>${result}</local-command-stdout>`,
                        ),
                        ...metaMessages,
                      ]
                  : [
                      createUserMessage({
                        content: prepareUserContent({
                          inputString: formatCommandInput(command, args),
                          precedingInputBlocks,
                        }),
                      }),
                      result
                        ? createUserMessage({
                            content: `<local-command-stdout>${result}</local-command-stdout>`,
                          })
                        : createUserMessage({
                            content: `<local-command-stdout>${NO_CONTENT_MESSAGE}</local-command-stdout>`,
                          }),
                      ...metaMessages,
                    ],
              shouldQuery: options?.shouldQuery ?? false,
              command,
              nextInput: options?.nextInput,
              submitNextInput: options?.submitNextInput,
            })
          }

          void command
            .load()
            .then(mod => mod.call(onDone, { ...context, canUseTool }, args))
            .then(jsx => {
              if (jsx == null) return
              if (context.options.isNonInteractiveSession) {
                void resolve({
                  messages: [],
                  shouldQuery: false,
                  command,
                })
                return
              }
              // 防护机制：若在 mod.call() 期间触发 onDone（调用 onDo
              // ne 后返回 JSX 的提前退出路径），则跳过 setToolJSX。此链为
              // 触发即忘模式 — 当 onDone 被调用时外部 Promise 即解析，因
              // 此 executeUserInput 可能在我们到达此处之前已运行其 set
              // ToolJSX({clearLocalJSX: true})。在清除后设置
              // isLocalJSXCommand 会使其卡在 true 状态，从而阻塞 us
              // eQueueProcessor 和 TextInput 焦点。
              if (doneWasCalled) return
              setToolJSX({
                jsx,
                shouldHidePromptInput: true,
                showSpinner: false,
                isLocalJSXCommand: true,
                isImmediate: command.immediate === true,
              })
            })
            .catch(e => {
              // 若 load()/call() 抛出异常且 onDone 从未触发，
              // 外部 Promise 将永久挂起，导致 queryGuard
              // 卡在 'dispatching' 状态并使队列处理器死锁。
              logError(e)
              if (doneWasCalled) return
              doneWasCalled = true
              setToolJSX({
                jsx: null,
                shouldHidePromptInput: false,
                clearLocalJSX: true,
              })
              void resolve({ messages: [], shouldQuery: false, command })
            })
        })
      }
      case 'local': {
        const displayArgs = command.isSensitive && args.trim() ? '***' : args
        const userMessage = createUserMessage({
          content: prepareUserContent({
            inputString: formatCommandInput(command, displayArgs),
            precedingInputBlocks,
          }),
        })

        try {
          const syntheticCaveatMessage = createSyntheticUserCaveatMessage()
          const mod = await command.load()
          const result = await mod.call(args, context)

          if (result.type === 'skip') {
            return {
              messages: [],
              shouldQuery: false,
              command,
            }
          }

          // 使用可辨识联合处理不同的结果类型
          if (result.type === 'compact') {
            // 将斜杠命令消息附加到 messagesToKeep，确
            // 保附件和 hookResults 位于用户消息之后
            const slashCommandMessages = [
              syntheticCaveatMessage,
              userMessage,
              ...(result.displayText
                ? [
                    createUserMessage({
                      content: `<local-command-stdout>${result.displayText}</local-command-stdout>`,
                      // --resume 查看最新时间戳消息以确定从哪条消息
                      // 恢复。此为性能优化，避免每次重新计算叶节点。由于我
                      // 们为紧凑模式创建了大量合成消息，将最后一条消息的时间
                      // 戳设置为略晚于当前时间至关重要。这对 SDK
                      // / -p 模式尤为重要。
                      timestamp: new Date(Date.now() + 100).toISOString(),
                    }),
                  ]
                : []),
            ]
            const compactionResultWithSlashMessages = {
              ...result.compactionResult,
              messagesToKeep: [
                ...(result.compactionResult.messagesToKeep ?? []),
                ...slashCommandMessages,
              ],
            }
            // 重置微紧凑状态，因为完整紧凑会替换所有消息 —
            // 旧工具 ID 不再相关。预算状态（位于 toolUs
            // eContext 上）无需重置：过期条目为惰性状态（
            // UUID 永不重复，因此永远不会被查找）。
            resetMicrocompactState()
            return {
              messages: buildPostCompactMessages(
                compactionResultWithSlashMessages,
              ) as AssistantMessage[],
              shouldQuery: false,
              command,
            }
          }

          // 文本结果 — 使用系统消息，避免渲染为用户气泡
          return {
            messages: [
              userMessage,
              createCommandInputMessage(
                `<local-command-stdout>${result.value}</local-command-stdout>`,
              ),
            ],
            shouldQuery: false,
            command,
            resultText: result.value,
          }
        } catch (e) {
          logError(e)
          return {
            messages: [
              userMessage,
              createCommandInputMessage(
                `<local-command-stderr>${String(e)}</local-command-stderr>`,
              ),
            ],
            shouldQuery: false,
            command,
          }
        }
      }
      case 'prompt': {
        try {
          // 检查命令是否应作为分叉子代理运行
          if (command.context === 'fork') {
            return await executeForkedSlashCommand(
              command,
              args,
              context,
              precedingInputBlocks,
              setToolJSX,
              canUseTool ?? hasPermissionsToUseTool,
            )
          }

          return await getMessagesForPromptSlashCommand(
            command,
            args,
            context,
            precedingInputBlocks,
            imageContentBlocks,
            uuid,
          )
        } catch (e) {
          // 特殊处理中止错误，以显示正确的“已中断”消息
          if (e instanceof AbortError) {
            return {
              messages: [
                createUserMessage({
                  content: prepareUserContent({
                    inputString: formatCommandInput(command, args),
                    precedingInputBlocks,
                  }),
                }),
                createUserInterruptionMessage({ toolUse: false }),
              ],
              shouldQuery: false,
              command,
            }
          }
          return {
            messages: [
              createUserMessage({
                content: prepareUserContent({
                  inputString: formatCommandInput(command, args),
                  precedingInputBlocks,
                }),
              }),
              createUserMessage({
                content: `<local-command-stderr>${String(e)}</local-command-stderr>`,
              }),
            ],
            shouldQuery: false,
            command,
          }
        }
      }
    }
  } catch (e) {
    if (e instanceof MalformedCommandError) {
      return {
        messages: [
          createUserMessage({
            content: prepareUserContent({
              inputString: e.message,
              precedingInputBlocks,
            }),
          }),
        ],
        shouldQuery: false,
        command,
      }
    }
    throw e
  }
}

function formatCommandInput(command: CommandBase, args: string): string {
  return formatCommandInputTags(getCommandName(command), args)
}

/**
 * Formats the metadata for a skill loading message.
 * Used by the Skill tool and for subagent skill preloading.
 */
export function formatSkillLoadingMetadata(
  skillName: string,
  _progressMessage: string = 'loading',
): string {
  // 仅使用技能名称 - UserCommandMessage 会渲染为“Skill(name)”
  return [
    `<${COMMAND_MESSAGE_TAG}>${skillName}</${COMMAND_MESSAGE_TAG}>`,
    `<${COMMAND_NAME_TAG}>${skillName}</${COMMAND_NAME_TAG}>`,
    `<skill-format>true</skill-format>`,
  ].join('\n')
}

/**
 * Formats the metadata for a slash command loading message.
 */
function formatSlashCommandLoadingMetadata(
  commandName: string,
  args?: string,
): string {
  return [
    `<${COMMAND_MESSAGE_TAG}>${commandName}</${COMMAND_MESSAGE_TAG}>`,
    `<${COMMAND_NAME_TAG}>/${commandName}</${COMMAND_NAME_TAG}>`,
    args ? `<command-args>${args}</command-args>` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Formats the loading metadata for a command (skill or slash command).
 * User-invocable skills use slash command format (/name), while model-only
 * skills use the skill format ("The X skill is running").
 */
function formatCommandLoadingMetadata(
  command: CommandBase & PromptCommand,
  args?: string,
): string {
  // 使用 command.name（包含插件前缀的完整名称，例如“product
  // -management:feature-spec”），而不是可能通过 displa
  // yName 回退机制去除插件前缀的 userFacing
  // Name()。用户可调用的技能应显示为 /command-name，就像常规的斜杠命令一样
  if (command.userInvocable !== false) {
    return formatSlashCommandLoadingMetadata(command.name, args)
  }
  // 仅模型技能（userInvocable: false）显示为“X 技能正在运行”
  if (
    command.loadedFrom === 'skills' ||
    command.loadedFrom === 'plugin' ||
    command.loadedFrom === 'mcp'
  ) {
    return formatSkillLoadingMetadata(command.name, command.progressMessage)
  }
  return formatSlashCommandLoadingMetadata(command.name, args)
}

export async function processPromptSlashCommand(
  commandName: string,
  args: string,
  commands: Command[],
  context: ToolUseContext,
  imageContentBlocks: ContentBlockParam[] = [],
): Promise<SlashCommandResult> {
  const command = findCommand(commandName, commands)
  if (!command) {
    throw new MalformedCommandError(`未知命令：${commandName}`)
  }
  if (command.type !== 'prompt') {
    throw new Error(
      `意外的 ${command.type} 命令。应为 'prompt' 命令。请在主对话中直接使用 /${commandName}。`,
    )
  }
  return getMessagesForPromptSlashCommand(
    command,
    args,
    context,
    [],
    imageContentBlocks,
  )
}

async function getMessagesForPromptSlashCommand(
  command: CommandBase & PromptCommand,
  args: string,
  context: ToolUseContext,
  precedingInputBlocks: ContentBlockParam[] = [],
  imageContentBlocks: ContentBlockParam[] = [],
  uuid?: string,
): Promise<SlashCommandResult> {
  // 在协调器模式（仅主线程）下，跳过加载完整的技能内容和权限。协
  // 调器仅拥有 Agent + TaskStop 工具，因此
  // 技能内容和 allowedTools 无用。相反，发送一个
  // 简短的摘要，告诉协调器如何将此技能委派给工作线程。
  //
  // 工作线程在进程内运行，并从父环境继承 CLAUDE_CODE_COORDIN
  // ATOR_MODE，因此我们还要检查 !context.agentId：a
  // gentId 仅针对子代理设置，让工作线程进入 getPromptForCom
  // mand 并在调用 Skill 工具时接收真实的技能内容。
  if (
    feature('COORDINATOR_MODE') &&
    isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE) &&
    !context.agentId
  ) {
    const metadata = formatCommandLoadingMetadata(command, args)
    const parts: string[] = [
      `技能“/${command.name}”可供工作线程使用。`,
    ]
    if (command.description) {
      parts.push(`描述：${command.description}`)
    }
    if (command.whenToUse) {
      parts.push(`使用时机：${command.whenToUse}`)
    }
    const skillAllowedTools = command.allowedTools ?? []
    if (skillAllowedTools.length > 0) {
      parts.push(
        `此技能授予工作线程额外的工具权限：${skillAllowedTools.join(', ')}`,
      )
    }
    parts.push(
      `
通过在你的 Agent 提示中包含“使用 /${command.name} 技能”来指示工作线程使用此技能。工作线程有权访问 Skill 工具，并在调用时接收该技能的内容和权限。`,
    )
    const summaryContent: ContentBlockParam[] = [
      { type: 'text', text: parts.join('\n') },
    ]
    return {
      messages: [
        createUserMessage({ content: metadata, uuid }),
        createUserMessage({ content: summaryContent, isMeta: true }),
      ],
      shouldQuery: true,
      model: command.model,
      effort: command.effort,
      command,
    }
  }

  const result = await command.getPromptForCommand(args, context)

  // 如果定义了技能钩子，则注册它们。在仅 ["hooks"] 下（技能未锁
  // 定），用户技能仍会加载并到达此处——在已知来源的位置阻止钩子注册。这反
  // 映了 runAgent.ts 中的代理 frontmatter 门控。
  const hooksAllowedForThisSkill =
    !isRestrictedToPluginOnly('hooks') || isSourceAdminTrusted(command.source)
  if (command.hooks && hooksAllowedForThisSkill) {
    const sessionId = getSessionId()
    registerSkillHooks(
      context.setAppState,
      sessionId,
      command.hooks,
      command.name,
      command.type === 'prompt' ? command.skillRoot : undefined,
    )
  }

  // 记录技能调用以进行压缩保留，作用域限定在代理上下文中
  // 。技能会标记其 agentId，因此只有属于当前代
  // 理的技能会在压缩期间被恢复（防止跨代理泄漏）。
  const skillPath = command.source
    ? `${command.source}:${command.name}`
    : command.name
  const skillContent = result
    .filter((b): b is TextBlockParam => b.type === 'text')
    .map(b => b.text)
    .join('\n\n')
  addInvokedSkill(
    command.name,
    skillPath,
    skillContent,
    getAgentContext()?.agentId ?? null,
  )

  const metadata = formatCommandLoadingMetadata(command, args)

  const additionalAllowedTools = parseToolListFromCLI(
    command.allowedTools ?? [],
  )

  // 为主消息创建内容，包括任何粘贴的图片
  const mainMessageContent: ContentBlockParam[] =
    imageContentBlocks.length > 0 || precedingInputBlocks.length > 0
      ? [...imageContentBlocks, ...precedingInputBlocks, ...result]
      : result

  // 从命令参数中提取附件（@-提及、MCP 资源、SKILL.md
  // 中的代理提及）。skipSkillDiscovery 可防止
  // SKILL.md 内容本身触发发现——它是元内容，而非用户意
  // 图，并且一个大型的 SKILL.md（例如 110KB）会触发分
  // 块的 AKI 查询，给每次技能调用增加数秒延迟。
  const attachmentMessages = await toArray(
    getAttachmentMessages(
      result
        .filter((block): block is TextBlockParam => block.type === 'text')
        .map(block => block.text)
        .join(' '),
      context,
      null,
      [], // queuedCommands - handled by query.ts for mid-turn attachments
      context.messages,
      'repl_main_thread',
      { skipSkillDiscovery: true },
    ),
  )

  const messages = [
    createUserMessage({
      content: metadata,
      uuid,
    }),
    createUserMessage({
      content: mainMessageContent,
      isMeta: true,
    }),
    ...attachmentMessages,
    createAttachmentMessage({
      type: 'command_permissions',
      allowedTools: additionalAllowedTools,
      model: command.model,
    }),
  ]

  return {
    messages,
    shouldQuery: true,
    allowedTools: additionalAllowedTools,
    model: command.model,
    effort: command.effort,
    command,
  }
}
