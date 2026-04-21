import { getAllowedSettingSources } from '../../bootstrap/state.js'

/**
 * 设置可以来自的所有可能来源
 * 顺序很重要 - 后面的来源会覆盖前面的
 */
export const SETTING_SOURCES = [
  // 用户设置（全局）
  'userSettings',

  // 项目设置（按目录共享）
  'projectSettings',

  // 本地设置（git 忽略）
  'localSettings',

  // 标志设置（来自 --settings 标志）
  'flagSettings',

  // 策略设置（managed-settings.json 或来自 API 的远程设置）
  'policySettings',
] as const

export type SettingSource = (typeof SETTING_SOURCES)[number]

export function getSettingSourceName(source: SettingSource): string {
  switch (source) {
    case 'userSettings':
      return 'user'
    case 'projectSettings':
      return 'project'
    case 'localSettings':
      return 'project, gitignored'
    case 'flagSettings':
      return 'cli flag'
    case 'policySettings':
      return 'managed'
  }
}

/**
 * 获取设置来源的简短显示名称（首字母大写，用于上下文/技能 UI）
 * @param source 设置来源或 'plugin'/'built-in'
 * @returns 简短的首字母大写显示名称，如 'User', 'Project', 'Plugin'
 */
export function getSourceDisplayName(
  source: SettingSource | 'plugin' | 'built-in',
): string {
  switch (source) {
    case 'userSettings':
      return 'User'
    case 'projectSettings':
      return 'Project'
    case 'localSettings':
      return 'Local'
    case 'flagSettings':
      return 'Flag'
    case 'policySettings':
      return 'Managed'
    case 'plugin':
      return 'Plugin'
    case 'built-in':
      return 'Built-in'
  }
}

/**
 * 获取设置或权限规则来源的显示名称（小写，用于内联使用）
 * @param source 设置来源或权限规则来源
 * @returns 来源的小写显示名称
 */
export function getSettingSourceDisplayNameLowercase(
  source: SettingSource | 'cliArg' | 'command' | 'session',
): string {
  switch (source) {
    case 'userSettings':
      return 'user settings'
    case 'projectSettings':
      return 'shared project settings'
    case 'localSettings':
      return 'project local settings'
    case 'flagSettings':
      return 'command line arguments'
    case 'policySettings':
      return 'enterprise managed settings'
    case 'cliArg':
      return 'CLI argument'
    case 'command':
      return 'command configuration'
    case 'session':
      return 'current session'
  }
}

/**
 * 获取设置或权限规则来源的显示名称（首字母大写，用于 UI 标签）
 * @param source 设置来源或权限规则来源
 * @returns 首字母大写的来源显示名称
 */
export function getSettingSourceDisplayNameCapitalized(
  source: SettingSource | 'cliArg' | 'command' | 'session',
): string {
  switch (source) {
    case 'userSettings':
      return 'User settings'
    case 'projectSettings':
      return 'Shared project settings'
    case 'localSettings':
      return 'Project local settings'
    case 'flagSettings':
      return 'Command line arguments'
    case 'policySettings':
      return 'Enterprise managed settings'
    case 'cliArg':
      return 'CLI argument'
    case 'command':
      return 'Command configuration'
    case 'session':
      return 'Current session'
  }
}

/**
 * 将 --setting-sources CLI 标志解析为 SettingSource 数组
 * @param flag 逗号分隔的字符串，例如 "user,project,local"
 * @returns SettingSource 值数组
 */
export function parseSettingSourcesFlag(flag: string): SettingSource[] {
  if (flag === '') return []

  const names = flag.split(',').map(s => s.trim())
  const result: SettingSource[] = []

  for (const name of names) {
    switch (name) {
      case 'user':
        result.push('userSettings')
        break
      case 'project':
        result.push('projectSettings')
        break
      case 'local':
        result.push('localSettings')
        break
      default:
        throw new Error(
          `无效的设置来源: ${name}。有效选项为: user, project, local`,
        )
    }
  }

  return result
}

/**
 * 获取启用的设置来源，策略/标志始终包含在内
 * @returns 启用的 SettingSource 值数组
 */
export function getEnabledSettingSources(): SettingSource[] {
  const allowed = getAllowedSettingSources()

  // 始终包含策略和标志设置
  const result = new Set<SettingSource>(allowed)
  result.add('policySettings')
  result.add('flagSettings')
  return Array.from(result)
}

/**
 * 检查特定来源是否启用
 * @param source 要检查的来源
 * @returns 如果应该加载该来源则返回 true
 */
export function isSettingSourceEnabled(source: SettingSource): boolean {
  const enabled = getEnabledSettingSources()
  return enabled.includes(source)
}

/**
 * 可编辑的设置来源（排除只读的 policySettings 和 flagSettings）
 */
export type EditableSettingSource = Exclude<
  SettingSource,
  'policySettings' | 'flagSettings'
>

/**
 * 可以保存权限规则的来源列表，按显示顺序排列。
 * 由权限规则和钩子保存 UI 使用，以呈现来源选项。
 */
export const SOURCES = [
  'localSettings',
  'projectSettings',
  'userSettings',
] as const satisfies readonly EditableSettingSource[]

/**
 * Claude Code 设置的 JSON Schema URL
 * 你可以在以下地址编辑内容：https://github.com/SchemaStore/schemastore/blob/master/src/schemas/json/claude-code-settings.json
 */
export const CLAUDE_CODE_SETTINGS_SCHEMA_URL =
  'https://json.schemastore.org/claude-code-settings.json'