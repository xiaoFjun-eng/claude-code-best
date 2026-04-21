import { createHash } from 'crypto'
import { readFileSync, realpathSync, statSync } from 'fs'
import { open, readFile, realpath, stat } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { basename, dirname, join, resolve, sep } from 'path'
import { hasBinaryExtension, isBinaryContent } from '../constants/files.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import {
  getCachedBranch,
  getCachedDefaultBranch,
  getCachedHead,
  getCachedRemoteUrl,
  getWorktreeCountFromFs,
  isShallowClone as isShallowCloneFs,
  resolveGitDir,
} from './git/gitFilesystem.js'
import { logError } from './log.js'
import { memoizeWithLRU } from './memoize.js'
import { whichSync } from './which.js'

const GIT_ROOT_NOT_FOUND = Symbol('git-root-not-found')

const findGitRootImpl = memoizeWithLRU(
  (startPath: string): string | typeof GIT_ROOT_NOT_FOUND => {
    const startTime = Date.now()
    logForDiagnosticsNoPII('info', 'find_git_root_started')

    let current = resolve(startPath)
    const root = current.substring(0, current.indexOf(sep) + 1) || sep
    let statCount = 0

    while (current !== root) {
      try {
        const gitPath = join(current, '.git')
        statCount++
        const stat = statSync(gitPath)
        // .git 可以是一个目录（常规仓库）或文件（工作树/子模块）
        if (stat.isDirectory() || stat.isFile()) {
          logForDiagnosticsNoPII('info', 'find_git_root_completed', {
            duration_ms: Date.now() - startTime,
            stat_count: statCount,
            found: true,
          })
          return current.normalize('NFC')
        }
      } catch {
        // 当前层级不存在 .git，继续向上查找
      }
      const parent = dirname(current)
      if (parent === current) {
        break
      }
      current = parent
    }

    // 同时检查根目录
    try {
      const gitPath = join(root, '.git')
      statCount++
      const stat = statSync(gitPath)
      if (stat.isDirectory() || stat.isFile()) {
        logForDiagnosticsNoPII('info', 'find_git_root_completed', {
          duration_ms: Date.now() - startTime,
          stat_count: statCount,
          found: true,
        })
        return root.normalize('NFC')
      }
    } catch {
      // 根目录下不存在 .git
    }

    logForDiagnosticsNoPII('info', 'find_git_root_completed', {
      duration_ms: Date.now() - startTime,
      stat_count: statCount,
      found: false,
    })
    return GIT_ROOT_NOT_FOUND
  },
  path => path,
  50,
)

/** 通过向上遍历目录树来查找 git 根目录。
寻找 .git 目录或文件（工作树/子模块使用文件）。
返回包含 .git 的目录，如果未找到则返回 null。

每个 startPath 使用 LRU 缓存（最多 50 条）进行记忆化，以防止
无限增长 —— gitDiff 使用 dirname(file) 调用此函数，因此编辑不同目录中的许多
文件否则会永久累积条目。 */
export const findGitRoot = createFindGitRoot()

function createFindGitRoot(): {
  (startPath: string): string | null
  cache: typeof findGitRootImpl.cache
} {
  function wrapper(startPath: string): string | null {
    const result = findGitRootImpl(startPath)
    return result === GIT_ROOT_NOT_FOUND ? null : result
  }
  wrapper.cache = findGitRootImpl.cache
  return wrapper
}

/** 将 git 根目录解析为规范的主仓库根目录。
对于常规仓库，此操作无效果。对于工作树，遵循
`.git` 文件 → `gitdir:` → `commondir` 链来查找主仓库的
工作目录。

子模块（`.git` 是文件但没有 `commondir`）会回退到
输入的根目录，这是正确的，因为子模块是独立的仓库。

使用小型 LRU 进行记忆化，以避免在热路径（权限检查、
提示构建）上重复读取文件。 */
const resolveCanonicalRoot = memoizeWithLRU(
  (gitRoot: string): string => {
    try {
      // 在工作树中，.git 是一个包含以下内容的文件：gitdir: <路径>。
      // 在常规仓库中，.git 是一个目录（readFileSync 会抛出 EISDIR 错误）。
      const gitContent = readFileSync(join(gitRoot, '.git'), 'utf-8').trim()
      if (!gitContent.startsWith('gitdir:')) {
        return gitRoot
      }
      const worktreeGitDir = resolve(
        gitRoot,
        gitContent.slice('gitdir:'.length).trim(),
      )
      // commondir 指向共享的 .git 目录（相对于工作树的 gitdir）。子模块没有
      // commondir（readFileSync 会抛出 ENOENT 错误）→ 回退。
      const commonDir = resolve(
        worktreeGitDir,
        readFileSync(join(worktreeGitDir, 'commondir'), 'utf-8').trim(),
      )
      // 安全警告：在克隆/下载的仓库中，.git 文件和 commond
      // ir 可由攻击者控制。如果不进行验证，恶意仓库可以将 common
      // dir 指向受害者信任的任何路径，从而绕过信任对话框并在启动时
      // 执行来自 .claude/settings.json 的钩子。
      //
      // 验证结构是否与 `git worktree add` 创建的结构匹
      // 配：1. worktreeGitDir 是 <commonDi
      // r>/worktrees/ 的直接子目录 → 确保我们读取的 co
      // mmondir 文件位于已解析的公共目录内，
      // 而不是攻击者的仓库内。2. <worktreeGitDir
      // >/gitdir 指回 <gitRoot>/.git → 确保攻击
      // 者无法通过猜测路径借用受害者
      // 的现有工作树条目。两者都是必需的：如果受害者拥有受信任仓库的工作树，
      // 仅（1）会失败；仅（2）会失败，因为攻击者控制 worktreeGitDir。
      if (resolve(dirname(worktreeGitDir)) !== join(commonDir, 'worktrees')) {
        return gitRoot
      }
      // Git 使用 strbuf_realpath()（解析符号链接）写入 gitd
      // ir，但来自 findGitRoot() 的 gitRoot 仅进行词法解析。对 g
      // itRoot 进行真实路径解析，以便通过符号链接路径（例如 macOS 的 /
      // tmp → /private/tmp）访问的合法工作树不会被拒绝。对目录进行真实路
      // 径解析，然后拼接 '.git' —— 对 .git 文件本身进行真实路径解析会跟随符
      // 号链接的 .git，从而允许攻击者借用受害者的反向链接。
      const backlink = realpathSync(
        readFileSync(join(worktreeGitDir, 'gitdir'), 'utf-8').trim(),
      )
      if (backlink !== join(realpathSync(gitRoot), '.git')) {
        return gitRoot
      }
      // 裸仓库工作树：公共目录不在工作目录内。使用公共目录本身作为稳
      // 定的标识（anthropics/claude-code#27994）。
      if (basename(commonDir) !== '.git') {
        return commonDir.normalize('NFC')
      }
      return dirname(commonDir).normalize('NFC')
    } catch {
      return gitRoot
    }
  },
  root => root,
  50,
)

/** 查找规范的 git 仓库根目录，解析工作树。

与 findGitRoot 不同（它返回工作树目录，即 `.git` 文件所在的位置），此函数返回主仓库的工作目录。这
确保同一仓库的所有工作树都映射到相同的项目标识。

对于项目范围的状态（自动记忆、
项目配置、代理记忆），请使用此函数代替 findGitRoot，以便工作树与主仓库共享状态。 */
export const findCanonicalGitRoot = createFindCanonicalGitRoot()

function createFindCanonicalGitRoot(): {
  (startPath: string): string | null
  cache: typeof resolveCanonicalRoot.cache
} {
  function wrapper(startPath: string): string | null {
    const root = findGitRoot(startPath)
    if (!root) {
      return null
    }
    return resolveCanonicalRoot(root)
  }
  wrapper.cache = resolveCanonicalRoot.cache
  return wrapper
}

export const gitExe = memoize((): string => {
  // 每次我们生成一个进程时，都必须查找路径。让
  // 我们改为避免该查找，这样我们只做一次。
  return whichSync('git') || 'git'
})

export const getIsGit = memoize(async (): Promise<boolean> => {
  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'is_git_check_started')

  const isGit = findGitRoot(getCwd()) !== null

  logForDiagnosticsNoPII('info', 'is_git_check_completed', {
    duration_ms: Date.now() - startTime,
    is_git: isGit,
  })
  return isGit
})

export function getGitDir(cwd: string): Promise<string | null> {
  return resolveGitDir(cwd)
}

export async function isAtGitRoot(): Promise<boolean> {
  const cwd = getCwd()
  const gitRoot = findGitRoot(cwd)
  if (!gitRoot) {
    return false
  }
  // 解析符号链接以进行精确比较
  try {
    const [resolvedCwd, resolvedGitRoot] = await Promise.all([
      realpath(cwd),
      realpath(gitRoot),
    ])
    return resolvedCwd === resolvedGitRoot
  } catch {
    return cwd === gitRoot
  }
}

export const dirIsInGitRepo = async (cwd: string): Promise<boolean> => {
  return findGitRoot(cwd) !== null
}

export const getHead = async (): Promise<string> => {
  return getCachedHead()
}

export const getBranch = async (): Promise<string> => {
  return getCachedBranch()
}

export const getDefaultBranch = async (): Promise<string> => {
  return getCachedDefaultBranch()
}

export const getRemoteUrl = async (): Promise<string | null> => {
  return getCachedRemoteUrl()
}

/** 将 git 远程 URL 规范化为用于哈希的规范形式。
将 SSH 和 HTTPS URL 转换为相同格式：host/owner/repo（小写，无 .git）

示例：
- git@github.com:owner/repo.git -> github.com/owner/repo
- https://github.com/owner/repo.git -> github.com/owner/repo
- ssh://git@github.com/owner/repo -> github.com/owner/repo
- http://local_proxy@127.0.0.1:16583/git/owner/repo -> github.com/owner/repo */
export function normalizeGitRemoteUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null

  // 处理 SSH 格式：git@host:owner/repo.git
  const sshMatch = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
  if (sshMatch && sshMatch[1] && sshMatch[2]) {
    return `${sshMatch[1]}/${sshMatch[2]}`.toLowerCase()
  }

  // 处理 HTTPS/SSH URL 格式：https://host/owner/repo.git 或 ssh://git@host/owner/repo
  const urlMatch = trimmed.match(
    /^(?:https?|ssh):\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/,
  )
  if (urlMatch && urlMatch[1] && urlMatch[2]) {
    const host = urlMatch[1]
    const path = urlMatch[2]

    // CCR git 代理 URL 使用格式：
    // 旧版：http://...@127.0.0.1:PORT/git/owner/repo
    // （假定为 github.com）GHE：    http://...@127.0.0.1:PORT/git
    // /ghe.host/owner/repo （主机名编码在路径中）移除 /git/ 前缀。
    // 如果第一个段包含点，则它是主机名（GitHub 组织名不能包含点）。否则假定为 github.com。
    if (isLocalHost(host) && path.startsWith('git/')) {
      const proxyPath = path.slice(4) // 移除 "git/" 前缀
      const segments = proxyPath.split('/')
      // 3 个或更多段，且第一个段包含点 → host/owner/repo（GHE 格式）
      if (segments.length >= 3 && segments[0]!.includes('.')) {
        return proxyPath.toLowerCase()
      }
      // 2 个段 → owner/repo（旧版格式，假定为 github.com）
      return `github.com/${proxyPath}`.toLowerCase()
    }

    return `${host}/${path}`.toLowerCase()
  }

  return null
}

/** 返回规范化 git 远程 URL 的 SHA256 哈希（前 16 个字符）。
这为仓库提供了一个全局唯一标识符，该标识符：
- 无论克隆方式是 SSH 还是 HTTPS 都相同
- 不会在日志中暴露实际的仓库名称 */
export async function getRepoRemoteHash(): Promise<string | null> {
  const remoteUrl = await getRemoteUrl()
  if (!remoteUrl) return null

  const normalized = normalizeGitRemoteUrl(remoteUrl)
  if (!normalized) return null

  const hash = createHash('sha256').update(normalized).digest('hex')
  return hash.substring(0, 16)
}

export const getIsHeadOnRemote = async (): Promise<boolean> => {
  const { code } = await execFileNoThrow(gitExe(), ['rev-parse', '@{u}'], {
    preserveOutputOnError: false,
  })
  return code === 0
}

export const hasUnpushedCommits = async (): Promise<boolean> => {
  const { stdout, code } = await execFileNoThrow(
    gitExe(),
    ['rev-list', '--count', '@{u}..HEAD'],
    { preserveOutputOnError: false },
  )
  return code === 0 && parseInt(stdout.trim(), 10) > 0
}

export const getIsClean = async (options?: {
  ignoreUntracked?: boolean
}): Promise<boolean> => {
  const args = ['--no-optional-locks', 'status', '--porcelain']
  if (options?.ignoreUntracked) {
    args.push('-uno')
  }
  const { stdout } = await execFileNoThrow(gitExe(), args, {
    preserveOutputOnError: false,
  })
  return stdout.trim().length === 0
}

export const getChangedFiles = async (): Promise<string[]> => {
  const { stdout } = await execFileNoThrow(
    gitExe(),
    ['--no-optional-locks', 'status', '--porcelain'],
    {
      preserveOutputOnError: false,
    },
  )
  return stdout
    .trim()
    .split('\n')
    .map(line => line.trim().split(' ', 2)[1]?.trim()) // 移除状态前缀（例如 "M "、"A "、"??"）
    .filter(line => typeof line === 'string') // 移除空条目
}

export type GitFileStatus = {
  tracked: string[]
  untracked: string[]
}

export const getFileStatus = async (): Promise<GitFileStatus> => {
  const { stdout } = await execFileNoThrow(
    gitExe(),
    ['--no-optional-locks', 'status', '--porcelain'],
    {
      preserveOutputOnError: false,
    },
  )

  const tracked: string[] = []
  const untracked: string[] = []

  stdout
    .trim()
    .split('\n')
    .filter(line => line.length > 0)
    .forEach(line => {
      const status = line.substring(0, 2)
      const filename = line.substring(2).trim()

      if (status === '??') {
        untracked.push(filename)
      } else if (filename) {
        tracked.push(filename)
      }
    })

  return { tracked, untracked }
}

export const getWorktreeCount = async (): Promise<number> => {
  return getWorktreeCountFromFs()
}

/** 暂存所有更改（包括未跟踪的文件）以使 git 恢复到干净的 porcelain 状态
重要提示：此函数在暂存之前会先将未跟踪的文件添加到暂存区，以防止数据丢失
@param message - 可选的暂存自定义消息
@returns Promise<boolean> - 如果暂存成功则为 true，否则为 false */
export const stashToCleanState = async (message?: string): Promise<boolean> => {
  try {
    const stashMessage =
      message || `Claude Code 自动暂存 - ${new Date().toISOString()}`

    // 首先，检查我们是否有未跟踪的文件
    const { untracked } = await getFileStatus()

    // 如果有未跟踪的文件，先将它们添加到暂存
    // 区。这可以防止它们被删除
    if (untracked.length > 0) {
      const { code: addCode } = await execFileNoThrow(
        gitExe(),
        ['add', ...untracked],
        { preserveOutputOnError: false },
      )

      if (addCode !== 0) {
        return false
      }
    }

    // 现在暂存所有内容（已暂存和未暂存的更改）
    const { code } = await execFileNoThrow(
      gitExe(),
      ['stash', 'push', '--message', stashMessage],
      { preserveOutputOnError: false },
    )
    return code === 0
  } catch (_) {
    return false
  }
}

export type GitRepoState = {
  commitHash: string
  branchName: string
  remoteUrl: string | null
  isHeadOnRemote: boolean
  isClean: boolean
  worktreeCount: number
}

export async function getGitState(): Promise<GitRepoState | null> {
  try {
    const [
      commitHash,
      branchName,
      remoteUrl,
      isHeadOnRemote,
      isClean,
      worktreeCount,
    ] = await Promise.all([
      getHead(),
      getBranch(),
      getRemoteUrl(),
      getIsHeadOnRemote(),
      getIsClean(),
      getWorktreeCount(),
    ])

    return {
      commitHash,
      branchName,
      remoteUrl,
      isHeadOnRemote,
      isClean,
      worktreeCount,
    }
  } catch (_) {
    // 静默失败 - git 状态处理是尽力而为的
    return null
  }
}

export async function getGithubRepo(): Promise<string | null> {
  const { parseGitRemote } = await import('./detectRepository.js')
  const remoteUrl = await getRemoteUrl()
  if (!remoteUrl) {
    logForDebugging('本地 GitHub 仓库：未知')
    return null
  }
  // 仅返回 github.com 的结果 —— 调用者（例如问题提交
  // ）假定结果是 github.com 仓库。
  const parsed = parseGitRemote(remoteUrl)
  if (parsed && parsed.host === 'github.com') {
    const result = `${parsed.owner}/${parsed.name}`
    logForDebugging(`本地 GitHub 仓库：${result}`)
    return result
  }
  logForDebugging('本地 GitHub 仓库：未知')
  return null
}

/** 为问题提交保留的 git 状态。
使用远程基准（例如 origin/main），它很少被强制推送，
不像本地提交在强制推送后可能被 GC 清理。 */
export type PreservedGitState = {
  /** 与远程分支的合并基准的 SHA */
  remote_base_sha: string | null
  /** 使用的远程分支（例如 "origin/main"） */
  remote_base: string | null
  /** 从合并基准到当前状态的补丁（包括未提交的更改） */
  patch: string
  /** 未跟踪的文件及其内容 */
  untracked_files: Array<{ path: string; content: string }>
  /** git format-patch 输出，用于合并基准与 HEAD 之间已提交的更改。
用于在重放容器中重建实际的提交链（作者、日期、消息）。
当合并基准与 HEAD 之间没有提交时，为 null。 */
  format_patch: string | null
  /** 当前 HEAD 的 SHA（特性分支的尖端） */
  head_sha: string | null
  /** 当前分支名称（例如 "feat/my-feature"） */
  branch_name: string | null
}

// 未跟踪文件捕获的大小限制
const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024 // 每个文件 500MB
const MAX_TOTAL_SIZE_BYTES = 5 * 1024 * 1024 * 1024 // 总计 5GB
const MAX_FILE_COUNT = 20000

// 用于二进制检测和内容重用的初始读取缓冲区。64KB 足以
// 在单次读取中覆盖大多数源文件；isBinaryConten
// t() 内部仅扫描其前 8KB 用于二进制启发式检测，因
// 此额外的字节纯粹是为了在文件最终是文本时避免第二次读取。
const SNIFF_BUFFER_SIZE = 64 * 1024

/** 查找用作基准的最佳远程分支。
优先级：跟踪分支 > origin/main > origin/staging > origin/master */
export async function findRemoteBase(): Promise<string | null> {
  // 第一次尝试：获取当前分支的跟踪分支
  const { stdout: trackingBranch, code: trackingCode } = await execFileNoThrow(
    gitExe(),
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    { preserveOutputOnError: false },
  )

  if (trackingCode === 0 && trackingBranch.trim()) {
    return trackingBranch.trim()
  }

  // 第二次尝试：检查 origin 上常见的默认分支名称
  const { stdout: remoteRefs, code: remoteCode } = await execFileNoThrow(
    gitExe(),
    ['remote', 'show', 'origin', '--', 'HEAD'],
    { preserveOutputOnError: false },
  )

  if (remoteCode === 0) {
    // 从远程 show 输出中解析默认分支
    const match = remoteRefs.match(/HEAD branch: (\S+)/)
    if (match && match[1]) {
      return `origin/${match[1]}`
    }
  }

  // 第三次尝试：检查哪些常见分支存在
  const candidates = ['origin/main', 'origin/staging', 'origin/master']
  for (const candidate of candidates) {
    const { code } = await execFileNoThrow(
      gitExe(),
      ['rev-parse', '--verify', candidate],
      { preserveOutputOnError: false },
    )
    if (code === 0) {
      return candidate
    }
  }

  return null
}

/** 通过查找 <gitDir>/shallow 来检查我们是否在浅克隆中。 */
function isShallowClone(): Promise<boolean> {
  return isShallowCloneFs()
}

/** 捕获未跟踪的文件（git diff 不包含它们）。
遵守大小限制并跳过二进制文件。 */
async function captureUntrackedFiles(): Promise<
  Array<{ path: string; content: string }>
> {
  const { stdout, code } = await execFileNoThrow(
    gitExe(),
    ['ls-files', '--others', '--exclude-standard'],
    { preserveOutputOnError: false },
  )

  const trimmed = stdout.trim()
  if (code !== 0 || !trimmed) {
    return []
  }

  const files = trimmed.split('\n').filter(Boolean)
  const result: Array<{ path: string; content: string }> = []
  let totalSize = 0

  for (const filePath of files) {
    // 检查文件数量限制
    if (result.length >= MAX_FILE_COUNT) {
      logForDebugging(
        `未跟踪文件捕获：已达到最大文件数 (${MAX_FILE_COUNT})`,
      )
      break
    }

    // 通过扩展名跳过二进制文件 - 零 I/O
    if (hasBinaryExtension(filePath)) {
      continue
    }

    try {
      const stats = await stat(filePath)
      const fileSize = stats.size

      // 跳过超过单文件限制的文件
      if (fileSize > MAX_FILE_SIZE_BYTES) {
        logForDebugging(
          `未跟踪文件捕获：跳过 ${filePath}（超过 ${MAX_FILE_SIZE_BYTES} 字节）`,
        )
        continue
      }

      // 检查总大小限制
      if (totalSize + fileSize > MAX_TOTAL_SIZE_BYTES) {
        logForDebugging(
          `未跟踪文件捕获：已达到总大小限制 (${MAX_TOTAL_SIZE_BYTES} 字节）`,
        )
        break
      }

      // 空文件 - 无需打开
      if (fileSize === 0) {
        result.push({ path: filePath, content: '' })
        continue
      }

      // 对最多 SNIFF_BUFFER_SIZE 字节进行二进制嗅探。即使 MA
      // X_FILE_SIZE_BYTES 允许高达 500MB，也将二进制文件读取限
      // 制在 SNIFF_BUFFER_SIZE。如果文件适合嗅探缓冲区，我们将
      // 其重用为内容；对于较大的文本文件，我们回退到使用编码的 readFile，以
      // 便运行时解码为字符串，而无需在 JS 中实例化完整大小的 Buffer。
      const sniffSize = Math.min(SNIFF_BUFFER_SIZE, fileSize)
      const fd = await open(filePath, 'r')
      try {
        const sniffBuf = Buffer.alloc(sniffSize)
        const { bytesRead } = await fd.read(sniffBuf, 0, sniffSize, 0)
        const sniff = sniffBuf.subarray(0, bytesRead)

        if (isBinaryContent(sniff)) {
          continue
        }

        let content: string
        if (fileSize <= sniffSize) {
          // 嗅探已覆盖整个文件
          content = sniff.toString('utf-8')
        } else {
          // 使用编码的 readFile 直接解码为字符串，避
          // 免了完整大小的 Buffer 与解码后的字符串并存
          // 。额外的打开/关闭操作比为大文件加倍峰值内存更便宜。
          content = await readFile(filePath, 'utf-8')
        }

        result.push({ path: filePath, content })
        totalSize += fileSize
      } finally {
        await fd.close()
      }
    } catch (err) {
      // 跳过我们无法读取的文件
      logForDebugging(`读取未跟踪文件 ${filePath} 失败：${err}`)
    }
  }

  return result
}

/** 为问题提交保留 git 状态。
使用远程基准以获得更稳定的重放能力。

处理的边缘情况：
- 分离的 HEAD：直接回退到与默认分支的合并基准
- 无远程：远程字段返回 null，使用仅 HEAD 模式
- 浅克隆：回退到仅 HEAD 模式 */
export async function preserveGitStateForIssue(): Promise<PreservedGitState | null> {
  try {
    const isGit = await getIsGit()
    if (!isGit) {
      return null
    }

    // 检查是否为浅克隆 - 回退到更简单的模式
    if (await isShallowClone()) {
      logForDebugging('检测到浅克隆，对问题使用仅 HEAD 模式')
      const [{ stdout: patch }, untrackedFiles] = await Promise.all([
        execFileNoThrow(gitExe(), ['diff', 'HEAD']),
        captureUntrackedFiles(),
      ])
      return {
        remote_base_sha: null,
        remote_base: null,
        patch: patch || '',
        untracked_files: untrackedFiles,
        format_patch: null,
        head_sha: null,
        branch_name: null,
      }
    }

    // 查找最佳远程基准
    const remoteBase = await findRemoteBase()

    if (!remoteBase) {
      // 未找到远程 - 使用仅 HEAD 模式
      logForDebugging('未找到远程，对问题使用仅 HEAD 模式')
      const [{ stdout: patch }, untrackedFiles] = await Promise.all([
        execFileNoThrow(gitExe(), ['diff', 'HEAD']),
        captureUntrackedFiles(),
      ])
      return {
        remote_base_sha: null,
        remote_base: null,
        patch: patch || '',
        untracked_files: untrackedFiles,
        format_patch: null,
        head_sha: null,
        branch_name: null,
      }
    }

    // 获取与远程的合并基准
    const { stdout: mergeBase, code: mergeBaseCode } = await execFileNoThrow(
      gitExe(),
      ['merge-base', 'HEAD', remoteBase],
      { preserveOutputOnError: false },
    )

    if (mergeBaseCode !== 0 || !mergeBase.trim()) {
      // 合并基准失败 - 回退到仅 HEAD 模式
      logForDebugging('合并基准失败，对问题使用仅 HEAD 模式')
      const [{ stdout: patch }, untrackedFiles] = await Promise.all([
        execFileNoThrow(gitExe(), ['diff', 'HEAD']),
        captureUntrackedFiles(),
      ])
      return {
        remote_base_sha: null,
        remote_base: null,
        patch: patch || '',
        untracked_files: untrackedFiles,
        format_patch: null,
        head_sha: null,
        branch_name: null,
      }
    }

    const remoteBaseSha = mergeBase.trim()

    // 下面的所有 5 个命令仅依赖于 remoteBaseSha —— 并行运行它们。在 Bun nati
    // ve（由 /issue 和 /share 使用）上，从约 5×90ms 串行 → 约 90ms 并行。
    const [
      { stdout: patch },
      untrackedFiles,
      { stdout: formatPatchOut, code: formatPatchCode },
      { stdout: headSha },
      { stdout: branchName },
    ] = await Promise.all([
      // 从合并基准到当前状态的补丁（包括已暂存的更改）
      execFileNoThrow(gitExe(), ['diff', remoteBaseSha]),
      // 未跟踪的文件单独捕获
      captureUntrackedFiles(),
      // 用于合并基准与 HEAD 之间已提交更改的 form
      // at-patch。保留实际的提交链（作者、日期、消息）
      // ，以便重放容器可以重建具有真实提交的分支，而不是压缩的差
      // 异。使用 --stdout 将所有补丁作为单个文本流输出。
      execFileNoThrow(gitExe(), [
        'format-patch',
        `${remoteBaseSha}..HEAD`,
        '--stdout',
      ]),
      // 用于回放的 HEAD SHA
      execFileNoThrow(gitExe(), ['rev-parse', 'HEAD']),
      // 用于回放的分支名称
      execFileNoThrow(gitExe(), ['rev-parse', '--abbrev-ref', 'HEAD']),
    ])

    let formatPatch: string | null = null
    if (formatPatchCode === 0 && formatPatchOut && formatPatchOut.trim()) {
      formatPatch = formatPatchOut
    }

    const trimmedBranch = branchName?.trim()
    return {
      remote_base_sha: remoteBaseSha,
      remote_base: remoteBase,
      patch: patch || '',
      untracked_files: untrackedFiles,
      format_patch: formatPatch,
      head_sha: headSha?.trim() || null,
      branch_name:
        trimmedBranch && trimmedBranch !== 'HEAD' ? trimmedBranch : null,
    }
  } catch (err) {
    logError(err)
    return null
  }
}

function isLocalHost(host: string): boolean {
  const hostWithoutPort = host.split(':')[0] ?? ''
  return (
    hostWithoutPort === 'localhost' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostWithoutPort)
  )
}

/** 检查当前工作目录是否看起来像一个裸 Git 仓库，或者被篡改以伪装成一个裸仓库（沙箱逃逸攻击向量）。

安全说明：Git 的 is_git_directory() 函数（setup.c:417-455）会检查：
1. HEAD 文件 - 必须是一个有效的引用
2. objects/ 目录 - 必须存在且可访问
3. refs/ 目录 - 必须存在且可访问

如果这三者都存在于当前目录（而非 .git 子目录中），
Git 会将当前目录视为一个裸仓库，并从当前工作目录执行 hooks/pre-commit 等钩子脚本。

攻击场景：
1. 攻击者在当前工作目录创建 HEAD、objects/、refs/ 和 hooks/pre-commit
2. 攻击者删除或破坏 .git/HEAD，使正常的 Git 目录失效
3. 当用户运行 'git status' 时，Git 将当前工作目录视为 Git 目录并运行钩子

@returns 如果当前工作目录看起来像一个裸/被利用的 Git 目录，则返回 true */
/* eslint-disable custom-rules/no-sync-fs -- 同步权限评估检查 */
export function isCurrentDirectoryBareGitRepo(): boolean {
  const fs = getFsImplementation()
  const cwd = getCwd()

  const gitPath = join(cwd, '.git')
  try {
    const stats = fs.statSync(gitPath)
    if (stats.isFile()) {
      // worktree/submodule — Git 会跟随 gitdir 引用
      return false
    }
    if (stats.isDirectory()) {
      const gitHeadPath = join(gitPath, 'HEAD')
      try {
        // 安全说明：检查 isFile()。攻击者如果将 .git/HEAD 创建为一
        // 个目录，会通过裸的 statSync 检查，但 Git 的 setup_git_di
        // rectory 会拒绝它（不是有效的 HEAD）并回退到当前工作目录发现机制。
        if (fs.statSync(gitHeadPath).isFile()) {
          // 正常仓库 — .git/HEAD 有效，Git 不会回退到当前工作目录
          return false
        }
        // .git/HEAD 存在但不是常规文件 — 继续检查
      } catch {
        // .git 存在但没有 HEAD — 继续执行裸仓库检查
      }
    }
  } catch {
    // 没有 .git — 继续执行裸仓库指示器检查
  }

  // 未找到有效的 .git/HEAD。检查当前工作目录是否有裸 Git 仓库的
  // 指示器。请谨慎 — 如果存在任何这些指示器但没有有效的 .git 引用，则标记
  // 。对每个指示器使用 try/catch，以便一个错误不会掩盖另一个。
  try {
    if (fs.statSync(join(cwd, 'HEAD')).isFile()) return true
  } catch {
    // 没有 HEAD
  }
  try {
    if (fs.statSync(join(cwd, 'objects')).isDirectory()) return true
  } catch {
    // 没有 objects/
  }
  try {
    if (fs.statSync(join(cwd, 'refs')).isDirectory()) return true
  } catch {
    // 没有 refs/
  }
  return false
}
/* eslint-enable custom-rules/no-sync-fs */
