/**
 * 用于在不同后端生成队友的共享工具函数。
 */

import {
  getChromeFlagOverride,
  getFlagSettingsPath,
  getInlinePlugins,
  getMainLoopModelOverride,
  getSessionBypassPermissionsMode,
} from '../../bootstrap/state.js'
import { quote } from '../bash/shellQuote.js'
import { isInBundledMode } from '../bundledMode.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { getTeammateModeFromSnapshot } from './backends/teammateModeSnapshot.js'
import { TEAMMATE_COMMAND_ENV_VAR } from './constants.js'

/**
 * 获取用于生成队友进程的命令。
 * 如果设置了 TEAMMATE_COMMAND_ENV_VAR，则使用该环境变量，否则回退到当前进程的可执行文件路径。
 */
export function getTeammateCommand(): string {
  if (process.env[TEAMMATE_COMMAND_ENV_VAR]) {
    return process.env[TEAMMATE_COMMAND_ENV_VAR]
  }
  return isInBundledMode() ? process.execPath : process.argv[1]!
}

/**
 * 构建要从当前会话传播给生成的队友的 CLI 标志。
 * 这确保队友继承父级的重要设置，如权限模式、模型选择和插件配置。
 *
 * @param options.planModeRequired - 如果为 true，则不继承绕过权限（计划模式优先）
 * @param options.permissionMode - 要传播的权限模式
 */
export function buildInheritedCliFlags(options?: {
  planModeRequired?: boolean
  permissionMode?: PermissionMode
}): string {
  return quote(buildInheritedCliArgParts(options))
}

export function buildInheritedCliArgParts(options?: {
  planModeRequired?: boolean
  permissionMode?: PermissionMode
}): string[] {
  const flags: string[] = []
  const { planModeRequired, permissionMode } = options || {}

  // 将权限模式传播给队友，但如果需要计划模式则不要传播
  // 出于安全考虑，计划模式优先于绕过权限
  if (planModeRequired) {
    // 当需要计划模式时，不继承绕过权限
  } else if (
    permissionMode === 'bypassPermissions' ||
    getSessionBypassPermissionsMode()
  ) {
    flags.push('--dangerously-skip-permissions')
  } else if (permissionMode === 'acceptEdits') {
    flags.push('--permission-mode', 'acceptEdits')
  } else if (permissionMode === 'auto') {
    // 队友继承自动模式，以便分类器也评估他们的工具调用。
    flags.push('--permission-mode', 'auto')
  }

  // 如果通过 CLI 显式设置了 --model，则传播
  const modelOverride = getMainLoopModelOverride()
  if (modelOverride) {
    flags.push('--model', modelOverride)
  }

  // 如果通过 CLI 设置了 --settings，则传播
  const settingsPath = getFlagSettingsPath()
  if (settingsPath) {
    flags.push('--settings', settingsPath)
  }

  // 为每个内联插件传播 --plugin-dir
  const inlinePlugins = getInlinePlugins()
  for (const pluginDir of inlinePlugins) {
    flags.push('--plugin-dir', pluginDir)
  }

  // 传播 --teammate-mode，以便 tmux 队友使用与领导者相同的模式
  const sessionMode = getTeammateModeFromSnapshot()
  flags.push('--teammate-mode', sessionMode)

  // 如果在 CLI 上显式设置了 --chrome / --no-chrome，则传播
  const chromeFlagOverride = getChromeFlagOverride()
  if (chromeFlagOverride === true) {
    flags.push('--chrome')
  } else if (chromeFlagOverride === false) {
    flags.push('--no-chrome')
  }

  return flags
}

/**
 * 必须显式转发给 tmux 生成的队友的环境变量。
 * Tmux 可能会启动一个新的登录 shell，它不会继承父级的环境变量，
 * 因此我们将当前进程中已设置的任何相关环境变量都转发过去。
 */
const TEAMMATE_ENV_VARS = [
  // API 提供者选择 — 如果没有这些，队友将默认使用 firstParty
  // 并将请求发送到错误的端点（GitHub issue #23561）
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  // 自定义 API 端点
  'ANTHROPIC_BASE_URL',
  // 配置目录覆盖
  'CLAUDE_CONFIG_DIR',
  // CCR 标记 — 队友需要此标记以使用 CCR 感知的代码路径。认证会通过
  // /home/claude/.claude/remote/.oauth_token 自行找到方式，无论是否设置该标记；
  // FD 环境变量没有帮助（管道 FD 不能跨越 tmux）。
  'CLAUDE_CODE_REMOTE',
  // 自动内存门控（memdir/paths.ts）检查 REMOTE && !MEMORY_DIR，以在临时的 CCR 文件系统上禁用内存。
  // 仅转发 REMOTE 会导致队友在父级启用内存时关闭内存。
  'CLAUDE_CODE_REMOTE_MEMORY_DIR',
  // 上游代理 — 父级的 MITM 中继可从队友（同一容器网络）访问。
  // 转发代理变量，以便队友通过中继路由客户配置的上游流量以注入凭据。
  // 没有这些变量，队友将完全绕过代理。
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
] as const

/**
 * 为队友生成命令构建 `env KEY=VALUE ...` 字符串。
 * 始终包含 CLAUDECODE=1 和 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1，
 * 以及当前进程中已设置的任何提供者/配置环境变量。
 */
export function buildInheritedEnvVars(): string {
  return getInheritedEnvVarAssignments()
    .map(([key, value]) => `${key}=${quote([value])}`)
    .join(' ')
}

export function getInheritedEnvVarAssignments(): Array<[string, string]> {
  const envVars: Array<[string, string]> = [
    ['CLAUDECODE', '1'],
    ['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', '1'],
  ]

  for (const key of TEAMMATE_ENV_VARS) {
    const value = process.env[key]
    if (value !== undefined && value !== '') {
      envVars.push([key, value])
    }
  }

  return envVars
}