import { feature } from 'bun:bundle'
import { relative } from 'path'
import {
  getOriginalCwd,
  handleAutoModeTransition,
  handlePlanModeTransition,
  setHasExitedPlanMode,
  setNeedsAutoModeExitAttachment,
} from '../../bootstrap/state.js'
import type {
  ToolPermissionContext,
  ToolPermissionRulesBySource,
} from '../../Tool.js'
import { getCwd } from '../cwd.js'
import { isEnvTruthy } from '../envUtils.js'
import type { SettingSource } from '../settings/constants.js'
import { SETTING_SOURCES } from '../settings/constants.js'
import {
  getSettings_DEPRECATED,
  getSettingsFilePathForSource,
  getUseAutoModeDuringPlan,
  hasAutoModeOptIn,
} from '../settings/settings.js'
import {
  type PermissionMode,
  permissionModeFromString,
} from './PermissionMode.js'
import { applyPermissionRulesToPermissionContext } from './permissions.js'
import { loadAllPermissionRulesFromDisk } from './permissionsLoader.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('./autoModeState.js') as typeof import('./autoModeState.js'))
  : null

import { resolve } from 'path'
import {
  checkSecurityRestrictionGate,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE,
  getDynamicConfig_BLOCKS_ON_INIT,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from 'src/services/analytics/growthbook.js'
import {
  addDirHelpMessage,
  validateDirectoryForWorkspace,
} from '../../commands/add-dir/validation.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { AGENT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/AgentTool/constants.js'
import { BASH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BashTool/toolName.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { POWERSHELL_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/PowerShellTool/toolName.js'
import { getToolsForDefaultPreset, parseToolPreset } from '../../tools.js'
import {
  getFsImplementation,
  safeResolvePath,
} from '../../utils/fsOperations.js'
import { modelSupportsAutoMode } from '../betas.js'
import { logForDebugging } from '../debug.js'
import { gracefulShutdown } from '../gracefulShutdown.js'
import { getMainLoopModel } from '../model/model.js'
import {
  CROSS_PLATFORM_CODE_EXEC,
  DANGEROUS_BASH_PATTERNS,
} from './dangerousPatterns.js'
import type {
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
} from './PermissionRule.js'
import {
  type AdditionalWorkingDirectory,
  applyPermissionUpdate,
} from './PermissionUpdate.js'
import type { PermissionUpdateDestination } from './PermissionUpdateSchema.js'
import {
  normalizeLegacyToolName,
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from './permissionRuleParser.js'

/** 检查 Bash 权限规则在自动模式下是否危险。
如果一条规则会自动允许执行任意代码的命令，从而绕过分类器的安全评估，则该规则是危险的。

危险模式：
1. 工具级别允许（无 ruleContent 的 Bash）——允许所有命令
2. 脚本解释器的前缀规则（python:*、node:* 等）
3. 匹配解释器的通配符规则（python*、node* 等） */
export function isDangerousBashPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  // 仅检查 Bash 规则
  if (toolName !== BASH_TOOL_NAME) {
    return false
  }

  // 工具级别允许（无内容的 Bash，或 Bash(*)）——允许所有命令
  if (ruleContent === undefined || ruleContent === '') {
    return true
  }

  const content = ruleContent.trim().toLowerCase()

  // 独立通配符 (*) 匹配所有内容
  if (content === '*') {
    return true
  }

  // 检查前缀语法（如 "python:*"）或通配符语法（如
  // "python*"）的危险模式
  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    const lowerPattern = pattern.toLowerCase()

    // 精确匹配模式本身（例如将 "python" 作为规则）
    if (content === lowerPattern) {
      return true
    }

    // 前缀语法："python:*" 允许任何 python 命令
    if (content === `${lowerPattern}:*`) {
      return true
    }

    // 末尾通配符："python*" 匹配 python、python3 等
    if (content === `${lowerPattern}*`) {
      return true
    }

    // 带空格的通配符："python *" 会匹配 "python script.py"
    if (content === `${lowerPattern} *`) {
      return true
    }

    // 检查类似 "python -*" 的模式，该模式会匹配 "python -c 'code'"
    if (content.startsWith(`${lowerPattern} -`) && content.endsWith('*')) {
      return true
    }
  }

  return false
}

/** 检查 PowerShell 权限规则在自动模式下是否危险。
如果一条规则会自动允许执行任意代码的命令（嵌套 shell、Invoke-Expression、Start-Process 等），从而绕过分类器的安全评估，则该规则是危险的。

PowerShell 不区分大小写，因此规则内容在匹配前会转换为小写。 */
export function isDangerousPowerShellPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  if (toolName !== POWERSHELL_TOOL_NAME) {
    return false
  }

  // 工具级别允许（无内容的 PowerShell，或 PowerShell(*)）——允许所有命令
  if (ruleContent === undefined || ruleContent === '') {
    return true
  }

  const content = ruleContent.trim().toLowerCase()

  // 独立通配符 (*) 匹配所有内容
  if (content === '*') {
    return true
  }

  // PS 特定的 cmdlet 名称。CROSS_PLATFORM_CODE_EXEC 与 bash 共享。
  const patterns: readonly string[] = [
    ...CROSS_PLATFORM_CODE_EXEC,
    // 嵌套 PS 及可从 PS 启动的 shell
    'pwsh',
    'powershell',
    'cmd',
    'wsl',
    // 字符串/脚本块求值器
    'iex',
    'invoke-expression',
    'icm',
    'invoke-command',
    // 进程生成器
    'start-process',
    'saps',
    'start',
    'start-job',
    'sajb',
    'start-threadjob', // 捆绑的 PS 6.1+；接受 -ScriptBlock，类似于 Sta
    // rt-Job 事件/会话代码执行
    'register-objectevent',
    'register-engineevent',
    'register-wmievent',
    'register-scheduledjob',
    'new-pssession',
    'nsn', // 别名
    'enter-pssession',
    'etsn', // 别名
    // .NET 逃生出口
    'add-type', // Add-Type -TypeDefinition '<C#>' → P/Invoke
    'new-object', // New-Object -ComObject WScript.Shell → .Run()
  ]

  for (const pattern of patterns) {
    // 模式以小写存储；内容已在上面转换为小写
    if (content === pattern) return true
    if (content === `${pattern}:*`) return true
    if (content === `${pattern}*`) return true
    if (content === `${pattern} *`) return true
    if (content.startsWith(`${pattern} -`) && content.endsWith('*')) return true
    // .exe — 附加在第一个单词上。`python` → `python.exe`。`
    // npm run` → `npm.exe run`（npm.exe 是真实的 Windows 二进制名称）
    // 。像 `PowerShell(npm.exe run:*)` 这样的规则需要匹配 `npm run`。
    const sp = pattern.indexOf(' ')
    const exe =
      sp === -1
        ? `${pattern}.exe`
        : `${pattern.slice(0, sp)}.exe${pattern.slice(sp)}`
    if (content === exe) return true
    if (content === `${exe}:*`) return true
    if (content === `${exe}*`) return true
    if (content === `${exe} *`) return true
    if (content.startsWith(`${exe} -`) && content.endsWith('*')) return true
  }
  return false
}

/** 检查 Agent（子代理）权限规则在自动模式下是否危险。
任何 Agent 允许规则都会在自动模式分类器评估子代理提示之前自动批准子代理的生成，从而破坏委托攻击防御。 */
export function isDangerousTaskPermission(
  toolName: string,
  _ruleContent: string | undefined,
): boolean {
  return normalizeLegacyToolName(toolName) === AGENT_TOOL_NAME
}

function formatPermissionSource(source: PermissionRuleSource): string {
  if ((SETTING_SOURCES as readonly string[]).includes(source)) {
    const filePath = getSettingsFilePathForSource(source as SettingSource)
    if (filePath) {
      const relativePath = relative(getCwd(), filePath)
      return relativePath.length < filePath.length ? relativePath : filePath
    }
  }
  return source
}

export type DangerousPermissionInfo = {
  ruleValue: PermissionRuleValue
  source: PermissionRuleSource
  /** 格式化后用于显示的权限规则，例如 "Bash(*)" 或 "Bash(python:*)" */
  ruleDisplay: string
  /** 格式化后用于显示的来源，例如文件路径或 "--allowed-tools" */
  sourceDisplay: string
}

/** 检查权限规则在自动模式下是否危险。
如果一条规则会在自动模式分类器评估之前自动允许操作，从而绕过安全检查，则该规则是危险的。 */
function isDangerousClassifierPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  if (process.env.USER_TYPE === 'ant') {
    // Tmux send-keys 执行任意 shell，与 Bash(*) 一样绕过分类器
    if (toolName === 'Tmux') return true
  }
  return (
    isDangerousBashPermission(toolName, ruleContent) ||
    isDangerousPowerShellPermission(toolName, ruleContent) ||
    isDangerousTaskPermission(toolName, ruleContent)
  )
}

/** 从磁盘和 CLI 参数加载的规则中查找所有危险权限。
返回关于每个找到的危险权限的结构化信息。

检查 Bash 权限（通配符/解释器模式）、PowerShell 权限（通配符/iex/Start-Process 模式）和 Agent 权限（任何允许规则都会绕过分类器的子代理评估）。 */
export function findDangerousClassifierPermissions(
  rules: PermissionRule[],
  cliAllowedTools: string[],
): DangerousPermissionInfo[] {
  const dangerous: DangerousPermissionInfo[] = []

  // 检查从设置加载的规则
  for (const rule of rules) {
    if (
      rule.ruleBehavior === 'allow' &&
      isDangerousClassifierPermission(
        rule.ruleValue.toolName,
        rule.ruleValue.ruleContent,
      )
    ) {
      const ruleString = rule.ruleValue.ruleContent
        ? `${rule.ruleValue.toolName}(${rule.ruleValue.ruleContent})`
        : `${rule.ruleValue.toolName}(*)`
      dangerous.push({
        ruleValue: rule.ruleValue,
        source: rule.source,
        ruleDisplay: ruleString,
        sourceDisplay: formatPermissionSource(rule.source),
      })
    }
  }

  // 检查 CLI --allowed-tools 参数
  for (const toolSpec of cliAllowedTools) {
    // 解析工具规范："Bash" 或 "Bash(pattern)" 或 "Agent" 或 "Agent(subagent_type)"
    const match = toolSpec.match(/^([^(]+)(?:\(([^)]*)\))?$/)
    if (match) {
      const toolName = match[1]!.trim()
      const ruleContent = match[2]?.trim()

      if (isDangerousClassifierPermission(toolName, ruleContent)) {
        dangerous.push({
          ruleValue: { toolName, ruleContent },
          source: 'cliArg',
          ruleDisplay: ruleContent ? toolSpec : `${toolName}(*)`,
          sourceDisplay: '--allowed-tools',
        })
      }
    }
  }

  return dangerous
}

/** 检查 Bash 允许规则是否过于宽泛（等同于 YOLO 模式）。
对于没有内容限制的工具级别 Bash 允许规则返回 true，
这些规则会自动允许每个 bash 命令。

匹配：Bash、Bash(*)、Bash() — 全部解析为 { toolName: 'Bash' } 且无 ruleContent。 */
export function isOverlyBroadBashAllowRule(
  ruleValue: PermissionRuleValue,
): boolean {
  return (
    ruleValue.toolName === BASH_TOOL_NAME && ruleValue.ruleContent === undefined
  )
}

/** isOverlyBroadBashAllowRule 的 PowerShell 等效方法。

匹配：PowerShell、PowerShell(*)、PowerShell() — 全部解析为
{ toolName: 'PowerShell' } 且无 ruleContent。 */
export function isOverlyBroadPowerShellAllowRule(
  ruleValue: PermissionRuleValue,
): boolean {
  return (
    ruleValue.toolName === POWERSHELL_TOOL_NAME &&
    ruleValue.ruleContent === undefined
  )
}

/** 从设置和 CLI 参数中查找所有过于宽泛的 Bash 允许规则。
过于宽泛的规则允许所有 bash 命令（例如 Bash 或 Bash(*)），
这实际上等同于 YOLO/绕过权限模式。 */
export function findOverlyBroadBashPermissions(
  rules: PermissionRule[],
  cliAllowedTools: string[],
): DangerousPermissionInfo[] {
  const overlyBroad: DangerousPermissionInfo[] = []

  for (const rule of rules) {
    if (
      rule.ruleBehavior === 'allow' &&
      isOverlyBroadBashAllowRule(rule.ruleValue)
    ) {
      overlyBroad.push({
        ruleValue: rule.ruleValue,
        source: rule.source,
        ruleDisplay: `${BASH_TOOL_NAME}(*)`,
        sourceDisplay: formatPermissionSource(rule.source),
      })
    }
  }

  for (const toolSpec of cliAllowedTools) {
    const parsed = permissionRuleValueFromString(toolSpec)
    if (isOverlyBroadBashAllowRule(parsed)) {
      overlyBroad.push({
        ruleValue: parsed,
        source: 'cliArg',
        ruleDisplay: `${BASH_TOOL_NAME}(*)`,
        sourceDisplay: '--allowed-tools',
      })
    }
  }

  return overlyBroad
}

/** findOverlyBroadBashPermissions 的 PowerShell 等效方法。 */
export function findOverlyBroadPowerShellPermissions(
  rules: PermissionRule[],
  cliAllowedTools: string[],
): DangerousPermissionInfo[] {
  const overlyBroad: DangerousPermissionInfo[] = []

  for (const rule of rules) {
    if (
      rule.ruleBehavior === 'allow' &&
      isOverlyBroadPowerShellAllowRule(rule.ruleValue)
    ) {
      overlyBroad.push({
        ruleValue: rule.ruleValue,
        source: rule.source,
        ruleDisplay: `${POWERSHELL_TOOL_NAME}(*)`,
        sourceDisplay: formatPermissionSource(rule.source),
      })
    }
  }

  for (const toolSpec of cliAllowedTools) {
    const parsed = permissionRuleValueFromString(toolSpec)
    if (isOverlyBroadPowerShellAllowRule(parsed)) {
      overlyBroad.push({
        ruleValue: parsed,
        source: 'cliArg',
        ruleDisplay: `${POWERSHELL_TOOL_NAME}(*)`,
        sourceDisplay: '--allowed-tools',
      })
    }
  }

  return overlyBroad
}

/** 类型守卫，检查 PermissionRuleSource 是否为有效的 PermissionUpdateDestination。
像 'flagSettings'、'policySettings' 和 'command' 这样的来源不是有效的目标。 */
function isPermissionUpdateDestination(
  source: PermissionRuleSource,
): source is PermissionUpdateDestination {
  return [
    'userSettings',
    'projectSettings',
    'localSettings',
    'session',
    'cliArg',
  ].includes(source)
}

/** 从内存上下文中移除危险权限，并可选地
将移除操作持久化到磁盘上的设置文件中。 */
export function removeDangerousPermissions(
  context: ToolPermissionContext,
  dangerousPermissions: DangerousPermissionInfo[],
): ToolPermissionContext {
  // 按来源（更新的目标）对危险规则进行分组
  const rulesBySource = new Map<
    PermissionUpdateDestination,
    PermissionRuleValue[]
  >()
  for (const perm of dangerousPermissions) {
    // 跳过无法持久化的来源（flagSettings、policySettings、command）
    if (!isPermissionUpdateDestination(perm.source)) {
      continue
    }
    const destination = perm.source
    const existing = rulesBySource.get(destination) || []
    existing.push(perm.ruleValue)
    rulesBySource.set(destination, existing)
  }

  let updatedContext = context
  for (const [destination, rules] of rulesBySource) {
    updatedContext = applyPermissionUpdate(updatedContext, {
      type: 'removeRules' as const,
      rules,
      behavior: 'allow' as const,
      destination,
    })
  }

  return updatedContext
}

/** 为自动模式准备 ToolPermissionContext，通过剥离
会绕过分类器的危险权限。
返回清理后的上下文（模式不变——由调用者设置模式）。 */
export function stripDangerousPermissionsForAutoMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const rules: PermissionRule[] = []
  for (const [source, ruleStrings] of Object.entries(
    context.alwaysAllowRules,
  )) {
    if (!ruleStrings) {
      continue
    }
    for (const ruleString of ruleStrings) {
      const ruleValue = permissionRuleValueFromString(ruleString)
      rules.push({
        source: source as PermissionRuleSource,
        ruleBehavior: 'allow',
        ruleValue,
      })
    }
  }
  const dangerousPermissions = findDangerousClassifierPermissions(rules, [])
  if (dangerousPermissions.length === 0) {
    return {
      ...context,
      strippedDangerousRules: context.strippedDangerousRules ?? {},
    }
  }
  for (const permission of dangerousPermissions) {
    logForDebugging(
      `忽略来自 ${permission.sourceDisplay} 的危险权限 ${permission.ruleDisplay}（绕过分类器）`,
    )
  }
  // 镜像 removeDangerousPermissions 的源过滤器，使 stash 与实际移除的内容一致。
  const stripped: ToolPermissionRulesBySource = {}
  for (const perm of dangerousPermissions) {
    if (!isPermissionUpdateDestination(perm.source)) continue
    ;(stripped[perm.source] ??= []).push(
      permissionRuleValueToString(perm.ruleValue),
    )
  }
  return {
    ...removeDangerousPermissions(context, dangerousPermissions),
    strippedDangerousRules: stripped,
  }
}

/** 恢复之前由 stripDangerousPermissionsForAutoMode 暂存的危险允许规则。
在离开自动模式时调用，以便用户的 Bash(python:*)、Agent(*) 等规则
在默认模式下再次生效。
清除暂存区，以便第二次退出时无操作。 */
export function restoreDangerousPermissions(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const stash = context.strippedDangerousRules
  if (!stash) {
    return context
  }
  let result = context
  for (const [source, ruleStrings] of Object.entries(stash)) {
    if (!ruleStrings || ruleStrings.length === 0) continue
    result = applyPermissionUpdate(result, {
      type: 'addRules',
      rules: ruleStrings.map(permissionRuleValueFromString),
      behavior: 'allow',
      destination: source as PermissionUpdateDestination,
    })
  }
  return { ...result, strippedDangerousRules: undefined }
}

/** 处理切换权限模式时的所有状态转换。
集中处理副作用，使每个激活路径（CLI Shift+Tab、
SDK 控制消息等）行为一致。

当前处理：
- Plan 模式进入/退出附件（通过 handlePlanModeTransition）
- 自动模式激活：setAutoModeActive、stripDangerousPermissionsForAutoMode

返回（可能已修改的）上下文。调用者负责在返回的上下文上设置模式。

@param fromMode 当前权限模式
@param toMode 目标权限模式
@param context 当前工具权限上下文 */
export function transitionPermissionMode(
  fromMode: string,
  toMode: string,
  context: ToolPermissionContext,
): ToolPermissionContext {
  // plan→plan（SDK set_permission_mode）会错误地触发下面的离开分支
  if (fromMode === toMode) return context

  handlePlanModeTransition(fromMode, toMode)
  handleAutoModeTransition(fromMode, toMode)

  if (fromMode === 'plan' && toMode !== 'plan') {
    setHasExitedPlanMode(true)
  }

  if (feature('TRANSCRIPT_CLASSIFIER')) {
    if (toMode === 'plan' && fromMode !== 'plan') {
      return prepareContextForPlanMode(context)
    }

    // 带有自动激活的 Plan 算作使用分类器（对于离开侧而言）。isAutoModeAct
    // ive() 是权威信号——prePlanMode/strippedDangerousRules
    // 是不可靠的代理，因为自动可能在 plan 中间被停用（非选择加入进入、transi
    // tionPlanAutoMode），而这些字段可能仍处于设置/未设置状态。
    const fromUsesClassifier =
      fromMode === 'auto' ||
      (fromMode === 'plan' &&
        (autoModeStateModule?.isAutoModeActive() ?? false))
    const toUsesClassifier = toMode === 'auto' // plan 进入已在上面处理

    if (toUsesClassifier && !fromUsesClassifier) {
      if (!isAutoModeGateEnabled()) {
        throw new Error('无法转换到自动模式：门控未启用')
      }
      autoModeStateModule?.setAutoModeActive(true)
      context = stripDangerousPermissionsForAutoMode(context)
    } else if (fromUsesClassifier && !toUsesClassifier) {
      autoModeStateModule?.setAutoModeActive(false)
      setNeedsAutoModeExitAttachment(true)
      context = restoreDangerousPermissions(context)
    }
  }

  // 仅在需要清除某些内容时才展开（保持引用相等性）
  if (fromMode === 'plan' && toMode !== 'plan' && context.prePlanMode) {
    return { ...context, prePlanMode: undefined }
  }

  return context
}

/** 从 CLI 解析基础工具规范
处理预设名称（default、none）和自定义工具列表 */
export function parseBaseToolsFromCLI(baseTools: string[]): string[] {
  // 连接所有数组元素并检查是否为单个预设名称
  const joinedInput = baseTools.join(' ').trim()
  const preset = parseToolPreset(joinedInput)

  if (preset) {
    return getToolsForDefaultPreset()
  }

  // 使用与 allowedTools/disallowedTools 相同的解析逻辑解析为自定义工具列表
  const parsedTools = parseToolListFromCLI(baseTools)

  return parsedTools
}

/** 检查 processPwd 是否为解析到 originalCwd 的符号链接 */
function isSymlinkTo({
  processPwd,
  originalCwd,
}: {
  processPwd: string
  originalCwd: string
}): boolean {
  // 使用 safeResolvePath 检查 processPwd 是否为符号链接并获取其解析路径
  const { resolvedPath: resolvedProcessPwd, isSymlink: isProcessPwdSymlink } =
    safeResolvePath(getFsImplementation(), processPwd)

  return isProcessPwdSymlink
    ? resolvedProcessPwd === resolve(originalCwd)
    : false
}

/** 安全地将 CLI 标志转换为 PermissionMode */
export function initialPermissionModeFromCLI({
  permissionModeCli,
  dangerouslySkipPermissions,
}: {
  permissionModeCli: string | undefined
  dangerouslySkipPermissions: boolean | undefined
}): { mode: PermissionMode; notification?: string } {
  const settings = getSettings_DEPRECATED() || {}

  // 首先检查 GrowthBook 门控——优先级最高
  const growthBookDisableBypassPermissionsMode =
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
      'tengu_disable_bypass_permissions_mode',
    )

  // 然后检查设置——优先级较低
  const settingsDisableBypassPermissionsMode =
    settings.permissions?.disableBypassPermissionsMode === 'disable'

  // Statsig 门控优先于设置
  const disableBypassPermissionsMode =
    growthBookDisableBypassPermissionsMode ||
    settingsDisableBypassPermissionsMode

  // 同步断路器检查（缓存的 GB 读取）。防止 AutoModeOp
  // tInDialog 在 showSetupScreens() 中显示，当自动模式
  // 实际上无法进入时。autoModeFlagCli 仍然将意图传递到 verif
  // yAutoModeGateAccess，后者会通知用户原因。
  const autoModeCircuitBrokenSync = feature('TRANSCRIPT_CLASSIFIER')
    ? getAutoModeEnabledStateIfCached() === 'disabled'
    : false

  // 按优先级顺序排列的模式
  const orderedModes: PermissionMode[] = []
  let notification: string | undefined

  if (dangerouslySkipPermissions) {
    orderedModes.push('bypassPermissions')
  }
  if (permissionModeCli) {
    const parsedMode = permissionModeFromString(permissionModeCli)
    if (feature('TRANSCRIPT_CLASSIFIER') && parsedMode === 'auto') {
      if (autoModeCircuitBrokenSync) {
        logForDebugging(
          '自动模式断路器已激活（缓存）——回退到默认',
          { level: 'warn' },
        )
      } else {
        orderedModes.push('auto')
      }
    } else {
      orderedModes.push(parsedMode)
    }
  }
  if (settings.permissions?.defaultMode) {
    const settingsMode = settings.permissions.defaultMode as PermissionMode
    // CCR 仅支持 acceptEdits 和 plan——忽略设置中的其他
    // defaultMode（例如 bypassPermissions 会在
    // 远程环境中静默授予完全访问权限）。
    if (
      isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
      !['acceptEdits', 'plan', 'default'].includes(settingsMode)
    ) {
      logForDebugging(
        `设置中的 defaultMode "${settingsMode}" 在 CLAUDE_CODE_REMOTE 中不受支持——仅允许 acceptEdits 和 plan`,
        { level: 'warn' },
      )
      logEvent('tengu_ccr_unsupported_default_mode_ignored', {
        mode: settingsMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
    // 来自设置的自动模式需要与来自 CLI 相同的门控检查
    else if (feature('TRANSCRIPT_CLASSIFIER') && settingsMode === 'auto') {
      if (autoModeCircuitBrokenSync) {
        logForDebugging(
          '自动模式断路器已激活（缓存）——回退到默认',
          { level: 'warn' },
        )
      } else {
        orderedModes.push('auto')
      }
    } else {
      orderedModes.push(settingsMode)
    }
  }

  let result: { mode: PermissionMode; notification?: string } | undefined

  for (const mode of orderedModes) {
    if (mode === 'bypassPermissions' && disableBypassPermissionsMode) {
      if (growthBookDisableBypassPermissionsMode) {
        logForDebugging('bypassPermissions 模式已被 Statsig 门控禁用', {
          level: 'warn',
        })
        notification =
          '绕过权限模式已被您的组织策略禁用'
      } else {
        logForDebugging('bypassPermissions 模式已被设置禁用', {
          level: 'warn',
        })
        notification = '绕过权限模式已被设置禁用'
      }
      continue // 如果此模式被禁用则跳过
    }

    result = { mode, notification } // 使用第一个有效模式
    break
  }

  if (!result) {
    result = { mode: 'default', notification }
  }

  if (!result) {
    result = { mode: 'default', notification }
  }

  if (feature('TRANSCRIPT_CLASSIFIER') && result.mode === 'auto') {
    autoModeStateModule?.setAutoModeActive(true)
  }

  return result
}

export function parseToolListFromCLI(tools: string[]): string[] {
  if (tools.length === 0) {
    return []
  }

  const result: string[] = []

  // 处理数组中的每个字符串
  for (const toolString of tools) {
    if (!toolString) continue

    let current = ''
    let isInParens = false

    // 解析字符串中的每个字符
    for (const char of toolString) {
      switch (char) {
        case '(':
          isInParens = true
          current += char
          break
        case ')':
          isInParens = false
          current += char
          break
        case ',':
          if (isInParens) {
            current += char
          } else {
            // 逗号分隔符——推入当前工具并开始新工具
            if (current.trim()) {
              result.push(current.trim())
            }
            current = ''
          }
          break
        case ' ':
          if (isInParens) {
            current += char
          } else if (current.trim()) {
            // 空格分隔符——推入当前工具并开始新工具
            result.push(current.trim())
            current = ''
          }
          break
        default:
          current += char
      }
    }

    // 推入任何剩余的工具
    if (current.trim()) {
      result.push(current.trim())
    }
  }

  return result
}

export async function initializeToolPermissionContext({
  allowedToolsCli,
  disallowedToolsCli,
  baseToolsCli,
  permissionMode,
  allowDangerouslySkipPermissions,
  addDirs,
}: {
  allowedToolsCli: string[]
  disallowedToolsCli: string[]
  baseToolsCli?: string[]
  permissionMode: PermissionMode
  allowDangerouslySkipPermissions: boolean
  addDirs: string[]
}): Promise<{
  toolPermissionContext: ToolPermissionContext
  warnings: string[]
  dangerousPermissions: DangerousPermissionInfo[]
  overlyBroadBashPermissions: DangerousPermissionInfo[]
}> {
  // 解析逗号分隔的允许和禁止工具列表（如果提供）。规范化旧版工具名称（
  // 例如 'Task' → 'Agent'），以便 stripDangerous
  // PermissionsForAutoMode 中的内存规则移除能够正确匹配。
  const parsedAllowedToolsCli = parseToolListFromCLI(allowedToolsCli).map(
    rule => permissionRuleValueToString(permissionRuleValueFromString(rule)),
  )
  let parsedDisallowedToolsCli = parseToolListFromCLI(disallowedToolsCli)

  // 如果指定了基础工具集，则自动拒绝所有不在基础工具集中的工具。
  // 我们需要检查基础工具集是否被显式提供（而不仅仅是空的默认值）。
  if (baseToolsCli && baseToolsCli.length > 0) {
    const baseToolsResult = parseBaseToolsFromCLI(baseToolsCli)
    // 规范化旧版工具名称（例如 'Task' → 'Agent'），以
    // 便用户提供的使用旧名称的基础工具列表仍能匹配规范名称。
    const baseToolsSet = new Set(baseToolsResult.map(normalizeLegacyToolName))
    const allToolNames = getToolsForDefaultPreset()
    const toolsToDisallow = allToolNames.filter(tool => !baseToolsSet.has(tool))
    parsedDisallowedToolsCli = [...parsedDisallowedToolsCli, ...toolsToDisallow]
  }

  const warnings: string[] = []
  const additionalWorkingDirectories = new Map<
    string,
    AdditionalWorkingDirectory
  >()
  // process.env.PWD 可能是一个符号链接，而 getOriginalCwd() 使用真实路径
  const processPwd = process.env.PWD
  if (
    processPwd &&
    processPwd !== getOriginalCwd() &&
    isSymlinkTo({ originalCwd: getOriginalCwd(), processPwd })
  ) {
    additionalWorkingDirectories.set(processPwd, {
      path: processPwd,
      source: 'session',
    })
  }

  const isBypassPermissionsModeAvailable = true
  const settings = getSettings_DEPRECATED() || {}

  // 从磁盘加载所有权限规则
  const rulesFromDisk = loadAllPermissionRulesFromDisk()

  // 仅限 Ant：检测所有模式下过于宽泛的 shell 允许规则。Ba
  // sh(*) 或 PowerShell(*) 等同于该 shell 的 YO
  // LO 模式。在 CCR/BYOC 中跳过，其中 --allowed-tools 是预
  // 期的预批准机制。变量名保留以保持返回字段兼容性；包含两种 shell。
  let overlyBroadBashPermissions: DangerousPermissionInfo[] = []
  if (
    process.env.USER_TYPE === 'ant' &&
    !isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
    process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent'
  ) {
    overlyBroadBashPermissions = [
      ...findOverlyBroadBashPermissions(rulesFromDisk, parsedAllowedToolsCli),
      ...findOverlyBroadPowerShellPermissions(
        rulesFromDisk,
        parsedAllowedToolsCli,
      ),
    ]
  }

  // 仅限 Ant：检测自动模式下的危险 shell 权限。危
  // 险权限（如 Bash(*)、Bash(python:*)、PowerShell(iex
  // :*)) 会在分类器评估之前自动允许，从而破坏更安全的 YOLO 模式的目的。
  let dangerousPermissions: DangerousPermissionInfo[] = []
  if (feature('TRANSCRIPT_CLASSIFIER') && permissionMode === 'auto') {
    dangerousPermissions = findDangerousClassifierPermissions(
      rulesFromDisk,
      parsedAllowedToolsCli,
    )
  }

  let toolPermissionContext = applyPermissionRulesToPermissionContext(
    {
      mode: permissionMode,
      additionalWorkingDirectories,
      alwaysAllowRules: { cliArg: parsedAllowedToolsCli },
      alwaysDenyRules: { cliArg: parsedDisallowedToolsCli },
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable,
      ...(feature('TRANSCRIPT_CLASSIFIER')
        ? { isAutoModeAvailable: true }
        : {}),
    },
    rulesFromDisk,
  )

  // 从设置和 --add-dir 添加目录
  const allAdditionalDirectories = [
    ...(settings.permissions?.additionalDirectories || []),
    ...addDirs,
  ]
  // 并行化文件系统验证；串行应用更新（累积上下文）。validateDire
  // ctoryForWorkspace 仅读取 permissionConte
  // xt 来检查目录是否已被覆盖——与并行化的行为差异是良性的（两个重叠的 --
  // add-dirs 都会成功，而不是其中一个被标记为 alreadyIn
  // WorkingDirectory，后者本来也会被静默跳过）。
  const validationResults = await Promise.all(
    allAdditionalDirectories.map(dir =>
      validateDirectoryForWorkspace(dir, toolPermissionContext),
    ),
  )
  for (const result of validationResults) {
    if (result.resultType === 'success') {
      toolPermissionContext = applyPermissionUpdate(toolPermissionContext, {
        type: 'addDirectories',
        directories: [result.absolutePath],
        destination: 'cliArg',
      })
    } else if (
      result.resultType !== 'alreadyInWorkingDirectory' &&
      result.resultType !== 'pathNotFound'
    ) {
      // 对实际的配置错误发出警告（例如指定文件而不是目
      // 录）。但如果目录不再存在（例如某人在 /tmp
      // 下工作且该目录已被清除），则静默跳过。如果他们
      // 稍后尝试访问，会再次收到提示。
      warnings.push(addDirHelpMessage(result))
    }
  }

  return {
    toolPermissionContext,
    warnings,
    dangerousPermissions,
    overlyBroadBashPermissions,
  }
}

export type AutoModeGateCheckResult = {
  // 返回转换函数（而非预计算的上下文），以便调用者可以在 setAppSta
  // te(prev => ...) 内部针对当前上下文应用它。在此处预计算上下文
  // 会捕获到过时的快照：下面的异步 GrowthBook await 可能会
  // 被中途的 shift-tab 操作抢先，而返回 { ...
  // currentContext, ... } 会覆盖用户的模式更改。
  updateContext: (ctx: ToolPermissionContext) => ToolPermissionContext
  notification?: string
}

export type AutoModeUnavailableReason = 'settings' | 'circuit-breaker' | 'model'

export function getAutoModeUnavailableNotification(
  reason: AutoModeUnavailableReason,
): string {
  let base: string
  switch (reason) {
    case 'settings':
      base = '自动模式已被设置禁用'
      break
    case 'circuit-breaker':
      base = '您的套餐不支持自动模式'
      break
    case 'model':
      base = '此模型不支持自动模式'
      break
  }
  return process.env.USER_TYPE === 'ant'
    ? `${base} · #claude-code-feedback`
    : base
}

/** 异步检查自动模式的可用性。

返回一个转换函数（而非预计算的上下文），调用者在 setAppState(prev => ...) 内部针对当前上下文应用它。这可以防止异步的 GrowthBook await 覆盖中途的模式更改（例如，在此检查进行时用户 shift-tab 切换到 acceptEdits）。

该转换函数会针对最新的 ctx 重新检查 mode/prePlanMode，以避免在 await 期间将用户踢出他们已经离开的模式。 */
export async function verifyAutoModeGateAccess(
  currentContext: ToolPermissionContext,
  // 运行时 AppState.fastMode——由具有 AppState 访问权限的调
  // 用者传入，以便 disableFastMode 断路器读取当前状态，而不是过时
  // 的 settings.fastMode（后者有意在 /model auto 降级
  // 时保持粘性）。对于没有 AppState 的调用者（例如 SDK 初始化路径）是可选的。
  fastMode?: boolean,
): Promise<AutoModeGateCheckResult> {
  // 自动模式配置——在所有构建中运行（断路器、轮播、踢出）。重新读取 teng
  // u_auto_mode_config.enabled——此异步检查在 G
  // rowthBook 初始化后运行一次，并且是 isAutoMode
  // Available 的权威来源。同步启动路径使用过时缓存；此操作
  // 纠正它。断路器（enabled==='disabled'）在此生效。
  const autoModeConfig = await getDynamicConfig_BLOCKS_ON_INIT<{
    enabled?: AutoModeEnabledState
    disableFastMode?: boolean
  }>('tengu_auto_mode_config', {})
  const enabledState = parseAutoModeEnabledState(autoModeConfig?.enabled)
  const disabledBySettings = isAutoModeDisabledBySettings()
  // 将设置禁用视为与 GrowthBook 的 'disabled' 相同，以实现断路器语义——
  // 通过 isAutoModeGateEnabled() 阻止 SDK/显式重新进入。
  autoModeStateModule?.setAutoModeCircuitBroken(
    enabledState === 'disabled' || disabledBySettings,
  )

  // 轮播可用性：未触发断路器、未被设置禁用、模型支持、dis
  // ableFastMode 断路器未触发，并且（已启用或已选择加入）
  const mainModel = getMainLoopModel()
  // 临时断路器：当快速模式开启时，tengu_auto_mode_config.dis
  // ableFastMode 会阻止自动模式。检查运行时 AppState.fastMo
  // de（如果提供），对于 ant，还检查模型名称中的 '-fast' 子字符串（
  // ant 内部快速模型如 capybara-v2-fast[1m] 在模型
  // ID 本身中编码了速度）。在自动+快速模式交互验证后移除。
  const disableFastModeBreakerFires =
    !!autoModeConfig?.disableFastMode &&
    (!!fastMode ||
      (process.env.USER_TYPE === 'ant' &&
        mainModel.toLowerCase().includes('-fast')))
  const modelSupported =
    modelSupportsAutoMode(mainModel) && !disableFastModeBreakerFires
  let carouselAvailable = false
  if (enabledState !== 'disabled' && !disabledBySettings && modelSupported) {
    carouselAvailable =
      enabledState === 'enabled' || hasAutoModeOptInAnySource()
  }
  // canEnterAuto 控制显式进入（--permission-mode auto, def
  // aultMode: auto）——显式进入本身就是选择加入，因此我们仅在断路器 + 设置 + 模型上阻止
  const canEnterAuto =
    enabledState !== 'disabled' && !disabledBySettings && modelSupported
  logForDebugging(
    `[auto-mode] verifyAutoModeGateAccess: enabledState=${enabledState} disabledBySettings=${disabledBySettings} model=${mainModel} modelSupported=${modelSupported} disableFastModeBreakerFires=${disableFastModeBreakerFires} carouselAvailable=${carouselAvailable} canEnterAuto=${canEnterAuto}`,
  )

  // 立即捕获 CLI 标志意图（不依赖于上下文）。
  const autoModeFlagCli = autoModeStateModule?.getAutoModeFlagCli() ?? false

  // 返回一个转换函数，该函数在 setAppState 时针对当前上下文重新评估依赖于上
  // 下文的条件。上面的异步 GrowthBook 结果（canEnterAuto,
  // carouselAvailable, enabledState, reason）
  // 被闭包捕获——这些不依赖于上下文。但 mode、prePlanMode 和 isA
  // utoModeAvailable 检查必须使用最新的 ctx，否则中途的 sh
  // ift-tab 操作会被还原（或者更糟，如果用户在 await 期间进入了自动
  // 模式——这是可能的，因为上面的 setAutoModeCircuitBroken
  // 在 await 之后运行——则用户会留在自动模式中尽管断路器已触发）。
  const setAvailable = (
    ctx: ToolPermissionContext,
    available: boolean,
  ): ToolPermissionContext => {
    if (ctx.isAutoModeAvailable !== available) {
      logForDebugging(
        `[auto-mode] verifyAutoModeGateAccess setAvailable: ${ctx.isAutoModeAvailable} -> ${available}`,
      )
    }
    return ctx.isAutoModeAvailable === available
      ? ctx
      : { ...ctx, isAutoModeAvailable: available }
  }

  if (canEnterAuto) {
    return { updateContext: ctx => setAvailable(ctx, carouselAvailable) }
  }

  // 门控已关闭或断路器已触发——确定原因（与上下文无关）。
  let reason: AutoModeUnavailableReason
  if (disabledBySettings) {
    reason = 'settings'
    logForDebugging('自动模式已禁用：设置中的 disableAutoMode', {
      level: 'warn',
    })
  } else if (enabledState === 'disabled') {
    reason = 'circuit-breaker'
    logForDebugging(
      '自动模式已禁用：tengu_auto_mode_config.enabled === "disabled"（断路器）',
      { level: 'warn' },
    )
  } else {
    reason = 'model'
    logForDebugging(
      `自动模式已禁用：模型 ${getMainLoopModel()} 不支持自动模式`,
      { level: 'warn' },
    )
  }
  const notification = getAutoModeUnavailableNotification(reason)

  // 统一的踢出转换。重新检查最新的 ctx，并且仅在踢出实际适用时触发副作用（
  // setAutoModeActive(false), setNeedsAutoMo
  // deExitAttachment）。这使 autoModeActive 与 t
  // oolPermissionContext.mode 保持同步，即使用户在 aw
  // ait 期间更改了模式：如果他们自己已经离开了自动模式，handleCyc
  // leMode 已经停用了分类器，我们不会再次触发；如果他们在 await 期
  // 间进入了自动模式（在 setAutoModeCircuitBroken 生效之前
  // 可能发生），我们会在此处将他们踢出。
  const kickOutOfAutoIfNeeded = (
    ctx: ToolPermissionContext,
  ): ToolPermissionContext => {
    const inAuto = ctx.mode === 'auto'
    logForDebugging(
      `[auto-mode] kickOutOfAutoIfNeeded applying: ctx.mode=${ctx.mode} ctx.prePlanMode=${ctx.prePlanMode} reason=${reason}`,
    )
    // 自动模式激活的计划模式：来自 prePlanMode='auto'（从自动模式进入
    // ）或来自选择加入（存在 strippedDangerousRules）。
    const inPlanWithAutoActive =
      ctx.mode === 'plan' &&
      (ctx.prePlanMode === 'auto' || !!ctx.strippedDangerousRules)
    if (!inAuto && !inPlanWithAutoActive) {
      return setAvailable(ctx, false)
    }
    if (inAuto) {
      autoModeStateModule?.setAutoModeActive(false)
      setNeedsAutoModeExitAttachment(true)
      return {
        ...applyPermissionUpdate(restoreDangerousPermissions(ctx), {
          type: 'setMode',
          mode: 'default',
          destination: 'session',
        }),
        isAutoModeAvailable: false,
      }
    }
    // 自动模式激活的计划：停用自动模式，恢复权限，解除 prePlanMode
    // 以便 ExitPlanMode 转到默认模式。
    autoModeStateModule?.setAutoModeActive(false)
    setNeedsAutoModeExitAttachment(true)
    return {
      ...restoreDangerousPermissions(ctx),
      prePlanMode: ctx.prePlanMode === 'auto' ? 'default' : ctx.prePlanMode,
      isAutoModeAvailable: false,
    }
  }

  // 通知决策使用过时的上下文——这没问题：我们根据
  // 用户在此检查开始时正在做什么来决定是否通知。（副
  // 作用和模式突变在上面的转换中，针对最新的 c
  // tx 决定。）
  const wasInAuto = currentContext.mode === 'auto'
  // 计划期间使用了自动模式：从自动模式进入或选择加入自动模式激活
  const autoActiveDuringPlan =
    currentContext.mode === 'plan' &&
    (currentContext.prePlanMode === 'auto' ||
      !!currentContext.strippedDangerousRules)
  const wantedAuto = wasInAuto || autoActiveDuringPlan || autoModeFlagCli

  if (!wantedAuto) {
    // 用户在调用时不需要自动模式——不通知。但仍应用完整的踢出转换：如果他们在
    // await 期间 shift-tab 进入了自动模式（在 setAuto
    // ModeCircuitBroken 生效之前），我们需要将他们驱逐出去。
    return { updateContext: kickOutOfAutoIfNeeded }
  }

  if (wasInAuto || autoActiveDuringPlan) {
    // 用户在自动模式中或在计划期间激活了自动模式——踢出并通知。
    return { updateContext: kickOutOfAutoIfNeeded, notification }
  }

  // 仅 autoModeFlagCli：defaultMode 是 aut
  // o 但同步检查拒绝了它。如果 isAutoModeAvailable
  // 已经为 false，则抑制通知（在先前的检查中已经通知过；防止在连续不
  // 支持的模型切换时重复通知）。
  return {
    updateContext: kickOutOfAutoIfNeeded,
    notification: currentContext.isAutoModeAvailable ? notification : undefined,
  }
}

/** 检查是否应根据 Statsig 门控禁用 bypassPermissions 的核心逻辑 */
export function shouldDisableBypassPermissions(): Promise<boolean> {
  return checkSecurityRestrictionGate('tengu_disable_bypass_permissions_mode')
}

function isAutoModeDisabledBySettings(): boolean {
  const settings = getSettings_DEPRECATED() || {}
  return (
    (settings as { disableAutoMode?: 'disable' }).disableAutoMode ===
      'disable' ||
    (settings.permissions as { disableAutoMode?: 'disable' } | undefined)
      ?.disableAutoMode === 'disable'
  )
}

/** 检查是否可以进入自动模式：断路器未激活且设置未禁用它。同步。 */
export function isAutoModeGateEnabled(): boolean {
  return true
}

/** 返回自动模式当前不可用的原因，如果可用则返回 null。同步——使用由 verifyAutoModeGateAccess 填充的状态。 */
export function getAutoModeUnavailableReason(): AutoModeUnavailableReason | null {
  if (isAutoModeDisabledBySettings()) return 'settings'
  if (autoModeStateModule?.isAutoModeCircuitBroken() ?? false) {
    return 'circuit-breaker'
  }
  if (!modelSupportsAutoMode(getMainLoopModel())) return 'model'
  return null
}

/** tengu_auto_mode_config GrowthBook JSON 配置中的 `enabled` 字段。控制 UI 界面（CLI、IDE、Desktop）中的自动模式可用性。
- 'enabled'：自动模式在 shift-tab 轮播（或等效功能）中可用
- 'disabled'：自动模式完全不可用——用于事件响应的断路器
- 'opt-in'：仅当用户显式选择加入时自动模式才可用
  （通过 CLI 中的 --enable-auto-mode，或 IDE/Desktop 中的设置开关） */
export type AutoModeEnabledState = 'enabled' | 'disabled' | 'opt-in'

const AUTO_MODE_ENABLED_DEFAULT: AutoModeEnabledState = feature(
  'TRANSCRIPT_CLASSIFIER',
)
  ? 'enabled'
  : 'disabled'

function parseAutoModeEnabledState(value: unknown): AutoModeEnabledState {
  if (value === 'enabled' || value === 'disabled' || value === 'opt-in') {
    return value
  }
  return AUTO_MODE_ENABLED_DEFAULT
}

/** 从 tengu_auto_mode_config 读取 `enabled` 字段（已缓存，可能已过时）。如果 GrowthBook 不可用或该字段未设置，则默认为 'disabled'。其他界面（IDE、Desktop）应调用此函数来决定是否在其模式选择器中显示自动模式。 */
export function getAutoModeEnabledState(): AutoModeEnabledState {
  const config = getFeatureValue_CACHED_MAY_BE_STALE<{
    enabled?: AutoModeEnabledState
  }>('tengu_auto_mode_config', {})
  return parseAutoModeEnabledState(config?.enabled)
}

const NO_CACHED_AUTO_MODE_CONFIG = Symbol('no-cached-auto-mode-config')

/** 类似于 getAutoModeEnabledState，但在没有缓存值时返回 undefined（冷启动，在 GrowthBook 初始化之前）。由 initialPermissionModeFromCLI 中的同步断路器检查使用，该检查不能将“尚未获取”与“已获取并已禁用”混淆——前者推迟到 verifyAutoModeGateAccess，后者立即阻止。 */
export function getAutoModeEnabledStateIfCached():
  | AutoModeEnabledState
  | undefined {
  const config = getFeatureValue_CACHED_MAY_BE_STALE<
    { enabled?: AutoModeEnabledState } | typeof NO_CACHED_AUTO_MODE_CONFIG
  >('tengu_auto_mode_config', NO_CACHED_AUTO_MODE_CONFIG)
  if (config === NO_CACHED_AUTO_MODE_CONFIG) return undefined
  return parseAutoModeEnabledState(config?.enabled)
}

/** 如果用户通过任何受信任的机制选择加入自动模式，则返回 true：
- CLI 标志（--enable-auto-mode / --permission-mode auto）——会话范围的可用性请求；showSetupScreens 中的启动对话框在 REPL 渲染之前强制执行持久同意。
- skipAutoPermissionPrompt 设置（持久性；通过接受选择加入对话框或 IDE/Desktop 设置开关设置） */
export function hasAutoModeOptInAnySource(): boolean {
  if (autoModeStateModule?.getAutoModeFlagCli() ?? false) return true
  return hasAutoModeOptIn()
}

/** 检查 bypassPermissions 模式当前是否被 Statsig 门控或设置禁用。这是一个使用缓存 Statsig 值的同步版本。 */
export function isBypassPermissionsModeDisabled(): boolean {
  const growthBookDisableBypassPermissionsMode =
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
      'tengu_disable_bypass_permissions_mode',
    )
  const settings = getSettings_DEPRECATED() || {}
  const settingsDisableBypassPermissionsMode =
    settings.permissions?.disableBypassPermissionsMode === 'disable'

  return (
    growthBookDisableBypassPermissionsMode ||
    settingsDisableBypassPermissionsMode
  )
}

/** 创建一个禁用了 bypassPermissions 的更新上下文 */
export function createDisabledBypassPermissionsContext(
  currentContext: ToolPermissionContext,
): ToolPermissionContext {
  let updatedContext = currentContext
  if (currentContext.mode === 'bypassPermissions') {
    updatedContext = applyPermissionUpdate(currentContext, {
      type: 'setMode',
      mode: 'default',
      destination: 'session',
    })
  }

  return {
    ...updatedContext,
    isBypassPermissionsModeAvailable: false,
  }
}

/** 异步检查是否应根据 Statsig 门控禁用 bypassPermissions 模式，并在需要时返回更新的 toolPermissionContext */
export async function checkAndDisableBypassPermissions(
  currentContext: ToolPermissionContext,
): Promise<void> {
  // 仅在 bypassPermissions 模式可用时继续
  if (!currentContext.isBypassPermissionsModeAvailable) {
    return
  }

  const shouldDisable = await shouldDisableBypassPermissions()
  if (!shouldDisable) {
    return
  }

  // 门控已启用，需要禁用 bypassPermissions 模式
  logForDebugging(
    'bypassPermissions 模式正在被 Statsig 门控禁用（异步检查）',
    { level: 'warn' },
  )

  void gracefulShutdown(1, 'bypass_permissions_disabled')
}

export function isDefaultPermissionModeAuto(): boolean {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const settings = getSettings_DEPRECATED() || {}
    return settings.permissions?.defaultMode === 'auto'
  }
  return false
}

/** 计划模式是否应使用自动模式语义（分类器在计划期间运行）。当用户已选择加入自动模式且门控已启用时为 true。在权限检查时评估，以便对配置更改做出响应。 */
export function shouldPlanUseAutoMode(): boolean {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    return (
      hasAutoModeOptIn() &&
      isAutoModeGateEnabled() &&
      getUseAutoModeDuringPlan()
    )
  }
  return false
}

/** 集中化的计划模式入口。将当前模式存储为 prePlanMode，以便 ExitPlanMode 可以恢复它。当用户已选择加入自动模式时，自动语义在计划模式期间保持激活。 */
export function prepareContextForPlanMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const currentMode = context.mode
  if (currentMode === 'plan') return context
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const planAutoMode = shouldPlanUseAutoMode()
    if (currentMode === 'auto') {
      if (planAutoMode) {
        return { ...context, prePlanMode: 'auto' }
      }
      autoModeStateModule?.setAutoModeActive(false)
      setNeedsAutoModeExitAttachment(true)
      return {
        ...restoreDangerousPermissions(context),
        prePlanMode: 'auto',
      }
    }
    if (planAutoMode && currentMode !== 'bypassPermissions') {
      autoModeStateModule?.setAutoModeActive(true)
      return {
        ...stripDangerousPermissionsForAutoMode(context),
        prePlanMode: currentMode,
      }
    }
  }
  logForDebugging(
    `[prepareContextForPlanMode] 普通计划入口，prePlanMode=${currentMode}`,
    { level: 'info' },
  )
  return { ...context, prePlanMode: currentMode }
}

/** 在设置更改后，协调计划模式期间的自动模式状态。比较期望状态（shouldPlanUseAutoMode）与实际状态（isAutoModeActive），并相应地激活/停用自动模式。当不在计划模式时无操作。从 applySettingsChange 调用，以便在计划中途切换 useAutoModeDuringPlan 立即生效。 */
export function transitionPlanAutoMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  if (!feature('TRANSCRIPT_CLASSIFIER')) return context
  if (context.mode !== 'plan') return context
  // 镜像 prepareContextForPlanMode 的入口排除逻
  // 辑——当用户从危险模式进入时，绝不在计划中途激活自动模式。
  if (context.prePlanMode === 'bypassPermissions') {
    return context
  }

  const want = shouldPlanUseAutoMode()
  const have = autoModeStateModule?.isAutoModeActive() ?? false

  if (want && have) {
    // syncPermissionRulesFromDisk（在 applySetti
    // ngsChange 中在我们之前调用）会从磁盘重新添加危险规则，而不触及 stripp
    // edDangerousRules。重新剥离，以便分类器不会被前缀规则允许匹配绕过。
    return stripDangerousPermissionsForAutoMode(context)
  }
  if (!want && !have) return context

  if (want) {
    autoModeStateModule?.setAutoModeActive(true)
    setNeedsAutoModeExitAttachment(false)
    return stripDangerousPermissionsForAutoMode(context)
  }
  autoModeStateModule?.setAutoModeActive(false)
  setNeedsAutoModeExitAttachment(true)
  return restoreDangerousPermissions(context)
}
