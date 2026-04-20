import { relative } from 'path'
import React from 'react'
import { getCwdState } from '../../bootstrap/state.js'
import { SandboxSettings } from '../../components/sandbox/SandboxSettings.js'
import { color } from '@anthropic/ink'
import { getPlatform } from '../../utils/platform.js'
import {
  addToExcludedCommands,
  SandboxManager,
} from '../../utils/sandbox/sandbox-adapter.js'
import {
  getSettings_DEPRECATED,
  getSettingsFilePathForSource,
} from '../../utils/settings/settings.js'
import type { ThemeName } from '../../utils/theme.js'

export async function call(
  onDone: (result?: string) => void,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode | null> {
  const settings = getSettings_DEPRECATED()
  const themeName: ThemeName = (settings.theme as ThemeName) || 'light'

  const platform = getPlatform()

  if (!SandboxManager.isSupportedPlatform()) {
    // WSL1 用户会看到此信息，因为 isSupportedPlatform 对 WSL1 返回 false
    const errorMessage =
      platform === 'wsl'
        ? '错误：沙盒功能需要 WSL2。不支持 WSL1。'
        : '错误：沙盒功能目前仅在 macOS、Linux 和 WSL2 上受支持。'
    const message = color('error', themeName)(errorMessage)
    onDone(message)
    return null
  }

  // 检查依赖项 - 获取包含错误/警告的结构化结果
  const depCheck = SandboxManager.checkDependencies()

  // 检查平台是否在 enabledPlatforms 列表中（未公开的企业设置）
  if (!SandboxManager.isPlatformInEnabledList()) {
    const message = color(
      'error',
      themeName,
    )(
      `错误：通过 enabledPlatforms 设置，此平台 (${platform}) 的沙盒功能已被禁用。`,
    )
    onDone(message)
    return null
  }

  // 检查沙盒设置是否被更高优先级的设置锁定
  if (SandboxManager.areSandboxSettingsLockedByPolicy()) {
    const message = color(
      'error',
      themeName,
    )(
      '错误：沙盒设置已被更高优先级的配置覆盖，无法在本地更改。',
    )
    onDone(message)
    return null
  }

  // 解析参数
  const trimmedArgs = args?.trim() || ''

  // 如果没有参数，则显示交互式菜单
  if (!trimmedArgs) {
    return <SandboxSettings onComplete={onDone} depCheck={depCheck} />
  }

  // 处理子命令
  if (trimmedArgs) {
    const parts = trimmedArgs.split(' ')
    const subcommand = parts[0]

    if (subcommand === 'exclude') {
      // 处理 exclude 子命令
      const commandPattern = trimmedArgs.slice('exclude '.length).trim()

      if (!commandPattern) {
        const message = color(
          'error',
          themeName,
        )(
          '错误：请提供要排除的命令模式（例如：/sandbox exclude "npm run test:*"）',
        )
        onDone(message)
        return null
      }

      // 如果存在引号则移除
      const cleanPattern = commandPattern.replace(/^["']|["']$/g, '')

      // 添加到 excludedCommands
      addToExcludedCommands(cleanPattern)

      // 获取本地设置路径并使其相对于当前工作目录
      const localSettingsPath = getSettingsFilePathForSource('localSettings')
      const relativePath = localSettingsPath
        ? relative(getCwdState(), localSettingsPath)
        : '.claude/settings.local.json'

      const message = color(
        'success',
        themeName,
      )(`已将 "${cleanPattern}" 添加到 ${relativePath} 的排除命令中`)

      onDone(message)
      return null
    } else {
      // 未知子命令
      const message = color(
        'error',
        themeName,
      )(
        `错误：未知子命令 "${subcommand}"。可用的子命令：exclude`,
      )
      onDone(message)
      return null
    }
  }

  // 由于上述已处理所有情况，此处应永远不会执行到
  return null
}
