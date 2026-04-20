import type { Notification } from 'src/context/notifications.js'
import type { TodoList } from 'src/utils/todo/types.js'
import type { BridgePermissionCallbacks } from '../bridge/bridgePermissionCallbacks.js'
import type { Command } from '../commands.js'
import type { ChannelPermissionCallbacks } from '../services/mcp/channelPermissions.js'
import type { ElicitationRequestEvent } from '../services/mcp/elicitationHandler.js'
import type {
  MCPServerConnection,
  ServerResource,
} from '../services/mcp/types.js'
import { shouldEnablePromptSuggestion } from '../services/PromptSuggestion/promptSuggestion.js'
import {
  getEmptyToolPermissionContext,
  type Tool,
  type ToolPermissionContext,
} from '../Tool.js'
import type { TaskState } from '../tasks/types.js'
import type { AgentColorName } from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js'
import type { AgentDefinitionsResult } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import type { AllowedPrompt } from '@claude-code-best/builtin-tools/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import type { AgentId } from '../types/ids.js'
import type { Message, UserMessage } from '../types/message.js'
import type { LoadedPlugin, PluginError } from '../types/plugin.js'
import type { DeepImmutable } from '../types/utils.js'
import {
  type AttributionState,
  createEmptyAttributionState,
} from '../utils/commitAttribution.js'
import type { EffortValue } from '../utils/effort.js'
import type { FileHistoryState } from '../utils/fileHistory.js'
import type { REPLHookContext } from '../utils/hooks/postSamplingHooks.js'
import type { SessionHooksState } from '../utils/hooks/sessionHooks.js'
import type { ModelSetting } from '../utils/model/model.js'
import type { DenialTrackingState } from '../utils/permissions/denialTracking.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import type { SettingsJson } from '../utils/settings/types.js'
import { shouldEnableThinkingByDefault } from '../utils/thinking.js'
import type { Store } from './store.js'

export type CompletionBoundary =
  | { type: 'complete'; completedAt: number; outputTokens: number }
  | { type: 'bash'; command: string; completedAt: number }
  | { type: 'edit'; toolName: string; filePath: string; completedAt: number }
  | {
      type: 'denied_tool'
      toolName: string
      detail: string
      completedAt: number
    }

export type SpeculationResult = {
  messages: Message[]
  boundary: CompletionBoundary | null
  timeSavedMs: number
}

export type SpeculationState =
  | { status: 'idle' }
  | {
      status: 'active'
      id: string
      abort: () => void
      startTime: number
      messagesRef: { current: Message[] } // 可变引用 - 避免每条消息都进行数组展开
      writtenPathsRef: { current: Set<string> } // 可变引用 - 写入覆盖层的相对路径
      boundary: CompletionBoundary | null
      suggestionLength: number
      toolUseCount: number
      isPipelined: boolean
      contextRef: { current: REPLHookContext }
      pipelinedSuggestion?: {
        text: string
        promptId: 'user_intent' | 'stated_intent'
        generationRequestId: string | null
      } | null
    }

export const IDLE_SPECULATION_STATE: SpeculationState = { status: 'idle' }

export type FooterItem =
  | 'tasks'
  | 'tmux'
  | 'bagel'
  | 'teams'
  | 'bridge'
  | 'companion'

export type AppState = DeepImmutable<{
  settings: SettingsJson
  verbose: boolean
  mainLoopModel: ModelSetting
  mainLoopModelForSession: ModelSetting
  statusLineText: string | undefined
  expandedView: 'none' | 'tasks' | 'teammates'
  isBriefOnly: boolean
  // 可选 - 仅当 ENABLE_AGENT_SWARMS 为 true 时存在（用于死代码消除）
  showTeammateMessagePreview?: boolean
  selectedIPAgentIndex: number
  // CoordinatorTaskPanel 选择：-1 = 药丸按钮，0 = 主面板，1..N =
  // 智能体行。位于 AppState（非本地状态），因此面板可以直接读取，无需通过 PromptInput
  // → PromptInputFooter 进行属性透传。
  coordinatorTaskIndex: number
  viewSelectionMode: 'none' | 'selecting-agent' | 'viewing-agent'
  // 哪个底部药丸按钮获得焦点（提示符下方的箭头键导航）。位于 AppState
  // 中，以便在 PromptInput 外部渲染的药丸组件（如 REPL.t
  // sx 中的 CompanionSprite）可以读取自身的焦点状态。
  footerSelection: FooterItem | null
  toolPermissionContext: ToolPermissionContext
  spinnerTip?: string
  // 来自 --agent CLI 标志或设置的智能体名称（用于显示徽标）
  agent: string | undefined
  // 助手模式已完全启用（设置 + GrowthBook 功能开关 +
  // 信任）。单一事实来源 - 在 main.tsx 中选项变更前计算
  // 一次，消费者读取此值而非重新调用 isAssistantMode()。
  kairosEnabled: boolean
  // --remote 模式的远程会话 URL（显示在底部指示器中）
  remoteSessionUrl: string | undefined
  // 远程会话 WebSocket 状态（`claude assistant` 查看器）。'conn
  // ected' 表示实时事件流已打开；'reconnecting' = 临时 WebSoc
  // ket 断开，正在退避重连；'disconnected' = 永久关闭或重连次数已用尽。
  remoteConnectionStatus:
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'disconnected'
  // `claude assistant`：在 REMOTE 守护进程子进程中运行的后台任
  // 务（智能体调用、队友、工作流）数量。通过 WebSocket 上的 system/
  // task_started 和 system/task_notification 事
  // 件溯源。在查看器模式下，本地 AppState.tasks 始终为空 —— 任务
  // 运行在不同的进程中。
  remoteBackgroundTaskCount: number
  // 常驻桥接：期望状态（由 /config 或底部切换按钮控制）
  replBridgeEnabled: boolean
  // 常驻桥接：通过 /remote-control 命令激活时为 true，由配置驱动时为 false
  replBridgeExplicit: boolean
  // 仅出站模式：将事件转发到 CCR 但拒绝入站提示/控制
  replBridgeOutboundOnly: boolean
  // 常驻桥接：环境已注册 + 会话已创建（= "就绪"）
  replBridgeConnected: boolean
  // 常驻桥接：入口 WebSocket 已打开（= "已连接" - 用户在 claude.ai 上）
  replBridgeSessionActive: boolean
  // 常驻桥接：轮询循环处于错误退避状态（= "正在重新连接"）
  replBridgeReconnecting: boolean
  // 常驻桥接：就绪状态的连接 URL（?bridge=envId）
  replBridgeConnectUrl: string | undefined
  // 常驻桥接：claude.ai 上的会话 URL（连接时设置）
  replBridgeSessionUrl: string | undefined
  // 常驻桥接：用于调试的 ID（在 --verbose 模式下显示在对话框中）
  replBridgeEnvironmentId: string | undefined
  replBridgeSessionId: string | undefined
  // 常驻桥接：连接失败时的错误消息（显示在 BridgeDialog 中）
  replBridgeError: string | undefined
  // 常驻桥接：通过 `/remote-control <名称>` 设置的会话名称（用作会话标题）
  replBridgeInitialName: string | undefined
  // 常驻桥接：首次远程对话框待处理（由 /remote-control 命令设置）
  showRemoteCallout: boolean
}> & {
  // 统一任务状态 - 从 DeepImmutable 中排除，因为 TaskState 包含函数类型
  tasks: { [taskId: string]: TaskState }
  // 名称 → AgentId 注册表，由 Agent 工具在提供 `name` 时填
  // 充。冲突时后写入者胜。SendMessage 使用此注册表按名称路由。
  agentNameRegistry: Map<string, AgentId>
  // 已被置为前台的任务 ID - 其消息显示在主视图中
  foregroundedTaskId?: string
  // 正在查看其转录的进程中队友的任务 ID（undefined = 领导者的视图）
  viewingAgentTaskId?: string
  // 来自 buddy_react API 的最新伙伴反应（src/buddy/companionReact.ts）
  companionReaction?: string
  // 上次 /buddy pet 的时间戳 - CompanionSprite 在近期内会渲染爱心
  companionPetAt?: number
  // 待办事项（ashwin）：查看是否可以使用 utility-types 的 DeepReadonly 处理此问题
  mcp: {
    clients: MCPServerConnection[]
    tools: Tool[]
    commands: Command[]
    resources: Record<string, ServerResource[]>
    /** * 由 /reload-plugins 递增，以触发 MCP 效果重新运行
     * 并获取新启用的插件 MCP 服务器。效果将此值作为依赖项读取；
     * 该值本身不被消费。 */
    pluginReconnectKey: number
  }
  plugins: {
    enabled: LoadedPlugin[]
    disabled: LoadedPlugin[]
    commands: Command[]
    /** * 在加载和初始化期间收集的插件系统错误。
     * 有关错误结构、上下文字段和显示格式的完整详细信息，请参阅 {@link PluginError} 类型文档。 */
    errors: PluginError[]
    // 后台插件/市场安装的安装状态
    installationStatus: {
      marketplaces: Array<{
        name: string
        status: 'pending' | 'installing' | 'installed' | 'failed'
        error?: string
      }>
      plugins: Array<{
        id: string
        name: string
        status: 'pending' | 'installing' | 'installed' | 'failed'
        error?: string
      }>
    }
    /** * 当磁盘上的插件状态发生更改（后台协调、/plugin 菜单安装、外部设置编辑）且活动组件已过时时，设置为 true。
     * 在交互模式下，用户运行 /reload-plugins 来应用。
     * 在无头模式下，refreshPluginState() 通过 refreshActivePlugins() 自动应用。 */
    needsRefresh: boolean
  }
  agentDefinitions: AgentDefinitionsResult
  fileHistory: FileHistoryState //文件编辑检查点 / 快照
  attribution: AttributionState
  todos: { [agentId: string]: TodoList }
  remoteAgentTaskSuggestions: { summary: string; task: string }[]
  notifications: {
    current: Notification | null
    queue: Notification[]
  }
  elicitation: {
    queue: ElicitationRequestEvent[]
  }
  thinkingEnabled: boolean | undefined
  promptSuggestionEnabled: boolean
  sessionHooks: SessionHooksState
  tungstenActiveSession?: {
    sessionName: string
    socketName: string
    target: string // tmux 目标（例如 "session:window.pane"）
  }
  tungstenLastCapturedTime?: number // 为模型捕获帧时的时间戳
  tungstenLastCommand?: {
    command: string // 要显示的命令字符串（例如 "Enter"、"echo hello"）
    timestamp: number // 命令发送的时间
  }
  // 粘性 tmux 面板可见性 — 与 globalConfig.tungstenPanelVisible 保持同步以实现响应性。
  tungstenPanelVisible?: boolean
  // 回合结束时的临时自动隐藏 — 与 tungstenPanelVisib
  // le 分开，这样药丸可以保留在页脚（用户可以重新打开），但面板内容在空闲
  // 时不会占用屏幕空间。在下一次使用 Tmux 工具或用户切换时清除。不持久化。
  tungstenPanelAutoHidden?: boolean
  // WebBrowser 工具（代号 bagel）：页脚中药丸可见
  bagelActive?: boolean
  // WebBrowser 工具：药丸标签中显示的当前页面 URL
  bagelUrl?: string
  // WebBrowser 工具：粘性面板可见性切换
  bagelPanelVisible?: boolean
  // chicago MCP 会话状态。类型内联（不从 @ant/comp
  // uter-use-mcp/types 导入），以便在未解析 ant 作用域依赖
  // 项时外部类型检查也能通过。结构上匹配 `AppGrant`/`CuGra
  // ntFlags` — wrapper.tsx 通过结构兼容性进行赋值。仅在 f
  // eature('CHICAGO_MCP') 激活时填充。
  computerUseMcpState?: {
    // 会话作用域的应用程序允许列表。在恢复会话时不会持久化。
    allowedApps?: readonly {
      bundleId: string
      displayName: string
      grantedAt: number
    }[]
    // 剪贴板/系统键授权标志（与允许列表正交）。
    grantFlags?: {
      clipboardRead: boolean
      clipboardWrite: boolean
      systemKeyCombos: boolean
    }
    // 压缩后用于 scaleCoord 的仅维度信息（非数据块）。包含 base64 的完
    // 整 `ScreenshotResult` 在 wrapper.tsx 中是进程本地的。
    lastScreenshotDims?: {
      width: number
      height: number
      displayWidth: number
      displayHeight: number
      displayId?: number
      originX?: number
      originY?: number
    }
    // 由 onAppsHidden 累积，在回合结束时清除并取消隐藏。
    hiddenDuringTurn?: ReadonlySet<string>
    // CU 目标所在的显示器。由包的 `autoTargetDis
    // play` 解析器通过 `onResolvedDisplayUpdated`
    // 写回。在恢复会话时持久化，以便点击保持在模型最后看到的显示器上。
    selectedDisplayId?: number
    // 当模型通过 `switch_display` 明确选择显示器时为 tru
    // e。这使得 `handleScreenshot` 跳过解析器追踪链，
    // 直接使用 `selectedDisplayId`。在解析器写回（固定的
    // 显示器被拔掉 → Swift 回退到主显示器）时以及在
    // `switch_display("auto")`.
    displayPinnedByModel?: boolean
    // 显示器上次自动解析所针对的、已排序的、逗号分隔的 bundle-I
    // D 集合。`handleScreenshot` 仅在允许的集合自
    // 上次以来发生更改时才重新解析 — 防止解析器在每次截图时都进行切换。
    displayResolvedForApps?: string
  }
  // REPL 工具 VM 上下文 - 在 REPL 调用之间持久化，用于状态共享
  replContext?: {
    vmContext: import('vm').Context
    registeredTools: Map<
      string,
      {
        name: string
        description: string
        schema: Record<string, unknown>
        handler: (args: Record<string, unknown>) => Promise<unknown>
      }
    >
    console: {
      log: (...args: unknown[]) => void
      error: (...args: unknown[]) => void
      warn: (...args: unknown[]) => void
      info: (...args: unknown[]) => void
      debug: (...args: unknown[]) => void
      getStdout: () => string
      getStderr: () => string
      clear: () => void
    }
  }
  teamContext?: {
    teamName: string
    teamFilePath: string
    leadAgentId: string
    // 集群成员（tmux 窗格中的独立进程）的自我身份标识。注意：这
    // 与 toolUseContext.agentId 不同，后者用于进程内的子代理。
    selfAgentId?: string // 集群成员自身的 ID（对于领导者，与 leadAgentId 相同）
    selfAgentName?: string // 集群成员的名称（对于领导者为 'team-lead'）
    isLeader?: boolean // 如果此集群成员是团队领导者，则为 true
    selfAgentColor?: string // 为 UI 分配的颜色（用于动态加入的会话）
    teammates: {
      [teammateId: string]: {
        name: string
        agentType?: string
        color?: string
        tmuxSessionName: string
        tmuxPaneId: string
        cwd: string
        worktreePath?: string
        spawnedAt: number
      }
    }
  }
  // 具有自定义名称/颜色的非集群会话的独立代理上下文
  standaloneAgentContext?: {
    name: string
    color?: AgentColorName
  }
  inbox: {
    messages: Array<{
      id: string
      from: string
      text: string
      timestamp: string
      status: 'pending' | 'processing' | 'processed'
      color?: string
      summary?: string
    }>
  }
  // 工作进程沙箱权限请求（领导者端）- 用于网络访问批准
  workerSandboxPermissions: {
    queue: Array<{
      requestId: string
      workerId: string
      workerName: string
      workerColor?: string
      host: string
      createdAt: number
    }>
    selectedIndex: number
  }
  // 工作进程端的待处理权限请求（在等待领导者批准时显示）
  pendingWorkerRequest: {
    toolName: string
    toolUseId: string
    description: string
  } | null
  // 工作进程端的待处理沙箱权限请求
  pendingSandboxRequest: {
    requestId: string
    host: string
  } | null
  promptSuggestion: {
    text: string | null
    promptId: 'user_intent' | 'stated_intent' | null
    shownAt: number
    acceptedAt: number
    generationRequestId: string | null
  }
  speculation: SpeculationState
  speculationSessionTimeSavedMs: number
  skillImprovement: {
    suggestion: {
      skillName: string
      updates: { section: string; change: string; reason: string }[]
    } | null
  }
  // 认证版本 - 登录/登出时递增，用于触发依赖认证数据的重新获取
  authVersion: number
  // 待处理的初始消息（来自 CLI 参数或计划模式退
  // 出）。设置后，REPL 将处理该消息并触发查询
  initialMessage: {
    message: UserMessage
    clearContext?: boolean
    mode?: PermissionMode
    // 来自计划模式的会话范围权限规则（例如，“运行测试”、“安装依赖项”）
    allowedPrompts?: AllowedPrompt[]
  } | null
  // 待定的计划验证状态（在退出计划模式时设置）。由 Ve
  // rifyPlanExecution 工具用于触发后台验证
  pendingPlanVerification?: {
    plan: string
    verificationStarted: boolean
    verificationCompleted: boolean
  }
  // 分类器模式（YOLO、无头模式等）的拒绝跟踪 - 超出限制时回退到提示
  denialTracking?: DenialTrackingState
  // 用于 Escape 键协调的活动叠加层（选择对话框等）
  activeOverlays: ReadonlySet<string>
  // 快速模式
  fastMode?: boolean
  // 服务器端顾问工具的顾问模型（未定义 = 禁用）。
  advisorModel?: string
  // 工作量值
  effortValue?: EffortValue
  // 在分离流程开始前，于 launchUltraplan 中同步设置。防止在 t
  // eleportToRemote 设置 ultraplanSes
  // sionUrl 前约 5 秒窗口期内重复启动。一旦 URL 设置完成或失败，由
  // launchDetached 清除。
  ultraplanLaunching?: boolean
  // 活动的 ultraplan CCR 会话 URL。在 RemoteAg
  // entTask 运行时设置；为真值时会禁用关键词触发 + 彩虹效果。当
  // 轮询达到终止状态时清除。
  ultraplanSessionUrl?: string
  // 已批准并等待用户选择的 ultraplan（在此处实现而非新会话）。由 RemoteAg
  // entTask 轮询在批准时设置；由 UltraplanChoiceDialog 清除。
  ultraplanPendingChoice?: { plan: string; sessionId: string; taskId: string }
  // 启动前权限对话框。由 /ultraplan（斜杠或关键词）设置；由 Ultr
  // aplanLaunchDialog 在选择时清除。
  ultraplanLaunchPending?: { blurb: string }
  // 远程工具端：通过 set_permission_mode control_request 设置，由 onC
  // hangeAppState 推送到 CCR external_metadata.is_ultraplan_mode。
  isUltraplanMode?: boolean
  // 常驻桥接器：用于双向权限检查的权限回调
  replBridgePermissionCallbacks?: BridgePermissionCallbacks
  // 通道权限回调 — 通过 Telegram/iMessage 等的权限提示。通过 interact
  // iveHandler.ts 中的 claim() 与本地 UI + 桥接器 + 钩子
  // + 分类器竞争。在 useManageMCPConnections 中一次性构建。
  channelPermissionCallbacks?: ChannelPermissionCallbacks
}

export type AppStateStore = Store<AppState>

export function getDefaultAppState(): AppState {
  // 为使用 plan_mode_required 生成的队友确定初始权限模式。使用惰性
  // require 以避免与 teammate.ts 产生循环依赖
  /* eslint-disable @typescript-eslint/no-require-imports */
  const teammateUtils =
    require('../utils/teammate.js') as typeof import('../utils/teammate.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const initialMode: PermissionMode =
    teammateUtils.isTeammate() && teammateUtils.isPlanModeRequired()
      ? 'plan'
      : 'default'

  return {
    settings: getInitialSettings(),
    tasks: {},
    agentNameRegistry: new Map(),
    verbose: false,
    mainLoopModel: null, // 别名、全名（与 --model 或环境变量相同）或 null（默认）
    mainLoopModelForSession: null,
    statusLineText: undefined,
    expandedView: 'none',
    isBriefOnly: false,
    showTeammateMessagePreview: false,
    selectedIPAgentIndex: -1,
    coordinatorTaskIndex: -1,
    viewSelectionMode: 'none',
    footerSelection: null,
    kairosEnabled: false,
    remoteSessionUrl: undefined,
    remoteConnectionStatus: 'connecting',
    remoteBackgroundTaskCount: 0,
    replBridgeEnabled: false,
    replBridgeExplicit: false,
    replBridgeOutboundOnly: false,
    replBridgeConnected: false,
    replBridgeSessionActive: false,
    replBridgeReconnecting: false,
    replBridgeConnectUrl: undefined,
    replBridgeSessionUrl: undefined,
    replBridgeEnvironmentId: undefined,
    replBridgeSessionId: undefined,
    replBridgeError: undefined,
    replBridgeInitialName: undefined,
    showRemoteCallout: false,
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: initialMode,
    },
    agent: undefined,
    agentDefinitions: { activeAgents: [], allAgents: [] },
    fileHistory: {
      snapshots: [],
      trackedFiles: new Set(),
      snapshotSequence: 0,
    },
    attribution: createEmptyAttributionState(),
    mcp: {
      clients: [],
      tools: [],
      commands: [],
      resources: {},
      pluginReconnectKey: 0,
    },
    plugins: {
      enabled: [],
      disabled: [],
      commands: [],
      errors: [],
      installationStatus: {
        marketplaces: [],
        plugins: [],
      },
      needsRefresh: false,
    },
    todos: {},
    remoteAgentTaskSuggestions: [],
    notifications: {
      current: null,
      queue: [],
    },
    elicitation: {
      queue: [],
    },
    thinkingEnabled: shouldEnableThinkingByDefault(),
    promptSuggestionEnabled: shouldEnablePromptSuggestion(),
    sessionHooks: new Map(),
    inbox: {
      messages: [],
    },
    workerSandboxPermissions: {
      queue: [],
      selectedIndex: 0,
    },
    pendingWorkerRequest: null,
    pendingSandboxRequest: null,
    promptSuggestion: {
      text: null,
      promptId: null,
      shownAt: 0,
      acceptedAt: 0,
      generationRequestId: null,
    },
    speculation: IDLE_SPECULATION_STATE,
    speculationSessionTimeSavedMs: 0,
    skillImprovement: {
      suggestion: null,
    },
    authVersion: 0,
    initialMessage: null,
    effortValue: undefined,
    activeOverlays: new Set<string>(),
    fastMode: false,
  }
}
