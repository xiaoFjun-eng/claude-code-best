import axios from 'axios'
import { constants as fsConstants } from 'fs'
import { access, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { getDynamicConfig_BLOCKS_ON_INIT } from 'src/services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { type ReleaseChannel, saveGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { env } from './env.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { ClaudeError, getErrnoCode, isENOENT } from './errors.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import { gracefulShutdownSync } from './gracefulShutdown.js'
import { logError } from './log.js'
import { gte, lt } from './semver.js'
import { getInitialSettings } from './settings/settings.js'
import {
  filterClaudeAliases,
  getShellConfigPaths,
  readFileLines,
  writeFileLines,
} from './shellConfig.js'
import { jsonParse } from './slowOperations.js'

const GCS_BUCKET_URL =
  'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases'

class AutoUpdaterError extends ClaudeError {}

export type InstallStatus =
  | 'success'
  | 'no_permissions'
  | 'install_failed'
  | 'in_progress'

export type AutoUpdaterResult = {
  version: string | null
  status: InstallStatus
  notifications?: string[]
}

export type MaxVersionConfig = {
  external?: string
  ant?: string
  external_message?: string
  ant_message?: string
}

/**
 * 检查当前版本是否满足 Statsig 配置中的最低版本要求
 * 如果版本过旧则终止进程并显示错误信息
 *
 * 关于基于 SHA 的版本控制说明：
 * 我们使用符合 SemVer 规范的版本控制，并带有构建元数据格式（X.X.X+SHA）以实现持续部署。
 * 根据 SemVer 规范，比较版本时会忽略构建元数据（+SHA 部分）。
 *
 * 版本管理方法：
 * 1. 对于版本要求/兼容性（assertMinVersion），使用忽略构建元数据的 semver 比较
 * 2. 对于更新（'claude update'），使用精确字符串比较来检测任何更改，包括 SHA
 *    - 这确保用户始终获得最新构建，即使仅 SHA 发生变化
 *    - UI 清晰显示包含构建元数据的两个版本
 *
 * 此方法保持版本比较逻辑简单，同时通过 SHA 保持可追溯性。
 */
export async function assertMinVersion(): Promise<void> {
  if (process.env.NODE_ENV === 'test') {
    return
  }

  try {
    const versionConfig = await getDynamicConfig_BLOCKS_ON_INIT<{
      minVersion: string
    }>('tengu_version_config', { minVersion: '0.0.0' })

    if (
      versionConfig.minVersion &&
      lt(MACRO.VERSION, versionConfig.minVersion)
    ) {
      console.error(`
您的 Claude Code 版本（${MACRO.VERSION}）似乎需要更新。
需要更新到更高版本（${versionConfig.minVersion} 或更高）才能继续。

请运行以下命令进行更新：
    claude update

这将确保您能够访问最新的功能和改进。
`)
      gracefulShutdownSync(1)
    }
  } catch (error) {
    logError(error as Error)
  }
}

/**
 * 返回当前用户类型允许的最高版本。
 * 对于 ants，返回 `ant` 字段（开发版本格式）。
 * 对于外部用户，返回 `external` 字段（干净的 semver）。
 * 这用作服务端终止开关，在事故期间暂停自动更新。
 * 如果未配置上限，则返回 undefined。
 */
export async function getMaxVersion(): Promise<string | undefined> {
  const config = await getMaxVersionConfig()
  if (process.env.USER_TYPE === 'ant') {
    return config.ant || undefined
  }
  return config.external || undefined
}

/**
 * 返回服务端驱动的消息，解释已知问题（如果已配置）。
 * 当当前版本超过允许的最高版本时，在警告横幅中显示。
 */
export async function getMaxVersionMessage(): Promise<string | undefined> {
  const config = await getMaxVersionConfig()
  if (process.env.USER_TYPE === 'ant') {
    return config.ant_message || undefined
  }
  return config.external_message || undefined
}

async function getMaxVersionConfig(): Promise<MaxVersionConfig> {
  try {
    return await getDynamicConfig_BLOCKS_ON_INIT<MaxVersionConfig>(
      'tengu_max_version_config',
      {},
    )
  } catch (error) {
    logError(error as Error)
    return {}
  }
}

/**
 * 检查目标版本是否应因用户的 minimumVersion 设置而被跳过。
 * 当切换到稳定通道时使用 —— 用户可以选择停留在当前版本直到稳定版追上，从而防止降级。
 */
export function shouldSkipVersion(targetVersion: string): boolean {
  const settings = getInitialSettings()
  const minimumVersion = settings?.minimumVersion
  if (!minimumVersion) {
    return false
  }
  // 如果目标版本小于最低版本则跳过
  const shouldSkip = !gte(targetVersion, minimumVersion)
  if (shouldSkip) {
    logForDebugging(
      `跳过更新到 ${targetVersion} —— 低于 minimumVersion ${minimumVersion}`,
    )
  }
  return shouldSkip
}

// 自动更新器的锁文件，防止并发更新
const LOCK_TIMEOUT_MS = 5 * 60 * 1000 // 锁超时 5 分钟

/**
 * 获取锁文件的路径
 * 这是一个函数，以确保在测试设置后于运行时评估
 */
export function getLockFilePath(): string {
  return join(getClaudeConfigHomeDir(), '.update.lock')
}

/**
 * 尝试获取自动更新器的锁
 * @returns 如果获取到锁则返回 true，如果另一个进程持有锁则返回 false
 */
async function acquireLock(): Promise<boolean> {
  const fs = getFsImplementation()
  const lockPath = getLockFilePath()

  // 检查现有锁：在快乐路径（新锁或 ENOENT）上 1 次 stat()，
  // 在过时锁恢复时 2 次（在 unlink 前立即重新验证过时状态）。
  try {
    const stats = await fs.stat(lockPath)
    const age = Date.now() - stats.mtimeMs
    if (age < LOCK_TIMEOUT_MS) {
      return false
    }
    // 锁已过时，在接管前移除它。在 unlink 前立即重新验证过时状态，
    // 以关闭 TOCTOU 竞争：如果两个进程都观察到过时锁，A 解除链接 + 写入新锁，
    // 然后 B 会解除链接 A 的新锁，并且两者都认为自己持有锁。
    // 新锁具有较新的 mtime，因此重新检查过时状态会使 B 退避。
    try {
      const recheck = await fs.stat(lockPath)
      if (Date.now() - recheck.mtimeMs < LOCK_TIMEOUT_MS) {
        return false
      }
      await fs.unlink(lockPath)
    } catch (err) {
      if (!isENOENT(err)) {
        logError(err as Error)
        return false
      }
    }
  } catch (err) {
    if (!isENOENT(err)) {
      logError(err as Error)
      return false
    }
    // ENOENT：没有锁文件，继续创建
  }

  // 使用 O_EXCL（flag: 'wx'）原子创建锁文件。如果另一个进程赢得竞争并先创建它，我们会得到 EEXIST 并退避。
  // 在 ENOENT 时延迟创建配置目录。
  try {
    await writeFile(lockPath, `${process.pid}`, {
      encoding: 'utf8',
      flag: 'wx',
    })
    return true
  } catch (err) {
    const code = getErrnoCode(err)
    if (code === 'EEXIST') {
      return false
    }
    if (code === 'ENOENT') {
      try {
        // getFsImplementation() 的 fs.mkdir 总是 recursive:true 并在内部吞掉 EEXIST，
        // 因此目录创建竞争不会到达下面的 catch —— 只有 writeFile 的 EEXIST（真正的锁竞争）可以。
        await fs.mkdir(getClaudeConfigHomeDir())
        await writeFile(lockPath, `${process.pid}`, {
          encoding: 'utf8',
          flag: 'wx',
        })
        return true
      } catch (mkdirErr) {
        if (getErrnoCode(mkdirErr) === 'EEXIST') {
          return false
        }
        logError(mkdirErr as Error)
        return false
      }
    }
    logError(err as Error)
    return false
  }
}

/**
 * 如果锁由当前进程持有，则释放更新锁
 */
async function releaseLock(): Promise<void> {
  const fs = getFsImplementation()
  const lockPath = getLockFilePath()
  try {
    const lockData = await fs.readFile(lockPath, { encoding: 'utf8' })
    if (lockData === `${process.pid}`) {
      await fs.unlink(lockPath)
    }
  } catch (err) {
    if (isENOENT(err)) {
      return
    }
    logError(err as Error)
  }
}

async function getInstallationPrefix(): Promise<string | null> {
  // 从主目录运行以避免读取项目级的 .npmrc/.bunfig.toml
  const isBun = env.isRunningWithBun()
  let prefixResult = null
  if (isBun) {
    prefixResult = await execFileNoThrowWithCwd('bun', ['pm', 'bin', '-g'], {
      cwd: homedir(),
    })
  } else {
    prefixResult = await execFileNoThrowWithCwd(
      'npm',
      ['-g', 'config', 'get', 'prefix'],
      { cwd: homedir() },
    )
  }
  if (prefixResult.code !== 0) {
    logError(new Error(`检查 ${isBun ? 'bun' : 'npm'} 权限失败`))
    return null
  }
  return prefixResult.stdout.trim()
}

export async function checkGlobalInstallPermissions(): Promise<{
  hasPermissions: boolean
  npmPrefix: string | null
}> {
  try {
    const prefix = await getInstallationPrefix()
    if (!prefix) {
      return { hasPermissions: false, npmPrefix: null }
    }

    try {
      await access(prefix, fsConstants.W_OK)
      return { hasPermissions: true, npmPrefix: prefix }
    } catch {
      logError(
        new AutoUpdaterError('全局 npm 安装权限不足。'),
      )
      return { hasPermissions: false, npmPrefix: prefix }
    }
  } catch (error) {
    logError(error as Error)
    return { hasPermissions: false, npmPrefix: null }
  }
}

export async function getLatestVersion(
  channel: ReleaseChannel,
): Promise<string | null> {
  const npmTag = channel === 'stable' ? 'stable' : 'latest'

  // 从主目录运行以避免读取项目级的 .npmrc
  // 项目级 .npmrc 可能被恶意构造以重定向到攻击者的注册表
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['view', `${MACRO.PACKAGE_URL}@${npmTag}`, 'version', '--prefer-online'],
    { abortSignal: AbortSignal.timeout(5000), cwd: homedir() },
  )
  if (result.code !== 0) {
    logForDebugging(`npm view 失败，代码 ${result.code}`)
    if (result.stderr) {
      logForDebugging(`npm stderr: ${result.stderr.trim()}`)
    } else {
      logForDebugging('npm stderr: (空)')
    }
    if (result.stdout) {
      logForDebugging(`npm stdout: ${result.stdout.trim()}`)
    }
    return null
  }
  return result.stdout.trim()
}

export type NpmDistTags = {
  latest: string | null
  stable: string | null
}

/**
 * 从注册表获取 npm dist-tags（latest 和 stable 版本）。
 * 由 doctor 命令使用，向用户显示可用的版本。
 */
export async function getNpmDistTags(): Promise<NpmDistTags> {
  // 从主目录运行以避免读取项目级的 .npmrc
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['view', MACRO.PACKAGE_URL, 'dist-tags', '--json', '--prefer-online'],
    { abortSignal: AbortSignal.timeout(5000), cwd: homedir() },
  )

  if (result.code !== 0) {
    logForDebugging(`npm view dist-tags 失败，代码 ${result.code}`)
    return { latest: null, stable: null }
  }

  try {
    const parsed = jsonParse(result.stdout.trim()) as Record<string, unknown>
    return {
      latest: typeof parsed.latest === 'string' ? parsed.latest : null,
      stable: typeof parsed.stable === 'string' ? parsed.stable : null,
    }
  } catch (error) {
    logForDebugging(`解析 dist-tags 失败: ${error}`)
    return { latest: null, stable: null }
  }
}

/**
 * 从 GCS 存储桶获取给定发布通道的最新版本。
 * 用于没有 npm 的安装（例如包管理器安装）。
 */
export async function getLatestVersionFromGcs(
  channel: ReleaseChannel,
): Promise<string | null> {
  try {
    const response = await axios.get(`${GCS_BUCKET_URL}/${channel}`, {
      timeout: 5000,
      responseType: 'text',
    })
    return response.data.trim()
  } catch (error) {
    logForDebugging(`从 GCS 获取 ${channel} 失败: ${error}`)
    return null
  }
}

/**
 * 从 GCS 存储桶获取可用版本（用于原生安装）。
 * 同时获取 latest 和 stable 通道指针。
 */
export async function getGcsDistTags(): Promise<NpmDistTags> {
  const [latest, stable] = await Promise.all([
    getLatestVersionFromGcs('latest'),
    getLatestVersionFromGcs('stable'),
  ])

  return { latest, stable }
}

/**
 * 从 npm 注册表获取版本历史（仅限 ant 内部功能）
 * 返回按最新排序的版本，限制为指定数量
 *
 * 在可用时使用 NATIVE_PACKAGE_URL，因为：
 * 1. 原生安装是 ant 用户的主要安装方法
 * 2. 并非所有 JS 包版本都有对应的原生包
 * 3. 这可以防止回滚列出没有原生二进制文件的版本
 */
export async function getVersionHistory(limit: number): Promise<string[]> {
  if (process.env.USER_TYPE !== 'ant') {
    return []
  }

  // 在可用时使用原生包 URL，以确保我们只显示具有原生二进制文件的版本
  // （并非所有 JS 包版本都有原生构建）
  const packageUrl = MACRO.NATIVE_PACKAGE_URL ?? MACRO.PACKAGE_URL

  // 从主目录运行以避免读取项目级的 .npmrc
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['view', packageUrl, 'versions', '--json', '--prefer-online'],
    // 版本列表的超时时间更长
    { abortSignal: AbortSignal.timeout(30000), cwd: homedir() },
  )

  if (result.code !== 0) {
    logForDebugging(`npm view versions 失败，代码 ${result.code}`)
    if (result.stderr) {
      logForDebugging(`npm stderr: ${result.stderr.trim()}`)
    }
    return []
  }

  try {
    const versions = jsonParse(result.stdout.trim()) as string[]
    // 取最后 N 个版本，然后反转以获得最新优先
    return versions.slice(-limit).reverse()
  } catch (error) {
    logForDebugging(`解析版本历史失败: ${error}`)
    return []
  }
}

export async function installGlobalPackage(
  specificVersion?: string | null,
): Promise<InstallStatus> {
  if (!(await acquireLock())) {
    logError(
      new AutoUpdaterError('另一个进程当前正在安装更新'),
    )
    // 记录锁竞争
    logEvent('tengu_auto_updater_lock_contention', {
      pid: process.pid,
      currentVersion:
        MACRO.VERSION as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return 'in_progress'
  }

  try {
    await removeClaudeAliasesFromShellConfigs()
    // 检查是否在 WSL 中使用来自 Windows 路径的 npm
    if (!env.isRunningWithBun() && env.isNpmFromWindowsPath()) {
      logError(new Error('在 WSL 环境中检测到 Windows NPM'))
      logEvent('tengu_auto_updater_windows_npm_in_wsl', {
        currentVersion:
          MACRO.VERSION as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      console.error(`
错误：在 WSL 中检测到 Windows NPM

您在 WSL 中运行 Claude Code，但使用的是来自 /mnt/c/ 的 Windows NPM 安装。
此配置不支持更新。

要解决此问题：
  1. 在您的 Linux 发行版中安装 Node.js：例如 sudo apt install nodejs npm
  2. 确保 Linux NPM 在 PATH 中位于 Windows 版本之前
  3. 使用 'claude update' 再次尝试更新
`)
      return 'install_failed'
    }

    const { hasPermissions } = await checkGlobalInstallPermissions()
    if (!hasPermissions) {
      return 'no_permissions'
    }

    // 如果提供了特定版本则使用，否则使用最新版本
    const packageSpec = specificVersion
      ? `${MACRO.PACKAGE_URL}@${specificVersion}`
      : MACRO.PACKAGE_URL

    // 从主目录运行以避免读取项目级的 .npmrc/.bunfig.toml
    // 项目级配置可能被恶意构造以重定向到攻击者的注册表
    const packageManager = env.isRunningWithBun() ? 'bun' : 'npm'
    const installResult = await execFileNoThrowWithCwd(
      packageManager,
      ['install', '-g', packageSpec],
      { cwd: homedir() },
    )
    if (installResult.code !== 0) {
      const error = new AutoUpdaterError(
        `安装新版本 claude 失败: ${installResult.stdout} ${installResult.stderr}`,
      )
      logError(error)
      return 'install_failed'
    }

    // 设置 installMethod 为 'global' 以跟踪 npm 全局安装
    saveGlobalConfig(current => ({
      ...current,
      installMethod: 'global',
    }))

    return 'success'
  } finally {
    // 确保始终释放锁
    await releaseLock()
  }
}

/**
 * 从 shell 配置文件中移除 claude 别名
 * 这有助于在切换到原生或 npm 全局安装时清理旧的安装方法
 */
async function removeClaudeAliasesFromShellConfigs(): Promise<void> {
  const configMap = getShellConfigPaths()

  // 处理每个 shell 配置文件
  for (const [, configFile] of Object.entries(configMap)) {
    try {
      const lines = await readFileLines(configFile)
      if (!lines) continue

      const { filtered, hadAlias } = filterClaudeAliases(lines)

      if (hadAlias) {
        await writeFileLines(configFile, filtered)
        logForDebugging(`已从 ${configFile} 移除 claude 别名`)
      }
    } catch (error) {
      // 不要因为一个文件处理失败而使整个操作失败
      logForDebugging(`从 ${configFile} 移除别名失败: ${error}`, {
        level: 'error',
      })
    }
  }
}