// biome-ignore-all assist/source/organizeImports: 仅限 ANTS 内部的导入标记不得重新排序
/**
 * 为分析系统共享的事件元数据增强
 *
 * 此模块提供了一个单一事实来源，用于收集和格式化所有分析系统（Datadog、第一方）的事件元数据。
 */

import { extname } from 'path'
import memoize from 'lodash-es/memoize.js'
import { env, getHostPlatformForAnalytics } from '../../utils/env.js'
import { envDynamic } from '../../utils/envDynamic.js'
import { getModelBetas } from '../../utils/betas.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import {
  getSessionId,
  getIsInteractive,
  getKairosActive,
  getClientType,
  getParentSessionId as getParentSessionIdFromState,
} from '../../bootstrap/state.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isOfficialMcpUrl } from '../mcp/officialRegistry.js'
import { isClaudeAISubscriber, getSubscriptionType } from '../../utils/auth.js'
import { getRepoRemoteHash } from '../../utils/git.js'
import {
  getWslVersion,
  getLinuxDistroInfo,
  detectVcs,
} from '../../utils/platform.js'
import type { CoreUserData } from 'src/utils/user.js'
import { getAgentContext } from '../../utils/agentContext.js'
import type { EnvironmentMetadata } from '../../types/generated/events_mono/claude_code/v1/claude_code_internal_event.js'
import type { PublicApiAuth } from '../../types/generated/events_mono/common/v1/auth.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getAgentId,
  getParentSessionId as getTeammateParentSessionId,
  getTeamName,
  isTeammate,
} from '../../utils/teammate.js'
import { feature } from 'bun:bundle'

/**
 * 用于验证分析元数据不包含敏感数据的标记类型
 *
 * 此类型强制显式验证被记录的字符串值不包含代码片段、文件路径或其他敏感信息。
 *
 * 元数据预期是可 JSON 序列化的。
 *
 * 用法：`myString as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`
 *
 * 该类型是 `never`，意味着它永远不能实际持有值 — 这是有意的，
 * 仅用于类型转换以记录开发者的意图。
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never

/**
 * 为分析日志清理工具名称，避免暴露 PII。
 *
 * MCP 工具名称遵循 `mcp__<server>__<tool>` 格式，可能暴露用户特定的服务器配置，
 * 这被视为中等 PII。此函数会脱敏 MCP 工具名称，同时保留内置工具名称
 * （Bash、Read、Write 等），这些可以安全记录。
 *
 * @param toolName - 要清理的工具名称
 * @returns 内置工具返回原始名称，MCP 工具返回 'mcp_tool'
 */
export function sanitizeToolNameForAnalytics(
  toolName: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  if (toolName.startsWith('mcp__')) {
    return 'mcp_tool' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  }
  return toolName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * 检查是否为 OTLP 事件启用了详细的工具名称日志记录。
 * 启用时，会记录 MCP 服务器/工具名称和技能名称。
 * 默认关闭以保护 PII（用户特定的服务器配置）。
 *
 * 通过 OTEL_LOG_TOOL_DETAILS=1 启用
 */
export function isToolDetailsLoggingEnabled(): boolean {
  return isEnvTruthy(process.env.OTEL_LOG_TOOL_DETAILS)
}

/**
 * 检查是否为分析事件启用了详细的工具名称日志记录（MCP 服务器/工具名称）。
 *
 * 根据 go/taxonomy，MCP 名称属于中等 PII。我们会在以下情况记录它们：
 * - Cowork（entrypoint=local-agent）— 没有 ZDR 概念，记录所有 MCP
 * - claude.ai 代理的连接器 — 始终是官方的（来自 claude.ai 的列表）
 * - URL 匹配官方 MCP 注册表的服务器 — 通过 `claude mcp add` 添加的目录连接器，不是客户特定的配置
 *
 * 自定义/用户配置的 MCP 保持脱敏（toolName='mcp_tool'）。
 */
export function isAnalyticsToolDetailsLoggingEnabled(
  mcpServerType: string | undefined,
  mcpServerBaseUrl: string | undefined,
): boolean {
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'local-agent') {
    return true
  }
  if (mcpServerType === 'claudeai-proxy') {
    return true
  }
  if (mcpServerBaseUrl && isOfficialMcpUrl(mcpServerBaseUrl)) {
    return true
  }
  return false
}

/**
 * 内置的第一方 MCP 服务器，其名称是固定的保留字符串，不是用户配置的 —
 * 因此记录它们不是 PII。除了 isAnalyticsToolDetailsLoggingEnabled 的传输/URL 门控外还会检查此项，
 * 否则 stdio 内置服务器会无法通过该门控。
 *
 * 通过功能门控，当功能关闭时集合为空：名称保留（main.tsx、config.ts addMcpServer）本身受功能门控，
 * 因此在没有该功能的构建中，用户配置的 'computer-use' 是可能的。
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const BUILTIN_MCP_SERVER_NAMES: ReadonlySet<string> = new Set(
  feature('CHICAGO_MCP')
    ? [
        (
          require('../../utils/computerUse/common.js') as typeof import('../../utils/computerUse/common.js')
        ).COMPUTER_USE_MCP_SERVER_NAME,
      ]
    : [],
)
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 用于 logEvent 负载的可扩展辅助函数 — 如果门控通过，返回 {mcpServerName, mcpToolName}，否则返回空对象。
 * 合并了每个 tengu_tool_use_* 调用点处相同的 IIFE 模式。
 */
export function mcpToolDetailsForAnalytics(
  toolName: string,
  mcpServerType: string | undefined,
  mcpServerBaseUrl: string | undefined,
): {
  mcpServerName?: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  mcpToolName?: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
} {
  const details = extractMcpToolDetails(toolName)
  if (!details) {
    return {}
  }
  if (
    !BUILTIN_MCP_SERVER_NAMES.has(details.serverName) &&
    !isAnalyticsToolDetailsLoggingEnabled(mcpServerType, mcpServerBaseUrl)
  ) {
    return {}
  }
  return {
    mcpServerName: details.serverName,
    mcpToolName: details.mcpToolName,
  }
}

/**
 * 从完整的 MCP 工具名称中提取 MCP 服务器和工具名称。
 * MCP 工具名称遵循格式：mcp__<server>__<tool>
 *
 * @param toolName - 完整的工具名称（例如 'mcp__slack__read_channel'）
 * @returns 包含 serverName 和 toolName 的对象，如果不是 MCP 工具则返回 undefined
 */
export function extractMcpToolDetails(toolName: string):
  | {
      serverName: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      mcpToolName: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    }
  | undefined {
  if (!toolName.startsWith('mcp__')) {
    return undefined
  }

  // 格式：mcp__<server>__<tool>
  const parts = toolName.split('__')
  if (parts.length < 3) {
    return undefined
  }

  const serverName = parts[1]
  // 工具名称可能包含 __，因此重新连接剩余部分
  const mcpToolName = parts.slice(2).join('__')

  if (!serverName || !mcpToolName) {
    return undefined
  }

  return {
    serverName:
      serverName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    mcpToolName:
      mcpToolName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  }
}

/**
 * 从 Skill 工具的输入中提取技能名称。
 *
 * @param toolName - 工具名称（应为 'Skill'）
 * @param input - 包含技能名称的工具输入
 * @returns 如果这是 Skill 工具调用，则返回技能名称，否则返回 undefined
 */
export function extractSkillName(
  toolName: string,
  input: unknown,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS | undefined {
  if (toolName !== 'Skill') {
    return undefined
  }

  if (
    typeof input === 'object' &&
    input !== null &&
    'skill' in input &&
    typeof (input as { skill: unknown }).skill === 'string'
  ) {
    return (input as { skill: string })
      .skill as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  }

  return undefined
}

const TOOL_INPUT_STRING_TRUNCATE_AT = 512
const TOOL_INPUT_STRING_TRUNCATE_TO = 128
const TOOL_INPUT_MAX_JSON_CHARS = 4 * 1024
const TOOL_INPUT_MAX_COLLECTION_ITEMS = 20
const TOOL_INPUT_MAX_DEPTH = 2

function truncateToolInputValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    if (value.length > TOOL_INPUT_STRING_TRUNCATE_AT) {
      return `${value.slice(0, TOOL_INPUT_STRING_TRUNCATE_TO)}…[${value.length} 字符]`
    }
    return value
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null ||
    value === undefined
  ) {
    return value
  }
  if (depth >= TOOL_INPUT_MAX_DEPTH) {
    return '<嵌套>'
  }
  if (Array.isArray(value)) {
    const mapped = value
      .slice(0, TOOL_INPUT_MAX_COLLECTION_ITEMS)
      .map(v => truncateToolInputValue(v, depth + 1))
    if (value.length > TOOL_INPUT_MAX_COLLECTION_ITEMS) {
      mapped.push(`…[${value.length} 项]`)
    }
    return mapped
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // 跳过内部标记键（例如 _simulatedSedEdit），避免它们泄漏到遥测中
      .filter(([k]) => !k.startsWith('_'))
    const mapped = entries
      .slice(0, TOOL_INPUT_MAX_COLLECTION_ITEMS)
      .map(([k, v]) => [k, truncateToolInputValue(v, depth + 1)])
    if (entries.length > TOOL_INPUT_MAX_COLLECTION_ITEMS) {
      mapped.push(['…', `${entries.length} 个键`])
    }
    return Object.fromEntries(mapped)
  }
  return String(value)
}

/**
 * 为 OTel tool_result 事件序列化工具的输入参数。
 * 截断长字符串和深层嵌套，以保持输出有界，同时保留对取证有用的字段，如文件路径、URL 和 MCP 参数。
 * 当 OTEL_LOG_TOOL_DETAILS 未启用时返回 undefined。
 */
export function extractToolInputForTelemetry(
  input: unknown,
): string | undefined {
  if (!isToolDetailsLoggingEnabled()) {
    return undefined
  }
  const truncated = truncateToolInputValue(input)
  let json = jsonStringify(truncated)
  if (json.length > TOOL_INPUT_MAX_JSON_CHARS) {
    json = json.slice(0, TOOL_INPUT_MAX_JSON_CHARS) + '…[已截断]'
  }
  return json
}

/**
 * 要记录的文件扩展名的最大长度。
 * 比这更长的扩展名被认为可能是敏感的
 * （例如基于哈希的文件名，如“key-hash-abcd-123-456”），
 * 将被替换为 'other'。
 */
const MAX_FILE_EXTENSION_LENGTH = 10

/**
 * 提取并清理用于分析日志的文件扩展名。
 *
 * 使用 Node 的 path.extname 进行可靠的跨平台扩展名提取。
 * 对于超过 MAX_FILE_EXTENSION_LENGTH 的扩展名返回 'other'，以避免记录潜在敏感数据（如基于哈希的文件名）。
 *
 * @param filePath - 要提取扩展名的文件路径
 * @returns 清理后的扩展名，长扩展名返回 'other'，如果没有扩展名则返回 undefined
 */
export function getFileExtensionForAnalytics(
  filePath: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS | undefined {
  const ext = extname(filePath).toLowerCase()
  if (!ext || ext === '.') {
    return undefined
  }

  const extension = ext.slice(1) // 移除前导点
  if (extension.length > MAX_FILE_EXTENSION_LENGTH) {
    return 'other' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  }

  return extension as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/** 我们从中提取文件扩展名的允许命令列表。 */
const FILE_COMMANDS = new Set([
  'rm',
  'mv',
  'cp',
  'touch',
  'mkdir',
  'chmod',
  'chown',
  'cat',
  'head',
  'tail',
  'sort',
  'stat',
  'diff',
  'wc',
  'grep',
  'rg',
  'sed',
])

/** 用于拆分 bash 命令中的复合运算符（&&、||、;、|）的正则表达式。 */
const COMPOUND_OPERATOR_REGEX = /\s*(?:&&|\|\||[;|])\s*/

/** 用于按空白字符拆分的正则表达式。 */
const WHITESPACE_REGEX = /\s+/

/**
 * 从 bash 命令中提取文件扩展名用于分析。
 * 尽力而为：按运算符和空白字符分割，从允许命令的非标志参数中提取扩展名。
 * 不需要复杂的 shell 解析，因为 grep 模式和 sed 脚本很少看起来像文件扩展名。
 */
export function getFileExtensionsFromBashCommand(
  command: string,
  simulatedSedEditFilePath?: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS | undefined {
  if (!command.includes('.') && !simulatedSedEditFilePath) return undefined

  let result: string | undefined
  const seen = new Set<string>()

  if (simulatedSedEditFilePath) {
    const ext = getFileExtensionForAnalytics(simulatedSedEditFilePath)
    if (ext) {
      seen.add(ext)
      result = ext
    }
  }

  for (const subcmd of command.split(COMPOUND_OPERATOR_REGEX)) {
    if (!subcmd) continue
    const tokens = subcmd.split(WHITESPACE_REGEX)
    if (tokens.length < 2) continue

    const firstToken = tokens[0]!
    const slashIdx = firstToken.lastIndexOf('/')
    const baseCmd = slashIdx >= 0 ? firstToken.slice(slashIdx + 1) : firstToken
    if (!FILE_COMMANDS.has(baseCmd)) continue

    for (let i = 1; i < tokens.length; i++) {
      const arg = tokens[i]!
      if (arg.charCodeAt(0) === 45 /* - */) continue
      const ext = getFileExtensionForAnalytics(arg)
      if (ext && !seen.has(ext)) {
        seen.add(ext)
        result = result ? result + ',' + ext : ext
      }
    }
  }

  if (!result) return undefined
  return result as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * 环境上下文元数据
 */
export type EnvContext = {
  platform: string
  platformRaw: string
  arch: string
  nodeVersion: string
  terminal: string | null
  packageManagers: string
  runtimes: string
  isRunningWithBun: boolean
  isCi: boolean
  isClaubbit: boolean
  isClaudeCodeRemote: boolean
  isLocalAgentMode: boolean
  isConductor: boolean
  remoteEnvironmentType?: string
  coworkerType?: string
  claudeCodeContainerId?: string
  claudeCodeRemoteSessionId?: string
  tags?: string
  isGithubAction: boolean
  isClaudeCodeAction: boolean
  isClaudeAiAuth: boolean
  version: string
  versionBase?: string
  buildTime: string
  deploymentEnvironment: string
  githubEventName?: string
  githubActionsRunnerEnvironment?: string
  githubActionsRunnerOs?: string
  githubActionRef?: string
  wslVersion?: string
  linuxDistroId?: string
  linuxDistroVersion?: string
  linuxKernel?: string
  vcs?: string
}

/**
 * 包含在所有分析事件中的进程指标。
 */
export type ProcessMetrics = {
  uptime: number
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
  arrayBuffers: number
  constrainedMemory: number | undefined
  cpuUsage: NodeJS.CpuUsage
  cpuPercent: number | undefined
}

/**
 * 跨所有分析系统共享的核心事件元数据
 */
export type EventMetadata = {
  model: string
  sessionId: string
  userType: string
  betas?: string
  envContext: EnvContext
  entrypoint?: string
  agentSdkVersion?: string
  isInteractive: string
  clientType: string
  processMetrics?: ProcessMetrics
  sweBenchRunId: string
  sweBenchInstanceId: string
  sweBenchTaskId: string
  // 用于分析归因的 Swarm/团队代理标识
  agentId?: string // CLAUDE_CODE_AGENT_ID（格式：agentName@teamName）或子代理 UUID
  parentSessionId?: string // CLAUDE_CODE_PARENT_SESSION_ID（团队负责人的会话）
  agentType?: 'teammate' | 'subagent' | 'standalone' // 区分群组成员、Agent 工具子代理和独立代理
  teamName?: string // 群组代理的团队名称（来自环境变量或 AsyncLocalStorage）
  subscriptionType?: string // OAuth 订阅层级（max, pro, enterprise, team）
  rh?: string // 仓库远程 URL 的哈希值（SHA256 的前 16 个字符），用于与服务端数据关联
  kairosActive?: true // KAIROS 助手模式激活（仅限 ant 内部；在 main.tsx 中门控检查后设置）
  skillMode?: 'discovery' | 'coach' | 'discovery_and_coach' // 哪些技能展示机制被门控（仅限 ant 内部；用于 BQ 会话分段）
  observerMode?: 'backseat' | 'skillcoach' | 'both' // 哪些观察者分类器被门控（仅限 ant 内部；用于 tengu_backseat_* 事件的 BQ 队列拆分）
}

/**
 * 丰富事件元数据的选项
 */
export type EnrichMetadataOptions = {
  // 使用的模型，如果未提供则回退到 getMainLoopModel()
  model?: unknown
  // 显式的 betas 字符串（已连接）
  betas?: unknown
  // 要包含的额外元数据（可选）
  additionalMetadata?: Record<string, unknown>
}

/**
 * 获取用于分析的代理标识。
 * 优先级：AsyncLocalStorage 上下文（子代理）> 环境变量（群组成员）
 */
function getAgentIdentification(): {
  agentId?: string
  parentSessionId?: string
  agentType?: 'teammate' | 'subagent' | 'standalone'
  teamName?: string
} {
  // 首先检查 AsyncLocalStorage（用于在同一进程中运行的子代理）
  const agentContext = getAgentContext()
  if (agentContext) {
    const result: ReturnType<typeof getAgentIdentification> = {
      agentId: agentContext.agentId,
      parentSessionId: agentContext.parentSessionId,
      agentType: agentContext.agentType,
    }
    if (agentContext.agentType === 'teammate') {
      result.teamName = agentContext.teamName
    }
    return result
  }

  // 回退到群组辅助函数（用于群组代理）
  const agentId = getAgentId()
  const parentSessionId = getTeammateParentSessionId()
  const teamName = getTeamName()
  const isSwarmAgent = isTeammate()
  // 对于独立代理（有代理 ID 但不是团队成员），将 agentType 设置为 'standalone'
  const agentType = isSwarmAgent
    ? ('teammate' as const)
    : agentId
      ? ('standalone' as const)
      : undefined
  if (agentId || agentType || parentSessionId || teamName) {
    return {
      ...(agentId ? { agentId } : {}),
      ...(agentType ? { agentType } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(teamName ? { teamName } : {}),
    }
  }

  // 检查引导状态的父会话 ID（例如计划模式 -> 实现）
  const stateParentSessionId = getParentSessionIdFromState()
  if (stateParentSessionId) {
    return { parentSessionId: stateParentSessionId }
  }

  return {}
}

/**
 * 从完整版本字符串中提取基础版本。“2.0.36-dev.20251107.t174150.sha2709699” → “2.0.36-dev”
 */
const getVersionBase = memoize((): string | undefined => {
  const match = MACRO.VERSION.match(/^\d+\.\d+\.\d+(?:-[a-z]+)?/)
  return match ? match[0] : undefined
})

/**
 * 构建环境上下文对象
 */
const buildEnvContext = memoize(async (): Promise<EnvContext> => {
  const [packageManagers, runtimes, linuxDistroInfo, vcs] = await Promise.all([
    env.getPackageManagers(),
    env.getRuntimes(),
    getLinuxDistroInfo(),
    detectVcs(),
  ])

  return {
    platform: getHostPlatformForAnalytics(),
    // 原始的 process.platform，以便 freebsd/openbsd/aix/sunos 在 BQ 中可见。
    // getHostPlatformForAnalytics() 将这些归类为 'linux'；这里我们需要真相。
    // CLAUDE_CODE_HOST_PLATFORM 仍然覆盖容器/远程环境。
    platformRaw: process.env.CLAUDE_CODE_HOST_PLATFORM || process.platform,
    arch: env.arch,
    nodeVersion: env.nodeVersion,
    terminal: envDynamic.terminal,
    packageManagers: packageManagers.join(','),
    runtimes: runtimes.join(','),
    isRunningWithBun: env.isRunningWithBun(),
    isCi: isEnvTruthy(process.env.CI),
    isClaubbit: isEnvTruthy(process.env.CLAUBBIT),
    isClaudeCodeRemote: isEnvTruthy(process.env.CLAUDE_CODE_REMOTE),
    isLocalAgentMode: process.env.CLAUDE_CODE_ENTRYPOINT === 'local-agent',
    isConductor: env.isConductor(),
    ...(process.env.CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE && {
      remoteEnvironmentType: process.env.CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE,
    }),
    // 通过功能门控防止在外部构建中泄漏“coworkerType”字符串
    ...(feature('COWORKER_TYPE_TELEMETRY')
      ? process.env.CLAUDE_CODE_COWORKER_TYPE
        ? { coworkerType: process.env.CLAUDE_CODE_COWORKER_TYPE }
        : {}
      : {}),
    ...(process.env.CLAUDE_CODE_CONTAINER_ID && {
      claudeCodeContainerId: process.env.CLAUDE_CODE_CONTAINER_ID,
    }),
    ...(process.env.CLAUDE_CODE_REMOTE_SESSION_ID && {
      claudeCodeRemoteSessionId: process.env.CLAUDE_CODE_REMOTE_SESSION_ID,
    }),
    ...(process.env.CLAUDE_CODE_TAGS && {
      tags: process.env.CLAUDE_CODE_TAGS,
    }),
    isGithubAction: isEnvTruthy(process.env.GITHUB_ACTIONS),
    isClaudeCodeAction: isEnvTruthy(process.env.CLAUDE_CODE_ACTION),
    isClaudeAiAuth: isClaudeAISubscriber(),
    version: MACRO.VERSION,
    versionBase: getVersionBase(),
    buildTime: MACRO.BUILD_TIME,
    deploymentEnvironment: env.detectDeploymentEnvironment(),
    ...(isEnvTruthy(process.env.GITHUB_ACTIONS) && {
      githubEventName: process.env.GITHUB_EVENT_NAME,
      githubActionsRunnerEnvironment: process.env.RUNNER_ENVIRONMENT,
      githubActionsRunnerOs: process.env.RUNNER_OS,
      githubActionRef: process.env.GITHUB_ACTION_PATH?.includes(
        'claude-code-action/',
      )
        ? process.env.GITHUB_ACTION_PATH.split('claude-code-action/')[1]
        : undefined,
    }),
    ...(getWslVersion() && { wslVersion: getWslVersion() }),
    ...(linuxDistroInfo ?? {}),
    ...(vcs.length > 0 ? { vcs: vcs.join(',') } : {}),
  }
})

// --
// CPU% 增量跟踪 — 本质上是进程全局的，与 datadog.ts 中的 logBatch/flushTimer 模式相同
let prevCpuUsage: NodeJS.CpuUsage | null = null
let prevWallTimeMs: number | null = null

/**
 * 为所有用户构建进程指标对象。
 */
function buildProcessMetrics(): ProcessMetrics | undefined {
  try {
    const mem = process.memoryUsage()
    const cpu = process.cpuUsage()
    const now = Date.now()

    let cpuPercent: number | undefined
    if (prevCpuUsage && prevWallTimeMs) {
      const wallDeltaMs = now - prevWallTimeMs
      if (wallDeltaMs > 0) {
        const userDeltaUs = cpu.user - prevCpuUsage.user
        const systemDeltaUs = cpu.system - prevCpuUsage.system
        cpuPercent =
          ((userDeltaUs + systemDeltaUs) / (wallDeltaMs * 1000)) * 100
      }
    }
    prevCpuUsage = cpu
    prevWallTimeMs = now

    return {
      uptime: process.uptime(),
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      constrainedMemory: process.constrainedMemory(),
      cpuUsage: cpu,
      cpuPercent,
    }
  } catch {
    return undefined
  }
}

/**
 * 获取跨所有分析系统共享的核心事件元数据。
 *
 * 此函数收集环境、运行时和上下文信息，这些信息应包含在所有分析事件中。
 *
 * @param options - 配置选项
 * @returns 解析为丰富元数据对象的 Promise
 */
export async function getEventMetadata(
  options: EnrichMetadataOptions = {},
): Promise<EventMetadata> {
  const model = options.model ? String(options.model) : getMainLoopModel()
  const betas =
    typeof options.betas === 'string'
      ? options.betas
      : getModelBetas(model).join(',')
  const [envContext, repoRemoteHash] = await Promise.all([
    buildEnvContext(),
    getRepoRemoteHash(),
  ])
  const processMetrics = buildProcessMetrics()

  const metadata: EventMetadata = {
    model,
    sessionId: getSessionId(),
    userType: process.env.USER_TYPE || '',
    ...(betas.length > 0 ? { betas: betas } : {}),
    envContext,
    ...(process.env.CLAUDE_CODE_ENTRYPOINT && {
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
    }),
    ...(process.env.CLAUDE_AGENT_SDK_VERSION && {
      agentSdkVersion: process.env.CLAUDE_AGENT_SDK_VERSION,
    }),
    isInteractive: String(getIsInteractive()),
    clientType: getClientType(),
    ...(processMetrics && { processMetrics }),
    sweBenchRunId: process.env.SWE_BENCH_RUN_ID || '',
    sweBenchInstanceId: process.env.SWE_BENCH_INSTANCE_ID || '',
    sweBenchTaskId: process.env.SWE_BENCH_TASK_ID || '',
    // Swarm/团队代理标识
    // 优先级：AsyncLocalStorage 上下文（子代理）> 环境变量（群组成员）
    ...getAgentIdentification(),
    // 用于按层 DAU 分析的订阅层级
    ...(getSubscriptionType() && {
      subscriptionType: getSubscriptionType()!,
    }),
    // 助手模式标签 — 位于记忆化的 buildEnvContext() 之外，因为
    // setKairosActive() 在 main.tsx:~1648 中运行，可能在第一个事件已经触发
    // 并记忆化环境之后。改为按事件新鲜读取。
    ...(feature('KAIROS') && getKairosActive()
      ? { kairosActive: true as const }
      : {}),
    // 用于与服务端仓库捆绑数据关联的仓库远程哈希
    ...(repoRemoteHash && { rh: repoRemoteHash }),
  }

  return metadata
}

/**
 * 用于第一方事件日志记录的核心事件元数据（snake_case 格式）。
 */
export type FirstPartyEventLoggingCoreMetadata = {
  session_id: string
  model: string
  user_type: string
  betas?: string
  entrypoint?: string
  agent_sdk_version?: string
  is_interactive: boolean
  client_type: string
  swe_bench_run_id?: string
  swe_bench_instance_id?: string
  swe_bench_task_id?: string
  // Swarm/团队代理标识
  agent_id?: string
  parent_session_id?: string
  agent_type?: 'teammate' | 'subagent' | 'standalone'
  team_name?: string
}

/**
 * 用于第一方事件的完整事件日志记录元数据格式。
 */
export type FirstPartyEventLoggingMetadata = {
  env: EnvironmentMetadata
  process?: string
  // auth 是 ClaudeCodeInternalEvent 上的顶级字段（proto PublicApiAuth）。
  // account_id 有意省略 — 仅客户端填充 UUID 字段。
  auth?: PublicApiAuth
  // core 字段对应于 ClaudeCodeInternalEvent 的顶级。
  // 它们直接导出到 BigQuery 表中各自的列
  core: FirstPartyEventLoggingCoreMetadata
  // additional 字段填充在 ClaudeCodeInternalEvent proto 的 additional_metadata 字段中。
  // 包括但不限于因事件类型而异的信息。
  additional: Record<string, unknown>
}

/**
 * 将元数据转换为第一方事件日志记录格式（snake_case 字段）。
 *
 * /api/event_logging/batch 端点期望环境和核心元数据使用 snake_case 字段名。
 *
 * @param metadata - 核心事件元数据
 * @param userMetadata - 用户元数据
 * @param additionalMetadata - 要包含的额外元数据
 * @returns 为第一方事件日志记录格式化的元数据
 */
export function to1PEventFormat(
  metadata: EventMetadata,
  userMetadata: CoreUserData,
  additionalMetadata: Record<string, unknown> = {},
): FirstPartyEventLoggingMetadata {
  const {
    envContext,
    processMetrics,
    rh,
    kairosActive,
    skillMode,
    observerMode,
    ...coreFields
  } = metadata

  // 将 envContext 转换为 snake_case。
  // 重要提示：env 的类型化为 proto 生成的 EnvironmentMetadata，以便
  // 在此处添加一个 proto 未定义的字段会导致编译错误。生成的 toJSON() 序列化器会静默丢弃未知键 —
  // 手写的平行类型之前让 #11318、#13924、#19448 和 coworker_type 都发送了从未到达 BQ 的字段。
  // 添加字段？首先更新 monorepo proto（go/cc-logging）：
  //   event_schemas/.../claude_code/v1/claude_code_internal_event.proto
  // 然后在此处运行 `bun run generate:proto`。
  const env: EnvironmentMetadata = {
    platform: envContext.platform,
    platform_raw: envContext.platformRaw,
    arch: envContext.arch,
    node_version: envContext.nodeVersion,
    terminal: envContext.terminal || 'unknown',
    package_managers: envContext.packageManagers,
    runtimes: envContext.runtimes,
    is_running_with_bun: envContext.isRunningWithBun,
    is_ci: envContext.isCi,
    is_claubbit: envContext.isClaubbit,
    is_claude_code_remote: envContext.isClaudeCodeRemote,
    is_local_agent_mode: envContext.isLocalAgentMode,
    is_conductor: envContext.isConductor,
    is_github_action: envContext.isGithubAction,
    is_claude_code_action: envContext.isClaudeCodeAction,
    is_claude_ai_auth: envContext.isClaudeAiAuth,
    version: envContext.version,
    build_time: envContext.buildTime,
    deployment_environment: envContext.deploymentEnvironment,
  }

  // 添加可选的环境字段
  if (envContext.remoteEnvironmentType) {
    env.remote_environment_type = envContext.remoteEnvironmentType
  }
  if (feature('COWORKER_TYPE_TELEMETRY') && envContext.coworkerType) {
    env.coworker_type = envContext.coworkerType
  }
  if (envContext.claudeCodeContainerId) {
    env.claude_code_container_id = envContext.claudeCodeContainerId
  }
  if (envContext.claudeCodeRemoteSessionId) {
    env.claude_code_remote_session_id = envContext.claudeCodeRemoteSessionId
  }
  if (envContext.tags) {
    env.tags = envContext.tags
      .split(',')
      .map(t => t.trim())
      .filter(Boolean)
  }
  if (envContext.githubEventName) {
    env.github_event_name = envContext.githubEventName
  }
  if (envContext.githubActionsRunnerEnvironment) {
    env.github_actions_runner_environment =
      envContext.githubActionsRunnerEnvironment
  }
  if (envContext.githubActionsRunnerOs) {
    env.github_actions_runner_os = envContext.githubActionsRunnerOs
  }
  if (envContext.githubActionRef) {
    env.github_action_ref = envContext.githubActionRef
  }
  if (envContext.wslVersion) {
    env.wsl_version = envContext.wslVersion
  }
  if (envContext.linuxDistroId) {
    env.linux_distro_id = envContext.linuxDistroId
  }
  if (envContext.linuxDistroVersion) {
    env.linux_distro_version = envContext.linuxDistroVersion
  }
  if (envContext.linuxKernel) {
    env.linux_kernel = envContext.linuxKernel
  }
  if (envContext.vcs) {
    env.vcs = envContext.vcs
  }
  if (envContext.versionBase) {
    env.version_base = envContext.versionBase
  }

  // 将核心字段转换为 snake_case
  const core: FirstPartyEventLoggingCoreMetadata = {
    session_id: coreFields.sessionId,
    model: coreFields.model,
    user_type: coreFields.userType,
    is_interactive: coreFields.isInteractive === 'true',
    client_type: coreFields.clientType,
  }

  // 添加其他核心字段
  if (coreFields.betas) {
    core.betas = coreFields.betas
  }
  if (coreFields.entrypoint) {
    core.entrypoint = coreFields.entrypoint
  }
  if (coreFields.agentSdkVersion) {
    core.agent_sdk_version = coreFields.agentSdkVersion
  }
  if (coreFields.sweBenchRunId) {
    core.swe_bench_run_id = coreFields.sweBenchRunId
  }
  if (coreFields.sweBenchInstanceId) {
    core.swe_bench_instance_id = coreFields.sweBenchInstanceId
  }
  if (coreFields.sweBenchTaskId) {
    core.swe_bench_task_id = coreFields.sweBenchTaskId
  }
  // Swarm/团队代理标识
  if (coreFields.agentId) {
    core.agent_id = coreFields.agentId
  }
  if (coreFields.parentSessionId) {
    core.parent_session_id = coreFields.parentSessionId
  }
  if (coreFields.agentType) {
    core.agent_type = coreFields.agentType
  }
  if (coreFields.teamName) {
    core.team_name = coreFields.teamName
  }

  // 将 userMetadata 映射到输出字段。
  // 基于 src/utils/user.ts getUser()，但字段在 ClaudeCodeInternalEvent 的其他部分中已被去重。
  // 将 camelCase GitHubActionsMetadata 转换为 snake_case 用于第一方 API
  // 注意：github_actions_metadata 放在 env（EnvironmentMetadata）内部，
  // 而不是 ClaudeCodeInternalEvent 的顶级
  if (userMetadata.githubActionsMetadata) {
    const ghMeta = userMetadata.githubActionsMetadata
    env.github_actions_metadata = {
      actor_id: ghMeta.actorId,
      repository_id: ghMeta.repositoryId,
      repository_owner_id: ghMeta.repositoryOwnerId,
    }
  }

  let auth: PublicApiAuth | undefined
  if (userMetadata.accountUuid || userMetadata.organizationUuid) {
    auth = {
      account_uuid: userMetadata.accountUuid,
      organization_uuid: userMetadata.organizationUuid,
    }
  }

  return {
    env,
    ...(processMetrics && {
      process: Buffer.from(jsonStringify(processMetrics)).toString('base64'),
    }),
    ...(auth && { auth }),
    core,
    additional: {
      ...(rh && { rh }),
      ...(kairosActive && { is_assistant_mode: true }),
      ...(skillMode && { skill_mode: skillMode }),
      ...(observerMode && { observer_mode: observerMode }),
      ...additionalMetadata,
    },
  }
}