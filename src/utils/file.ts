import { chmodSync, writeFileSync as fsWriteFileSync } from 'fs'
import { realpath, stat } from 'fs/promises'
import { homedir } from 'os'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getCwd } from '../utils/cwd.js'
import { logForDebugging } from './debug.js'
import { isENOENT, isFsInaccessible } from './errors.js'
import {
  detectEncodingForResolvedPath,
  detectLineEndingsForString,
  type LineEndingType,
} from './fileRead.js'
import { fileReadCache } from './fileReadCache.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'
import { logError } from './log.js'
import { expandPath } from './path.js'
import { getPlatform } from './platform.js'

export type File = {
  filename: string
  content: string
}

/**
 * 异步检查路径是否存在。
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export const MAX_OUTPUT_SIZE = 0.25 * 1024 * 1024 // 0.25MB 字节

export function readFileSafe(filepath: string): string | null {
  try {
    const fs = getFsImplementation()
    return fs.readFileSync(filepath, { encoding: 'utf8' })
  } catch (error) {
    logError(error)
    return null
  }
}

/**
 * 获取文件的规范化修改时间（毫秒）。
 * 使用 Math.floor 确保跨文件操作的时间戳比较一致，减少来自亚毫秒级精度变化（例如，来自 IDE 文件监视器在不更改内容的情况下触及文件）的误报。
 */
export function getFileModificationTime(filePath: string): number {
  const fs = getFsImplementation()
  return Math.floor(fs.statSync(filePath).mtimeMs)
}

/**
 * getFileModificationTime 的异步变体。相同的 Math.floor 语义。
 * 在异步路径中使用此方法（getChangedFiles 在每个轮次对每个 readFileState 条目运行 —— 同步的 statSync 会在网络/慢速磁盘上触发慢操作指示器）。
 */
export async function getFileModificationTimeAsync(
  filePath: string,
): Promise<number> {
  const s = await getFsImplementation().stat(filePath)
  return Math.floor(s.mtimeMs)
}

export function writeTextContent(
  filePath: string,
  content: string,
  encoding: BufferEncoding,
  endings: LineEndingType,
): void {
  let toWrite = content
  if (endings === 'CRLF') {
    // 首先将任何现有的 CRLF 规范化为 LF，这样已经包含 \r\n（原始模型输出）的新字符串在拼接后不会变成 \r\r\n。
    toWrite = content.replaceAll('\r\n', '\n').split('\n').join('\r\n')
  }

  writeFileSyncAndFlush_DEPRECATED(filePath, toWrite, { encoding })
}

export function detectFileEncoding(filePath: string): BufferEncoding {
  try {
    const fs = getFsImplementation()
    const { resolvedPath } = safeResolvePath(fs, filePath)
    return detectEncodingForResolvedPath(resolvedPath)
  } catch (error) {
    if (isFsInaccessible(error)) {
      logForDebugging(
        `detectFileEncoding 因预期原因失败: ${error.code}`,
        {
          level: 'debug',
        },
      )
    } else {
      logError(error)
    }
    return 'utf8'
  }
}

export function detectLineEndings(
  filePath: string,
  encoding: BufferEncoding = 'utf8',
): LineEndingType {
  try {
    const fs = getFsImplementation()
    const { resolvedPath } = safeResolvePath(fs, filePath)
    const { buffer, bytesRead } = fs.readSync(resolvedPath, { length: 4096 })

    const content = buffer.toString(encoding, 0, bytesRead)
    return detectLineEndingsForString(content)
  } catch (error) {
    logError(error)
    return 'LF'
  }
}

export function convertLeadingTabsToSpaces(content: string): string {
  // 即使不匹配，/gm 正则也会扫描每一行；对于常见的无制表符情况，完全跳过。
  if (!content.includes('\t')) return content
  return content.replace(/^\t+/gm, _ => '  '.repeat(_.length))
}

export function getAbsoluteAndRelativePaths(path: string | undefined): {
  absolutePath: string | undefined
  relativePath: string | undefined
} {
  const absolutePath = path ? expandPath(path) : undefined
  const relativePath = absolutePath
    ? relative(getCwd(), absolutePath)
    : undefined
  return { absolutePath, relativePath }
}

export function getDisplayPath(filePath: string): string {
  // 如果文件在当前工作目录中，使用相对路径
  const { relativePath } = getAbsoluteAndRelativePaths(filePath)
  if (relativePath && !relativePath.startsWith('..')) {
    return relativePath
  }

  // 对于主目录中的文件，使用波浪号表示法
  const homeDir = homedir()
  if (filePath.startsWith(homeDir + sep)) {
    return '~' + filePath.slice(homeDir.length)
  }

  // 否则返回绝对路径
  return filePath
}

/**
 * 在同一目录中查找具有相同名称但不同扩展名的文件
 * @param filePath 不存在文件的路径
 * @returns 找到的具有不同扩展名的文件，如果没有找到则返回 undefined
 */

export function findSimilarFile(filePath: string): string | undefined {
  const fs = getFsImplementation()
  try {
    const dir = dirname(filePath)
    const fileBaseName = basename(filePath, extname(filePath))

    // 获取目录中的所有文件
    const files = fs.readdirSync(dir)

    // 查找具有相同基础名称但不同扩展名的文件
    const similarFiles = files.filter(
      file =>
        basename(file.name, extname(file.name)) === fileBaseName &&
        join(dir, file.name) !== filePath,
    )

    // 如果找到匹配项，则返回第一个匹配项的文件名
    const firstMatch = similarFiles[0]
    if (firstMatch) {
      return firstMatch.name
    }
    return undefined
  } catch (error) {
    // 缺失目录（ENOENT）是预期的；对于其他错误，记录日志并返回 undefined
    if (!isENOENT(error)) {
      logError(error)
    }
    return undefined
  }
}

/**
 * 包含 cwd 注释的文件未找到错误消息中包含的标记。
 * UI 渲染器检查此标记以显示简短的“文件未找到”消息。
 */
export const FILE_NOT_FOUND_CWD_NOTE = '注意：您当前的工作目录是'

/**
 * 当文件/目录未找到时，建议当前工作目录下的修正路径。
 * 检测“丢失的仓库文件夹”模式，即模型构造的绝对路径缺少仓库目录组件。
 *
 * 示例：
 *   cwd = /Users/zeeg/src/currentRepo
 *   requestedPath = /Users/zeeg/src/foobar           （不存在）
 *   returns        /Users/zeeg/src/currentRepo/foobar （如果存在）
 *
 * @param requestedPath - 未找到的绝对路径
 * @returns 如果在 cwd 下找到则返回修正后的路径，否则返回 undefined
 */
export async function suggestPathUnderCwd(
  requestedPath: string,
): Promise<string | undefined> {
  const cwd = getCwd()
  const cwdParent = dirname(cwd)

  // 解析请求路径的父目录中的符号链接（例如 macOS 上的 /tmp -> /private/tmp）
  // 以便前缀比较能正确针对 cwd（它已经通过 realpath 解析）工作。
  let resolvedPath = requestedPath
  try {
    const resolvedDir = await realpath(dirname(requestedPath))
    resolvedPath = join(resolvedDir, basename(requestedPath))
  } catch {
    // 父目录不存在，使用原始路径
  }

  // 仅当请求路径位于 cwd 的父目录下但不在 cwd 本身下时进行检查。
  // 当 cwdParent 是根目录（例如 '/'）时，直接将其作为前缀使用，以避免出现永远无法匹配的双分隔符 '//'。
  const cwdParentPrefix = cwdParent === sep ? sep : cwdParent + sep
  if (
    !resolvedPath.startsWith(cwdParentPrefix) ||
    resolvedPath.startsWith(cwd + sep) ||
    resolvedPath === cwd
  ) {
    return undefined
  }

  // 从父目录获取相对路径
  const relFromParent = relative(cwdParent, resolvedPath)

  // 检查相同的相对路径是否存在于 cwd 下
  const correctedPath = join(cwd, relFromParent)
  try {
    await stat(correctedPath)
    return correctedPath
  } catch {
    return undefined
  }
}

/**
 * 是否使用紧凑的行号前缀格式（`N\t` 而不是 `     N→`）。填充箭头格式每行开销 9 字节；
 * 在 13.5 亿次 Read 调用 × 平均 132 行的情况下，这占集群未缓存输入的 2.18%
 *（bq-queries/read_line_prefix_overhead_verify.sql）。
 *
 * Ant 浸泡验证没有 Edit 错误回归（6.29% vs 6.86% 基线）。
 * 终止开关模式：如果问题在外部浮现，GB 可以禁用。
 */
export function isCompactLinePrefixEnabled(): boolean {
  // 3P 默认值：终止开关关闭 = 启用紧凑格式。仅客户端 —— 无需服务器支持，对 Bedrock/Vertex/Foundry 安全。
  return !getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_compact_line_prefix_killswitch',
    false,
  )
}

/**
 * 向内容添加类似 cat -n 风格的行号。
 */
export function addLineNumbers({
  content,
  // 1 索引
  startLine,
}: {
  content: string
  startLine: number
}): string {
  if (!content) {
    return ''
  }

  const lines = content.split(/\r?\n/)

  if (isCompactLinePrefixEnabled()) {
    return lines
      .map((line, index) => `${index + startLine}\t${line}`)
      .join('\n')
  }

  return lines
    .map((line, index) => {
      const numStr = String(index + startLine)
      if (numStr.length >= 6) {
        return `${numStr}→${line}`
      }
      return `${numStr.padStart(6, ' ')}→${line}`
    })
    .join('\n')
}

/**
 * addLineNumbers 的逆操作 —— 从单行中去除 `N→` 或 `N\t` 前缀。
 * 放在这里以便此处的格式更改与 addLineNumbers 中的更改保持同步。
 */
export function stripLineNumberPrefix(line: string): string {
  const match = line.match(/^\s*\d+[\u2192\t](.*)$/)
  return match?.[1] ?? line
}

/**
 * 检查目录是否为空。
 * @param dirPath 要检查的目录路径
 * @returns 如果目录为空或不存在则返回 true，否则返回 false
 */
export function isDirEmpty(dirPath: string): boolean {
  try {
    return getFsImplementation().isDirEmptySync(dirPath)
  } catch (e) {
    // ENOENT：目录不存在，视为空
    // 其他错误（macOS 受保护文件夹上的 EPERM 等）：假设不为空
    return isENOENT(e)
  }
}

/**
 * 使用缓存读取文件以避免冗余的 I/O 操作。
 * 这是 FileEditTool 操作的首选方法。
 */
export function readFileSyncCached(filePath: string): string {
  const { content } = fileReadCache.readFile(filePath)
  return content
}

/**
 * 将内容写入文件并将文件刷新到磁盘
 * @param filePath 要写入的文件的路径
 * @param content 要写入文件的内容
 * @param options 写入文件的选项，包括编码和模式
 * @deprecated 对于非阻塞写入，请使用带有 flush 选项的 `fs.promises.writeFile`。
 * 同步文件写入会阻塞事件循环并导致性能问题。
 */
export function writeFileSyncAndFlush_DEPRECATED(
  filePath: string,
  content: string,
  options: { encoding: BufferEncoding; mode?: number } = { encoding: 'utf-8' },
): void {
  const fs = getFsImplementation()

  // 检查目标文件是否为符号链接，以便为所有用户保留它
  // 注意：我们不使用 safeResolvePath，因为我们需要手动处理符号链接，以确保在保留符号链接本身的同时写入目标
  let targetPath = filePath
  try {
    // 尝试读取符号链接 - 如果成功，则它是符号链接
    const linkTarget = fs.readlinkSync(filePath)
    // 解析为绝对路径
    targetPath = isAbsolute(linkTarget)
      ? linkTarget
      : resolve(dirname(filePath), linkTarget)
    logForDebugging(`通过符号链接写入: ${filePath} -> ${targetPath}`)
  } catch {
    // ENOENT（不存在）或 EINVAL（不是符号链接）—— 保持 targetPath = filePath
  }

  // 首先尝试原子写入
  const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`

  // 检查目标文件是否存在并获取其权限（单个 stat，在原子路径和回退路径中重用）
  let targetMode: number | undefined
  let targetExists = false
  try {
    targetMode = fs.statSync(targetPath).mode
    targetExists = true
    logForDebugging(`保留文件权限: ${targetMode.toString(8)}`)
  } catch (e) {
    if (!isENOENT(e)) throw e
    if (options.mode !== undefined) {
      // 为新文件使用提供的模式
      targetMode = options.mode
      logForDebugging(
        `为新文件设置权限: ${targetMode.toString(8)}`,
      )
    }
  }

  try {
    logForDebugging(`写入临时文件: ${tempPath}`)

    // 写入临时文件并刷新，并设置模式（如果是新文件）
    const writeOptions: {
      encoding: BufferEncoding
      flush: boolean
      mode?: number
    } = {
      encoding: options.encoding,
      flush: true,
    }
    // 仅在新文件时在 writeFileSync 中设置模式，以确保原子权限设置
    if (!targetExists && options.mode !== undefined) {
      writeOptions.mode = options.mode
    }

    fsWriteFileSync(tempPath, content, writeOptions)
    logForDebugging(
      `临时文件写入成功，大小: ${content.length} 字节`,
    )

    // 对于现有文件，或者如果模式未原子设置，则应用权限
    if (targetExists && targetMode !== undefined) {
      chmodSync(tempPath, targetMode)
      logForDebugging(`已将原始权限应用于临时文件`)
    }

    // 原子重命名（在 POSIX 系统上，这是原子的）
    // 在 Windows 上，如果目标存在，这将覆盖目标
    logForDebugging(`重命名 ${tempPath} 为 ${targetPath}`)
    fs.renameSync(tempPath, targetPath)
    logForDebugging(`文件 ${targetPath} 已原子写入`)
  } catch (atomicError) {
    logForDebugging(`原子写入文件失败: ${atomicError}`, {
      level: 'error',
    })
    logEvent('tengu_atomic_write_error', {})

    // 出错时清理临时文件
    try {
      logForDebugging(`清理临时文件: ${tempPath}`)
      fs.unlinkSync(tempPath)
    } catch (cleanupError) {
      logForDebugging(`清理临时文件失败: ${cleanupError}`)
    }

    // 回退到非原子写入
    logForDebugging(`回退到非原子写入: ${targetPath}`)
    try {
      const fallbackOptions: {
        encoding: BufferEncoding
        flush: boolean
        mode?: number
      } = {
        encoding: options.encoding,
        flush: true,
      }
      // 仅对新文件设置模式
      if (!targetExists && options.mode !== undefined) {
        fallbackOptions.mode = options.mode
      }

      fsWriteFileSync(targetPath, content, fallbackOptions)
      logForDebugging(
        `文件 ${targetPath} 已使用非原子回退成功写入`,
      )
    } catch (fallbackError) {
      logForDebugging(`非原子写入也失败: ${fallbackError}`)
      throw fallbackError
    }
  }
}

export function getDesktopPath(): string {
  const platform = getPlatform()
  const homeDir = homedir()

  if (platform === 'macos') {
    return join(homeDir, 'Desktop')
  }

  if (platform === 'windows') {
    // 对于 WSL，尝试访问 Windows 桌面
    const windowsHome = process.env.USERPROFILE
      ? process.env.USERPROFILE.replace(/\\/g, '/')
      : null

    if (windowsHome) {
      const wslPath = windowsHome.replace(/^[A-Z]:/, '')
      const desktopPath = `/mnt/c${wslPath}/Desktop`

      if (getFsImplementation().existsSync(desktopPath)) {
        return desktopPath
      }
    }

    // 回退：尝试在典型的 Windows 用户位置查找桌面
    try {
      const usersDir = '/mnt/c/Users'
      const userDirs = getFsImplementation().readdirSync(usersDir)

      for (const user of userDirs) {
        if (
          user.name === 'Public' ||
          user.name === 'Default' ||
          user.name === 'Default User' ||
          user.name === 'All Users'
        ) {
          continue
        }

        const potentialDesktopPath = join(usersDir, user.name, 'Desktop')

        if (getFsImplementation().existsSync(potentialDesktopPath)) {
          return potentialDesktopPath
        }
      }
    } catch (error) {
      logError(error)
    }
  }

  // Linux/未知平台回退
  const desktopPath = join(homeDir, 'Desktop')
  if (getFsImplementation().existsSync(desktopPath)) {
    return desktopPath
  }

  // 如果 Desktop 文件夹不存在，回退到主目录
  return homeDir
}

/**
 * 验证文件大小是否在指定的限制内。
 * 如果文件大小在限制内则返回 true，否则返回 false。
 *
 * @param filePath 要验证的文件的路径
 * @param maxSizeBytes 允许的最大文件大小（字节）
 * @returns 如果文件大小在限制内则返回 true，否则返回 false
 */
export function isFileWithinReadSizeLimit(
  filePath: string,
  maxSizeBytes: number = MAX_OUTPUT_SIZE,
): boolean {
  try {
    const stats = getFsImplementation().statSync(filePath)
    return stats.size <= maxSizeBytes
  } catch {
    // 如果无法获取文件状态，返回 false 表示验证失败
    return false
  }
}

/**
 * 规范化文件路径以进行比较，处理平台差异。
 * 在 Windows 上，规范化路径分隔符并转换为小写以实现不区分大小写的比较。
 */
export function normalizePathForComparison(filePath: string): string {
  // 使用 path.normalize() 清理冗余分隔符并解析 . 和 ..
  let normalized = normalize(filePath)

  // 将分隔符转换为稳定的斜杠形式，以便比较行为跨平台以及在测试中使用 POSIX 风格夹具时保持一致。
  normalized = normalized.replace(/\\/g, '/')

  // 在 Windows 上，规范化大小写以实现不区分大小写的比较。
  if (getPlatform() === 'windows') {
    normalized = normalized.toLowerCase()
  }

  return normalized
}

/**
 * 比较两个文件路径是否相等，处理 Windows 不区分大小写的情况。
 */
export function pathsEqual(path1: string, path2: string): boolean {
  return normalizePathForComparison(path1) === normalizePathForComparison(path2)
}