import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import { getPlatform } from '../platform.js'

/**
 * 获取当前平台对应的托管设置目录路径。
 */
export const getManagedFilePath = memoize(function (): string {
  // 允许为测试/演示进行覆盖（仅限 Ant 内部，从外部构建中移除）
  if (
    process.env.USER_TYPE === 'ant' &&
    process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH
  ) {
    return process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH
  }

  switch (getPlatform()) {
    case 'macos':
      return '/Library/Application Support/ClaudeCode'
    case 'windows':
      return 'C:\\Program Files\\ClaudeCode'
    default:
      return '/etc/claude-code'
  }
})

/**
 * 获取 managed-settings.d/ 随插即用目录的路径。
 * 首先合并 managed-settings.json（基础配置），然后按字母顺序合并此目录中的文件
 * （随插即用配置覆盖基础配置，后面的文件覆盖前面的）。
 */
export const getManagedSettingsDropInDir = memoize(function (): string {
  return join(getManagedFilePath(), 'managed-settings.d')
})