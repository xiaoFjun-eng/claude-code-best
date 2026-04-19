import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import { dirname } from 'path'
import {
  getMainLoopModelOverride,
  getSessionId,
  setMainLoopModelOverride,
  setMainThreadAgentType,
  setOriginalCwd,
  switchSession,
} from '../bootstrap/state.js'
import { clearSystemPromptSections } from '../constants/systemPromptSections.js'
import { restoreCostStateForSession } from '../cost-tracker.js'
import type { AppState } from '../state/AppState.js'
import type { AgentColorName } from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js'
import {
  type AgentDefinition,
  type AgentDefinitionsResult,
  getActiveAgentsFromList,
  getAgentDefinitionsWithOverrides,
} from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { TODO_WRITE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TodoWriteTool/constants.js'
import { asSessionId } from '../types/ids.js'
import type {
  AttributionSnapshotMessage,
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
  PersistedWorktreeSession,
} from '../types/logs.js'
import type { Message } from '../types/message.js'
import { renameRecordingForSession } from './asciicast.js'
import { clearMemoryFileCaches } from './claudemd.js'
import {
  type AttributionState,
  attributionRestoreStateFromLog,
  restoreAttributionStateFromSnapshots,
} from './commitAttribution.js'
import { updateSessionName } from './concurrentSessions.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import type { FileHistorySnapshot } from './fileHistory.js'
import { fileHistoryRestoreStateFromLog } from './fileHistory.js'
import { createSystemMessage } from './messages.js'
import { parseUserSpecifiedModel } from './model/model.js'
import { getPlansDirectory } from './plans.js'
import { setCwd } from './Shell.js'
import {
  adoptResumedSessionFile,
  recordContentReplacement,
  resetSessionFilePointer,
  restoreSessionMetadata,
  saveMode,
  saveWorktreeState,
} from './sessionStorage.js'
import { isTodoV2Enabled } from './tasks.js'
import type { TodoList } from './todo/types.js'
import { TodoListSchema } from './todo/types.js'
import type { ContentReplacementRecord } from './toolResultStorage.js'
import {
  getCurrentWorktreeSession,
  restoreWorktreeSession,
} from './worktree.js'

type ResumeResult = {
  messages?: Message[]
  fileHistorySnapshots?: FileHistorySnapshot[]
  attributionSnapshots?: AttributionSnapshotMessage[]
  contextCollapseCommits?: ContextCollapseCommitEntry[]
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry
}

/** 扫描对话记录，查找最后一个 TodoWrite 工具使用块并返回其待办事项。
用于在 SDK --resume 时填充 AppState.todos，使模型的待办列表在会话重启后得以保留，无需文件持久化。 */
function extractTodosFromTranscript(messages: Message[]): TodoList {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.type !== 'assistant') continue
    const toolUse = (msg.message!.content as any[]).find(
      block => block.type === 'tool_use' && block.name === TODO_WRITE_TOOL_NAME,
    )
    if (!toolUse || toolUse.type !== 'tool_use') continue
    const input = toolUse.input
    if (input === null || typeof input !== 'object') return []
    const parsed = TodoListSchema().safeParse(
      (input as Record<string, unknown>).todos,
    )
    return parsed.success ? parsed.data : []
  }
  return []
}

/** 从日志中恢复会话状态（文件历史、归属信息、待办事项）。
供 SDK (print.ts) 和交互式 (REPL.tsx, main.tsx) 恢复路径使用。 */
export function restoreSessionStateFromLog(
  result: ResumeResult,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  // 恢复文件历史状态
  if (result.fileHistorySnapshots && result.fileHistorySnapshots.length > 0) {
    fileHistoryRestoreStateFromLog(result.fileHistorySnapshots, newState => {
      setAppState(prev => ({ ...prev, fileHistory: newState }))
    })
  }

  // 恢复归属状态（仅限 ant 功能）
  if (
    feature('COMMIT_ATTRIBUTION') &&
    result.attributionSnapshots &&
    result.attributionSnapshots.length > 0
  ) {
    attributionRestoreStateFromLog(result.attributionSnapshots, newState => {
      setAppState(prev => ({ ...prev, attribution: newState }))
    })
  }

  // 恢复上下文折叠提交日志 + 暂存快照。必须在首次 query
  // () 前运行，以便 projectView() 能从恢复的
  // Message[] 重建折叠视图。无条件调用（即
  // 使条目未定义/为空），因为 restoreFromEntr
  // ies 会首先重置存储——否则，在会话内 /resume
  // 到一个没有提交的会话时，会保留先前会话的陈旧提交日志。
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    ;(
      require('../services/contextCollapse/persist.js') as typeof import('../services/contextCollapse/persist.js')
    ).restoreFromEntries(
      result.contextCollapseCommits ?? [],
      result.contextCollapseSnapshot,
    )
    /* eslint-enable @typescript-eslint/no-require-imports */
  }

  // 从对话记录恢复 TodoWrite 状态（仅限 SDK/非交互模式）。交互
  // 模式使用基于文件的 v2 任务，因此 AppState.todos 在那里未被使用。
  if (!isTodoV2Enabled() && result.messages && result.messages.length > 0) {
    const todos = extractTodosFromTranscript(result.messages)
    if (todos.length > 0) {
      const agentId = getSessionId()
      setAppState(prev => ({
        ...prev,
        todos: { ...prev.todos, [agentId]: todos },
      }))
    }
  }
}

/** 根据日志快照计算恢复的归属状态。
用于渲染前计算初始状态（例如，main.tsx --continue）。
如果归属功能被禁用或不存在快照，则返回 undefined。 */
export function computeRestoredAttributionState(
  result: ResumeResult,
): AttributionState | undefined {
  if (
    feature('COMMIT_ATTRIBUTION') &&
    result.attributionSnapshots &&
    result.attributionSnapshots.length > 0
  ) {
    return restoreAttributionStateFromSnapshots(result.attributionSnapshots)
  }
  return undefined
}

/** 为会话恢复计算独立的智能体上下文（名称/颜色）。
用于渲染前计算初始状态（遵循 CLAUDE.md 指南）。
如果会话未设置名称/颜色，则返回 undefined。 */
export function computeStandaloneAgentContext(
  agentName: string | undefined,
  agentColor: string | undefined,
): AppState['standaloneAgentContext'] | undefined {
  if (!agentName && !agentColor) {
    return undefined
  }
  return {
    name: agentName ?? '',
    color: (agentColor === 'default' ? undefined : agentColor) as
      | AgentColorName
      | undefined,
  }
}

/** 从恢复的会话中恢复智能体设置。

当恢复一个使用了自定义智能体的对话时，此操作会重新应用智能体类型和模型覆盖（除非用户在 CLI 中指定了 --agent）。
通过 setMainThreadAgentType / setMainLoopModelOverride 修改引导状态。

返回恢复的智能体定义及其 agentType 字符串，如果未恢复任何智能体，则返回 undefined。 */
export function restoreAgentFromSession(
  agentSetting: string | undefined,
  currentAgentDefinition: AgentDefinition | undefined,
  agentDefinitions: AgentDefinitionsResult,
): {
  agentDefinition: AgentDefinition | undefined
  agentType: string | undefined
} {
  // 如果用户已在 CLI 中指定了 --agent，则保留该定义
  if (currentAgentDefinition) {
    return { agentDefinition: currentAgentDefinition, agentType: undefined }
  }

  // 如果会话没有智能体，则清除任何陈旧的引导状态
  if (!agentSetting) {
    setMainThreadAgentType(undefined)
    return { agentDefinition: undefined, agentType: undefined }
  }

  const resumedAgent = agentDefinitions.activeAgents.find(
    agent => agent.agentType === agentSetting,
  )
  if (!resumedAgent) {
    logForDebugging(
      `恢复的会话拥有智能体 "${agentSetting}"，但它已不再可用。使用默认行为。`,
    )
    setMainThreadAgentType(undefined)
    return { agentDefinition: undefined, agentType: undefined }
  }

  setMainThreadAgentType(resumedAgent.agentType)

  // 如果用户未指定模型，则应用智能体的模型
  if (
    !getMainLoopModelOverride() &&
    resumedAgent.model &&
    resumedAgent.model !== 'inherit'
  ) {
    setMainLoopModelOverride(parseUserSpecifiedModel(resumedAgent.model))
  }

  return { agentDefinition: resumedAgent, agentType: resumedAgent.agentType }
}

/** 在协调器/普通模式切换后刷新智能体定义。

当恢复一个处于不同模式（协调器 vs 普通）的会话时，需要重新派生内置智能体以匹配新模式。CLI 提供的智能体（来自 --agents 标志）会被合并回去。 */
export async function refreshAgentDefinitionsForModeSwitch(
  modeWasSwitched: boolean,
  currentCwd: string,
  cliAgents: AgentDefinition[],
  currentAgentDefinitions: AgentDefinitionsResult,
): Promise<AgentDefinitionsResult> {
  if (!feature('COORDINATOR_MODE') || !modeWasSwitched) {
    return currentAgentDefinitions
  }

  // 在模式切换后重新派生智能体定义，使内置智能
  // 体反映新的协调器/普通模式
  getAgentDefinitionsWithOverrides.cache.clear?.()
  const freshAgentDefs = await getAgentDefinitionsWithOverrides(currentCwd)
  const freshAllAgents = [...freshAgentDefs.allAgents, ...cliAgents]
  return {
    ...freshAgentDefs,
    allAgents: freshAllAgents,
    activeAgents: getActiveAgentsFromList(freshAllAgents),
  }
}

/** 为渲染而处理恢复/继续对话的结果。 */
export type ProcessedResume = {
  messages: Message[]
  fileHistorySnapshots?: FileHistorySnapshot[]
  contentReplacements?: ContentReplacementRecord[]
  agentName: string | undefined
  agentColor: AgentColorName | undefined
  restoredAgentDef: AgentDefinition | undefined
  initialState: AppState
}

/** 会话恢复所需的协调器模式模块 API 子集。 */
type CoordinatorModeApi = {
  matchSessionMode(mode?: string): string | undefined
  isCoordinatorMode(): boolean
}

/** 已加载的对话数据（loadConversationForResume 的返回类型）。 */
type ResumeLoadResult = {
  messages: Message[]
  fileHistorySnapshots?: FileHistorySnapshot[]
  attributionSnapshots?: AttributionSnapshotMessage[]
  contentReplacements?: ContentReplacementRecord[]
  contextCollapseCommits?: ContextCollapseCommitEntry[]
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry
  sessionId: UUID | undefined
  agentName?: string
  agentColor?: string
  agentSetting?: string
  customTitle?: string
  tag?: string
  mode?: 'coordinator' | 'normal'
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
}

/** 在恢复时恢复工作树工作目录。对话记录记录了最后一次工作树进入/退出；如果会话在某个工作树内崩溃（最后条目 = 会话对象，非 null），则 cd 回到该目录。

process.chdir 是 TOCTOU 安全的存在性检查——如果 /exit 对话框移除了目录，或者用户在会话之间手动删除了它，则会抛出 ENOENT 错误。

当 --worktree 已创建新工作树时，该新工作树优先于恢复会话的状态。restoreSessionMetadata 刚刚用陈旧的对话记录值覆盖了 project.currentSessionWorktree，因此在 adoptResumedSessionFile 将其写回磁盘之前，在此处重新确认新工作树。 */
export function restoreWorktreeForResume(
  worktreeSession: PersistedWorktreeSession | null | undefined,
): void {
  const fresh = getCurrentWorktreeSession()
  if (fresh) {
    saveWorktreeState(fresh)
    return
  }
  if (!worktreeSession) return

  try {
    process.chdir(worktreeSession.worktreePath)
  } catch {
    // 目录已不存在。覆盖陈旧缓存，以便下一次 reAppe
    // ndSessionMetadata 记录 "已退出"，而不是重
    // 新持久化一个不再存在的路径。
    saveWorktreeState(null)
    return
  }

  setCwd(worktreeSession.worktreePath)
  setOriginalCwd(getCwd())
  // 此处故意不设置 projectRoot。对话记录未记录工作树是通过 --
  // worktree（会设置 projectRoot）还是 EnterWor
  // ktreeTool（不会设置）进入的。保持 projectRoot 稳定
  // 符合 EnterWorktreeTool 的行为——技能/历史记录
  // 仍锚定到原始项目。
  restoreWorktreeSession(worktreeSession)
  // /resume 斜杠命令在缓存已针对旧 cwd 填充后
  // 在会话中调用此函数。对于 CLI 标志路径是廉价的
  // 无操作（那里缓存尚未填充）。
  clearMemoryFileCaches()
  clearSystemPromptSections()
  getPlansDirectory.cache.clear?.()
}

/** 在会话中 /resume 切换到另一个会话之前，撤销 restoreWorktreeForResume。如果没有此操作，从工作树会话 /resume 到非工作树会话会使用户留在旧工作树目录中，且 currentWorktreeSession 仍指向先前的会话。/resume 到一个*不同*的工作树会完全失败——上面的 getCurrentWorktreeSession() 守卫会阻止切换。

CLI --resume/--continue 不需要此操作：它们在启动时运行一次，其中 getCurrentWorktreeSession() 仅在使用了 --worktree 时才为真（应优先处理的新工作树，由上面的重新确认处理）。 */
export function exitRestoredWorktree(): void {
  const current = getCurrentWorktreeSession()
  if (!current) return

  restoreWorktreeSession(null)
  // 工作树状态已更改，因此引用它的缓存提示部分已陈旧，无
  // 论下面的 chdir 是否成功。
  clearMemoryFileCaches()
  clearSystemPromptSections()
  getPlansDirectory.cache.clear?.()

  try {
    process.chdir(current.originalCwd)
  } catch {
    // 原始目录已不存在（罕见情况）。保持当前位置——如果存在目标工作树，restor
    // eWorktreeForResume 接下来会 cd 进入其中。
    return
  }
  setCwd(current.originalCwd)
  setOriginalCwd(getCwd())
}

/** 处理已加载的对话以进行恢复/继续。

处理协调器模式匹配、会话 ID 设置、智能体恢复、模式持久化和初始状态计算。由 main.tsx 中的 --continue 和 --resume 路径调用。 */
export async function processResumedConversation(
  result: ResumeLoadResult,
  opts: {
    forkSession: boolean
    sessionIdOverride?: string
    transcriptPath?: string
    includeAttribution?: boolean
  },
  context: {
    modeApi: CoordinatorModeApi | null
    mainThreadAgentDefinition: AgentDefinition | undefined
    agentDefinitions: AgentDefinitionsResult
    currentCwd: string
    cliAgents: AgentDefinition[]
    initialState: AppState
  },
): Promise<ProcessedResume> {
  // 将协调器/普通模式与恢复的会话匹配
  let modeWarning: string | undefined
  if (feature('COORDINATOR_MODE')) {
    modeWarning = context.modeApi?.matchSessionMode(result.mode)
    if (modeWarning) {
      result.messages.push(createSystemMessage(modeWarning, 'warning'))
    }
  }

  // 重用恢复会话的 ID，除非指定了 --fork-session
  if (!opts.forkSession) {
    const sid = opts.sessionIdOverride ?? result.sessionId
    if (sid) {
      // 当从不同的项目目录恢复时（git worktre
      // es、跨项目），transcriptPath 指向实
      // 际文件；其目录名即为项目目录。否则会话位于当前项目中。
      switchSession(
        asSessionId(sid),
        opts.transcriptPath ? dirname(opts.transcriptPath) : null,
      )
      // 重命名 asciicast 录制文件以匹配恢复的会话 ID，以便 getSes
      // sionRecordingPaths() 能在 /share 期间发现它
      await renameRecordingForSession()
      await resetSessionFilePointer()
      restoreCostStateForSession(sid)
    }
  } else if (result.contentReplacements?.length) {
    // --fork-session 保留新启动的会话 ID。useLogMessages
    // 将通过 recordTranscript 将源消息复制到新的 JSONL
    // 中，但内容替换条目是单独的条目类型，仅由 recordContentReplac
    // ement 写入（query.ts 为 newlyReplaced 调用，而非预加
    // 载的记录）。没有这个种子，`claude -r {newSessionId}` 会
    // 在消息中找到源 tool_use_ids，但没有匹配的替换记录 → 它们被归类为 FR
    // OZEN → 发送完整内容（缓存未命中，永久超额）。insertContentRepl
    // acement 标记 sessionId = getSessionId() = 新
    // ID，因此 loadTranscriptFile 的键控查找将匹配。
    await recordContentReplacement(result.contentReplacements)
  }

  // 恢复会话元数据，以便 /status 显示保存的名称，并在会话退
  // 出时重新附加元数据。Fork 不会接管原始会话的 worktr
  // ee —— fork 退出对话框上的“Remove”会删除原始
  // 会话仍引用的 worktree —— 因此从 fork 路径中
  // 剥离 worktreeSession，使缓存保持未设置状态。
  restoreSessionMetadata(
    opts.forkSession ? { ...result, worktreeSession: undefined } : result,
  )

  if (!opts.forkSession) {
    // 切换回会话上次退出时所在的 worktree 目录。在 restore
    // SessionMetadata（它从 transcript 缓存 wor
    // ktree 状态）之后执行，以便如果目录不存在，我们可以在 adopt
    // ResumedSessionFile 写入之前覆盖缓存。
    restoreWorktreeForResume(result.worktreeSession)

    // 将 sessionFile 指向恢复的 transcript 并立即重新附加
    // 元数据。上面的 resetSessionFilePointer 将其设为 null
    // （防止旧的初始会话路径泄露），但这会阻止 reAppendSessionMet
    // adata（它在 null 时退出）在退出清理处理程序中运行。对于 fork，
    // useLogMessages 通过 REPL 挂载上的 recordTran
    // script 填充一个*新*文件；正常的惰性物化路径在那里是正确的。
    adoptResumedSessionFile()
  }

  // 恢复上下文折叠的提交日志 + 暂存快照。交互式 /resume 路径通过 res
  // toreSessionStateFromLog (REPL.tsx)；CLI
  // --continue/--resume 则通过此处。无条件调用 —— 原因请参见
  // 上面的 restoreSessionStateFromLog 调用点。
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    ;(
      require('../services/contextCollapse/persist.js') as typeof import('../services/contextCollapse/persist.js')
    ).restoreFromEntries(
      result.contextCollapseCommits ?? [],
      result.contextCollapseSnapshot,
    )
    /* eslint-enable @typescript-eslint/no-require-imports */
  }

  // 从恢复的会话中恢复代理设置
  const { agentDefinition: restoredAgent, agentType: resumedAgentType } =
    restoreAgentFromSession(
      result.agentSetting,
      context.mainThreadAgentDefinition,
      context.agentDefinitions,
    )

  // 持久化当前模式，以便未来恢复时知道此会话处于何种模式
  if (feature('COORDINATOR_MODE')) {
    saveMode(context.modeApi?.isCoordinatorMode() ? 'coordinator' : 'normal')
  }

  // 在渲染前计算初始状态（遵循 CLAUDE.md 指南）
  const restoredAttribution = opts.includeAttribution
    ? computeRestoredAttributionState(result)
    : undefined
  const standaloneAgentContext = computeStandaloneAgentContext(
    result.agentName,
    result.agentColor,
  )
  void updateSessionName(result.agentName)
  const refreshedAgentDefs = await refreshAgentDefinitionsForModeSwitch(
    !!modeWarning,
    context.currentCwd,
    context.cliAgents,
    context.agentDefinitions,
  )

  return {
    messages: result.messages,
    fileHistorySnapshots: result.fileHistorySnapshots,
    contentReplacements: result.contentReplacements,
    agentName: result.agentName,
    agentColor: (result.agentColor === 'default'
      ? undefined
      : result.agentColor) as AgentColorName | undefined,
    restoredAgentDef: restoredAgent,
    initialState: {
      ...context.initialState,
      ...(resumedAgentType && { agent: resumedAgentType }),
      ...(restoredAttribution && { attribution: restoredAttribution }),
      ...(standaloneAgentContext && { standaloneAgentContext }),
      agentDefinitions: refreshedAgentDefs,
    },
  }
}
