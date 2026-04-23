import { feature } from 'bun:bundle'
import { randomBytes } from 'crypto'
import { unwatchFile, watchFile } from 'fs'
import memoize from 'lodash-es/memoize.js'
import pickBy from 'lodash-es/pickBy.js'
import { basename, dirname, join, resolve } from 'path'
import { getOriginalCwd, getSessionTrustAccepted } from '../bootstrap/state.js'
import { getAutoMemEntrypoint } from '../memdir/paths.js'
import { logEvent } from '../services/analytics/index.js'
import type { McpServerConfig } from '../services/mcp/types.js'
import type {
  BillingType,
  ReferralEligibilityResponse,
} from '../services/oauth/types.js'
import { getCwd } from '../utils/cwd.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { getGlobalClaudeFile } from './env.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { ConfigParseError, getErrnoCode } from './errors.js'
import { writeFileSyncAndFlush_DEPRECATED } from './file.js'
import { getFsImplementation } from './fsOperations.js'
import { findCanonicalGitRoot } from './git.js'
import { safeParseJSON } from './json.js'
import { stripBOM } from './jsonRead.js'
import * as lockfile from './lockfile.js'
import { logError } from './log.js'
import type { MemoryType } from './memory/types.js'
import { normalizePathForConfigKey } from './path.js'
import { getEssentialTrafficOnlyReason } from './privacyLevel.js'
import { getManagedFilePath } from './settings/managedPath.js'
import type { ThemeSetting } from './theme.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('../memdir/teamMemPaths.js') as typeof import('../memdir/teamMemPaths.js'))
  : null
const ccrAutoConnect = feature('CCR_AUTO_CONNECT')
  ? (require('../bridge/bridgeEnabled.js') as typeof import('../bridge/bridgeEnabled.js'))
  : null

/* eslint-enable @typescript-eslint/no-require-imports */
import type { ImageDimensions } from './imageResizer.js'
import type { ModelOption } from './model/modelOptions.js'
import { jsonParse, jsonStringify } from './slowOperations.js'

// 可重入防护：防止当配置文件损坏时 getConfig → logEvent → getGlobalConfig → getConfig 无限递归。
// logEvent 的采样检查会从全局配置中读取 GrowthBook 功能，这又会再次调用 getConfig。
let insideGetConfig = false

// 用于坐标映射的图像尺寸信息（仅在图像被调整大小时设置）
export type PastedContent = {
  id: number // 顺序数字 ID
  type: 'text' | 'image'
  content: string
  mediaType?: string // 例如 'image/png', 'image/jpeg'
  filename?: string // 附件插槽中图像的显示名称
  dimensions?: ImageDimensions
  sourcePath?: string // 拖拽到终端的图像的原始文件路径
}

export interface SerializedStructuredHistoryEntry {
  display: string
  pastedContents?: Record<number, PastedContent>
  pastedText?: string
}
export interface HistoryEntry {
  display: string
  pastedContents: Record<number, PastedContent>
}

export type ReleaseChannel = 'stable' | 'latest'

export type ProjectConfig = {
  allowedTools: string[]
  mcpContextUris: string[]
  mcpServers?: Record<string, McpServerConfig>
  lastAPIDuration?: number
  lastAPIDurationWithoutRetries?: number
  lastToolDuration?: number
  lastCost?: number
  lastDuration?: number
  lastLinesAdded?: number
  lastLinesRemoved?: number
  lastTotalInputTokens?: number
  lastTotalOutputTokens?: number
  lastTotalCacheCreationInputTokens?: number
  lastTotalCacheReadInputTokens?: number
  lastTotalWebSearchRequests?: number
  lastFpsAverage?: number
  lastFpsLow1Pct?: number
  lastSessionId?: string
  lastModelUsage?: Record<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
      webSearchRequests: number
      costUSD: number
    }
  >
  lastSessionMetrics?: Record<string, number>
  exampleFiles?: string[]
  exampleFilesGeneratedAt?: number

  // 信任对话框设置
  hasTrustDialogAccepted?: boolean

  hasCompletedProjectOnboarding?: boolean
  projectOnboardingSeenCount: number
  hasClaudeMdExternalIncludesApproved?: boolean
  hasClaudeMdExternalIncludesWarningShown?: boolean
  // MCP 服务器批准字段 - 已迁移到设置，但保留以向后兼容
  enabledMcpjsonServers?: string[]
  disabledMcpjsonServers?: string[]
  enableAllProjectMcpServers?: boolean
  // 已禁用的 MCP 服务器列表（所有作用域）- 用于启用/禁用切换
  disabledMcpServers?: string[]
  // 默认禁用的内置 MCP 服务器的加入列表
  enabledMcpServers?: string[]
  // 工作树会话管理
  activeWorktreeSession?: {
    originalCwd: string
    worktreePath: string
    worktreeName: string
    originalBranch?: string
    sessionId: string
    hookBased?: boolean
  }
  /** `claude remote-control` 多会话的生成模式。由首次运行对话框或 `w` 切换设置。 */
  remoteControlSpawnMode?: 'same-dir' | 'worktree'
}

const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  projectOnboardingSeenCount: 0,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
}

export type InstallMethod = 'local' | 'native' | 'global' | 'unknown'

export {
  EDITOR_MODES,
  NOTIFICATION_CHANNELS,
} from './configConstants.js'

import type { EDITOR_MODES, NOTIFICATION_CHANNELS } from './configConstants.js'

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

export type AccountInfo = {
  accountUuid: string
  emailAddress: string
  organizationUuid?: string
  organizationName?: string | null // 添加于 2025-04-23，现有用户未填充
  organizationRole?: string | null
  workspaceRole?: string | null
  // 由 /api/oauth/profile 填充
  displayName?: string
  hasExtraUsageEnabled?: boolean
  billingType?: BillingType | null
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
}

// TODO：'emacs' 保留用于向后兼容 - 几个版本后移除
export type EditorMode = 'emacs' | (typeof EDITOR_MODES)[number]

export type DiffTool = 'terminal' | 'auto'

export type OutputStyle = string

export type GlobalConfig = {
  /**
   * @deprecated 请改用 settings.apiKeyHelper。
   */
  apiKeyHelper?: string
  projects?: Record<string, ProjectConfig>
  numStartups: number
  installMethod?: InstallMethod
  autoUpdates?: boolean
  // 用于区分基于保护机制的禁用与用户偏好的标志
  autoUpdatesProtectedForNative?: boolean
  // 上次显示 Doctor 时的会话计数
  doctorShownAtSession?: number
  userID?: string
  theme: ThemeSetting
  hasCompletedOnboarding?: boolean
  // 追踪最近重置引导的版本，与 MIN_VERSION_REQUIRING_ONBOARDING_RESET 一起使用
  lastOnboardingVersion?: string
  // 追踪上次看到的版本以显示发布说明的版本，用于管理发布说明
  lastReleaseNotesSeen?: string
  // 上次获取更新日志的时间戳（内容存储在 ~/.claude/cache/changelog.md 中）
  changelogLastFetched?: number
  // @deprecated - 已迁移到 ~/.claude/cache/changelog.md。保留以支持迁移。
  cachedChangelog?: string
  mcpServers?: Record<string, McpServerConfig>
  // 至少成功连接过一次的 claude.ai MCP 连接器。
  // 用于门控“连接器不可用”/“需要认证”的启动通知：
  // 用户实际使用过的连接器在出现问题时值得标记，
  // 但一个自第一天起就处于“需要认证”状态的组织配置的连接器，用户明显忽略了，不应打扰。
  claudeAiMcpEverConnected?: string[]
  preferredNotifChannel: NotificationChannel
  /**
   * @deprecated。请改用 Notification 钩子（docs/hooks.md）。
   */
  customNotifyCommand?: string
  verbose: boolean
  customApiKeyResponses?: {
    approved?: string[]
    rejected?: string[]
  }
  primaryApiKey?: string // 当未设置环境变量时用户的主要 API 密钥，通过 OAuth 设置（TODO：重命名）
  hasAcknowledgedCostThreshold?: boolean
  hasSeenUndercoverAutoNotice?: boolean // 仅限 ant 内部：是否已经显示过一次性的 auto-undercover 解释器
  hasSeenUltraplanTerms?: boolean // 仅限 ant 内部：是否已经在 ultraplan 发布对话框中显示过一次性的 CCR 条款通知
  hasResetAutoModeOptInForDefaultOffer?: boolean // 仅限 ant 内部：一次性迁移防护，重新提示流失的自动模式用户
  oauthAccount?: AccountInfo
  iterm2KeyBindingInstalled?: boolean // 遗留字段 - 保持向后兼容
  editorMode?: EditorMode
  bypassPermissionsModeAccepted?: boolean
  hasUsedBackslashReturn?: boolean
  autoCompactEnabled: boolean // 控制是否启用自动压缩
  showTurnDuration: boolean // 控制是否显示轮次持续时间消息（例如“Cooked for 1m 6s”）
  /**
   * @deprecated 请改用 settings.env。
   */
  env: { [key: string]: string } // 为 CLI 设置的环境变量
  hasSeenTasksHint?: boolean // 用户是否已看到任务提示
  hasUsedStash?: boolean // 用户是否已使用 stash 功能（Ctrl+S）
  hasUsedBackgroundTask?: boolean // 用户是否已后台化任务（Ctrl+B）
  queuedCommandUpHintCount?: number // 用户已看到排队命令上移提示的次数
  diffTool?: DiffTool // 用于显示差异的工具（terminal 或 vscode）

  // 终端设置状态跟踪
  iterm2SetupInProgress?: boolean
  iterm2BackupPath?: string // iTerm2 偏好设置备份文件的路径
  appleTerminalBackupPath?: string // Terminal.app 偏好设置备份文件的路径
  appleTerminalSetupInProgress?: boolean // Terminal.app 设置是否正在进行中

  // 快捷键设置跟踪
  shiftEnterKeyBindingInstalled?: boolean // 是否安装了 Shift+Enter 快捷键（适用于 iTerm2 或 VSCode）
  optionAsMetaKeyInstalled?: boolean // 是否安装了 Option 作为 Meta 键（适用于 Terminal.app）

  // IDE 配置
  autoConnectIde?: boolean // 是否在启动时自动连接到恰好一个可用 IDE
  autoInstallIdeExtension?: boolean // 当从 IDE 内部运行时是否自动安装 IDE 扩展

  // IDE 对话框
  hasIdeOnboardingBeenShown?: Record<string, boolean> // 终端名称到是否已显示 IDE 引导的映射
  ideHintShownCount?: number // /ide 命令提示已显示次数
  hasIdeAutoConnectDialogBeenShown?: boolean // 是否已显示自动连接 IDE 对话框

  tipsHistory: {
    [tipId: string]: number // 键为 tipId，值为上次显示提示时的 numStartups
  }

  // /buddy 伴生灵魂 — 读取时根据 userId 重新生成骨骼。参见 src/buddy/。
  companion?: import('../buddy/types.js').StoredCompanion
  companionMuted?: boolean

  // 反馈调查跟踪
  feedbackSurveyState?: {
    lastShownTime?: number
  }

  // 对话记录分享提示跟踪（“不再询问”）
  transcriptShareDismissed?: boolean

  // 内存使用跟踪
  memoryUsageCount: number // 用户添加记忆的次数

  // Sonnet-1M 配置
  hasShownS1MWelcomeV2?: Record<string, boolean> // 每个组织是否已显示 Sonnet-1M v2 欢迎消息的标记
  // 每个组织的 Sonnet-1M 订阅者访问缓存 - 键为组织 ID
  // hasAccess 表示“hasAccessAsDefault”，但旧名称保留以向后兼容
  s1mAccessCache?: Record<
    string,
    { hasAccess: boolean; hasAccessNotAsDefault?: boolean; timestamp: number }
  >
  // 每个组织的 Sonnet-1M 按需付费访问缓存 - 键为组织 ID
  // hasAccess 表示“hasAccessAsDefault”，但旧名称保留以向后兼容
  s1mNonSubscriberAccessCache?: Record<
    string,
    { hasAccess: boolean; hasAccessNotAsDefault?: boolean; timestamp: number }
  >

  // 每个组织的访客通行证资格缓存 - 键为组织 ID
  passesEligibilityCache?: Record<
    string,
    ReferralEligibilityResponse & { timestamp: number }
  >

  // 每个账户的 Grove 配置缓存 - 键为账户 UUID
  groveConfigCache?: Record<
    string,
    { grove_enabled: boolean; timestamp: number }
  >

  // 访客通行证升级跟踪
  passesUpsellSeenCount?: number // 访客通行证升级已显示次数
  hasVisitedPasses?: boolean // 用户是否已访问 /passes 命令
  passesLastSeenRemaining?: number // 上次看到的剩余通行证数量 — 当增加时重置升级提示

  // 超额信用授予升级跟踪（按组织 UUID 键 — 多组织用户）。
  // 内联形状（非 import()），因为 config.ts 在 SDK 构建范围内，
  // 而 SDK 打包器无法解析 CLI 服务模块。
  overageCreditGrantCache?: Record<
    string,
    {
      info: {
        available: boolean
        eligible: boolean
        granted: boolean
        amount_minor_units: number | null
        currency: string | null
      }
      timestamp: number
    }
  >
  overageCreditUpsellSeenCount?: number // 超额信用升级已显示次数
  hasVisitedExtraUsage?: boolean // 用户是否已访问 /extra-usage — 隐藏信用升级

  // 显示语言偏好
  preferredLanguage?: 'auto' | 'en' | 'zh' // auto = 跟随系统语言环境，en = 英语，zh = 中文

  // 语音模式通知跟踪
  voiceNoticeSeenCount?: number // “语音模式可用”通知已显示次数
  voiceLangHintShownCount?: number // /voice 听写语言提示已显示次数
  voiceLangHintLastLanguage?: string // 上次显示提示时解析的 STT 语言代码 — 更改时重置计数
  voiceFooterHintSeenCount?: number // “按住 X 说话”页脚提示已显示的会话次数

  // Opus 1M 合并通知跟踪
  opus1mMergeNoticeSeenCount?: number // opus-1m-merge 通知已显示次数

  // 实验加入通知跟踪（按实验 ID 键）
  experimentNoticesSeenCount?: Record<string, number>

  // OpusPlan 实验配置
  hasShownOpusPlanWelcome?: Record<string, boolean> // 每个组织是否已显示 OpusPlan 欢迎消息

  // 队列使用跟踪
  promptQueueUseCount: number // 用户使用提示队列的次数

  // Btw 使用跟踪
  btwUseCount: number // 用户使用 /btw 的次数

  // 计划模式使用跟踪
  lastPlanModeUse?: number // 上次使用计划模式的时间戳

  // 订阅通知跟踪
  subscriptionNoticeCount?: number // 订阅通知已显示次数
  hasAvailableSubscription?: boolean // 用户是否有可用订阅的缓存结果
  subscriptionUpsellShownCount?: number // 订阅升级已显示次数（已弃用）
  recommendedSubscription?: string // 来自 Statsig 的缓存配置值（已弃用）

  // Todo 功能配置
  todoFeatureEnabled: boolean // Todo 功能是否启用
  showExpandedTodos?: boolean // 是否即使为空也展开显示待办事项
  showSpinnerTree?: boolean // 是否显示队友旋转器树而不是药丸

  // 首次启动时间跟踪
  firstStartTime?: string // Claude Code 在此机器上首次启动时的 ISO 时间戳

  messageIdleNotifThresholdMs: number // 用户需要空闲多久才能收到 Claude 生成完成的通知

  githubActionSetupCount?: number // 用户设置 GitHub Action 的次数
  slackAppInstallCount?: number // 用户点击安装 Slack 应用的次数

  // 文件检查点配置
  fileCheckpointingEnabled: boolean

  // 终端进度条配置（OSC 9;4）
  terminalProgressBarEnabled: boolean

  // 终端选项卡状态指示器（OSC 21337）。开启后，会在选项卡侧边栏显示一个彩色点 + 状态文本，
  // 并从标题中移除旋转器前缀（点使其冗余）。
  showStatusInTerminalTab?: boolean

  // 推送通知开关（通过 /config 设置）。默认为关闭 — 需要显式加入。
  taskCompleteNotifEnabled?: boolean
  inputNeededNotifEnabled?: boolean
  agentPushNotifEnabled?: boolean

  // Claude Code 使用跟踪
  claudeCodeFirstTokenDate?: string // 用户首次 Claude Code OAuth 令牌的 ISO 时间戳

  // 模型切换调用跟踪（仅限 ant 内部）
  modelSwitchCalloutDismissed?: boolean // 用户是否选择了“不再显示”
  modelSwitchCalloutLastShown?: number // 上次显示的时间戳（24 小时内不再显示）
  modelSwitchCalloutVersion?: string

  // 工作量调用跟踪 - 为 Opus 4.6 用户显示一次
  effortCalloutDismissed?: boolean // v1 - 遗留状态，读取以抑制已看过它的 Pro 用户的 v2 版本
  effortCalloutV2Dismissed?: boolean

  // 远程调用跟踪 - 首次启用桥接前显示一次
  remoteDialogSeen?: boolean

  // 跨进程退避，用于 initReplBridge 的 oauth_expired_unrefreshable 跳过。
  // `expiresAt` 是去重键 — 内容寻址，当 /login 替换令牌时自清除。
  // `failCount` 限制误报：瞬时刷新失败（认证服务器 5xx、锁错误）在退避生效前获得 3 次重试，
  // 镜像 useReplBridge 的 MAX_CONSECUTIVE_INIT_FAILURES。死令牌账户最多进行 3 次配置写入；
  // 健康 + 瞬时波动在约 210 秒内自愈。
  bridgeOauthDeadExpiresAt?: number
  bridgeOauthDeadFailCount?: number

  // 桌面版升级启动对话框跟踪
  desktopUpsellSeenCount?: number // 总显示次数（最多 3 次）
  desktopUpsellDismissed?: boolean // 选择了“不再询问”

  // 空闲返回对话框跟踪
  idleReturnDismissed?: boolean // 选择了“不再询问”

  // Opus 4.5 Pro 迁移跟踪
  opusProMigrationComplete?: boolean
  opusProMigrationTimestamp?: number

  // Sonnet 4.5 1m 迁移跟踪
  sonnet1m45MigrationComplete?: boolean

  // Opus 4.0/4.1 → 当前 Opus 迁移（显示一次性通知）
  legacyOpusMigrationTimestamp?: number

  // Sonnet 4.5 → 4.6 迁移（pro/max/team premium）
  sonnet45To46MigrationTimestamp?: number

  // 缓存的 statsig 门控值
  cachedStatsigGates: {
    [gateName: string]: boolean
  }

  // 缓存的 statsig 动态配置
  cachedDynamicConfigs?: { [configName: string]: unknown }

  // 缓存的 GrowthBook 功能值
  cachedGrowthBookFeatures?: { [featureName: string]: unknown }

  // 本地 GrowthBook 覆盖（仅限 ant 内部，通过 /config Gates 选项卡设置）。
  // 在环境变量覆盖之后但在真实解析值之前检查。
  growthBookOverrides?: { [featureName: string]: unknown }

  // 紧急提示跟踪 - 存储上次显示的提示以防止重复显示
  lastShownEmergencyTip?: string

  // 文件选择器 gitignore 行为
  respectGitignore: boolean // 文件选择器是否应遵守 .gitignore 文件（默认：true）。注意：.ignore 文件始终被遵守

  // 复制命令行为
  copyFullResponse: boolean // /copy 是否始终复制完整响应而不是显示选择器

  // 全屏应用内文本选择行为
  copyOnSelect?: boolean // 鼠标抬起时自动复制到剪贴板（undefined → true；通过无操作让 cmd+c 能“工作”）

  // 用于传送目录切换的 GitHub 仓库路径映射
  // 键：“owner/repo”（小写），值：仓库克隆的绝对路径数组
  githubRepoPaths?: Record<string, string[]>

  // 用于启动 claude-cli:// 深度链接的终端模拟器。
  // 从交互式会话期间捕获 TERM_PROGRAM，因为深度链接处理程序以无头模式运行（LaunchServices/xdg），没有设置 TERM_PROGRAM。
  deepLinkTerminal?: string

  // iTerm2 it2 CLI 设置
  iterm2It2SetupComplete?: boolean // 是否已验证 it2 设置
  preferTmuxOverIterm2?: boolean // 用户偏好始终使用 tmux 而非 iTerm2 分割窗格

  // 用于自动补全排序的技能使用跟踪
  skillUsage?: Record<string, { usageCount: number; lastUsedAt: number }>
  // 官方市场自动安装跟踪
  officialMarketplaceAutoInstallAttempted?: boolean // 是否已尝试自动安装
  officialMarketplaceAutoInstalled?: boolean // 自动安装是否成功
  officialMarketplaceAutoInstallFailReason?:
    | 'policy_blocked'
    | 'git_unavailable'
    | 'gcs_unavailable'
    | 'unknown' // 失败原因（如果适用）
  officialMarketplaceAutoInstallRetryCount?: number // 重试次数
  officialMarketplaceAutoInstallLastAttemptTime?: number // 上次尝试时间戳
  officialMarketplaceAutoInstallNextRetryTime?: number // 再次重试的最早时间

  // Claude in Chrome 设置
  hasCompletedClaudeInChromeOnboarding?: boolean // 是否已显示 Claude in Chrome 引导
  claudeInChromeDefaultEnabled?: boolean // Claude in Chrome 是否默认启用（undefined 表示平台默认值）
  cachedChromeExtensionInstalled?: boolean // Chrome 扩展是否已安装的缓存结果

  // Chrome 扩展配对状态（跨会话持久化）
  chromeExtension?: {
    pairedDeviceId?: string
    pairedDeviceName?: string
  }

  // LSP 插件推荐偏好
  lspRecommendationDisabled?: boolean // 禁用所有 LSP 插件推荐
  lspRecommendationNeverPlugins?: string[] // 永不建议的插件 ID
  lspRecommendationIgnoredCount?: number // 跟踪忽略的推荐次数（达到 5 次后停止）

  // Claude Code 提示协议状态（来自 CLI/SDK 的 <claude-code-hint /> 标签）。
  // 按提示类型嵌套，以便未来的类型（文档、mcp……）无需新的顶级键即可加入。
  claudeCodeHints?: {
    // 用户已被提示过的插件 ID。显示一次语义：
    // 无论回答是还是否都记录，不再重新提示。限制为 100 个条目以控制配置增长 — 超出后完全停止提示。
    plugin?: string[]
    // 用户从对话框中选择了“不再显示插件安装提示”。
    disabled?: boolean
  }

  // 权限解释器配置
  permissionExplainerEnabled?: boolean // 是否启用 Haiku 生成的权限请求解释（默认：true）

  // 队友生成模式：'auto' | 'tmux' | 'windows-terminal' | 'in-process'
  teammateMode?: 'auto' | 'tmux' | 'windows-terminal' | 'in-process' // 如何生成队友（默认：'auto'）
  // 当工具调用未传递模型时，新队友使用的模型。
  // undefined = 硬编码 Opus（向后兼容）；null = 负责人的模型；string = 模型别名/ID。
  teammateDefaultModel?: string | null

  // PR 状态页脚配置（通过 GrowthBook 功能门控）
  prStatusFooterEnabled?: boolean // 是否在页脚显示 PR 审查状态（默认：true）

  // Tmux 活动面板可见性（仅限 ant 内部，通过按 Enter 键切换 tmux 药丸）
  tungstenPanelVisible?: boolean

  // 来自 API 的缓存组织级快速模式状态。
  // 用于检测跨会话更改并通知用户。
  penguinModeOrgEnabled?: boolean

  // 上次运行后台刷新的 Unix 毫秒时间戳（快速模式、配额、通行证、客户端数据）。
  // 与 tengu_cicada_nap_ms 一起用于限制 API 调用
  startupPrefetchedAt?: number

  // 启动时运行远程控制（需要 BRIDGE_MODE）
  // undefined = 使用默认值（有关优先级，请参见 getRemoteControlAtStartup()）
  remoteControlAtStartup?: boolean

  // 上次 API 响应缓存的额外使用禁用原因
  // undefined = 无缓存，null = 启用额外使用，string = 禁用原因。
  cachedExtraUsageDisabledReason?: string | null

  // 自动权限通知跟踪（仅限 ant 内部）
  autoPermissionsNotificationCount?: number // 自动权限通知已显示次数

  // 推测配置（仅限 ant 内部）
  speculationEnabled?: boolean // 是否启用推测（默认：true）

  // 用于服务端实验的客户端数据（在引导期间获取）。
  clientDataCache?: Record<string, unknown> | null

  // 模型选择器的额外模型选项（在引导期间获取）。
  additionalModelOptionsCache?: ModelOption[]

  // /api/claude_code/organizations/metrics_enabled 的磁盘缓存。
  // 组织级设置很少更改；跨进程持久化可以避免每次 `claude -p` 调用都进行冷 API 调用。
  metricsStatusCache?: {
    enabled: boolean
    timestamp: number
  }

  // 上次应用的迁移集版本。当等于 CURRENT_MIGRATION_VERSION 时，
  // runMigrations() 跳过所有同步迁移（避免每次启动进行 11 次 saveGlobalConfig 锁定+重新读取）。
  migrationVersion?: number
}

/**
 * 创建全新默认 GlobalConfig 的工厂函数。用于代替深度克隆共享常量 —
 * 嵌套容器（数组、记录）都是空的，因此工厂在零克隆成本下提供新的引用。
 */
function createDefaultGlobalConfig(): GlobalConfig {
  return {
    numStartups: 0,
    installMethod: undefined,
    autoUpdates: undefined,
    theme: 'dark',
    preferredNotifChannel: 'auto',
    verbose: false,
    editorMode: 'normal',
    autoCompactEnabled: true,
    showTurnDuration: true,
    hasSeenTasksHint: false,
    hasUsedStash: false,
    hasUsedBackgroundTask: false,
    queuedCommandUpHintCount: 0,
    diffTool: 'auto',
    customApiKeyResponses: {
      approved: [],
      rejected: [],
    },
    env: {},
    tipsHistory: {},
    memoryUsageCount: 0,
    promptQueueUseCount: 0,
    btwUseCount: 0,
    todoFeatureEnabled: true,
    showExpandedTodos: false,
    messageIdleNotifThresholdMs: 60000,
    autoConnectIde: false,
    autoInstallIdeExtension: true,
    fileCheckpointingEnabled: true,
    terminalProgressBarEnabled: true,
    cachedStatsigGates: {},
    cachedDynamicConfigs: {},
    cachedGrowthBookFeatures: {},
    respectGitignore: true,
    copyFullResponse: false,
  }
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = createDefaultGlobalConfig()

export const GLOBAL_CONFIG_KEYS = [
  'apiKeyHelper',
  'installMethod',
  'autoUpdates',
  'autoUpdatesProtectedForNative',
  'theme',
  'verbose',
  'preferredNotifChannel',
  'shiftEnterKeyBindingInstalled',
  'editorMode',
  'hasUsedBackslashReturn',
  'autoCompactEnabled',
  'showTurnDuration',
  'diffTool',
  'env',
  'tipsHistory',
  'todoFeatureEnabled',
  'showExpandedTodos',
  'messageIdleNotifThresholdMs',
  'autoConnectIde',
  'autoInstallIdeExtension',
  'fileCheckpointingEnabled',
  'terminalProgressBarEnabled',
  'showStatusInTerminalTab',
  'taskCompleteNotifEnabled',
  'inputNeededNotifEnabled',
  'agentPushNotifEnabled',
  'respectGitignore',
  'claudeInChromeDefaultEnabled',
  'hasCompletedClaudeInChromeOnboarding',
  'lspRecommendationDisabled',
  'lspRecommendationNeverPlugins',
  'lspRecommendationIgnoredCount',
  'copyFullResponse',
  'copyOnSelect',
  'permissionExplainerEnabled',
  'prStatusFooterEnabled',
  'remoteControlAtStartup',
  'remoteDialogSeen',
] as const

export type GlobalConfigKey = (typeof GLOBAL_CONFIG_KEYS)[number]

export function isGlobalConfigKey(key: string): key is GlobalConfigKey {
  return GLOBAL_CONFIG_KEYS.includes(key as GlobalConfigKey)
}

export const PROJECT_CONFIG_KEYS = [
  'allowedTools',
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
] as const

export type ProjectConfigKey = (typeof PROJECT_CONFIG_KEYS)[number]

/**
 * 检查用户是否已接受当前工作目录的信任对话框。
 *
 * 此函数遍历父目录以检查是否有父目录已批准。
 * 接受对某个目录的信任意味着也信任其子目录。
 *
 * @returns 信任对话框是否已被接受（即“不应显示”）
 */
let _trustAccepted = false

export function resetTrustDialogAcceptedCacheForTesting(): void {
  _trustAccepted = false
}

export function checkHasTrustDialogAccepted(): boolean {
  // 信任在会话中只会从 false 变为 true（永远不会反向），
  // 因此一旦为 true，我们可以锁定它。false 不会被缓存 — 每次调用时重新检查，
  // 以便信任对话框的接受能在会话中途被捕获。
  // （lodash memoize 不适合这里，因为它也会缓存 false。）
  return (_trustAccepted ||= computeTrustDialogAccepted())
}

function computeTrustDialogAccepted(): boolean {
  // 检查会话级信任（对于主目录的情况，信任未持久化）
  // 当从主目录运行时，信任对话框会显示，但接受仅存储在内存中。
  // 这允许钩子和其他功能在会话期间工作。
  if (getSessionTrustAccepted()) {
    return true
  }

  const config = getGlobalConfig()

  // 始终检查信任将要保存的位置（git 根目录或原始 cwd）
  // 这是 saveCurrentProjectConfig 持久化信任的主要位置
  const projectPath = getProjectPathForConfig()
  const projectConfig = config.projects?.[projectPath]
  if (projectConfig?.hasTrustDialogAccepted) {
    return true
  }

  // 现在从当前工作目录及其父目录开始检查
  // 规范化路径以实现一致的 JSON 键查找
  let currentPath = normalizePathForConfigKey(getCwd())

  // 遍历所有父目录
  while (true) {
    const pathConfig = config.projects?.[currentPath]
    if (pathConfig?.hasTrustDialogAccepted) {
      return true
    }

    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    // 如果到达根目录（当父目录与当前相同）则停止
    if (parentPath === currentPath) {
      break
    }
    currentPath = parentPath
  }

  return false
}

/**
 * 检查任意目录（不是会话 cwd）的信任状态。
 * 从 `dir` 向上遍历，如果任何祖先目录具有持久化的信任，则返回 true。
 * 与 checkHasTrustDialogAccepted 不同，此函数不会查阅会话信任或记忆的项目路径 —
 * 当目标目录与 cwd 不同时（例如 /assistant 安装到用户键入的路径）使用此函数。
 */
export function isPathTrusted(dir: string): boolean {
  const config = getGlobalConfig()
  let currentPath = normalizePathForConfigKey(resolve(dir))
  while (true) {
    if (config.projects?.[currentPath]?.hasTrustDialogAccepted) return true
    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    if (parentPath === currentPath) return false
    currentPath = parentPath
  }
}

// 我们必须在此处放置测试代码，因为 Jest 不支持 mock ES 模块 :O
const TEST_GLOBAL_CONFIG_FOR_TESTING: GlobalConfig = {
  ...DEFAULT_GLOBAL_CONFIG,
  autoUpdates: false,
}
const TEST_PROJECT_CONFIG_FOR_TESTING: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
}

export function isProjectConfigKey(key: string): key is ProjectConfigKey {
  return PROJECT_CONFIG_KEYS.includes(key as ProjectConfigKey)
}

/**
 * 检测写入 `fresh` 是否会丢失内存缓存仍然持有的认证/引导状态。
 * 当 `getConfig` 遇到损坏或截断的文件（来自另一个进程或非原子回退）并返回
 * DEFAULT_GLOBAL_CONFIG 时会发生这种情况。将其写回会永久擦除认证。
 * 参见 GH #3117。
 */
function wouldLoseAuthState(fresh: {
  oauthAccount?: unknown
  hasCompletedOnboarding?: boolean
}): boolean {
  const cached = globalConfigCache.config
  if (!cached) return false
  const lostOauth =
    cached.oauthAccount !== undefined && fresh.oauthAccount === undefined
  const lostOnboarding =
    cached.hasCompletedOnboarding === true &&
    fresh.hasCompletedOnboarding !== true
  return lostOauth || lostOnboarding
}

export function saveGlobalConfig(
  updater: (currentConfig: GlobalConfig) => GlobalConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    const config = updater(TEST_GLOBAL_CONFIG_FOR_TESTING)
    // 如果没有更改（返回相同引用），则跳过
    if (config === TEST_GLOBAL_CONFIG_FOR_TESTING) {
      return
    }
    Object.assign(TEST_GLOBAL_CONFIG_FOR_TESTING, config)
    return
  }

  let written: GlobalConfig | null = null
  try {
    const didWrite = saveConfigWithLock(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
      current => {
        const config = updater(current)
        // 如果没有更改（返回相同引用），则跳过
        if (config === current) {
          return current
        }
        written = {
          ...config,
          projects: removeProjectHistory(current.projects),
        }
        return written
      },
    )
    // 只有实际写入时才写穿缓存。如果认证丢失防护触发（或更新器未做任何更改），
    // 文件未被触及，缓存仍然有效 — 触碰它会破坏防护。
    if (didWrite && written) {
      writeThroughGlobalConfigCache(written)
    }
  } catch (error) {
    logForDebugging(`使用锁保存配置失败：${error}`, {
      level: 'error',
    })
    // 出错时回退到无锁版本。此回退存在一个竞争窗口：
    // 如果另一个进程正在写入中（或文件被截断），getConfig 返回默认值。
    // 拒绝将那些值写入良好的缓存配置，以避免擦除认证。参见 GH #3117。
    const currentConfig = getConfig(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
    )
    if (wouldLoseAuthState(currentConfig)) {
      logForDebugging(
        'saveGlobalConfig 回退：重新读取的配置缺少缓存拥有的认证；拒绝写入。参见 GH #3117。',
        { level: 'error' },
      )
      logEvent('tengu_config_auth_loss_prevented', {})
      return
    }
    const config = updater(currentConfig)
    // 如果没有更改（返回相同引用），则跳过
    if (config === currentConfig) {
      return
    }
    written = {
      ...config,
      projects: removeProjectHistory(currentConfig.projects),
    }
    saveConfig(getGlobalClaudeFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
  }
}

// 全局配置的缓存
let globalConfigCache: { config: GlobalConfig | null; mtime: number } = {
  config: null,
  mtime: 0,
}

// 配置文件操作的跟踪（遥测）
let lastReadFileStats: { mtime: number; size: number } | null = null
let configCacheHits = 0
let configCacheMisses = 0
// 会话总计对全局配置文件的实际磁盘写入次数。
// 暴露给仅限 ant 内部的开发诊断（见 inc-4552），以便异常写入率在 UI 中显示，在损坏 ~/.claude.json 之前。
let globalConfigWriteCount = 0

export function getGlobalConfigWriteCount(): number {
  return globalConfigWriteCount
}

export const CONFIG_WRITE_DISPLAY_THRESHOLD = 20

function reportConfigCacheStats(): void {
  const total = configCacheHits + configCacheMisses
  if (total > 0) {
    logEvent('tengu_config_cache_stats', {
      cache_hits: configCacheHits,
      cache_misses: configCacheMisses,
      hit_rate: configCacheHits / total,
    })
  }
  configCacheHits = 0
  configCacheMisses = 0
}

// 注册清理以在会话结束时报告缓存统计信息
// eslint-disable-next-line custom-rules/no-top-level-side-effects
registerCleanup(async () => {
  reportConfigCacheStats()
})

/**
 * 迁移旧的 autoUpdaterStatus 到新的 installMethod 和 autoUpdates 字段
 * @internal
 */
function migrateConfigFields(config: GlobalConfig): GlobalConfig {
  // 已迁移
  if (config.installMethod !== undefined) {
    return config
  }

  // autoUpdaterStatus 已从类型中移除，但可能存在于旧配置中
  const legacy = config as GlobalConfig & {
    autoUpdaterStatus?:
      | 'migrated'
      | 'installed'
      | 'disabled'
      | 'enabled'
      | 'no_permissions'
      | 'not_configured'
  }

  // 从旧字段确定安装方法和自动更新偏好
  let installMethod: InstallMethod = 'unknown'
  let autoUpdates = config.autoUpdates ?? true // 默认启用，除非显式禁用

  switch (legacy.autoUpdaterStatus) {
    case 'migrated':
      installMethod = 'local'
      break
    case 'installed':
      installMethod = 'native'
      break
    case 'disabled':
      // 禁用时，我们不知道安装方法
      autoUpdates = false
      break
    case 'enabled':
    case 'no_permissions':
    case 'not_configured':
      // 这些意味着全局安装
      installMethod = 'global'
      break
    case undefined:
      // 没有旧状态，保持默认值
      break
  }

  return {
    ...config,
    installMethod,
    autoUpdates,
  }
}

/**
 * 从项目中移除历史字段（已迁移到 history.jsonl）
 * @internal
 */
function removeProjectHistory(
  projects: Record<string, ProjectConfig> | undefined,
): Record<string, ProjectConfig> | undefined {
  if (!projects) {
    return projects
  }

  const cleanedProjects: Record<string, ProjectConfig> = {}
  let needsCleaning = false

  for (const [path, projectConfig] of Object.entries(projects)) {
    // history 已从类型中移除，但可能存在于旧配置中
    const legacy = projectConfig as ProjectConfig & { history?: unknown }
    if (legacy.history !== undefined) {
      needsCleaning = true
      const { history, ...cleanedConfig } = legacy
      cleanedProjects[path] = cleanedConfig
    } else {
      cleanedProjects[path] = projectConfig
    }
  }

  return needsCleaning ? cleanedProjects : projects
}

// fs.watchFile 轮询间隔，用于检测来自其他实例的写入（毫秒）
const CONFIG_FRESHNESS_POLL_MS = 1000
let freshnessWatcherStarted = false

// fs.watchFile 在 libuv 线程池上轮询 stat，并且仅在 mtime 更改时调用我们 —
// 停滞的 stat 永远不会阻塞主线程。
function startGlobalConfigFreshnessWatcher(): void {
  if (freshnessWatcherStarted || process.env.NODE_ENV === 'test') return
  freshnessWatcherStarted = true
  const file = getGlobalClaudeFile()
  watchFile(
    file,
    { interval: CONFIG_FRESHNESS_POLL_MS, persistent: false },
    curr => {
      // 我们自己写入也会触发 — 写穿的 Date.now() 超过文件 mtime，因此缓存 mtime > 文件 mtime，跳过重新读取。
      // Bun/Node 在文件不存在时也会触发 curr.mtimeMs=0（初始回调或删除）— <= 也处理该情况。
      if (curr.mtimeMs <= globalConfigCache.mtime) return
      void getFsImplementation()
        .readFile(file, { encoding: 'utf-8' })
        .then(content => {
          // 在我们读取时，写穿可能已经推进了缓存；不要退化到 watchFile 统计的过时快照。
          if (curr.mtimeMs <= globalConfigCache.mtime) return
          const parsed = safeParseJSON(stripBOM(content))
          if (parsed === null || typeof parsed !== 'object') return
          globalConfigCache = {
            config: migrateConfigFields({
              ...createDefaultGlobalConfig(),
              ...(parsed as Partial<GlobalConfig>),
            }),
            mtime: curr.mtimeMs,
          }
          lastReadFileStats = { mtime: curr.mtimeMs, size: curr.size }
        })
        .catch(() => {})
    },
  )
  registerCleanup(async () => {
    unwatchFile(file)
    freshnessWatcherStarted = false
  })
}

// 写穿：我们刚刚写入的内容就是新的配置。缓存 mtime 超出文件的实际 mtime
// （Date.now() 在写入后记录），以便新鲜度观察器在下一个 tick 跳过读取我们自己写入。
function writeThroughGlobalConfigCache(config: GlobalConfig): void {
  globalConfigCache = { config, mtime: Date.now() }
  lastReadFileStats = null
}

export function getGlobalConfig(): GlobalConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_GLOBAL_CONFIG_FOR_TESTING
  }

  // 快速路径：纯内存读取。启动后，此路径总是命中 — 我们自己写入走写穿，
  // 其他实例的写入由后台新鲜度观察器捕获（从不阻塞此路径）。
  if (globalConfigCache.config) {
    configCacheHits++
    return globalConfigCache.config
  }

  // 慢速路径：启动加载。这里的同步 I/O 是可接受的，因为它恰好运行一次，在 UI 渲染之前。
  // 先 stat 再读取，以便任何竞争自纠正（旧的 mtime + 新内容 → 观察器在下一个 tick 重新读取）。
  configCacheMisses++
  try {
    let stats: { mtimeMs: number; size: number } | null = null
    try {
      stats = getFsImplementation().statSync(getGlobalClaudeFile())
    } catch {
      // 文件不存在
    }
    const config = migrateConfigFields(
      getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig),
    )
    globalConfigCache = {
      config,
      mtime: stats?.mtimeMs ?? Date.now(),
    }
    lastReadFileStats = stats
      ? { mtime: stats.mtimeMs, size: stats.size }
      : null
    startGlobalConfigFreshnessWatcher()
    return config
  } catch {
    // 如果出任何问题，回退到未缓存行为
    return migrateConfigFields(
      getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig),
    )
  }
}

/**
 * 返回 remoteControlAtStartup 的有效值。优先级：
 *   1. 用户的显式配置值（始终获胜 — 尊重选择退出）
 *   2. CCR 自动连接默认值（仅限 ant 内部构建，通过 GrowthBook 门控）
 *   3. false（必须显式选择加入远程控制）
 */
export function getRemoteControlAtStartup(): boolean {
  const explicit = getGlobalConfig().remoteControlAtStartup
  if (explicit !== undefined) return explicit
  if (feature('CCR_AUTO_CONNECT')) {
    if (ccrAutoConnect?.getCcrAutoConnectDefault()) return true
  }
  return false
}

export function getCustomApiKeyStatus(
  truncatedApiKey: string,
): 'approved' | 'rejected' | 'new' {
  const config = getGlobalConfig()
  if (config.customApiKeyResponses?.approved?.includes(truncatedApiKey)) {
    return 'approved'
  }
  if (config.customApiKeyResponses?.rejected?.includes(truncatedApiKey)) {
    return 'rejected'
  }
  return 'new'
}

function saveConfig<A extends object>(
  file: string,
  config: A,
  defaultConfig: A,
): void {
  // 在写入配置文件之前确保目录存在
  const dir = dirname(file)
  const fs = getFsImplementation()
  // FsOperations 实现中的 mkdirSync 已经是递归的
  fs.mkdirSync(dir)

  // 过滤掉任何与默认值匹配的值
  const filteredConfig = pickBy(
    config,
    (value, key) =>
      jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
  )
  // 使用安全权限写入配置文件 - 模式仅适用于新文件
  writeFileSyncAndFlush_DEPRECATED(
    file,
    jsonStringify(filteredConfig, null, 2),
    {
      encoding: 'utf-8',
      mode: 0o600,
    },
  )
  if (file === getGlobalClaudeFile()) {
    globalConfigWriteCount++
  }
}

/**
 * 返回是否执行了写入；如果写入被跳过（无更改，或认证丢失防护触发），则返回 false。
 * 调用方使用此来决定是否使缓存失效 — 在跳过的写入后使缓存失效会破坏认证丢失防护所依赖的良好缓存状态。
 */
function saveConfigWithLock<A extends object>(
  file: string,
  createDefault: () => A,
  mergeFn: (current: A) => A,
): boolean {
  const defaultConfig = createDefault()
  const dir = dirname(file)
  const fs = getFsImplementation()

  // 确保目录存在（FsOperations 中的 mkdirSync 已经是递归的）
  fs.mkdirSync(dir)

  let release
  try {
    const lockFilePath = `${file}.lock`
    const startTime = Date.now()
    release = lockfile.lockSync(file, {
      lockfilePath: lockFilePath,
      onCompromised: err => {
        // 默认的 onCompromised 从 setTimeout 回调中抛出，变成未捕获的异常。
        // 仅记录 — 锁被盗（例如在 10 秒事件循环停顿后）是可恢复的。
        logForDebugging(`配置锁受损：${err}`, { level: 'error' })
      },
    })
    const lockTime = Date.now() - startTime
    if (lockTime > 100) {
      logForDebugging(
        '获取锁的时间比预期的长 - 可能另一个 Claude 实例正在运行',
      )
      logEvent('tengu_config_lock_contention', {
        lock_time_ms: lockTime,
      })
    }

    // 检查陈旧写入 - 文件自我们上次读取后已更改
    // 仅对全局配置文件进行检查，因为 lastReadFileStats 跟踪的是该特定文件
    if (lastReadFileStats && file === getGlobalClaudeFile()) {
      try {
        const currentStats = fs.statSync(file)
        if (
          currentStats.mtimeMs !== lastReadFileStats.mtime ||
          currentStats.size !== lastReadFileStats.size
        ) {
          logEvent('tengu_config_stale_write', {
            read_mtime: lastReadFileStats.mtime,
            write_mtime: currentStats.mtimeMs,
            read_size: lastReadFileStats.size,
            write_size: currentStats.size,
          })
        }
      } catch (e) {
        const code = getErrnoCode(e)
        if (code !== 'ENOENT') {
          throw e
        }
        // 文件尚不存在，无需陈旧检查
      }
    }

    // 重新读取当前配置以获取最新状态。如果文件暂时损坏（并发写入、写入中途终止），
    // 此操作返回默认值 — 我们绝不能将这些默认值写回良好的配置上。
    const currentConfig = getConfig(file, createDefault)
    if (file === getGlobalClaudeFile() && wouldLoseAuthState(currentConfig)) {
      logForDebugging(
        'saveConfigWithLock：重新读取的配置缺少缓存拥有的认证；拒绝写入以避免擦除 ~/.claude.json。参见 GH #3117。',
        { level: 'error' },
      )
      logEvent('tengu_config_auth_loss_prevented', {})
      return false
    }

    // 应用合并函数以获得更新后的配置
    const mergedConfig = mergeFn(currentConfig)

    // 如果没有更改（返回相同引用），则跳过写入
    if (mergedConfig === currentConfig) {
      return false
    }

    // 过滤掉任何与默认值匹配的值
    const filteredConfig = pickBy(
      mergedConfig,
      (value, key) =>
        jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
    )

    // 在写入前创建现有配置的时间戳备份
    // 我们保留多个备份，以防止重置/损坏的配置覆盖良好的备份。
    // 备份存储在 ~/.claude/backups/ 中，以保持主目录整洁。
    try {
      const fileBase = basename(file)
      const backupDir = getConfigBackupDir()

      // 确保备份目录存在
      try {
        fs.mkdirSync(backupDir)
      } catch (mkdirErr) {
        const mkdirCode = getErrnoCode(mkdirErr)
        if (mkdirCode !== 'EEXIST') {
          throw mkdirErr
        }
      }

      // 首先检查现有备份 — 如果最近已存在备份，则跳过创建新备份。
      // 在启动期间，许多 saveGlobalConfig 调用会在几毫秒内触发；没有此检查，每次调用都会创建一个新的备份文件，在磁盘上累积。
      const MIN_BACKUP_INTERVAL_MS = 60_000
      const existingBackups = fs
        .readdirStringSync(backupDir)
        .filter(f => f.startsWith(`${fileBase}.backup.`))
        .sort()
        .reverse() // 最近的优先（时间戳按字典序排序）

      const mostRecentBackup = existingBackups[0]
      const mostRecentTimestamp = mostRecentBackup
        ? Number(mostRecentBackup.split('.backup.').pop())
        : 0
      const shouldCreateBackup =
        Number.isNaN(mostRecentTimestamp) ||
        Date.now() - mostRecentTimestamp >= MIN_BACKUP_INTERVAL_MS

      if (shouldCreateBackup) {
        const backupPath = join(backupDir, `${fileBase}.backup.${Date.now()}`)
        fs.copyFileSync(file, backupPath)
      }

      // 清理旧备份，仅保留最新的 5 个
      const MAX_BACKUPS = 5
      // 如果刚刚创建了一个，则重新读取列表；否则重用现有列表
      const backupsForCleanup = shouldCreateBackup
        ? fs
            .readdirStringSync(backupDir)
            .filter(f => f.startsWith(`${fileBase}.backup.`))
            .sort()
            .reverse()
        : existingBackups

      for (const oldBackup of backupsForCleanup.slice(MAX_BACKUPS)) {
        try {
          fs.unlinkSync(join(backupDir, oldBackup))
        } catch {
          // 忽略清理错误
        }
      }
    } catch (e) {
      const code = getErrnoCode(e)
      if (code !== 'ENOENT') {
        logForDebugging(`备份配置失败：${e}`, {
          level: 'error',
        })
      }
      // 没有文件可备份或备份失败，继续写入
    }

    // 使用安全权限写入配置文件 - 模式仅适用于新文件
    writeFileSyncAndFlush_DEPRECATED(
      file,
      jsonStringify(filteredConfig, null, 2),
      {
        encoding: 'utf-8',
        mode: 0o600,
      },
    )
    if (file === getGlobalClaudeFile()) {
      globalConfigWriteCount++
    }
    return true
  } finally {
    if (release) {
      release()
    }
  }
}

// 跟踪是否允许配置读取的标志
let configReadingAllowed = false

export function enableConfigs(): void {
  if (configReadingAllowed) {
    // 确保幂等性
    return
  }

  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'enable_configs_started')

  // 在此标志设置之前的任何配置读取都会显示控制台警告，以防止我们在模块初始化期间添加配置读取
  configReadingAllowed = true
  // 我们只检查全局配置，因为目前所有配置共享一个文件
  getConfig(
    getGlobalClaudeFile(),
    createDefaultGlobalConfig,
    true /* 无效时抛出 */,
  )

  logForDiagnosticsNoPII('info', 'enable_configs_completed', {
    duration_ms: Date.now() - startTime,
  })
}

/**
 * 返回存储配置备份文件的目录。
 * 使用 ~/.claude/backups/ 以保持主目录整洁。
 */
function getConfigBackupDir(): string {
  return join(getClaudeConfigHomeDir(), 'backups')
}

/**
 * 查找给定配置文件的最新备份文件。
 * 首先检查 ~/.claude/backups/，然后出于向后兼容回退到旧位置（配置文件旁边）。
 * 返回最新备份的完整路径，如果不存在则返回 null。
 */
function findMostRecentBackup(file: string): string | null {
  const fs = getFsImplementation()
  const fileBase = basename(file)
  const backupDir = getConfigBackupDir()

  // 首先检查新的备份目录
  try {
    const backups = fs
      .readdirStringSync(backupDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()

    const mostRecent = backups.at(-1) // 时间戳按字典序排序
    if (mostRecent) {
      return join(backupDir, mostRecent)
    }
  } catch {
    // 备份目录尚不存在
  }

  // 回退到旧位置（配置文件旁边）
  const fileDir = dirname(file)

  try {
    const backups = fs
      .readdirStringSync(fileDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()

    const mostRecent = backups.at(-1) // 时间戳按字典序排序
    if (mostRecent) {
      return join(fileDir, mostRecent)
    }

    // 检查旧版备份文件（无时间戳）
    const legacyBackup = `${file}.backup`
    try {
      fs.statSync(legacyBackup)
      return legacyBackup
    } catch {
      // 旧版备份不存在
    }
  } catch {
    // 忽略读取目录的错误
  }

  return null
}

function getConfig<A>(
  file: string,
  createDefault: () => A,
  throwOnInvalid?: boolean,
): A {
  // 如果在允许之前访问配置，则记录警告
  if (!configReadingAllowed && process.env.NODE_ENV !== 'test') {
    throw new Error('在允许之前访问了配置。')
  }

  const fs = getFsImplementation()

  try {
    const fileContent = fs.readFileSync(file, {
      encoding: 'utf-8',
    })
    try {
      // 移除 BOM 后再解析 - PowerShell 5.x 会为 UTF-8 文件添加 BOM
      const parsedConfig = jsonParse(stripBOM(fileContent))
      return {
        ...createDefault(),
        ...parsedConfig,
      }
    } catch (error) {
      // 抛出 ConfigParseError，包含文件路径和默认配置
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      throw new ConfigParseError(errorMessage, file, createDefault())
    }
  } catch (error) {
    // 处理文件未找到 - 检查备份并返回默认值
    const errCode = getErrnoCode(error)
    if (errCode === 'ENOENT') {
      const backupPath = findMostRecentBackup(file)
      if (backupPath) {
        process.stderr.write(
          `\n未找到 Claude 配置文件：${file}\n` +
            `存在备份文件：${backupPath}\n` +
            `您可以手动恢复：cp "${backupPath}" "${file}"\n\n`,
        )
      }
      return createDefault()
    }

    // 如果 throwOnInvalid 为 true，则重新抛出 ConfigParseError
    if (error instanceof ConfigParseError && throwOnInvalid) {
      throw error
    }

    // 记录配置解析错误，以便用户了解发生了什么
    if (error instanceof ConfigParseError) {
      logForDebugging(
        `配置文件损坏，重置为默认值：${error.message}`,
        { level: 'error' },
      )

      // 防护：logEvent → shouldSampleEvent → getGlobalConfig → getConfig
      // 当配置文件损坏时会导致无限递归，因为采样检查会从全局配置中读取 GrowthBook 功能。
      // 仅在最外层调用时记录分析。
      if (!insideGetConfig) {
        insideGetConfig = true
        try {
          // 记录错误以供监控
          logError(error)

          // 记录配置损坏的分析事件
          let hasBackup = false
          try {
            fs.statSync(`${file}.backup`)
            hasBackup = true
          } catch {
            // 无备份
          }
          logEvent('tengu_config_parse_error', {
            has_backup: hasBackup,
          })
        } finally {
          insideGetConfig = false
        }
      }

      process.stderr.write(
        `\nClaude 配置文件 ${file} 已损坏：${error.message}\n`,
      )

      // 尝试备份损坏的配置文件（仅当尚未备份时）
      const fileBase = basename(file)
      const corruptedBackupDir = getConfigBackupDir()

      // 确保备份目录存在
      try {
        fs.mkdirSync(corruptedBackupDir)
      } catch (mkdirErr) {
        const mkdirCode = getErrnoCode(mkdirErr)
        if (mkdirCode !== 'EEXIST') {
          throw mkdirErr
        }
      }

      const existingCorruptedBackups = fs
        .readdirStringSync(corruptedBackupDir)
        .filter(f => f.startsWith(`${fileBase}.corrupted.`))

      let corruptedBackupPath: string | undefined
      let alreadyBackedUp = false

      // 检查当前损坏的内容是否与任何现有备份匹配
      const currentContent = fs.readFileSync(file, { encoding: 'utf-8' })
      for (const backup of existingCorruptedBackups) {
        try {
          const backupContent = fs.readFileSync(
            join(corruptedBackupDir, backup),
            { encoding: 'utf-8' },
          )
          if (currentContent === backupContent) {
            alreadyBackedUp = true
            break
          }
        } catch {
          // 忽略备份的读取错误
        }
      }

      if (!alreadyBackedUp) {
        corruptedBackupPath = join(
          corruptedBackupDir,
          `${fileBase}.corrupted.${Date.now()}`,
        )
        try {
          fs.copyFileSync(file, corruptedBackupPath)
          logForDebugging(
            `已备份损坏的配置到：${corruptedBackupPath}`,
            {
              level: 'error',
            },
          )
        } catch {
          // 忽略备份错误
        }
      }

      // 通知用户关于损坏的配置和可用的备份
      const backupPath = findMostRecentBackup(file)
      if (corruptedBackupPath) {
        process.stderr.write(
          `损坏的文件已备份到：${corruptedBackupPath}\n`,
        )
      } else if (alreadyBackedUp) {
        process.stderr.write(`损坏的文件已经备份。\n`)
      }

      if (backupPath) {
        process.stderr.write(
          `存在备份文件：${backupPath}\n` +
            `您可以手动恢复：cp "${backupPath}" "${file}"\n\n`,
        )
      } else {
        process.stderr.write(`\n`)
      }
    }

    return createDefault()
  }
}

// 用于配置查找的项目路径的记忆化函数
export const getProjectPathForConfig = memoize((): string => {
  const originalCwd = getOriginalCwd()
  const gitRoot = findCanonicalGitRoot(originalCwd)

  if (gitRoot) {
    // 规范化以保持一致 JSON 键（所有平台上使用正斜杠）
    // 这确保类似于 C:\Users\... 和 C:/Users/... 的路径映射到相同的键
    return normalizePathForConfigKey(gitRoot)
  }

  // 不在 git 仓库中
  return normalizePathForConfigKey(resolve(originalCwd))
})

export function getCurrentProjectConfig(): ProjectConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_PROJECT_CONFIG_FOR_TESTING
  }

  const absolutePath = getProjectPathForConfig()
  const config = getGlobalConfig()

  if (!config.projects) {
    return DEFAULT_PROJECT_CONFIG
  }

  const projectConfig = config.projects[absolutePath] ?? DEFAULT_PROJECT_CONFIG
  // 不确定这如何变成了字符串
  // TODO：修复上游
  if (typeof projectConfig.allowedTools === 'string') {
    projectConfig.allowedTools =
      (safeParseJSON(projectConfig.allowedTools) as string[]) ?? []
  }

  return projectConfig
}

export function saveCurrentProjectConfig(
  updater: (currentConfig: ProjectConfig) => ProjectConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    const config = updater(TEST_PROJECT_CONFIG_FOR_TESTING)
    // 如果没有更改（返回相同引用），则跳过
    if (config === TEST_PROJECT_CONFIG_FOR_TESTING) {
      return
    }
    Object.assign(TEST_PROJECT_CONFIG_FOR_TESTING, config)
    return
  }
  const absolutePath = getProjectPathForConfig()

  let written: GlobalConfig | null = null
  try {
    const didWrite = saveConfigWithLock(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
      current => {
        const currentProjectConfig =
          current.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
        const newProjectConfig = updater(currentProjectConfig)
        // 如果没有更改（返回相同引用），则跳过
        if (newProjectConfig === currentProjectConfig) {
          return current
        }
        written = {
          ...current,
          projects: {
            ...current.projects,
            [absolutePath]: newProjectConfig,
          },
        }
        return written
      },
    )
    if (didWrite && written) {
      writeThroughGlobalConfigCache(written)
    }
  } catch (error) {
    logForDebugging(`使用锁保存配置失败：${error}`, {
      level: 'error',
    })

    // 与 saveGlobalConfig 回退相同的竞争窗口 — 拒绝将默认值写回良好的缓存配置。参见 GH #3117。
    const config = getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig)
    if (wouldLoseAuthState(config)) {
      logForDebugging(
        'saveCurrentProjectConfig 回退：重新读取的配置缺少缓存拥有的认证；拒绝写入。参见 GH #3117。',
        { level: 'error' },
      )
      logEvent('tengu_config_auth_loss_prevented', {})
      return
    }
    const currentProjectConfig =
      config.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
    const newProjectConfig = updater(currentProjectConfig)
    // 如果没有更改（返回相同引用），则跳过
    if (newProjectConfig === currentProjectConfig) {
      return
    }
    written = {
      ...config,
      projects: {
        ...config.projects,
        [absolutePath]: newProjectConfig,
      },
    }
    saveConfig(getGlobalClaudeFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
  }
}

export function isAutoUpdaterDisabled(): boolean {
  return getAutoUpdaterDisabledReason() !== null
}

/**
 * 返回是否应跳过插件自动更新。
 * 如果自动更新器被禁用且 FORCE_AUTOUPDATE_PLUGINS 环境变量未设置为 'true'，则返回 true。
 * 该环境变量允许在自动更新器被禁用时仍然强制进行插件自动更新。
 */
export function shouldSkipPluginAutoupdate(): boolean {
  return (
    isAutoUpdaterDisabled() &&
    !isEnvTruthy(process.env.FORCE_AUTOUPDATE_PLUGINS)
  )
}

export type AutoUpdaterDisabledReason =
  | { type: 'development' }
  | { type: 'env'; envVar: string }
  | { type: 'config' }

export function formatAutoUpdaterDisabledReason(
  reason: AutoUpdaterDisabledReason,
): string {
  switch (reason.type) {
    case 'development':
      return 'development build'
    case 'env':
      return `${reason.envVar} 已设置`
    case 'config':
      return 'config'
  }
}

export function getAutoUpdaterDisabledReason(): AutoUpdaterDisabledReason | null {
  if (process.env.NODE_ENV === 'development') {
    return { type: 'development' }
  }
  // 本项目默认关闭自动更新；通过 ENABLE_AUTOUPDATER=1 显式开启
  if (!isEnvTruthy(process.env.ENABLE_AUTOUPDATER)) {
    return { type: 'config' }
  }
  if (isEnvTruthy(process.env.DISABLE_AUTOUPDATER)) {
    return { type: 'env', envVar: 'DISABLE_AUTOUPDATER' }
  }
  const essentialTrafficEnvVar = getEssentialTrafficOnlyReason()
  if (essentialTrafficEnvVar) {
    return { type: 'env', envVar: essentialTrafficEnvVar }
  }
  const config = getGlobalConfig()
  if (
    config.autoUpdates === false &&
    (config.installMethod !== 'native' ||
      config.autoUpdatesProtectedForNative !== true)
  ) {
    return { type: 'config' }
  }
  return null
}

export function getOrCreateUserID(): string {
  const config = getGlobalConfig()
  if (config.userID) {
    return config.userID
  }

  const userID = randomBytes(32).toString('hex')
  saveGlobalConfig(current => ({ ...current, userID }))
  return userID
}

export function recordFirstStartTime(): void {
  const config = getGlobalConfig()
  if (!config.firstStartTime) {
    const firstStartTime = new Date().toISOString()
    saveGlobalConfig(current => ({
      ...current,
      firstStartTime: current.firstStartTime ?? firstStartTime,
    }))
  }
}

export function getMemoryPath(memoryType: MemoryType): string {
  const cwd = getOriginalCwd()

  switch (memoryType) {
    case 'User':
      return join(getClaudeConfigHomeDir(), 'CLAUDE.md')
    case 'Local':
      return join(cwd, 'CLAUDE.local.md')
    case 'Project':
      return join(cwd, 'CLAUDE.md')
    case 'Managed':
      return join(getManagedFilePath(), 'CLAUDE.md')
    case 'AutoMem':
      return getAutoMemEntrypoint()
  }
  // 仅当 feature('TEAMMEM') 为 true 时，TeamMem 才是有效的 MemoryType
  if (feature('TEAMMEM')) {
    return teamMemPaths!.getTeamMemEntrypoint()
  }
  return '' // 在 TeamMem 不在 MemoryType 中的外部构建中无法到达
}

export function getManagedClaudeRulesDir(): string {
  return join(getManagedFilePath(), '.claude', 'rules')
}

export function getUserClaudeRulesDir(): string {
  return join(getClaudeConfigHomeDir(), 'rules')
}

// 仅用于测试的导出
export const _getConfigForTesting = getConfig
export const _wouldLoseAuthStateForTesting = wouldLoseAuthState
export function _setGlobalConfigCacheForTesting(
  config: GlobalConfig | null,
): void {
  globalConfigCache.config = config
  globalConfigCache.mtime = config ? Date.now() : 0
}