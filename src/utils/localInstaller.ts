/**
 * 处理本地安装的工具函数
 */

import { access, chmod, writeFile } from 'fs/promises'
import { join } from 'path'
import { type ReleaseChannel, saveGlobalConfig } from './config.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { getErrnoCode } from './errors.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import { logError } from './log.js'
import { jsonStringify } from './slowOperations.js'

// 懒加载 getter：getClaudeConfigHomeDir() 是被记忆化的，并且会读取 process.env。
// 在模块作用域中求值会在入口点（如 hfi.tsx）有机会在 main() 中设置 CLAUDE_CONFIG_DIR 之前捕获其值，
// 并且还会用该过时值填充记忆化缓存，影响其他 150 多个调用方。
function getLocalInstallDir(): string {
  return join(getClaudeConfigHomeDir(), 'local')
}
export function getLocalClaudePath(): string {
  return join(getLocalInstallDir(), 'claude')
}

/**
 * 检查我们是否正在从受管理的本地安装运行
 */
export function isRunningFromLocalInstallation(): boolean {
  const execPath = process.argv[1] || ''
  return execPath.includes('/.claude/local/node_modules/')
}

/**
 * 仅当文件不存在时才将 `content` 写入 `path`。
 * 使用 O_EXCL（'wx'）实现原子性的“若缺失则创建”。
 */
async function writeIfMissing(
  path: string,
  content: string,
  mode?: number,
): Promise<boolean> {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx', mode })
    return true
  } catch (e) {
    if (getErrnoCode(e) === 'EEXIST') return false
    throw e
  }
}

/**
 * 确保本地包环境已设置
 * 创建目录、package.json 和包装脚本
 */
export async function ensureLocalPackageEnvironment(): Promise<boolean> {
  try {
    const localInstallDir = getLocalInstallDir()

    // 创建安装目录（递归、幂等）
    await getFsImplementation().mkdir(localInstallDir)

    // 如果不存在，则创建 package.json
    await writeIfMissing(
      join(localInstallDir, 'package.json'),
      jsonStringify(
        { name: 'claude-local', version: '0.0.1', private: true },
        null,
        2,
      ),
    )

    // 如果不存在，则创建包装脚本
    const wrapperPath = join(localInstallDir, 'claude')
    const created = await writeIfMissing(
      wrapperPath,
      `#!/bin/sh\nexec "${localInstallDir}/node_modules/.bin/claude" "$@"`,
      0o755,
    )
    if (created) {
      // writeFile 中的模式受 umask 影响；通过 chmod 确保可执行位被设置
      await chmod(wrapperPath, 0o755)
    }

    return true
  } catch (error) {
    logError(error)
    return false
  }
}

/**
 * 在本地目录中安装或更新 Claude CLI 包
 * @param channel - 使用的发布通道（latest 或 stable）
 * @param specificVersion - 可选的特定版本（会覆盖通道设置）
 */
export async function installOrUpdateClaudePackage(
  channel: ReleaseChannel,
  specificVersion?: string | null,
): Promise<'in_progress' | 'success' | 'install_failed'> {
  try {
    // 首先确保环境已设置
    if (!(await ensureLocalPackageEnvironment())) {
      return 'install_failed'
    }

    // 如果提供了特定版本则使用，否则使用通道标签
    const versionSpec = specificVersion
      ? specificVersion
      : channel === 'stable'
        ? 'stable'
        : 'latest'
    const result = await execFileNoThrowWithCwd(
      'npm',
      ['install', `${MACRO.PACKAGE_URL}@${versionSpec}`],
      { cwd: getLocalInstallDir(), maxBuffer: 1000000 },
    )

    if (result.code !== 0) {
      const error = new Error(
        `安装 Claude CLI 包失败：${result.stderr}`,
      )
      logError(error)
      return result.code === 190 ? 'in_progress' : 'install_failed'
    }

    // 设置 installMethod 为 'local'，以避免 npm 权限警告
    saveGlobalConfig(current => ({
      ...current,
      installMethod: 'local',
    }))

    return 'success'
  } catch (error) {
    logError(error)
    return 'install_failed'
  }
}

/**
 * 检查本地安装是否存在。
 * 纯存在性探测 — 调用方用它来选择更新路径 / UI 提示。
 */
export async function localInstallationExists(): Promise<boolean> {
  try {
    await access(join(getLocalInstallDir(), 'node_modules', '.bin', 'claude'))
    return true
  } catch {
    return false
  }
}

/**
 * 获取 Shell 类型，以确定合适的路径设置方式
 */
export function getShellType(): string {
  const shellPath = process.env.SHELL || ''
  if (shellPath.includes('zsh')) return 'zsh'
  if (shellPath.includes('bash')) return 'bash'
  if (shellPath.includes('fish')) return 'fish'
  return 'unknown'
}