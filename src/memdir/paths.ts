import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { isAbsolute, join, normalize, sep } from 'path'
import {
  getIsNonInteractiveSession,
  getProjectRoot,
} from '../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  getClaudeConfigHomeDir,
  isEnvDefinedFalsy,
  isEnvTruthy,
} from '../utils/envUtils.js'
import { findCanonicalGitRoot } from '../utils/git.js'
import { sanitizePath } from '../utils/path.js'
import {
  getInitialSettings,
  getSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 是否启用自动内存功能（memdir、代理内存、过往会话搜索）。
 * 默认启用。优先级链（最先定义的生效）：
 *   1. CLAUDE_CODE_DISABLE_AUTO_MEMORY 环境变量（1/true → 关闭，0/false → 开启）
 *   2. CLAUDE_CODE_SIMPLE（--bare）→ 关闭
 *   3. 无持久化存储的 CCR → 关闭（没有 CLAUDE_CODE_REMOTE_MEMORY_DIR）
 *   4. settings.json 中的 autoMemoryEnabled（支持项目级退出）
 *   5. 默认：启用
 */
export function isAutoMemoryEnabled(): boolean {
  const envVal = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  if (isEnvTruthy(envVal)) {
    return false
  }
  if (isEnvDefinedFalsy(envVal)) {
    return true
  }
  // --bare / SIMPLE：prompts.ts 已经通过其 SIMPLE 提前返回从系统提示中移除了内存部分；
  // 此门控停止另一半功能（extractMemories 轮次末分支、autoDream、/remember、/dream、团队同步）。
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    return false
  }
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
    !process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
  ) {
    return false
  }
  const settings = getInitialSettings()
  if (settings.autoMemoryEnabled !== undefined) {
    return settings.autoMemoryEnabled
  }
  return true
}

/**
 * 提取记忆的后台代理是否会在本次会话中运行。
 *
 * 无论此门控如何，主代理的提示始终包含完整的保存指令 —— 当主代理写入记忆时，
 * 后台代理会跳过该范围（extractMemories.ts 中的 hasMemoryWritesSince）；
 * 当主代理未写入时，后台代理会捕获遗漏的内容。
 *
 * 调用方还必须同时使用 feature('EXTRACT_MEMORIES') 进行门控 —— 该检查不能放在此辅助函数内部，
 * 因为 feature() 仅在直接用于 `if` 条件中时才会进行摇树优化。
 */
export function isExtractModeActive(): boolean {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_passport_quail', false)) {
    return false
  }
  return (
    !getIsNonInteractiveSession() ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_slate_thimble', false)
  )
}

/**
 * 返回持久化内存存储的基础目录。
 * 解析顺序：
 *   1. CLAUDE_CODE_REMOTE_MEMORY_DIR 环境变量（显式覆盖，在 CCR 中设置）
 *   2. ~/.claude（默认配置主目录）
 */
export function getMemoryBaseDir(): string {
  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    return process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
  }
  return getClaudeConfigHomeDir()
}

const AUTO_MEM_DIRNAME = 'memory'
const AUTO_MEM_ENTRYPOINT_NAME = 'MEMORY.md'

/**
 * 规范化并验证候选的自动内存目录路径。
 *
 * 安全：拒绝那些作为读取允许列表根目录会有危险的路径，
 * 或 normalize() 无法完全解析的路径：
 * - 相对路径（!isAbsolute）："../foo" —— 会相对于 CWD 解释
 * - 根目录或接近根目录（长度 < 3）："/" → 剥离后为空字符串；"/a" 过短
 * - Windows 驱动器根目录（C: 正则）："C:\" → 剥离后为 "C:"
 * - UNC 路径（\\server\share）：网络路径 —— 不透明的信任边界
 * - 空字节：通过 normalize() 保留，可能在系统调用中被截断
 *
 * 返回规范化的路径，且恰好带一个尾部分隔符，
 * 如果路径未设置/为空/被拒绝，则返回 undefined。
 */
function validateMemoryPath(
  raw: string | undefined,
  expandTilde: boolean,
): string | undefined {
  if (!raw) {
    return undefined
  }
  let candidate = raw
  // Settings.json 路径支持 ~/ 扩展（用户友好）。环境变量覆盖不支持（它由 Cowork/SDK 程序化设置，应始终传递绝对路径）。
  // 裸的 "~"、"~/""、"~/.", "~/.." 等不会被扩展 —— 它们会使 isAutoMemPath() 匹配整个 $HOME 或其父目录（与 "/" 或 "C:\" 属同一类危险）。
  if (
    expandTilde &&
    (candidate.startsWith('~/') || candidate.startsWith('~\\'))
  ) {
    const rest = candidate.slice(2)
    // 拒绝会扩展为 $HOME 或其祖先的平凡剩余部分。
    // normalize('') = '.'，normalize('.') = '.'，normalize('foo/..') = '.'，
    // normalize('..') = '..'，normalize('foo/../..') = '..'
    const restNorm = normalize(rest || '.')
    if (restNorm === '.' || restNorm === '..') {
      return undefined
    }
    candidate = join(homedir(), rest)
  }
  // normalize() 可能会保留尾部分隔符；先剥离，再添加恰好一个分隔符以匹配 getAutoMemPath() 的尾部分隔符约定
  const normalized = normalize(candidate).replace(/[/\\]+$/, '')
  if (
    !isAbsolute(normalized) ||
    normalized.length < 3 ||
    /^[A-Za-z]:$/.test(normalized) ||
    normalized.startsWith('\\\\') ||
    normalized.startsWith('//') ||
    normalized.includes('\0')
  ) {
    return undefined
  }
  return (normalized + sep).normalize('NFC')
}

/**
 * 通过环境变量直接覆盖完整的自动内存目录路径。
 * 当设置时，getAutoMemPath()/getAutoMemEntrypoint() 直接返回此路径，
 * 而不是计算 `{base}/projects/{sanitized-cwd}/memory/`。
 *
 * 由 Cowork 使用，用于将内存重定向到空间作用域的挂载点，
 * 否则每个会话的 cwd（包含虚拟机进程名）会为每个会话生成不同的项目键。
 */
function getAutoMemPathOverride(): string | undefined {
  return validateMemoryPath(
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE,
    false,
  )
}

/**
 * Settings.json 中对完整自动内存目录路径的覆盖。
 * 支持 ~/ 扩展，以方便用户使用。
 *
 * 安全：projectSettings（提交到仓库的 .claude/settings.json）被有意排除 ——
 * 否则恶意仓库可以设置 autoMemoryDirectory: "~/.ssh"，并通过 filesystem.ts 的写入例外
 * （当 isAutoMemPath() 匹配且 hasAutoMemPathOverride() 为 false 时触发）获得对敏感目录的静默写入权限。
 * 这与 hasSkipDangerousModePermissionPrompt() 等采用相同的模式。
 */
function getAutoMemPathSetting(): string | undefined {
  const dir =
    getSettingsForSource('policySettings')?.autoMemoryDirectory ??
    getSettingsForSource('flagSettings')?.autoMemoryDirectory ??
    getSettingsForSource('localSettings')?.autoMemoryDirectory ??
    getSettingsForSource('userSettings')?.autoMemoryDirectory
  return validateMemoryPath(dir, true)
}

/**
 * 检查 CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 是否设置为有效的覆盖路径。
 * 将其作为 SDK 调用方已明确选择加入自动内存机制的信号 ——
 * 例如，用于决定在自定义系统提示替换默认提示时是否注入内存提示。
 */
export function hasAutoMemPathOverride(): boolean {
  return getAutoMemPathOverride() !== undefined
}

/**
 * 返回规范的 git 仓库根目录（如果可用），否则回退到稳定的项目根目录。
 * 使用 findCanonicalGitRoot，使得同一仓库的所有工作树共享一个自动内存目录（anthropics/claude-code#24382）。
 */
function getAutoMemBase(): string {
  return findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot()
}

/**
 * 返回自动内存目录路径。
 *
 * 解析顺序：
 *   1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 环境变量（完整路径覆盖，由 Cowork 使用）
 *   2. settings.json 中的 autoMemoryDirectory（仅可信来源：policy/local/user）
 *   3. <memoryBase>/projects/<sanitized-git-root>/memory/
 *      其中 memoryBase 由 getMemoryBaseDir() 解析
 *
 * 已记忆化：渲染路径调用方（collapseReadSearchGroups → isAutoManagedMemoryFile）
 * 每次消息重渲染时触发；每次缓存未命中会调用 getSettingsForSource × 4 → parseSettingsFile（realpathSync + readFileSync）。
 * 以 projectRoot 为键，以便在块中间更改其 mock 的测试能重新计算；
 * 环境变量 / settings.json / CLAUDE_CONFIG_DIR 在生产环境中是会话稳定的，并且由每个测试的 cache.clear 覆盖。
 */
export const getAutoMemPath = memoize(
  (): string => {
    const override = getAutoMemPathOverride() ?? getAutoMemPathSetting()
    if (override) {
      return override
    }
    const projectsDir = join(getMemoryBaseDir(), 'projects')
    return (
      join(projectsDir, sanitizePath(getAutoMemBase()), AUTO_MEM_DIRNAME) + sep
    ).normalize('NFC')
  },
  () => getProjectRoot(),
)

/**
 * 返回给定日期（默认为今天）的每日日志文件路径。
 * 格式：<autoMemPath>/logs/YYYY/MM/YYYY-MM-DD.md
 *
 * 用于助手模式（feature('KAIROS')）：代理在运行时追加到按日期命名的日志文件，
 * 而不是将 MEMORY.md 维护为实时索引。单独的夜间 /dream 技能会将这些日志提炼为主题文件 + MEMORY.md。
 */
export function getAutoMemDailyLogPath(date: Date = new Date()): string {
  const yyyy = date.getFullYear().toString()
  const mm = (date.getMonth() + 1).toString().padStart(2, '0')
  const dd = date.getDate().toString().padStart(2, '0')
  return join(getAutoMemPath(), 'logs', yyyy, mm, `${yyyy}-${mm}-${dd}.md`)
}

/**
 * 返回自动内存入口点（自动内存目录内的 MEMORY.md）。
 * 遵循与 getAutoMemPath() 相同的解析顺序。
 */
export function getAutoMemEntrypoint(): string {
  return join(getAutoMemPath(), AUTO_MEM_ENTRYPOINT_NAME)
}

/**
 * 检查绝对路径是否位于自动内存目录内。
 *
 * 当设置了 CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 时，此函数会与环境变量覆盖目录进行匹配。
 * 注意：在这种情况下，返回 true 并不意味着有写入权限 —— filesystem.ts 的写入例外受
 * !hasAutoMemPathOverride() 门控（它存在的目的是绕过 DANGEROUS_DIRECTORIES）。
 *
 * settings.json 中的 autoMemoryDirectory 确实会获得写入例外：这是用户从可信设置来源
 * （projectSettings 被排除 —— 见 getAutoMemPathSetting）的明确选择，并且 hasAutoMemPathOverride() 对此返回 false。
 */
export function isAutoMemPath(absolutePath: string): boolean {
  // 安全：规范化以防止通过 .. 段进行路径遍历绕过
  const normalizedPath = normalize(absolutePath)
  return normalizedPath.startsWith(getAutoMemPath())
}