import { feature } from 'bun:bundle'
import chalk from 'chalk'
import { spawnSync } from 'child_process'
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  utimes,
} from 'fs/promises'
import ignore from 'ignore'
import { basename, dirname, join } from 'path'
import { saveCurrentProjectConfig } from './config.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { errorMessage, getErrnoCode } from './errors.js'
import { execFileNoThrow, execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { parseGitConfigValue } from './git/gitConfigParser.js'
import {
  getCommonDir,
  readWorktreeHeadSha,
  resolveGitDir,
  resolveRef,
} from './git/gitFilesystem.js'
import {
  findCanonicalGitRoot,
  findGitRoot,
  getBranch,
  getDefaultBranch,
  gitExe,
} from './git.js'
import {
  executeWorktreeCreateHook,
  executeWorktreeRemoveHook,
  hasWorktreeCreateHook,
} from './hooks.js'
import { containsPathTraversal } from './path.js'
import { getPlatform } from './platform.js'
import {
  getInitialSettings,
  getRelativeSettingsFilePathForSource,
} from './settings/settings.js'
import { sleep } from './sleep.js'
import { isInITerm2 } from './swarm/backends/detection.js'

const VALID_WORKTREE_SLUG_SEGMENT = /^[a-zA-Z0-9._-]+$/
const MAX_WORKTREE_SLUG_LENGTH = 64

/** 验证工作树标识符，防止路径遍历和目录逃逸。

标识符通过 path.join 拼接成 `.claude/worktrees/<标识符>`，该操作会规范化 `..` 路径段——因此 `../../../target` 会逃逸出工作树目录。类似地，绝对路径（以 `/` 或 `C:\` 开头）会完全丢弃前缀。

允许使用正斜杠进行嵌套（例如 `asm/feature-foo`）；每个路径段会独立根据允许列表进行验证，因此 `.` / `..` 路径段和驱动器指定字符仍会被拒绝。

同步抛出错误——调用者依赖此操作在任何副作用（git 命令、钩子执行、chdir）之前运行。 */
export function validateWorktreeSlug(slug: string): void {
  if (slug.length > MAX_WORKTREE_SLUG_LENGTH) {
    throw new Error(
      `无效的工作树名称：长度必须不超过 ${MAX_WORKTREE_SLUG_LENGTH} 个字符（实际为 ${slug.length}）`,
    )
  }
  // 开头或结尾的 `/` 会导致 path.join 生成绝对路径或悬
  // 空路径段。拆分并验证每个路径段可以同时拒绝这两种情况（空路径段无
  // 法通过正则表达式匹配），同时允许 `user/feature`。
  for (const segment of slug.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new Error(
        `无效的工作树名称 "${slug}"：不得包含 "." 或 ".." 路径段`,
      )
    }
    if (!VALID_WORKTREE_SLUG_SEGMENT.test(segment)) {
      throw new Error(
        `无效的工作树名称 "${slug}"：每个以 "/" 分隔的路径段必须非空，且只能包含字母、数字、点、下划线和短横线`,
      )
    }
  }
}

// 用于递归创建目录的辅助函数
async function mkdirRecursive(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true })
}

/** 从主仓库创建目录符号链接以避免重复。
这可以防止因复制 node_modules 和其他大型目录而导致的磁盘膨胀。

@param repoRootPath - 主仓库根目录的路径
@param worktreePath - 工作树目录的路径
@param dirsToSymlink - 要创建符号链接的目录名数组（例如 ['node_modules']） */
async function symlinkDirectories(
  repoRootPath: string,
  worktreePath: string,
  dirsToSymlink: string[],
): Promise<void> {
  for (const dir of dirsToSymlink) {
    // 验证目录不会逃逸出仓库边界
    if (containsPathTraversal(dir)) {
      logForDebugging(
        `跳过 "${dir}" 的符号链接：检测到路径遍历`,
        { level: 'warn' },
      )
      continue
    }

    const sourcePath = join(repoRootPath, dir)
    const destPath = join(worktreePath, dir)

    try {
      await symlink(sourcePath, destPath, 'dir')
      logForDebugging(
        `已将 ${dir} 从主仓库符号链接到工作树，以避免磁盘膨胀`,
      )
    } catch (error) {
      const code = getErrnoCode(error)
      // ENOENT：源文件尚不存在（预期情况 - 静默跳过
      // ） EEXIST：目标已存在（预期情况 - 静默跳过）
      if (code !== 'ENOENT' && code !== 'EEXIST') {
        // 意外错误（例如，权限被拒绝、平台不支持）
        logForDebugging(
          `创建 ${dir} 的符号链接失败 (${code ?? 'unknown'})：${errorMessage(error)}`,
          { level: 'warn' },
        )
      }
    }
  }
}

export type WorktreeSession = {
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch?: string
  originalBranch?: string
  originalHeadCommit?: string
  sessionId: string
  tmuxSessionName?: string
  hookBased?: boolean
  /** 工作树创建耗时（恢复现有工作树时未设置）。 */
  creationDurationMs?: number
  /** 如果通过 settings.worktree.sparsePaths 应用了 git sparse-checkout，则为 true。 */
  usedSparsePaths?: boolean
}

let currentWorktreeSession: WorktreeSession | null = null

export function getCurrentWorktreeSession(): WorktreeSession | null {
  return currentWorktreeSession
}

/** 在 --resume 时恢复工作树会话。调用者必须已通过 process.chdir 验证目录存在，并设置了引导状态（cwd, originalCwd）。 */
export function restoreWorktreeSession(session: WorktreeSession | null): void {
  currentWorktreeSession = session
}

export function generateTmuxSessionName(
  repoPath: string,
  branch: string,
): string {
  const repoName = basename(repoPath)
  const combined = `${repoName}_${branch}`
  return combined.replace(/[/.]/g, '_')
}

type WorktreeCreateResult =
  | {
      worktreePath: string
      worktreeBranch: string
      headCommit: string
      existed: true
    }
  | {
      worktreePath: string
      worktreeBranch: string
      headCommit: string
      baseBranch: string
      existed: false
    }

// 用于防止 git/SSH 提示输入凭据（这会导致 CLI 挂起）的环境变量。GIT_TERM
// INAL_PROMPT=0 可防止 git 为凭据提示打开 /dev/tty。GIT_AS
// KPASS='' 禁用 askpass GUI 程序
// 。stdin: 'ignore' 关闭标准输入，因此交互式提示无法阻塞。
const GIT_NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
}

function worktreesDir(repoRoot: string): string {
  return join(repoRoot, '.claude', 'worktrees')
}

// 展平嵌套的标识符（`user/feature` → `user+feature`），
// 用于分支名和目录路径。在任一位置嵌套都是不安全的：- git 引用：`wo
// rktree-user`（文件）与 `worktree-user/feature`
// （需要目录）是 D/F 冲突，git 会
// 拒绝。- 目录：`.claude/worktrees/user/feature/
// ` 位于 `user` 工作树内部；对父级执行 `git worktree
// remove` 会删
// 除包含未提交工作的子级。`+` 在 git 分支名和文件系统路径中有效，但在标
// 识符路径段允许列表（[a-zA-Z0-9._-]）中无效，因此该映射是单射的。
function flattenSlug(slug: string): string {
  return slug.replaceAll('/', '+')
}

export function worktreeBranchName(slug: string): string {
  return `worktree-${flattenSlug(slug)}`
}

function worktreePathFor(repoRoot: string, slug: string): string {
  return join(worktreesDir(repoRoot), flattenSlug(slug))
}

/** 为给定的标识符创建新的 git 工作树，如果已存在则恢复它。
命名工作树在多次调用中复用相同路径，因此存在性检查可防止在每次恢复时无条件运行 `git fetch`（该操作可能因等待凭据而挂起）。 */
async function getOrCreateWorktree(
  repoRoot: string,
  slug: string,
  options?: { prNumber?: number },
): Promise<WorktreeCreateResult> {
  const worktreePath = worktreePathFor(repoRoot, slug)
  const worktreeBranch = worktreeBranchName(slug)

  // 快速恢复路径：如果工作树已存在，则跳过 fetch 和创建。直接读取 .g
  // it 指针文件（无子进程，无向上遍历）——即使对于 2ms 的任务，子进
  // 程 `rev-parse HEAD` 也会因生成开销而消耗约 15ms，并
  // 且 await 让步会让后台的 spawnSync 堆积（观察到 55ms）。
  const existingHead = await readWorktreeHeadSha(worktreePath)
  if (existingHead) {
    return {
      worktreePath,
      worktreeBranch,
      headCommit: existingHead,
      existed: true,
    }
  }

  // 新工作树：先获取基础分支，然后添加
  await mkdir(worktreesDir(repoRoot), { recursive: true })

  const fetchEnv = { ...process.env, ...GIT_NO_PROMPT_ENV }

  let baseBranch: string
  let baseSha: string | null = null
  if (options?.prNumber) {
    const { code: prFetchCode, stderr: prFetchStderr } =
      await execFileNoThrowWithCwd(
        gitExe(),
        ['fetch', 'origin', `pull/${options.prNumber}/head`],
        { cwd: repoRoot, stdin: 'ignore', env: fetchEnv },
      )
    if (prFetchCode !== 0) {
      throw new Error(
        `获取 PR #${options.prNumber} 失败：${prFetchStderr.trim() || 'PR may not exist or the repository may not have a remote named "origin"'}`,
      )
    }
    baseBranch = 'FETCH_HEAD'
  } else {
    // 如果 origin/<branch> 已存在于本地，则跳过 fetch。在
    // 大型仓库（21 万个文件，1600 万个对象）中，fetch 在触及网络
    // 之前，仅本地 commit-graph 扫描就会消耗约 6-8 秒。基础分
    // 支稍旧是可以接受的——用户如果需要最新版本，可以在工作树中
    // 执行 pull。resolveRef 直接读取松散/打包的引用；当它成功
    // 时，我们已经有了 SHA，因此后续的 rev-parse 会被完全跳过。
    const [defaultBranch, gitDir] = await Promise.all([
      getDefaultBranch(),
      resolveGitDir(repoRoot),
    ])
    const originRef = `origin/${defaultBranch}`
    const originSha = gitDir
      ? await resolveRef(gitDir, `refs/remotes/origin/${defaultBranch}`)
      : null
    if (originSha) {
      baseBranch = originRef
      baseSha = originSha
    } else {
      const { code: fetchCode } = await execFileNoThrowWithCwd(
        gitExe(),
        ['fetch', 'origin', defaultBranch],
        { cwd: repoRoot, stdin: 'ignore', env: fetchEnv },
      )
      baseBranch = fetchCode === 0 ? originRef : 'HEAD'
    }
  }

  // 对于 fetch/PR-fetch 路径，我们仍然需要 SHA——上述仅基于文件系统的 r
  // esolveRef 仅覆盖“origin/<branch> 已存在于本地”的情况。
  if (!baseSha) {
    const { stdout, code: shaCode } = await execFileNoThrowWithCwd(
      gitExe(),
      ['rev-parse', baseBranch],
      { cwd: repoRoot },
    )
    if (shaCode !== 0) {
      throw new Error(
        `解析基础分支 "${baseBranch}" 失败：git rev-parse 失败`,
      )
    }
    baseSha = stdout.trim()
  }

  const sparsePaths = getInitialSettings().worktree?.sparsePaths
  const addArgs = ['worktree', 'add']
  if (sparsePaths?.length) {
    addArgs.push('--no-checkout')
  }
  // -B（而非 -b）：重置因移除工作树目录而遗留的任何孤立分支。每次创建时可节
  // 省一个 `git branch -D` 子进程（约 15ms 的生成开销）。
  addArgs.push('-B', worktreeBranch, worktreePath, baseBranch)

  const { code: createCode, stderr: createStderr } =
    await execFileNoThrowWithCwd(gitExe(), addArgs, { cwd: repoRoot })
  if (createCode !== 0) {
    throw new Error(`创建工作树失败：${createStderr}`)
  }

  if (sparsePaths?.length) {
    // 如果在 --no-checkout 之后 sparse-checkou
    // t 或 checkout 失败，工作树会被注册且 HEAD 已设置，但工
    // 作目录为空。下一次运行的快速恢复（rev-parse HEAD）会成功，并
    // 将损坏的工作树呈现为“已恢复”。在传播错误之前将其拆除。
    const tearDown = async (msg: string): Promise<never> => {
      await execFileNoThrowWithCwd(
        gitExe(),
        ['worktree', 'remove', '--force', worktreePath],
        { cwd: repoRoot },
      )
      throw new Error(msg)
    }
    const { code: sparseCode, stderr: sparseErr } =
      await execFileNoThrowWithCwd(
        gitExe(),
        ['sparse-checkout', 'set', '--cone', '--', ...sparsePaths],
        { cwd: worktreePath },
      )
    if (sparseCode !== 0) {
      await tearDown(`配置 sparse-checkout 失败：${sparseErr}`)
    }
    const { code: coCode, stderr: coErr } = await execFileNoThrowWithCwd(
      gitExe(),
      ['checkout', 'HEAD'],
      { cwd: worktreePath },
    )
    if (coCode !== 0) {
      await tearDown(`检出稀疏工作树失败：${coErr}`)
    }
  }

  return {
    worktreePath,
    worktreeBranch,
    headCommit: baseSha,
    baseBranch,
    existed: false,
  }
}

/** 将 .worktreeinclude 中指定的 git 忽略文件从基础仓库复制到工作树。

仅复制同时满足以下两个条件的文件：
1. 匹配 .worktreeinclude 中的模式（使用 .gitignore 语法）
2. 被 Git 忽略（未被 git 跟踪）

使用 `git ls-files --others --ignored --exclude-standard --directory` 列出 git 忽略的条目，并将完全忽略的目录折叠为单个条目（这样像 node_modules/ 这样的大型构建输出就不会强制进行完整的树遍历），然后在进程内使用 `ignore` 库根据 .worktreeinclude 模式进行过滤。如果 .worktreeinclude 模式明确针对折叠目录内的路径，则会通过第二次有范围的 `ls-files` 调用来展开该目录。 */
export async function copyWorktreeIncludeFiles(
  repoRoot: string,
  worktreePath: string,
): Promise<string[]> {
  let includeContent: string
  try {
    includeContent = await readFile(join(repoRoot, '.worktreeinclude'), 'utf-8')
  } catch {
    return []
  }

  const patterns = includeContent
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
  if (patterns.length === 0) {
    return []
  }

  // 使用 --directory 进行单次遍历：将完全被 git 忽略的目录（node_m
  // odules/、.turbo/ 等）折叠为单个条目，而不是列出其中的每个文件。在
  // 大型仓库中，这可以将约 50 万个条目/约 7 秒减少到约数百个条目/约 100 毫秒。
  const gitignored = await execFileNoThrowWithCwd(
    gitExe(),
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
    { cwd: repoRoot },
  )
  if (gitignored.code !== 0 || !gitignored.stdout.trim()) {
    return []
  }

  const entries = gitignored.stdout.trim().split('\n').filter(Boolean)
  const matcher = ignore().add(includeContent)

  // --directory 输出带尾随斜杠的折叠目录；其他所有内
  // 容都是单个文件。
  const collapsedDirs = entries.filter(e => e.endsWith('/'))
  const files = entries.filter(e => !e.endsWith('/') && matcher.ignores(e))

  // 边界情况：.worktreeinclude 模式针对折叠目录内的路径（例
  // 如，当整个 `config/secrets/` 目录被 git 忽略
  // 且没有已跟踪的同级文件时，模式 `config/secrets/api
  // .key`）。仅展开满足以下条件的目录：模式将该目录作为其显式路径前缀（
  // 去除冗余的前导 `/`）、目录位于锚定通配符的字面前缀下（例如 `co
  // nfig/**/*.key` 展开 `config/secrets/`
  // ），或者目录本身匹配某个模式。我们不针对 `**/` 或无锚定模式进行展
  // 开——这些模式匹配已跟踪目录中的文件（已单独列出），为它们展开每个折
  // 叠目录会抵消性能优势。
  const dirsToExpand = collapsedDirs.filter(dir => {
    if (
      patterns.some(p => {
        const normalized = p.startsWith('/') ? p.slice(1) : p
        // 字面前缀匹配：模式以折叠目录路径开头
        if (normalized.startsWith(dir)) return true
        // 锚定通配符：目录位于模式的字面（非通配符）前缀下，例如 `config/**/*
        // .key` 的字面前缀是 `config/` → 展开 `config/secrets/`
        const globIdx = normalized.search(/[*?[]/)
        if (globIdx > 0) {
          const literalPrefix = normalized.slice(0, globIdx)
          if (dir.startsWith(literalPrefix)) return true
        }
        return false
      })
    )
      return true
    if (matcher.ignores(dir.slice(0, -1))) return true
    return false
  })
  if (dirsToExpand.length > 0) {
    const expanded = await execFileNoThrowWithCwd(
      gitExe(),
      [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--',
        ...dirsToExpand,
      ],
      { cwd: repoRoot },
    )
    if (expanded.code === 0 && expanded.stdout.trim()) {
      for (const f of expanded.stdout.trim().split('\n').filter(Boolean)) {
        if (matcher.ignores(f)) {
          files.push(f)
        }
      }
    }
  }
  const copied: string[] = []

  for (const relativePath of files) {
    const srcPath = join(repoRoot, relativePath)
    const destPath = join(worktreePath, relativePath)
    try {
      await mkdir(dirname(destPath), { recursive: true })
      await copyFile(srcPath, destPath)
      copied.push(relativePath)
    } catch (e: unknown) {
      logForDebugging(
        `复制 ${relativePath} 到工作树失败：${(e as Error).message}`,
        { level: 'warn' },
      )
    }
  }

  if (copied.length > 0) {
    logForDebugging(
      `从 .worktreeinclude 复制了 ${copied.length} 个文件：${copied.join(', ')}`,
    )
  }

  return copied
}

/** 为新创建的工作树进行创建后设置。
传播 settings.local.json，配置 git 钩子，并创建目录符号链接。 */
async function performPostCreationSetup(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  // 将 settings.local.json 复制到工作树
  // 的 .claude 目录。这会将本地设置（可能包含密钥）传播到工作树
  const localSettingsRelativePath =
    getRelativeSettingsFilePathForSource('localSettings')
  const sourceSettingsLocal = join(repoRoot, localSettingsRelativePath)
  try {
    const destSettingsLocal = join(worktreePath, localSettingsRelativePath)
    await mkdirRecursive(dirname(destSettingsLocal))
    await copyFile(sourceSettingsLocal, destSettingsLocal)
    logForDebugging(
      `已将 settings.local.json 复制到工作树：${destSettingsLocal}`,
    )
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      logForDebugging(
        `复制 settings.local.json 失败：${(e as Error).message}`,
        { level: 'warn' },
      )
    }
  }

  // 配置工作树以使用主仓库的钩子。这解决了 .
  // husky 和其他使用相对路径的 git 钩子的问题
  const huskyPath = join(repoRoot, '.husky')
  const gitHooksPath = join(repoRoot, '.git', 'hooks')
  let hooksPath: string | null = null
  for (const candidatePath of [huskyPath, gitHooksPath]) {
    try {
      const s = await stat(candidatePath)
      if (s.isDirectory()) {
        hooksPath = candidatePath
        break
      }
    } catch {
      // 路径不存在或无法访问
    }
  }
  if (hooksPath) {
    // `git config`（无 --worktree 标志）会写入主仓库的
    // .git/config，该文件由所有工作树共享。一旦设置，后续的每次工
    // 作树创建都是空操作——当值已匹配时，跳过子进程（约 14ms 生成）。
    const gitDir = await resolveGitDir(repoRoot)
    const configDir = gitDir ? ((await getCommonDir(gitDir)) ?? gitDir) : null
    const existing = configDir
      ? await parseGitConfigValue(configDir, 'core', null, 'hooksPath')
      : null
    if (existing !== hooksPath) {
      const { code: configCode, stderr: configError } =
        await execFileNoThrowWithCwd(
          gitExe(),
          ['config', 'core.hooksPath', hooksPath],
          { cwd: worktreePath },
        )
      if (configCode === 0) {
        logForDebugging(
          `已将工作树配置为使用主仓库的钩子：${hooksPath}`,
        )
      } else {
        logForDebugging(`配置钩子路径失败：${configError}`, {
          level: 'error',
        })
      }
    }
  }

  // 创建目录符号链接以避免磁盘膨胀（通过设置选择启用）
  const settings = getInitialSettings()
  const dirsToSymlink = settings.worktree?.symlinkDirectories ?? []
  if (dirsToSymlink.length > 0) {
    await symlinkDirectories(repoRoot, worktreePath, dirsToSymlink)
  }

  // 复制 .worktreeinclude 中指定的 git 忽略文件（尽力而为）
  await copyWorktreeIncludeFiles(repoRoot, worktreePath)

  // 上面设置的 core.hooksPath 配置很脆弱：husky 的 prepa
  // re 脚本（`git config core.hooksPath .husk
  // y`）在每次 `bun install` 时运行，并将 SHARED 的
  // .git/config 值重置回相对路径，导致每个工作树再次解析到其自身的
  // .husky/。归属钩子文件未被跟踪（它在 .git/info/excl
  // ude 中），因此新的工作树没有它。将其直接安装到工作树的 .husky
  // / 中——husky 不会删除它（husky install 是仅增量的
  // ），对于非 husky 仓库，这会解析到共享的 .git/hooks/（幂等）。
  //
  // 显式传递工作树本地的 .husky：getHooksDir 会返回我们上面刚
  // 刚设置的绝对 core.hooksPath（主仓库的 .husky），而不是
  // 工作树的——当配置值为绝对路径时，`git rev-parse --git-pa
  // th hooks` 会逐字回显该值。
  if (feature('COMMIT_ATTRIBUTION')) {
    const worktreeHooksDir =
      hooksPath === huskyPath ? join(worktreePath, '.husky') : undefined
    void import('./postCommitAttribution.js')
      .then(m =>
        m
          .installPrepareCommitMsgHook(worktreePath, worktreeHooksDir)
          .catch(error => {
            logForDebugging(
              `在工作树中安装归属钩子失败：${error}`,
            )
          }),
      )
      .catch(error => {
        // 动态 import() 本身被拒绝（模块加载失败）。上面的内部
        // .catch 仅处理 installPrepareCommitM
        // sgHook 拒绝——没有此外部处理程序，导入失败将表现为未处
        // 理的 Promise 拒绝。
        logForDebugging(`加载 postCommitAttribution 模块失败：${error}`)
      })
  }
}

/** 从字符串解析 PR 引用。
接受 GitHub 风格的 PR URL（例如，https://github.com/owner/repo/pull/123，或 GHE 等效地址如 https://ghe.example.com/owner/repo/pull/123）或 `#N` 格式（例如，#123）。
返回 PR 编号，如果字符串不是可识别的 PR 引用，则返回 null。 */
export function parsePRReference(input: string): number | null {
  // GitHub 风格的 PR URL：https://<host>/owner/repo/pull/123（可选的尾随斜杠、查询参数、哈希）。
  // /pull/N 路径格式是 GitHub 特有的——GitLab 使用 /-/merge_requests/N，
  // Bitbucket 使用 /pull-requests/N——因此在此匹配任何主机都是安全的。
  const urlMatch = input.match(
    /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)\/?(?:[?#].*)?$/i,
  )
  if (urlMatch?.[1]) {
    return parseInt(urlMatch[1], 10)
  }

  // #N 格式
  const hashMatch = input.match(/^#(\d+)$/)
  if (hashMatch?.[1]) {
    return parseInt(hashMatch[1], 10)
  }

  return null
}

export async function isTmuxAvailable(): Promise<boolean> {
  const { code } = await execFileNoThrow('tmux', ['-V'])
  return code === 0
}

export function getTmuxInstallInstructions(): string {
  const platform = getPlatform()
  switch (platform) {
    case 'macos':
      return '安装 tmux：brew install tmux'
    case 'linux':
    case 'wsl':
      return '安装 tmux：sudo apt install tmux (Debian/Ubuntu) 或 sudo dnf install tmux (Fedora/RHEL)'
    case 'windows':
      return 'tmux 在 Windows 上原生不可用。请考虑使用 WSL 或 Cygwin。'
    default:
      return '使用系统包管理器安装 tmux。'
  }
}

export async function createTmuxSessionForWorktree(
  sessionName: string,
  worktreePath: string,
): Promise<{ created: boolean; error?: string }> {
  const { code, stderr } = await execFileNoThrow('tmux', [
    'new-session',
    '-d',
    '-s',
    sessionName,
    '-c',
    worktreePath,
  ])

  if (code !== 0) {
    return { created: false, error: stderr }
  }

  return { created: true }
}

export async function killTmuxSession(sessionName: string): Promise<boolean> {
  const { code } = await execFileNoThrow('tmux', [
    'kill-session',
    '-t',
    sessionName,
  ])
  return code === 0
}

export async function createWorktreeForSession(
  sessionId: string,
  slug: string,
  tmuxSessionName?: string,
  options?: { prNumber?: number },
): Promise<WorktreeSession> {
  // 必须在下面的钩子分支之前运行——钩子接收原始标识符作为参数
  // ，git 分支通过 path.join 从中构建路径。
  validateWorktreeSlug(slug)

  const originalCwd = getCwd()

  // 首先尝试基于钩子的工作树创建（允许用户配置的 VCS）
  if (hasWorktreeCreateHook()) {
    const hookResult = await executeWorktreeCreateHook(slug)
    logForDebugging(
      `已创建基于钩子的工作树，位置：${hookResult.worktreePath}`,
    )

    currentWorktreeSession = {
      originalCwd,
      worktreePath: hookResult.worktreePath,
      worktreeName: slug,
      sessionId,
      tmuxSessionName,
      hookBased: true,
    }
  } else {
    // 回退到 git worktree
    const gitRoot = findGitRoot(getCwd())
    if (!gitRoot) {
      throw new Error(
        '无法创建工作树：不在 git 仓库中且未配置 WorktreeCreate 钩子。' +
          '在 settings.json 中配置 WorktreeCreate/WorktreeRemove 钩子，以便在其他 VCS 系统中使用工作树隔离。',
      )
    }

    const originalBranch = await getBranch()

    const createStart = Date.now()
    const { worktreePath, worktreeBranch, headCommit, existed } =
      await getOrCreateWorktree(gitRoot, slug, options)

    let creationDurationMs: number | undefined
    if (existed) {
      logForDebugging(`正在恢复位于 ${worktreePath} 的现有工作树`)
    } else {
      logForDebugging(
        `已在分支 ${worktreeBranch} 上创建工作树，位置：${worktreePath}`,
      )
      await performPostCreationSetup(gitRoot, worktreePath)
      creationDurationMs = Date.now() - createStart
    }

    currentWorktreeSession = {
      originalCwd,
      worktreePath,
      worktreeName: slug,
      worktreeBranch,
      originalBranch,
      originalHeadCommit: headCommit,
      sessionId,
      tmuxSessionName,
      creationDurationMs,
      usedSparsePaths:
        (getInitialSettings().worktree?.sparsePaths?.length ?? 0) > 0,
    }
  }

  // 保存到项目配置以实现持久化
  saveCurrentProjectConfig(current => ({
    ...current,
    activeWorktreeSession: currentWorktreeSession ?? undefined,
  }))

  return currentWorktreeSession
}

export async function keepWorktree(): Promise<void> {
  if (!currentWorktreeSession) {
    return
  }

  try {
    const { worktreePath, originalCwd, worktreeBranch } = currentWorktreeSession

    // 首先切换回原始目录
    process.chdir(originalCwd)

    // 清除会话但保持工作树完整
    currentWorktreeSession = null

    // 更新配置
    saveCurrentProjectConfig(current => ({
      ...current,
      activeWorktreeSession: undefined,
    }))

    logForDebugging(
      `链接的工作树保留在：${worktreePath}${worktreeBranch ? ` on branch: ${worktreeBranch}` : ''}`,
    )
    logForDebugging(
      `您可以通过运行以下命令继续在那里工作：cd ${worktreePath}`,
    )
  } catch (error) {
    logForDebugging(`保留工作树时出错：${error}`, {
      level: 'error',
    })
  }
}

export async function cleanupWorktree(): Promise<void> {
  if (!currentWorktreeSession) {
    return
  }

  try {
    const { worktreePath, originalCwd, worktreeBranch, hookBased } =
      currentWorktreeSession

    // 首先切换回原始目录
    process.chdir(originalCwd)

    if (hookBased) {
      // 基于钩子的工作树：将清理工作委托给 WorktreeRemove 钩子
      const hookRan = await executeWorktreeRemoveHook(worktreePath)
      if (hookRan) {
        logForDebugging(`已移除位于 ${worktreePath} 的基于钩子的工作树`)
      } else {
        logForDebugging(
          `未配置 WorktreeRemove 钩子，基于钩子的工作树保留在：${worktreePath}`,
          { level: 'warn' },
        )
      }
    } else {
      // 基于 Git 的工作树：请使用 git worktre
      // e remove。显式 cwd：上方的 process.chdir 不会更新 get
      // Cwd()（execFileNoThrow 默认使用的状态 CWD）。如果模型 cd
      // 到了一个非仓库目录，此处裸的 execFileNoThrow 变体会静默失败。
      const { code: removeCode, stderr: removeError } =
        await execFileNoThrowWithCwd(
          gitExe(),
          ['worktree', 'remove', '--force', worktreePath],
          { cwd: originalCwd },
        )

      if (removeCode !== 0) {
        logForDebugging(`移除链接工作树失败：${removeError}`, {
          level: 'error',
        })
      } else {
        logForDebugging(`已移除位于 ${worktreePath} 的链接工作树`)
      }
    }

    // 清除会话
    currentWorktreeSession = null

    // 更新配置
    saveCurrentProjectConfig(current => ({
      ...current,
      activeWorktreeSession: undefined,
    }))

    // 删除临时工作树分支（仅限基于 Git 的情况）
    if (!hookBased && worktreeBranch) {
      // 稍等片刻以确保 Git 已释放所有锁
      await sleep(100)

      const { code: deleteBranchCode, stderr: deleteBranchError } =
        await execFileNoThrowWithCwd(
          gitExe(),
          ['branch', '-D', worktreeBranch],
          { cwd: originalCwd },
        )

      if (deleteBranchCode !== 0) {
        logForDebugging(
          `无法删除工作树分支：${deleteBranchError}`,
          { level: 'error' },
        )
      } else {
        logForDebugging(`已删除工作树分支：${worktreeBranch}`)
      }
    }

    logForDebugging('链接工作树已完全清理')
  } catch (error) {
    logForDebugging(`清理工作树时出错：${error}`, {
      level: 'error',
    })
  }
}

/** 为子代理创建一个轻量级工作树。
复用 getOrCreateWorktree/performPostCreationSetup，但不会触及
全局会话状态（currentWorktreeSession、process.chdir、项目配置）。
如果不在 Git 仓库中，则回退到基于钩子的创建方式。 */
export async function createAgentWorktree(slug: string): Promise<{
  worktreePath: string
  worktreeBranch?: string
  headCommit?: string
  gitRoot?: string
  hookBased?: boolean
}> {
  validateWorktreeSlug(slug)

  // 首先尝试基于钩子的工作树创建（允许用户配置的 VCS）
  if (hasWorktreeCreateHook()) {
    const hookResult = await executeWorktreeCreateHook(slug)
    logForDebugging(
      `已创建基于钩子的代理工作树，位于：${hookResult.worktreePath}`,
    )

    return { worktreePath: hookResult.worktreePath, hookBased: true }
  }

  // 回退到 git worktr
  // ee findCanonicalGitRoot（而非 findGitRoot），
  // 这样代理工作树始终会落在主仓库的 .claude/worktrees/ 中，即使是
  // 从会话工作树内部启动的——否则它们会嵌套在 <worktree>/.claud
  // e/worktrees/ 下，而定期清理（扫描规范根目录）永远找不到它们。
  const gitRoot = findCanonicalGitRoot(getCwd())
  if (!gitRoot) {
    throw new Error(
      '无法创建代理工作树：不在 Git 仓库中且未配置 WorktreeCreate 钩子。' +
        '请在 settings.json 中配置 WorktreeCreate/WorktreeRemove 钩子，以便在其他 VCS 系统中使用工作树隔离功能。',
    )
  }

  const { worktreePath, worktreeBranch, headCommit, existed } =
    await getOrCreateWorktree(gitRoot, slug)

  if (!existed) {
    logForDebugging(
      `已创建代理工作树，位于：${worktreePath}，分支：${worktreeBranch}`,
    )
    await performPostCreationSetup(gitRoot, worktreePath)
  } else {
    // 更新 mtime，这样定期清理陈旧工作树时就不会认为此工
    // 作树已过期——快速恢复路径是只读的，会保持原始的创建时间
    // mtime 不变，这可能已超过 30 天的截止期限。
    const now = new Date()
    await utimes(worktreePath, now, now)
    logForDebugging(`正在恢复位于 ${worktreePath} 的现有代理工作树`)
  }

  return { worktreePath, worktreeBranch, headCommit, gitRoot }
}

/** 移除由 createAgentWorktree 创建的工作树。
对于基于 Git 的工作树，移除工作树目录并删除临时分支。
对于基于钩子的工作树，委托给 WorktreeRemove 钩子处理。
必须传入主仓库的 Git 根目录（对于 Git 工作树）来调用，而不是工作树路径，
因为在此操作期间工作树目录会被删除。 */
export async function removeAgentWorktree(
  worktreePath: string,
  worktreeBranch?: string,
  gitRoot?: string,
  hookBased?: boolean,
): Promise<boolean> {
  if (hookBased) {
    const hookRan = await executeWorktreeRemoveHook(worktreePath)
    if (hookRan) {
      logForDebugging(`已移除位于 ${worktreePath} 的基于钩子的代理工作树`)
    } else {
      logForDebugging(
        `未配置 WorktreeRemove 钩子，基于钩子的代理工作树保留在：${worktreePath}`,
        { level: 'warn' },
      )
    }
    return hookRan
  }

  if (!gitRoot) {
    logForDebugging('无法移除代理工作树：未提供 Git 根目录', {
      level: 'error',
    })
    return false
  }

  // 请从主仓库根目录运行，而不是从工作树目录（我们即将删除它）
  const { code: removeCode, stderr: removeError } =
    await execFileNoThrowWithCwd(
      gitExe(),
      ['worktree', 'remove', '--force', worktreePath],
      { cwd: gitRoot },
    )

  if (removeCode !== 0) {
    logForDebugging(`移除代理工作树失败：${removeError}`, {
      level: 'error',
    })
    return false
  }
  logForDebugging(`已移除位于 ${worktreePath} 的代理工作树`)

  if (!worktreeBranch) {
    return true
  }

  // 从主仓库删除临时工作树分支
  const { code: deleteBranchCode, stderr: deleteBranchError } =
    await execFileNoThrowWithCwd(gitExe(), ['branch', '-D', worktreeBranch], {
      cwd: gitRoot,
    })

  if (deleteBranchCode !== 0) {
    logForDebugging(
      `无法删除代理工作树分支：${deleteBranchError}`,
      { level: 'error' },
    )
  }
  return true
}

/** 由 AgentTool 创建的临时工作树的 Slug 模式（`agent-a<7hex>`，
来自 earlyAgentId.slice(0,8)）、WorkflowTool（`wf_<runId>-<idx>`，其中 runId
是 randomUUID().slice(0,12) = 8 位十六进制 + `-` + 3 位十六进制）以及 bridgeMain
（`bridge-<safeFilenameId>`）。当父进程在其进程内清理运行之前被终止时（Ctrl+C、ESC、崩溃），
这些模式会泄漏。精确形状的模式可以避免误扫用户命名的 EnterWorktree slug，例如 `wf-myfeature`。 */
const EPHEMERAL_WORKTREE_PATTERNS = [
  /^agent-a[0-9a-f]{7}$/,
  /^wf_[0-9a-f]{8}-[0-9a-f]{3}-\d+$/,
  // 来自 workflowRunId 去重之前的遗留 wf-<idx> sl
  // ug——保留它们以便 30 天扫描仍能清理旧版本构建泄漏的工作树。
  /^wf-\d+$/,
  // 真正的 bridge slug 是 `bridge-${safeFilenameId(sessionId)}`。
  /^bridge-[A-Za-z0-9_]+(-[A-Za-z0-9_]+)*$/,
  // 模板作业工作树：job-<templateName>-<8hex>。前缀用于区分与恰
  // 好以 8 位十六进制结尾的用户命名的 EnterWorktree slug。
  /^job-[a-zA-Z0-9._-]{1,55}-[0-9a-f]{8}$/,
]

/** 移除早于 cutoffDate 的陈旧代理/工作流工作树。

安全措施：
- 仅处理匹配临时模式的 slug（绝不触碰用户命名的工作树）
- 跳过当前会话的工作树
- 故障关闭：如果 git status 失败或显示已跟踪的更改则跳过
  （-uno：30 天前崩溃的代理工作树中的未跟踪文件是构建产物；
   跳过未跟踪扫描在大型仓库上快 5-10 倍）
- 故障关闭：如果有任何提交无法从远程仓库访问则跳过

`git worktree remove --force` 会同时处理目录和 Git 的内部工作树跟踪。
如果 Git 不将该路径识别为工作树（孤立目录），则将其保留在原处——
后续的 readdir 再次发现它陈旧是无害的。 */
export async function cleanupStaleAgentWorktrees(
  cutoffDate: Date,
): Promise<number> {
  const gitRoot = findCanonicalGitRoot(getCwd())
  if (!gitRoot) {
    return 0
  }

  const dir = worktreesDir(gitRoot)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return 0
  }

  const cutoffMs = cutoffDate.getTime()
  const currentPath = currentWorktreeSession?.worktreePath
  let removed = 0

  for (const slug of entries) {
    if (!EPHEMERAL_WORKTREE_PATTERNS.some(p => p.test(slug))) {
      continue
    }

    const worktreePath = join(dir, slug)
    if (currentPath === worktreePath) {
      continue
    }

    let mtimeMs: number
    try {
      mtimeMs = (await stat(worktreePath)).mtimeMs
    } catch {
      continue
    }
    if (mtimeMs >= cutoffMs) {
      continue
    }

    // 两项检查都必须成功且输出为空。非零退出（工作树损
    // 坏、Git 无法识别等）意味着跳过——我们不知道
    // 里面有什么。
    const [status, unpushed] = await Promise.all([
      execFileNoThrowWithCwd(
        gitExe(),
        ['--no-optional-locks', 'status', '--porcelain', '-uno'],
        { cwd: worktreePath },
      ),
      execFileNoThrowWithCwd(
        gitExe(),
        ['rev-list', '--max-count=1', 'HEAD', '--not', '--remotes'],
        { cwd: worktreePath },
      ),
    ])
    if (status.code !== 0 || status.stdout.trim().length > 0) {
      continue
    }
    if (unpushed.code !== 0 || unpushed.stdout.trim().length > 0) {
      continue
    }

    if (
      await removeAgentWorktree(worktreePath, worktreeBranchName(slug), gitRoot)
    ) {
      removed++
    }
  }

  if (removed > 0) {
    await execFileNoThrowWithCwd(gitExe(), ['worktree', 'prune'], {
      cwd: gitRoot,
    })
    logForDebugging(
      `cleanupStaleAgentWorktrees：已移除 ${removed} 个陈旧工作树`,
    )
  }
  return removed
}

/** 检查工作树自创建以来是否有未提交的更改或新提交。
如果存在未提交的更改（脏的工作区）、自 `headCommit` 以来在工作树分支上进行了提交，
或者 Git 命令失败，则返回 true——调用方使用此结果来决定是否移除工作树，因此采用故障关闭策略。 */
export async function hasWorktreeChanges(
  worktreePath: string,
  headCommit: string,
): Promise<boolean> {
  const { code: statusCode, stdout: statusOutput } =
    await execFileNoThrowWithCwd(gitExe(), ['status', '--porcelain'], {
      cwd: worktreePath,
    })
  if (statusCode !== 0) {
    return true
  }
  if (statusOutput.trim().length > 0) {
    return true
  }

  const { code: revListCode, stdout: revListOutput } =
    await execFileNoThrowWithCwd(
      gitExe(),
      ['rev-list', '--count', `${headCommit}..HEAD`],
      { cwd: worktreePath },
    )
  if (revListCode !== 0) {
    return true
  }
  if (parseInt(revListOutput.trim(), 10) > 0) {
    return true
  }

  return false
}

/** --worktree --tmux 的快速路径处理程序。
创建工作树并 exec 到在其中运行 Claude 的 tmux。
这是在 cli.tsx 加载完整 CLI 之前早期调用的。 */
export async function execIntoTmuxWorktree(args: string[]): Promise<{
  handled: boolean
  error?: string
}> {
  // 检查平台 - tmux 在 Windows 上无法工作
  if (process.platform === 'win32') {
    return {
      handled: false,
      error: '错误：Windows 不支持 --tmux',
    }
  }

  // 检查 tmux 是否可用
  const tmuxCheck = spawnSync('tmux', ['-V'], { encoding: 'utf-8' })
  if (tmuxCheck.status !== 0) {
    const installHint =
      process.platform === 'darwin'
        ? '使用以下命令安装 tmux：brew install tmux'
        : '使用以下命令安装 tmux：sudo apt install tmux'
    return {
      handled: false,
      error: `错误：未安装 tmux。${installHint}`,
    }
  }

  // 从参数中解析工作树名称和 tmux 模式
  let worktreeName: string | undefined
  let forceClassicTmux = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '-w' || arg === '--worktree') {
      // 检查下一个参数是否存在且不是另一个标志
      const next = args[i + 1]
      if (next && !next.startsWith('-')) {
        worktreeName = next
      }
    } else if (arg.startsWith('--worktree=')) {
      worktreeName = arg.slice('--worktree='.length)
    } else if (arg === '--tmux=classic') {
      forceClassicTmux = true
    }
  }

  // 检查工作树名称是否为 PR 引用
  let prNumber: number | null = null
  if (worktreeName) {
    prNumber = parsePRReference(worktreeName)
    if (prNumber !== null) {
      worktreeName = `pr-${prNumber}`
    }
  }

  // 如果未提供名称，则生成一个 slug
  if (!worktreeName) {
    const adjectives = ['swift', 'bright', 'calm', 'keen', 'bold']
    const nouns = ['fox', 'owl', 'elm', 'oak', 'ray']
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)]
    const noun = nouns[Math.floor(Math.random() * nouns.length)]
    const suffix = Math.random().toString(36).slice(2, 6)
    worktreeName = `${adj}-${noun}-${suffix}`
  }

  // worktreeName 会在下方通过 path.join 合并到
  // worktreeDir 中；应用与会话内工作树工具相同的允许列表
  // ，这样无论入口点如何，约束都能统一保持。
  try {
    validateWorktreeSlug(worktreeName)
  } catch (e) {
    return {
      handled: false,
      error: `Error: ${(e as Error).message}`,
    }
  }

  // 镜像 createWorktreeForSession()：钩子优先于 Git，因此
  // WorktreeCreate 钩子也会为此快速路径替换 VCS 后端（anthrop
  // ics/claude-code#39281）。下面的 Git 路径仅在无钩子时运行。
  let worktreeDir: string
  let repoName: string
  if (hasWorktreeCreateHook()) {
    try {
      const hookResult = await executeWorktreeCreateHook(worktreeName)
      worktreeDir = hookResult.worktreePath
    } catch (error) {
      return {
        handled: false,
        error: `Error: ${errorMessage(error)}`,
      }
    }
    repoName = basename(findCanonicalGitRoot(getCwd()) ?? getCwd())
    // biome-ignore lint/suspicious/noConsole：故意的控制台输出
    console.log(`通过钩子使用工作树：${worktreeDir}`)
  } else {
    // 获取主 Git 仓库根目录（通过工作树解析）
    const repoRoot = findCanonicalGitRoot(getCwd())
    if (!repoRoot) {
      return {
        handled: false,
        error: '错误：--worktree 需要一个 Git 仓库',
      }
    }

    repoName = basename(repoRoot)
    worktreeDir = worktreePathFor(repoRoot, worktreeName)

    // 创建或恢复工作树
    try {
      const result = await getOrCreateWorktree(
        repoRoot,
        worktreeName,
        prNumber !== null ? { prNumber } : undefined,
      )
      if (!result.existed) {
        // biome-ignore lint/suspicious/noConsole：故意的控制台输出
        console.log(
          `已创建工作树：${worktreeDir}（基于 ${(result as any).baseBranch}）`,
        )
        await performPostCreationSetup(repoRoot, worktreeDir)
      }
    } catch (error) {
      return {
        handled: false,
        error: `Error: ${errorMessage(error)}`,
      }
    }
  }

  // 为 tmux 会话名称进行清理（将 / 和 . 替换为 _）
  const tmuxSessionName =
    `${repoName}_${worktreeBranchName(worktreeName)}`.replace(/[/.]/g, '_')

  // 构建不含 --tmux 和 --worktree 的新参数（我们已经在工作树中）
  const newArgs: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '--tmux' || arg === '--tmux=classic') continue
    if (arg === '-w' || arg === '--worktree') {
      // 如果存在，则跳过该标志及其值
      const next = args[i + 1]
      if (next && !next.startsWith('-')) {
        i++ // 也跳过该值
      }
      continue
    }
    if (arg.startsWith('--worktree=')) continue
    newArgs.push(arg)
  }

  // 获取 tmux 前缀以提供用户指导
  let tmuxPrefix = 'C-b' // 默认
  const prefixResult = spawnSync('tmux', ['show-options', '-g', 'prefix'], {
    encoding: 'utf-8',
  })
  if (prefixResult.status === 0 && prefixResult.stdout) {
    const match = prefixResult.stdout.match(/prefix\s+(\S+)/)
    if (match?.[1]) {
      tmuxPrefix = match[1]
    }
  }

  // 检查 tmux 前缀是否与 Claude 键绑定冲突 Claude 绑定了：ct
  // rl+b（任务：background）、ctrl+c、ctrl+d、ctrl+t、ctrl+o、ctrl+r、ctrl+s、ctrl+g、ctrl+e
  const claudeBindings = [
    'C-b',
    'C-c',
    'C-d',
    'C-t',
    'C-o',
    'C-r',
    'C-s',
    'C-g',
    'C-e',
  ]
  const prefixConflicts = claudeBindings.includes(tmuxPrefix)

  // 为内部的 Claude 设置环境变量，以便在欢迎消息中显示 tmux 信息
  const tmuxEnv = {
    ...process.env,
    CLAUDE_CODE_TMUX_SESSION: tmuxSessionName,
    CLAUDE_CODE_TMUX_PREFIX: tmuxPrefix,
    CLAUDE_CODE_TMUX_PREFIX_CONFLICTS: prefixConflicts ? '1' : '',
  }

  // 检查会话是否已存在
  const hasSessionResult = spawnSync(
    'tmux',
    ['has-session', '-t', tmuxSessionName],
    { encoding: 'utf-8' },
  )
  const sessionExists = hasSessionResult.status === 0

  // 检查我们是否已经在 tmux 会话内部
  const isAlreadyInTmux = Boolean(process.env.TMUX)

  // 使用 tmux 控制模式（-CC）实现原生 iTerm2 标签页/窗格集成
  // 这允许用户使用 iTerm2 的 UI，而无需学习 tmux 键绑定 使用
  // --tmux=classic 强制使用传统的 tmux，即使在 i
  // Term2 中 当已经在 tmux 中时，控制模式没有意义（需要 switch-client）
  const useControlMode = isInITerm2() && !forceClassicTmux && !isAlreadyInTmux
  const tmuxGlobalArgs = useControlMode ? ['-CC'] : []

  // 使用控制模式时，打印关于 iTerm2 首选项的提示
  if (useControlMode && !sessionExists) {
    const y = chalk.yellow
    // biome-ignore lint/suspicious/noConsole：故意的用户指导
    console.log(
      `\n${y('╭─ iTerm2 提示 ────────────────────────────────────────────────────────╮')}\n` +
        `${y('│')} 要作为标签页而非新窗口打开：                           ${y('│')}
` +
        `${y('│')} iTerm2 > 设置 > 通用 > tmux > "附加窗口中的标签页"     ${y('│')}
` +
        `${y('╰─────────────────────────────────────────────────────────────────────╯')}\n`,
    )
  }

  // 对于 claude-cli-internal 中的 ants，设置开发窗格（watch + start）
  const isAnt = process.env.USER_TYPE === 'ant'
  const isClaudeCliInternal = repoName === 'claude-cli-internal'
  const shouldSetupDevPanes = isAnt && isClaudeCliInternal && !sessionExists

  if (shouldSetupDevPanes) {
    // 创建分离的会话，第一个窗格中运行 Claude
    spawnSync(
      'tmux',
      [
        'new-session',
        '-d', // 分离的
        '-s',
        tmuxSessionName,
        '-c',
        worktreeDir,
        '--',
        process.execPath,
        ...newArgs,
      ],
      { cwd: worktreeDir, env: tmuxEnv },
    )

    // 水平分割并运行 watch
    spawnSync(
      'tmux',
      ['split-window', '-h', '-t', tmuxSessionName, '-c', worktreeDir],
      { cwd: worktreeDir },
    )
    spawnSync(
      'tmux',
      ['send-keys', '-t', tmuxSessionName, 'bun run watch', 'Enter'],
      { cwd: worktreeDir },
    )

    // 垂直分割并运行 start
    spawnSync(
      'tmux',
      ['split-window', '-v', '-t', tmuxSessionName, '-c', worktreeDir],
      { cwd: worktreeDir },
    )
    spawnSync('tmux', ['send-keys', '-t', tmuxSessionName, '运行 bun start'], {
      cwd: worktreeDir,
    })

    // 选择第一个窗格 (Claude)
    spawnSync('tmux', ['select-pane', '-t', `${tmuxSessionName}:0.0`], {
      cwd: worktreeDir,
    })

    // 附加到会话或切换到会话
    if (isAlreadyInTmux) {
      // 切换到同级会话 (避免嵌套)
      spawnSync('tmux', ['switch-client', '-t', tmuxSessionName], {
        stdio: 'inherit',
      })
    } else {
      // 附加到会话
      spawnSync(
        'tmux',
        [...tmuxGlobalArgs, 'attach-session', '-t', tmuxSessionName],
        {
          stdio: 'inherit',
          cwd: worktreeDir,
        },
      )
    }
  } else {
    // 标准行为：创建或附加
    if (isAlreadyInTmux) {
      // 已在 tmux 中 - 先检查会话是否已存在，然后创建分
      // 离式会话，再切换到它 (同级)
      if (sessionExists) {
        // 直接切换到现有会话
        spawnSync('tmux', ['switch-client', '-t', tmuxSessionName], {
          stdio: 'inherit',
        })
      } else {
        // 创建新的分离式会话
        spawnSync(
          'tmux',
          [
            'new-session',
            '-d', // 分离式
            '-s',
            tmuxSessionName,
            '-c',
            worktreeDir,
            '--',
            process.execPath,
            ...newArgs,
          ],
          { cwd: worktreeDir, env: tmuxEnv },
        )

        // 切换到新会话
        spawnSync('tmux', ['switch-client', '-t', tmuxSessionName], {
          stdio: 'inherit',
        })
      }
    } else {
      // 不在 tmux 中 - 创建并附加 (原始行为)
      const tmuxArgs = [
        ...tmuxGlobalArgs,
        'new-session',
        '-A', // 如果存在则附加，否则创建
        '-s',
        tmuxSessionName,
        '-c',
        worktreeDir,
        '--', // 命令前的分隔符
        process.execPath,
        ...newArgs,
      ]

      spawnSync('tmux', tmuxArgs, {
        stdio: 'inherit',
        cwd: worktreeDir,
        env: tmuxEnv,
      })
    }
  }

  return { handled: true }
}
