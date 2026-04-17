import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import uniqBy from 'lodash-es/uniqBy.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getProjectRoot, getSessionId } from '../../bootstrap/state.js'
import { getCommand, getSkillToolCommands, hasCommand } from '../../commands.js'
import {
  DEFAULT_AGENT_PROMPT,
  enhanceSystemPromptWithEnvDetails,
} from '../../constants/prompts.js'
import type { QuerySource } from '../../constants/querySource.js'
import { getSystemContext, getUserContext } from '../../context.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { query } from '../../query.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getDumpPromptsPath } from '../../services/api/dumpPrompts.js'
import { cleanupAgentTracking } from '../../services/api/promptCacheBreakDetection.js'
import {
  connectToServer,
  fetchToolsForClient,
} from '../../services/mcp/client.js'
import { getMcpConfigByName } from '../../services/mcp/config.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import type { Tool, Tools, ToolUseContext } from '../../Tool.js'
import { killShellTasksForAgent } from '../../tasks/LocalShellTask/killShellTasks.js'
import type { Command } from '../../types/command.js'
import type { AgentId } from '../../types/ids.js'
import type {
  AssistantMessage,
  Message,
  ProgressMessage,
  RequestStartEvent,
  StreamEvent,
  SystemCompactBoundaryMessage,
  TombstoneMessage,
  ToolUseSummaryMessage,
  UserMessage,
} from '../../types/message.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { AbortError } from '../../utils/errors.js'
import { getDisplayPath } from '../../utils/file.js'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../utils/fileStateCache.js'
import {
  type CacheSafeParams,
  createSubagentContext,
} from '../../utils/forkedAgent.js'
import { registerFrontmatterHooks } from '../../utils/hooks/registerFrontmatterHooks.js'
import { clearSessionHooks } from '../../utils/hooks/sessionHooks.js'
import { executeSubagentStartHooks } from '../../utils/hooks.js'
import { createUserMessage } from '../../utils/messages.js'
import { getAgentModel } from '../../utils/model/agent.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import {
  clearAgentTranscriptSubdir,
  recordSidechainTranscript,
  setAgentTranscriptSubdir,
  writeAgentMetadata,
} from '../../utils/sessionStorage.js'
import {
  isRestrictedToPluginOnly,
  isSourceAdminTrusted,
} from '../../utils/settings/pluginOnlyPolicy.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPromptType.js'
import {
  isPerfettoTracingEnabled,
  registerAgent as registerPerfettoAgent,
  unregisterAgent as unregisterPerfettoAgent,
} from '../../utils/telemetry/perfettoTracing.js'
import type { ContentReplacementState } from '../../utils/toolResultStorage.js'
import { createAgentId } from '../../utils/uuid.js'
import { resolveAgentTools } from './agentToolUtils.js'
import { type AgentDefinition, isBuiltInAgent } from './loadAgentsDir.js'

/**
 * 初始化代理专属 MCP 服务
 * 代理可在 frontmatter 中声明 MCP 服务，与父级 MCP 客户端叠加。
 * 代理启动时连接这些服务，结束时清理。
 *
 * @param agentDefinition 含可选 mcpServers 的代理定义
 * @param parentClients 从父上下文继承的 MCP 客户端
 * @returns 合并后的客户端（父级 + 代理专属）、代理 MCP 工具与清理函数
 */
async function initializeAgentMcpServers(
  agentDefinition: AgentDefinition,
  parentClients: MCPServerConnection[],
): Promise<{
  clients: MCPServerConnection[]
  tools: Tools
  cleanup: () => Promise<void>
}> {
  // 未定义代理专属服务时，原样返回父级客户端
  if (!agentDefinition.mcpServers?.length) {
    return {
      clients: parentClients,
      tools: [],
      cleanup: async () => {},
    }
  }

  // MCP 锁为仅插件时，仅对用户可控代理跳过 frontmatter MCP。
  // 插件、内置与 policySettings 代理属管理员信任 —— 其 frontmatter MCP 在管理员批准面内。
  // 一律拦截会破坏确实需要 MCP 的插件代理，与「插件提供的一律加载」矛盾。
  const agentIsAdminTrusted = isSourceAdminTrusted(agentDefinition.source)
  if (isRestrictedToPluginOnly('mcp') && !agentIsAdminTrusted) {
    logForDebugging(
      `[Agent: ${agentDefinition.agentType}] 跳过 MCP 服务：strictPluginOnlyCustomization 将 MCP 限制为仅插件（代理来源：${agentDefinition.source}）`,
    )
    return {
      clients: parentClients,
      tools: [],
      cleanup: async () => {},
    }
  }

  const agentClients: MCPServerConnection[] = []
  // 区分新建（内联定义）与复用父级的客户端
  // 仅新建客户端在代理结束时需要清理
  const newlyCreatedClients: MCPServerConnection[] = []
  const agentTools: Tool[] = []

  for (const spec of agentDefinition.mcpServers) {
    let config: ScopedMcpServerConfig | null = null
    let name: string
    let isNewlyCreated = false

    if (typeof spec === 'string') {
      // 按名称引用 —— 在已有 MCP 配置中查找
      // 使用带缓存的 connectToServer，可能得到共享客户端
      name = spec
      config = getMcpConfigByName(spec)
      if (!config) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] 未找到 MCP 服务：${spec}`,
          { level: 'warn' },
        )
        continue
      }
    } else {
      // 内联定义为 { [name]: config }
      // 属代理专属，结束时应清理
      const entries = Object.entries(spec)
      if (entries.length !== 1) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] 无效的 MCP 服务规格：应恰好一个键`,
          { level: 'warn' },
        )
        continue
      }
      const [serverName, serverConfig] = entries[0]!
      name = serverName
      config = {
        ...serverConfig,
        scope: 'dynamic' as const,
      } as ScopedMcpServerConfig
      isNewlyCreated = true
    }

    // 连接服务
    const client = await connectToServer(name, config)
    agentClients.push(client)
    if (isNewlyCreated) {
      newlyCreatedClients.push(client)
    }

    // 已连接则拉取工具
    if (client.type === 'connected') {
      const tools = await fetchToolsForClient(client)
      agentTools.push(...tools)
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] 已连接 MCP 服务 '${name}'，共 ${tools.length} 个工具`,
      )
    } else {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] 连接 MCP 服务 '${name}' 失败：${client.type}`,
        { level: 'warn' },
      )
    }
  }

  // 代理专属服务的清理函数
  // 仅清理新建（内联）客户端，不清理共享/引用客户端
  // 字符串名引用的共享客户端被缓存，仍由父上下文使用
  const cleanup = async () => {
    for (const client of newlyCreatedClients) {
      if (client.type === 'connected') {
        try {
          await client.cleanup()
        } catch (error) {
          logForDebugging(
            `[Agent: ${agentDefinition.agentType}] 清理 MCP 服务 '${client.name}' 出错：${error}`,
            { level: 'warn' },
          )
        }
      }
    }
  }

  // 返回合并客户端（父级 + 代理专属）与代理工具
  return {
    clients: [...parentClients, ...agentClients],
    tools: agentTools,
    cleanup,
  }
}

type QueryMessage =
  | StreamEvent
  | RequestStartEvent
  | Message
  | ToolUseSummaryMessage
  | TombstoneMessage

/**
 * 判断 query() 产出消息是否为可记录的 Message 类型。
 * 匹配需持久化的类型：assistant、user、progress，或 system compact_boundary。
 */
function isRecordableMessage(
  msg: QueryMessage,
): msg is
  | AssistantMessage
  | UserMessage
  | ProgressMessage
  | SystemCompactBoundaryMessage {
  return (
    msg.type === 'assistant' ||
    msg.type === 'user' ||
    msg.type === 'progress' ||
    (msg.type === 'system' &&
      'subtype' in msg &&
      msg.subtype === 'compact_boundary')
  )
}

export async function* runAgent({
  agentDefinition,
  promptMessages,
  toolUseContext,
  canUseTool,
  isAsync,
  canShowPermissionPrompts,
  forkContextMessages,
  querySource,
  override,
  model,
  maxTurns,
  preserveToolUseResults,
  availableTools,
  allowedTools,
  onCacheSafeParams,
  contentReplacementState,
  useExactTools,
  worktreePath,
  description,
  transcriptSubdir,
  onQueryProgress,
}: {
  agentDefinition: AgentDefinition
  promptMessages: Message[]
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  isAsync: boolean
  /**
   * 该代理是否可展示权限提示。默认值为 !isAsync。
   * 对于进程内队友：即使以异步方式运行，但与主会话共享终端，也应设为 true。
   */
  canShowPermissionPrompts?: boolean
  forkContextMessages?: Message[]
  querySource: QuerySource
  override?: {
    userContext?: { [k: string]: string }
    systemContext?: { [k: string]: string }
    systemPrompt?: SystemPrompt
    abortController?: AbortController
    agentId?: AgentId
  }
  model?: ModelAlias
  maxTurns?: number
  /** 对于 transcript 可查看的子代理，在消息上保留 toolUseResult */
  preserveToolUseResults?: boolean
  /**
   * 预先计算的子代理工具池。由调用方（AgentTool.tsx）计算，避免 runAgent 与 tools.ts 循环依赖。
   * 始终包含按「子代理自身权限模式」组装的完整工具池，不受父级工具限制影响。
   */
  availableTools: Tools
  /**
   * 追加到该代理会话 allow 规则中的工具权限规则。
   * 提供时会替换所有 allow 规则，使代理仅拥有显式列出的权限（父级批准不会泄漏）。
   */
  allowedTools?: string[]
  /**
   * 可选回调：在构造完代理的 system prompt、上下文与工具后，回传 CacheSafeParams。
   * 供后台摘要使用，用于分叉代理会话并周期性产出进度摘要。
   */
  onCacheSafeParams?: (params: CacheSafeParams) => void
  /**
   * 从恢复的侧链 transcript 重建的替换状态，用于对相同工具结果重复替换（提升 prompt cache 稳定性）。
   * 省略时 createSubagentContext 会克隆父级状态。
   */
  contentReplacementState?: ContentReplacementState
  /**
   * 为 true 时直接使用 availableTools，不经 resolveAgentTools() 过滤。
   * 同时继承父级的 thinkingConfig 与 isNonInteractiveSession，而非覆盖。
   * 用于 fork 子代理路径，以生成字节级一致的 API 请求前缀，提升 prompt cache 命中。
   */
  useExactTools?: boolean
  /**
   * 若代理以 isolation: \"worktree\" 启动，则为 worktree 路径。
   * 会持久化到元数据，便于恢复时还原正确 cwd。
   */
  worktreePath?: string
  /**
   * 来自 AgentTool 输入的原始任务描述。
   * 会持久化到元数据，便于恢复后的通知显示原始描述。
   */
  description?: string
  /**
   * subagents/ 下的可选子目录，用于将该代理 transcript 与相关 transcript 归组
   *（如工作流子代理写入 workflows/<runId>）。
   */
  transcriptSubdir?: string
  /**
   * 可选回调：对 query() yield 的每条消息触发——包含 runAgent 通常会丢弃的 stream_event delta。
   * 用于在长时间单块流（如 thinking）期间探测存活性，此时可能 >60s 都没有 assistant 消息产出。
   */
  onQueryProgress?: () => void
}): AsyncGenerator<Message, void> {
  // 跟踪子代理使用以便功能发现

  const appState = toolUseContext.getAppState()
  const permissionMode = appState.toolPermissionContext.mode
  // 始终通向根 AppState 的通道。父级本身为异步代理时 toolUseContext.setAppState 为空操作，
  // 会话级写入（钩子、bash 任务）须走此通道。
  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState

  const resolvedAgentModel = getAgentModel(
    agentDefinition.model,
    toolUseContext.options.mainLoopModel,
    model,
    permissionMode,
  )

  const agentId = override?.agentId ? override.agentId : createAgentId()

  // 若指定 transcriptSubdir，则将该代理 transcript 写入归组子目录
  //（如工作流子代理写入 subagents/workflows/<runId>/）。
  if (transcriptSubdir) {
    setAgentTranscriptSubdir(agentId, transcriptSubdir)
  }

  // 在 Perfetto trace 中注册代理，用于层级可视化
  if (isPerfettoTracingEnabled()) {
    const parentId = toolUseContext.agentId ?? getSessionId()
    registerPerfettoAgent(agentId, agentDefinition.agentType, parentId)
  }

  // 记录子代理 API 调用路径（仅 ant）
  if (process.env.USER_TYPE === 'ant') {
    logForDebugging(
      `[Subagent ${agentDefinition.agentType}] API 调用：${getDisplayPath(getDumpPromptsPath(agentId))}`,
    )
  }

  // 处理消息分叉以共享上下文
  // 从父级消息中过滤未完成的工具调用，避免 API 报错
  const contextMessages: Message[] = forkContextMessages
    ? filterIncompleteToolCalls(forkContextMessages)
    : []
  const initialMessages: Message[] = [...contextMessages, ...promptMessages]

  const agentReadFileState =
    forkContextMessages !== undefined
      ? cloneFileStateCache(toolUseContext.readFileState)
      : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)

  const [baseUserContext, baseSystemContext] = await Promise.all([
    override?.userContext ?? getUserContext(),
    override?.systemContext ?? getSystemContext(),
  ])

  // 只读代理（Explore、Plan）不会执行 CLAUDE.md 中的 commit/PR/lint 规则——
  // 主代理具备完整上下文并会解释其输出。
  // 在此丢弃 claudeMd 可在 3400 万+ Explore 启动中节省约 5–15 Gtok/周。
  // 调用方显式传入的 override.userContext 保持不变。
  // 总开关默认开启；将 tengu_slim_subagent_claudemd=false 可回滚。
  const shouldOmitClaudeMd =
    agentDefinition.omitClaudeMd &&
    !override?.userContext &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_slim_subagent_claudemd', true)
  const { claudeMd: _omittedClaudeMd, ...userContextNoClaudeMd } =
    baseUserContext
  const resolvedUserContext = shouldOmitClaudeMd
    ? userContextNoClaudeMd
    : baseUserContext

  // Explore/Plan 为只读搜索代理——父级 session_start 的 gitStatus（最多 40KB，且明确标记为 stale）
  // 对它们是冗余。如果需要 git 信息，它们会自行运行 `git status` 获取最新数据。
  // 全局可节省约 1–3 Gtok/周。
  const { gitStatus: _omittedGitStatus, ...systemContextNoGit } =
    baseSystemContext
  const resolvedSystemContext =
    agentDefinition.agentType === 'Explore' ||
    agentDefinition.agentType === 'Plan'
      ? systemContextNoGit
      : baseSystemContext

  // 若代理定义了 permissionMode，则覆盖权限模式
  // 但若父级处于 bypassPermissions 或 acceptEdits，则它们应始终优先
  // 对异步代理，还需设置 shouldAvoidPermissionPrompts（无法展示 UI）
  const agentPermissionMode = agentDefinition.permissionMode
  const agentGetAppState = () => {
    const state = toolUseContext.getAppState()
    let toolPermissionContext = state.toolPermissionContext

    // 若代理定义了 permissionMode 则覆盖（除非父级为 bypassPermissions、acceptEdits 或 auto）
    if (
      agentPermissionMode &&
      state.toolPermissionContext.mode !== 'bypassPermissions' &&
      state.toolPermissionContext.mode !== 'acceptEdits' &&
      !(
        feature('TRANSCRIPT_CLASSIFIER') &&
        state.toolPermissionContext.mode === 'auto'
      )
    ) {
      toolPermissionContext = {
        ...toolPermissionContext,
        mode: agentPermissionMode,
      }
    }

    // 对无法展示 UI 的代理，设置标记以自动拒绝权限提示
    // 若提供 canShowPermissionPrompts 则以其为准，否则：
    //   - bubble 模式：始终展示提示（冒泡到父级终端）
    //   - 默认：!isAsync（同步代理展示，异步代理不展示）
    const shouldAvoidPrompts =
      canShowPermissionPrompts !== undefined
        ? !canShowPermissionPrompts
        : agentPermissionMode === 'bubble'
          ? false
          : isAsync
    if (shouldAvoidPrompts) {
      toolPermissionContext = {
        ...toolPermissionContext,
        shouldAvoidPermissionPrompts: true,
      }
    }

    // 对可展示提示的后台代理，在展示权限对话框前等待自动检查（分类器、权限钩子）。
    // 后台代理等待无妨——仅当自动检查无法判定权限时才打断用户。
    // 适用于 bubble 模式（始终）以及显式 canShowPermissionPrompts。
    if (isAsync && !shouldAvoidPrompts) {
      toolPermissionContext = {
        ...toolPermissionContext,
        awaitAutomatedChecksBeforeDialog: true,
      }
    }

    // 限定工具权限：提供 allowedTools 时，将其作为会话级规则。
    // 重要：保留 cliArg 规则（来自 SDK 的 --allowedTools），它们是 SDK 调用方显式授予的权限，应对所有代理生效。
    // 仅清理父级的 session 级规则，防止非预期泄漏。
    if (allowedTools !== undefined) {
      toolPermissionContext = {
        ...toolPermissionContext,
        alwaysAllowRules: {
          // 保留来自 --allowedTools 的 SDK 级权限
          cliArg: state.toolPermissionContext.alwaysAllowRules.cliArg,
          // 将提供的 allowedTools 作为会话级权限
          session: [...allowedTools],
        },
      }
    }

    // 若代理定义了 effort，则覆盖 effort 级别
    const effortValue =
      agentDefinition.effort !== undefined
        ? agentDefinition.effort
        : state.effortValue

    if (
      toolPermissionContext === state.toolPermissionContext &&
      effortValue === state.effortValue
    ) {
      return state
    }
    return {
      ...state,
      toolPermissionContext,
      effortValue,
    }
  }

  const resolvedTools = useExactTools
    ? availableTools
    : resolveAgentTools(agentDefinition, availableTools, isAsync).resolvedTools

  const additionalWorkingDirectories = Array.from(
    appState.toolPermissionContext.additionalWorkingDirectories.keys(),
  )

  const agentSystemPrompt = override?.systemPrompt
    ? override.systemPrompt
    : asSystemPrompt(
        await getAgentSystemPrompt(
          agentDefinition,
          toolUseContext,
          resolvedAgentModel,
          additionalWorkingDirectories,
          resolvedTools,
        ),
      )

  // 确定 abortController：
  // - override 优先
  // - 异步代理使用新的、与父级不联动的 controller（独立运行）
  // - 同步代理与父级共享 controller
  const agentAbortController = override?.abortController
    ? override.abortController
    : isAsync
      ? new AbortController()
      : toolUseContext.abortController

  // 执行 SubagentStart 钩子并收集 additionalContext
  const additionalContexts: string[] = []
  for await (const hookResult of executeSubagentStartHooks(
    agentId,
    agentDefinition.agentType,
    agentAbortController.signal,
  )) {
    if (
      hookResult.additionalContexts &&
      hookResult.additionalContexts.length > 0
    ) {
      additionalContexts.push(...hookResult.additionalContexts)
    }
  }

  // 将 SubagentStart 钩子上下文作为 user 消息注入（与 SessionStart/UserPromptSubmit 一致）
  if (additionalContexts.length > 0) {
    const contextMessage = createAttachmentMessage({
      type: 'hook_additional_context',
      content: additionalContexts,
      hookName: 'SubagentStart',
      toolUseID: randomUUID(),
      hookEvent: 'SubagentStart',
    })
    initialMessages.push(contextMessage)
  }

  // 注册代理 frontmatter 钩子（限定在代理生命周期内）
  // 传 isAgent=true，将 Stop 钩子转换为 SubagentStop（子代理触发 SubagentStop）
  // frontmatter 钩子同样走管理员信任门禁：仅在 ["hooks"] 被锁（skills/agents 未锁）时，
  // 用户代理仍会加载——应在此处（已知 source）阻止其 frontmatter-hook「注册」，而非在执行时一刀切禁用
  // 全部会话钩子（那也会误伤插件代理钩子）。
  const hooksAllowedForThisAgent =
    !isRestrictedToPluginOnly('hooks') ||
    isSourceAdminTrusted(agentDefinition.source)
  if (agentDefinition.hooks && hooksAllowedForThisAgent) {
    registerFrontmatterHooks(
      rootSetAppState,
      agentId,
      agentDefinition.hooks,
      `agent '${agentDefinition.agentType}'`,
      true, // isAgent：将 Stop 转为 SubagentStop
    )
  }

  // 预加载代理 frontmatter 中声明的技能
  const skillsToPreload = agentDefinition.skills ?? []
  if (skillsToPreload.length > 0) {
    const allSkills = await getSkillToolCommands(getProjectRoot())

    // 过滤有效技能，并对缺失项告警
    const validSkills: Array<{
      skillName: string
      skill: (typeof allSkills)[0] & { type: 'prompt' }
    }> = []

    for (const skillName of skillsToPreload) {
      // 解析技能名，依次尝试多种策略：
      // 1. 精确匹配（hasCommand 检查 name、userFacingName、aliases）
      // 2. 加代理插件前缀的全名（如 \"my-skill\" → \"plugin:my-skill\"）
      // 3. 插件命名空间技能的后缀匹配（以 \":skillName\" 结尾）
      const resolvedName = resolveSkillName(
        skillName,
        allSkills,
        agentDefinition,
      )
      if (!resolvedName) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] 警告：frontmatter 中指定的技能 '${skillName}' 未找到`,
          { level: 'warn' },
        )
        continue
      }

      const skill = getCommand(resolvedName, allSkills)
      if (skill.type !== 'prompt') {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] 警告：技能 '${skillName}' 不是基于提示词的技能`,
          { level: 'warn' },
        )
        continue
      }
      validSkills.push({ skillName, skill })
    }

    // 并发加载所有技能内容并加入 initialMessages
    const { formatSkillLoadingMetadata } = await import(
      '../../utils/processUserInput/processSlashCommand.js'
    )
    const loaded = await Promise.all(
      validSkills.map(async ({ skillName, skill }) => ({
        skillName,
        skill,
        content: await skill.getPromptForCommand('', toolUseContext),
      })),
    )
    for (const { skillName, skill, content } of loaded) {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] 已预加载技能 '${skillName}'`,
      )

      // 添加 command-message 元数据，使 UI 显示正在加载哪个技能
      const metadata = formatSkillLoadingMetadata(
        skillName,
        skill.progressMessage,
      )

      initialMessages.push(
        createUserMessage({
          content: [{ type: 'text', text: metadata }, ...content],
          isMeta: true,
        }),
      )
    }
  }

  // 初始化代理专属 MCP 服务（与父级服务叠加）
  const {
    clients: mergedMcpClients,
    tools: agentMcpTools,
    cleanup: mcpCleanup,
  } = await initializeAgentMcpServers(
    agentDefinition,
    toolUseContext.options.mcpClients,
  )

  // 将代理 MCP 工具与 resolvedTools 合并，并按 name 去重。
  // resolvedTools 已去重（见 resolveAgentTools），若无代理专属 MCP 工具则跳过展开 + uniqBy 的开销。
  const allTools =
    agentMcpTools.length > 0
      ? uniqBy([...resolvedTools, ...agentMcpTools], 'name')
      : resolvedTools

  // 构建代理专属 options
  const agentOptions: ToolUseContext['options'] = {
    isNonInteractiveSession: useExactTools
      ? toolUseContext.options.isNonInteractiveSession
      : isAsync
        ? true
        : (toolUseContext.options.isNonInteractiveSession ?? false),
    appendSystemPrompt: toolUseContext.options.appendSystemPrompt,
    tools: allTools,
    commands: [],
    debug: toolUseContext.options.debug,
    verbose: toolUseContext.options.verbose,
    mainLoopModel: resolvedAgentModel,
    // 对 fork 子代理（useExactTools），继承 thinking 配置以匹配父级 API 请求前缀，提升 prompt cache 命中。
    // 普通子代理则禁用 thinking，以控制输出 token 成本。
    thinkingConfig: useExactTools
      ? toolUseContext.options.thinkingConfig
      : { type: 'disabled' as const },
    mcpClients: mergedMcpClients,
    mcpResources: toolUseContext.options.mcpResources,
    agentDefinitions: toolUseContext.options.agentDefinitions,
    // fork 子代理（useExactTools 路径）需要在 context.options 上携带 querySource，
    // 供 AgentTool.tsx call() 的递归 fork 防护使用——它检查 options.querySource === 'agent:builtin:fork'。
    // 该字段可跨 autocompact 保留（autocompact 改写 messages，不改写 context.options）。
    // 若缺失，该防护读到 undefined，只能依赖「扫描消息」回退——而 autocompact 会替换 fork 的模板消息使回退失效。
    ...(useExactTools && { querySource }),
  }

  // 使用共享 helper 创建子代理上下文
  // - 同步代理与父级共享 setAppState、setResponseLength、abortController
  // - 异步代理完全隔离（但显式使用与父级不联动的 abortController）
  const agentToolUseContext = createSubagentContext(toolUseContext, {
    options: agentOptions,
    agentId,
    agentType: agentDefinition.agentType,
    messages: initialMessages,
    readFileState: agentReadFileState,
    abortController: agentAbortController,
    getAppState: agentGetAppState,
    // 同步代理与父级共享这些回调
    shareSetAppState: !isAsync,
    shareSetResponseLength: true, // 同步与异步均计入响应指标
    criticalSystemReminder_EXPERIMENTAL:
      agentDefinition.criticalSystemReminder_EXPERIMENTAL,
    contentReplacementState,
  })

  // 对 transcript 可查看的子代理保留工具调用结果（进程内队友）
  if (preserveToolUseResults) {
    agentToolUseContext.preserveToolUseResults = true
  }

  // 暴露 cache-safe 参数供后台摘要使用（prompt cache 共享）
  if (onCacheSafeParams) {
    onCacheSafeParams({
      systemPrompt: agentSystemPrompt,
      userContext: resolvedUserContext,
      systemContext: resolvedSystemContext,
      toolUseContext: agentToolUseContext,
      forkContextMessages: initialMessages,
    })
  }

  // 在 query 循环开始前记录初始消息，并写入 agentType；
  // 这样恢复时即使 subagent_type 缺失也能正确路由。两次写入均为即发即弃——持久化失败不应阻塞代理。
  void recordSidechainTranscript(initialMessages, agentId).catch(_err =>
    logForDebugging(`记录侧链 transcript 失败：${_err}`),
  )
  void writeAgentMetadata(agentId, {
    agentType: agentDefinition.agentType,
    ...(worktreePath && { worktreePath }),
    ...(description && { description }),
  }).catch(_err => logForDebugging(`写入代理元数据失败：${_err}`))

  // 跟踪最后一次记录的消息 UUID，用于父链连续性
  let lastRecordedUuid: UUID | null = initialMessages.at(-1)?.uuid ?? null

  try {
    for await (const message of query({
      messages: initialMessages,
      systemPrompt: agentSystemPrompt,
      userContext: resolvedUserContext,
      systemContext: resolvedSystemContext,
      canUseTool,
      toolUseContext: agentToolUseContext,
      querySource,
      maxTurns: maxTurns ?? agentDefinition.maxTurns,
    })) {
      onQueryProgress?.()
      // 将子代理 API 请求开始事件转发给父级指标显示，
      // 使 TTFT/OTPS 在子代理执行期间也能更新。
      if (
        message.type === 'stream_event' &&
        message.event.type === 'message_start' &&
        message.ttftMs != null
      ) {
        toolUseContext.pushApiMetricsEntry?.(message.ttftMs)
        continue
      }

      // attachment 消息（如 structured_output）直接 yield，不记录到侧链 transcript
      if (message.type === 'attachment') {
        // 处理 query.ts 发出的「达到最大轮次」信号
        if (message.attachment.type === 'max_turns_reached') {
          logForDebugging(
            `[Agent: ${agentDefinition.agentType}] 已达最大轮次上限 (${message.attachment.maxTurns})`,
          )
          break
        }
        yield message
        continue
      }

      if (isRecordableMessage(message)) {
        // 仅记录新增消息，并带正确 parent（每条消息 O(1)）
        await recordSidechainTranscript(
          [message],
          agentId,
          lastRecordedUuid,
        ).catch(err =>
          logForDebugging(`记录侧链 transcript 失败：${err}`),
        )
        if (message.type !== 'progress') {
          lastRecordedUuid = message.uuid
        }
        yield message
      }
    }

    if (agentAbortController.signal.aborted) {
      throw new AbortError()
    }

    // 若提供则运行 callback（仅内置代理有回调）
    if (isBuiltInAgent(agentDefinition) && agentDefinition.callback) {
      agentDefinition.callback()
    }
  } finally {
    // 清理代理专属 MCP 服务（正常结束/中止/异常均执行）
    await mcpCleanup()
    // 清理代理的会话钩子
    if (agentDefinition.hooks) {
      clearSessionHooks(rootSetAppState, agentId)
    }
    // 清理该代理的 prompt cache tracking 状态
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      cleanupAgentTracking(agentId)
    }
    // 释放克隆的文件状态缓存内存
    agentToolUseContext.readFileState.clear()
    // 释放克隆的 fork 上下文消息
    initialMessages.length = 0
    // 释放 perfetto 代理注册表条目
    unregisterPerfettoAgent(agentId)
    // 释放 transcript 子目录映射
    clearAgentTranscriptSubdir(agentId)
    // 释放该代理的 todos 条目。若不清理，任何调用过 TodoWrite 的子代理都会在 AppState.todos 里永久留下一个 key
    //（即使全部事项完成，值变为 [] 但 key 仍存在）。大型会话会生成数百个代理；每个孤儿 key 都是小泄漏，累积可观。
    rootSetAppState(prev => {
      if (!(agentId in prev.todos)) return prev
      const { [agentId]: _removed, ...todos } = prev.todos
      return { ...prev, todos }
    })
    // 终止该代理启动的所有后台 bash 任务。若不做，`run_in_background` 的 shell 循环（如测试夹具 fake-logs.sh）
    // 会在主会话最终退出后以 PPID=1 僵尸进程形式继续存活。
    killShellTasksForAgent(agentId, toolUseContext.getAppState, rootSetAppState)
    /* eslint-disable @typescript-eslint/no-require-imports */
    if (feature('MONITOR_TOOL')) {
      const mcpMod =
        require('../../tasks/MonitorMcpTask/MonitorMcpTask.js') as typeof import('../../tasks/MonitorMcpTask/MonitorMcpTask.js')
      mcpMod.killMonitorMcpTasksForAgent(
        agentId,
        toolUseContext.getAppState,
        rootSetAppState,
      )
    }
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
}

/**
 * 过滤含未完成工具调用的 assistant 消息（有 tool_use 无对应结果）。
 * 避免发送孤立 tool 调用导致 API 报错。
 */
export function filterIncompleteToolCalls(messages: Message[]): Message[] {
  // 构建已有结果的 tool use ID 集合
  const toolUseIdsWithResults = new Set<string>()

  for (const message of messages) {
    if (message?.type === 'user') {
      const userMessage = message as UserMessage
      const content = userMessage.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolUseIdsWithResults.add(block.tool_use_id)
          }
        }
      }
    }
  }

  // 排除含无结果 tool 调用的 assistant 消息
  return messages.filter(message => {
    if (message?.type === 'assistant') {
      const assistantMessage = message as AssistantMessage
      const content = assistantMessage.message.content
      if (Array.isArray(content)) {
        // 是否存在无对应结果的 tool_use
        const hasIncompleteToolCall = content.some(
          block =>
            block.type === 'tool_use' &&
            block.id &&
            !toolUseIdsWithResults.has(block.id),
        )
        // 排除含未完成调用的消息
        return !hasIncompleteToolCall
      }
    }
    // 保留非 assistant 消息及无 tool 调用的 assistant
    return true
  })
}

async function getAgentSystemPrompt(
  agentDefinition: AgentDefinition,
  toolUseContext: Pick<ToolUseContext, 'options'>,
  resolvedAgentModel: string,
  additionalWorkingDirectories: string[],
  resolvedTools: readonly Tool[],
): Promise<string[]> {
  const enabledToolNames = new Set(resolvedTools.map(t => t.name))
  try {
    const agentPrompt = agentDefinition.getSystemPrompt({ toolUseContext })
    const prompts = [agentPrompt]

    return await enhanceSystemPromptWithEnvDetails(
      prompts,
      resolvedAgentModel,
      additionalWorkingDirectories,
      enabledToolNames,
    )
  } catch (_error) {
    return enhanceSystemPromptWithEnvDetails(
      [DEFAULT_AGENT_PROMPT],
      resolvedAgentModel,
      additionalWorkingDirectories,
      enabledToolNames,
    )
  }
}

/**
 * 将代理 frontmatter 中的技能名解析为已注册命令名。
 *
 * 插件技能以命名空间注册（如 "my-plugin:my-skill"），代理中常写短名（如 "my-skill"）。
 * 本函数依次尝试：
 *
 * 1. hasCommand 精确匹配（name、userFacingName、aliases）
 * 2. 加代理插件前缀（如 "my-skill" → "my-plugin:my-skill"）
 * 3. 后缀匹配 —— 找以 ":skillName" 结尾的命令名
 */
function resolveSkillName(
  skillName: string,
  allSkills: Command[],
  agentDefinition: AgentDefinition,
): string | null {
  // 1. 直接匹配
  if (hasCommand(skillName, allSkills)) {
    return skillName
  }

  // 2. 尝试加代理插件前缀
  // 插件代理的 agentType 形如 "pluginName:agentName"
  const pluginPrefix = agentDefinition.agentType.split(':')[0]
  if (pluginPrefix) {
    const qualifiedName = `${pluginPrefix}:${skillName}`
    if (hasCommand(qualifiedName, allSkills)) {
      return qualifiedName
    }
  }

  // 3. 后缀匹配 —— 找名称以 ":skillName" 结尾的技能
  const suffix = `:${skillName}`
  const match = allSkills.find(cmd => cmd.name.endsWith(suffix))
  if (match) {
    return match.name
  }

  return null
}
