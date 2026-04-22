/**
 * 内置插件注册表
 *
 * 管理随 CLI 一同发布的内置插件，用户可以通过 /plugin UI 启用/禁用这些插件。
 *
 * 内置插件与打包技能（src/skills/bundled/）的区别在于：
 * - 它们会出现在 /plugin UI 的“内置”部分
 * - 用户可以启用/禁用它们（持久化到用户设置中）
 * - 它们可以提供多种组件（技能、钩子、MCP 服务器）
 *
 * 插件 ID 使用格式 `{name}@builtin`，以便与市场插件（`{name}@{marketplace}`）区分开。
 */

import type { Command } from '../commands.js'
import type { BundledSkillDefinition } from '../skills/bundledSkills.js'
import type { BuiltinPluginDefinition, LoadedPlugin } from '../types/plugin.js'
import { getSettings_DEPRECATED } from '../utils/settings/settings.js'

const BUILTIN_PLUGINS: Map<string, BuiltinPluginDefinition> = new Map()

export const BUILTIN_MARKETPLACE_NAME = 'builtin'

/**
 * 注册一个内置插件。在启动时从 initBuiltinPlugins() 中调用此函数。
 */
export function registerBuiltinPlugin(
  definition: BuiltinPluginDefinition,
): void {
  BUILTIN_PLUGINS.set(definition.name, definition)
}

/**
 * 检查一个插件 ID 是否代表内置插件（以 @builtin 结尾）。
 */
export function isBuiltinPluginId(pluginId: string): boolean {
  return pluginId.endsWith(`@${BUILTIN_MARKETPLACE_NAME}`)
}

/**
 * 根据名称获取特定内置插件的定义。
 * 用于 /plugin UI，无需市场查询即可显示技能/钩子/MCP 列表。
 */
export function getBuiltinPluginDefinition(
  name: string,
): BuiltinPluginDefinition | undefined {
  return BUILTIN_PLUGINS.get(name)
}

/**
 * 将所有已注册的内置插件作为 LoadedPlugin 对象返回，并根据用户设置（回退到 defaultEnabled）拆分为已启用/已禁用。
 * 如果 isAvailable() 返回 false，则完全省略该插件。
 */
export function getBuiltinPlugins(): {
  enabled: LoadedPlugin[]
  disabled: LoadedPlugin[]
} {
  const settings = getSettings_DEPRECATED()
  const enabled: LoadedPlugin[] = []
  const disabled: LoadedPlugin[] = []

  for (const [name, definition] of BUILTIN_PLUGINS) {
    if (definition.isAvailable && !definition.isAvailable()) {
      continue
    }

    const pluginId = `${name}@${BUILTIN_MARKETPLACE_NAME}`
    const userSetting = settings?.enabledPlugins?.[pluginId]
    // 启用状态：用户偏好 > 插件默认值 > true
    const isEnabled =
      userSetting !== undefined
        ? userSetting === true
        : (definition.defaultEnabled ?? true)

    const plugin: LoadedPlugin = {
      name,
      manifest: {
        name,
        description: definition.description,
        version: definition.version,
      },
      path: BUILTIN_MARKETPLACE_NAME, // 哨兵值 — 没有实际文件系统路径
      source: pluginId,
      repository: pluginId,
      enabled: isEnabled,
      isBuiltin: true,
      hooksConfig: definition.hooks,
      mcpServers: definition.mcpServers,
    }

    if (isEnabled) {
      enabled.push(plugin)
    } else {
      disabled.push(plugin)
    }
  }

  return { enabled, disabled }
}

/**
 * 从已启用的内置插件中获取作为 Command 对象的技能。
 * 来自已禁用插件的技能不会被返回。
 */
export function getBuiltinPluginSkillCommands(): Command[] {
  const { enabled } = getBuiltinPlugins()
  const commands: Command[] = []

  for (const plugin of enabled) {
    const definition = BUILTIN_PLUGINS.get(plugin.name)
    if (!definition?.skills) continue
    for (const skill of definition.skills) {
      commands.push(skillDefinitionToCommand(skill))
    }
  }

  return commands
}

/**
 * 清除内置插件注册表（用于测试）。
 */
export function clearBuiltinPlugins(): void {
  BUILTIN_PLUGINS.clear()
}

// --

function skillDefinitionToCommand(definition: BundledSkillDefinition): Command {
  return {
    type: 'prompt',
    name: definition.name,
    description: definition.description,
    hasUserSpecifiedDescription: true,
    allowedTools: definition.allowedTools ?? [],
    argumentHint: definition.argumentHint,
    whenToUse: definition.whenToUse,
    model: definition.model,
    disableModelInvocation: definition.disableModelInvocation ?? false,
    userInvocable: definition.userInvocable ?? true,
    contentLength: 0,
    // 使用 'bundled' 而不是 'builtin' — Command.source 中的 'builtin' 表示硬编码的斜杠命令（/help、/clear）。
    // 使用 'bundled' 可以使这些技能出现在 Skill 工具的列表中、分析名称日志中以及提示截断豁免中。
    // 用户可切换的方面由 LoadedPlugin.isBuiltin 跟踪。
    source: 'bundled',
    loadedFrom: 'bundled',
    hooks: definition.hooks,
    context: definition.context,
    agent: definition.agent,
    isEnabled: definition.isEnabled ?? (() => true),
    isHidden: !(definition.userInvocable ?? true),
    progressMessage: 'running',
    getPromptForCommand: definition.getPromptForCommand,
  }
}