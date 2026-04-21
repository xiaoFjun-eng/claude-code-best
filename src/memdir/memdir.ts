import { feature } from 'bun:bundle'
import { join } from 'path'
import { getFsImplementation } from '../utils/fsOperations.js'
import { getAutoMemPath, isAutoMemoryEnabled } from './paths.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('./teamMemPaths.js') as typeof import('./teamMemPaths.js'))
  : null

import { getKairosActive, getOriginalCwd } from '../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { GREP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GrepTool/prompt.js'
import { isReplModeEnabled } from '@claude-code-best/builtin-tools/tools/REPLTool/constants.js'
import { logForDebugging } from '../utils/debug.js'
import { hasEmbeddedSearchTools } from '../utils/embeddedTools.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { formatFileSize } from '../utils/format.js'
import { getProjectDir } from '../utils/sessionStorage.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
} from './memoryTypes.js'

export const ENTRYPOINT_NAME = 'MEMORY.md'
export const MAX_ENTRYPOINT_LINES = 200
// 约 125 字符/行 * 200 行。目前覆盖了 p97 分位数；用于捕获那些绕过行数限制的长行索引（观察到 p100 极端情况：197KB 在 200 行以内）。
export const MAX_ENTRYPOINT_BYTES = 25_000
const AUTO_MEM_DISPLAY_NAME = 'auto memory'

export type EntrypointTruncation = {
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

/**
 * 截断 MEMORY.md 内容，同时遵守行数和字节数限制，并附加一个警告说明触发了哪个限制。
 * 先按行截断（自然边界），然后按字节截断到最后一个换行符之前，避免切在行中间。
 *
 * 被 buildMemoryPrompt 和 claudemd 的 getMemoryFiles 共用（之前重复实现了仅行数的逻辑）。
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim()
  const contentLines = trimmed.split('\n')
  const lineCount = contentLines.length
  const byteCount = trimmed.length

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  // 检查原始字节数 —— 长行是字节限制要处理的失败模式，因此按行截断后的大小会低估警告的严重性。
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  if (!wasLineTruncated && !wasByteTruncated) {
    return {
      content: trimmed,
      lineCount,
      byteCount,
      wasLineTruncated,
      wasByteTruncated,
    }
  }

  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : trimmed

  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES)
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES)
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${formatFileSize(byteCount)} (限制: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — 索引条目过长`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} 行 (限制: ${MAX_ENTRYPOINT_LINES})`
        : `${lineCount} 行 和 ${formatFileSize(byteCount)}`

  return {
    content:
      truncated +
      `\n\n> 警告: ${ENTRYPOINT_NAME} 的大小为 ${reason}。仅加载了部分内容。请保持索引条目每行不超过约 200 字符；将详细内容移到主题文件中。`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  }
}

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPrompts = feature('TEAMMEM')
  ? (require('./teamMemPrompts.js') as typeof import('./teamMemPrompts.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 附加到每个内存目录提示行的共享指导文本。
 * 提供该文本是因为 Claude 会在写入前执行 `ls`/`mkdir -p` 浪费轮次。
 * 工具通过 ensureMemoryDirExists() 保证目录已存在。
 */
export const DIR_EXISTS_GUIDANCE =
  '此目录已存在 —— 请直接使用 Write 工具写入（不要运行 mkdir 或检查其存在性）。'
export const DIRS_EXIST_GUIDANCE =
  '两个目录均已存在 —— 请直接使用 Write 工具写入（不要运行 mkdir 或检查其存在性）。'

/**
 * 确保内存目录存在。幂等操作 —— 从 loadMemoryPrompt 调用（每个会话通过 systemPromptSection 缓存调用一次），
 * 这样模型无需预先检查存在性即可直接写入。FsOperations.mkdir 默认递归且已吞掉 EEXIST 错误，
 * 因此一次调用即可创建完整的父目录链（~/.claude/projects/<slug>/memory/），正常路径下无需 try/catch。
 */
export async function ensureMemoryDirExists(memoryDir: string): Promise<void> {
  const fs = getFsImplementation()
  try {
    await fs.mkdir(memoryDir)
  } catch (e) {
    // fs.mkdir 内部已处理 EEXIST。到达这里的错误是真正的问题（EACCES/EPERM/EROFS）——
    // 记录日志以便 --debug 显示原因。无论是否记录，提示构建都会继续；模型写入时会暴露真实的权限错误
    // （FileWriteTool 也会自己创建父目录）。
    const code =
      e instanceof Error && 'code' in e && typeof e.code === 'string'
        ? e.code
        : undefined
    logForDebugging(
      `ensureMemoryDirExists 对 ${memoryDir} 失败: ${code ?? String(e)}`,
      { level: 'debug' },
    )
  }
}

/**
 * 异步记录内存目录的文件/子目录数量。
 * 即发即忘 —— 不阻塞提示构建。
 */
function logMemoryDirCounts(
  memoryDir: string,
  baseMetadata: Record<
    string,
    | number
    | boolean
    | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  >,
): void {
  const fs = getFsImplementation()
  void fs.readdir(memoryDir).then(
    dirents => {
      let fileCount = 0
      let subdirCount = 0
      for (const d of dirents) {
        if (d.isFile()) {
          fileCount++
        } else if (d.isDirectory()) {
          subdirCount++
        }
      }
      logEvent('tengu_memdir_loaded', {
        ...baseMetadata,
        total_file_count: fileCount,
        total_subdir_count: subdirCount,
      })
    },
    () => {
      // 目录不可读 —— 记录不带计数的事件
      logEvent('tengu_memdir_loaded', baseMetadata)
    },
  )
}

/**
 * 构建类型化内存的行为指令（不包含 MEMORY.md 内容）。
 * 将记忆限制在封闭的四类型分类中（user / feedback / project / reference）——
 * 明确排除那些可以从当前项目状态（代码模式、架构、git 历史）推导出的内容。
 *
 * 个人专用变体：不包含 `## Memory scope` 章节，类型块中没有 <scope> 标签，
 * 且示例中去掉了 team/private 限定词。
 *
 * 被 buildMemoryPrompt（代理内存，包含内容）和 loadMemoryPrompt（系统提示，内容通过用户上下文注入）使用。
 */
export function buildMemoryLines(
  displayName: string,
  memoryDir: string,
  extraGuidelines?: string[],
  skipIndex = false,
): string[] {
  const howToSave = skipIndex
    ? [
        '## 如何保存记忆',
        '',
        '将每条记忆写入自己的文件（例如 `user_role.md`、`feedback_testing.md`），使用以下前置元数据格式：',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '- 保持记忆文件中的名称、描述和类型字段与内容同步',
        '- 按主题语义组织记忆，而不是按时间顺序',
        '- 更新或删除那些被证明错误或过时的记忆',
        '- 不要写入重复的记忆。在写入新记忆前，先检查是否存在可更新的现有记忆。',
      ]
    : [
        '## 如何保存记忆',
        '',
        '保存记忆分为两步：',
        '',
        '**第 1 步** —— 将记忆写入自己的文件（例如 `user_role.md`、`feedback_testing.md`），使用以下前置元数据格式：',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        `**第 2 步** —— 在 \`${ENTRYPOINT_NAME}\` 中添加指向该文件的指针。\`${ENTRYPOINT_NAME}\` 是索引，不是记忆本身 —— 每个条目占一行，不超过约 150 字符：\`- [标题](file.md) — 单行钩子\`。它没有前置元数据。永远不要将记忆内容直接写入 \`${ENTRYPOINT_NAME}\`。`,
        '',
        `- \`${ENTRYPOINT_NAME}\` 始终加载到你的对话上下文中 —— 超过 ${MAX_ENTRYPOINT_LINES} 行的部分将被截断，请保持索引简洁`,
        '- 保持记忆文件中的名称、描述和类型字段与内容同步',
        '- 按主题语义组织记忆，而不是按时间顺序',
        '- 更新或删除那些被证明错误或过时的记忆',
        '- 不要写入重复的记忆。在写入新记忆前，先检查是否存在可更新的现有记忆。',
      ]

  const lines: string[] = [
    `# ${displayName}`,
    '',
    `你有一个基于文件的持久化记忆系统，位于 \`${memoryDir}\`。${DIR_EXISTS_GUIDANCE}`,
    '',
    '你应该随着时间逐步构建这个记忆系统，以便未来的对话能够全面了解用户是谁、用户希望如何与你协作、需要避免或重复哪些行为，以及用户所给工作背后的上下文。',
    '',
    '如果用户明确要求你记住某事，请立即以最合适的类型保存它。如果他们要求你忘记某事，请找到并删除相关的条目。',
    '',
    ...TYPES_SECTION_INDIVIDUAL,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    ...howToSave,
    '',
    ...WHEN_TO_ACCESS_SECTION,
    '',
    ...TRUSTING_RECALL_SECTION,
    '',
    '## 记忆与其他持久化形式',
    '记忆是你在对话中帮助用户时可用的多种持久化机制之一。区别通常在于记忆可以在未来的对话中被回忆起来，而不应用于持久化仅在当前对话范围内有用的信息。',
    '- 何时使用或更新计划而不是记忆：如果你即将开始一项非平凡的实现任务，并希望与用户就你的方法达成一致，你应该使用计划，而不是将此信息保存到记忆中。类似地，如果对话中已有计划且你改变了方法，请通过更新计划来持久化该变更，而不是保存记忆。',
    '- 何时使用或更新任务而不是记忆：当你需要将当前对话中的工作分解为离散的步骤或跟踪进度时，请使用任务而不是保存到记忆。任务非常适合持久化当前对话中需要完成的工作信息，但记忆应保留给对未来对话有用的信息。',
    '',
    ...(extraGuidelines ?? []),
    '',
  ]

  lines.push(...buildSearchingPastContextSection(memoryDir))

  return lines
}

/**
 * 构建包含 MEMORY.md 内容的类型化内存提示。
 * 供代理内存使用（没有对应的 getClaudeMds() 方法）。
 */
export function buildMemoryPrompt(params: {
  displayName: string
  memoryDir: string
  extraGuidelines?: string[]
}): string {
  const { displayName, memoryDir, extraGuidelines } = params
  const fs = getFsImplementation()
  const entrypoint = memoryDir + ENTRYPOINT_NAME

  // 创建目录是调用者的责任（loadMemoryPrompt / loadAgentMemoryPrompt）。
  // 构建器只读取，不创建目录。

  // 读取现有记忆入口文件（同步：提示构建是同步的）
  let entrypointContent = ''
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs
    entrypointContent = fs.readFileSync(entrypoint, { encoding: 'utf-8' })
  } catch {
    // 还没有记忆文件
  }

  const lines = buildMemoryLines(displayName, memoryDir, extraGuidelines)

  if (entrypointContent.trim()) {
    const t = truncateEntrypointContent(entrypointContent)
    const memoryType = displayName === AUTO_MEM_DISPLAY_NAME ? 'auto' : 'agent'
    logMemoryDirCounts(memoryDir, {
      content_length: t.byteCount,
      line_count: t.lineCount,
      was_truncated: t.wasLineTruncated,
      was_byte_truncated: t.wasByteTruncated,
      memory_type:
        memoryType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    lines.push(`## ${ENTRYPOINT_NAME}`, '', t.content)
  } else {
    lines.push(
      `## ${ENTRYPOINT_NAME}`,
      '',
      `你的 ${ENTRYPOINT_NAME} 当前为空。当你保存新记忆时，它们将显示在这里。`,
    )
  }

  return lines.join('\n')
}

/**
 * 助手模式的每日日志提示。由 feature('KAIROS') 门控启用。
 *
 * 助手会话实际上是永久性的，因此代理以仅追加的方式将记忆写入按日期命名的日志文件，
 * 而不是维护 MEMORY.md 作为实时索引。单独的夜间 /dream 技能将日志提炼为主题文件 + MEMORY.md。
 * MEMORY.md 仍然通过 claudemd.ts 作为提炼后的索引加载到上下文中 —— 此提示仅改变新记忆的去向。
 */
function buildAssistantDailyLogPrompt(skipIndex = false): string {
  const memoryDir = getAutoMemPath()
  // 将路径描述为模式，而不是内联今天的实际路径：
  // 此提示由 systemPromptSection('memory', ...) 缓存，并且不会因日期变化而失效。
  // 模型从 date_change 附件（午夜轮转时追加在尾部）获取当前日期，而不是从用户上下文消息中获取 ——
  // 后者故意保持过期状态，以保留跨午夜的提示缓存前缀。
  const logPathPattern = join(memoryDir, 'logs', 'YYYY', 'MM', 'YYYY-MM-DD.md')

  const lines: string[] = [
    '# 自动记忆',
    '',
    `你有一个基于文件的持久化记忆系统，位于：\`${memoryDir}\``,
    '',
    '此会话是长期运行的。在你工作过程中，请通过**追加**到今天的每日日志文件来记录任何值得记住的内容：',
    '',
    `\`${logPathPattern}\``,
    '',
    "将上下文中的 `currentDate` 所对应的今天日期替换到 `YYYY-MM-DD` 中。如果会话中途跨越了午夜，请开始追加到新一天的日志文件中。",
    '',
    '每条记录为简短的带时间戳的列表项。首次写入时如果文件（及其父目录）不存在，请创建它。不要重写或重新组织日志 —— 它仅是追加的。单独的夜间进程会将这些日志提炼到 `MEMORY.md` 和主题文件中。',
    '',
    '## 记录什么',
    '- 用户的纠正和偏好（“使用 bun，不要用 npm”；“停止总结差异”）',
    '- 关于用户、其角色或目标的事实',
    '- 无法从代码推导出的项目上下文（截止日期、事故、决策及其理由）',
    '- 指向外部系统的指针（仪表盘、Linear 项目、Slack 频道）',
    '- 用户明确要求你记住的任何内容',
    '',
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    ...(skipIndex
      ? []
      : [
          `## ${ENTRYPOINT_NAME}`,
          `\`${ENTRYPOINT_NAME}\` 是提炼后的索引（由夜间进程从你的日志维护）并自动加载到你的上下文中。阅读它以了解概况，但不要直接编辑它 —— 请将新信息记录到今天的日志中。`,
          '',
        ]),
    ...buildSearchingPastContextSection(memoryDir),
  ]

  return lines.join('\n')
}

/**
 * 如果功能开关已启用，则构建“搜索过往上下文”章节。
 */
export function buildSearchingPastContextSection(autoMemDir: string): string[] {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_coral_fern', false)) {
    return []
  }
  const projectDir = getProjectDir(getOriginalCwd())
  // Ant 原生构建会将 grep 别名为嵌入式 ugrep，并移除专用的 Grep 工具，
  // 因此在那里给模型一个真实的 shell 调用。
  // 在 REPL 模式下，Grep 和 Bash 都对直接使用隐藏 —— 模型通过 REPL 脚本内部调用它们，
  // 因此 grep 的 shell 形式仍然是模型会在脚本中写出的形式。
  const embedded = hasEmbeddedSearchTools() || isReplModeEnabled()
  const memSearch = embedded
    ? `grep -rn "<搜索词>" ${autoMemDir} --include="*.md"`
    : `${GREP_TOOL_NAME} 使用 pattern="<搜索词>" path="${autoMemDir}" glob="*.md"`
  const transcriptSearch = embedded
    ? `grep -rn "<搜索词>" ${projectDir}/ --include="*.jsonl"`
    : `${GREP_TOOL_NAME} 使用 pattern="<搜索词>" path="${projectDir}/" glob="*.jsonl"`
  return [
    '## 搜索过往上下文',
    '',
    '在查找过往上下文时：',
    '1. 搜索内存目录中的主题文件：',
    '```',
    memSearch,
    '```',
    '2. 会话转录日志（最后手段 —— 文件大，速度慢）：',
    '```',
    transcriptSearch,
    '```',
    '使用窄搜索词（错误消息、文件路径、函数名），而不是宽泛的关键字。',
    '',
  ]
}

/**
 * 加载统一的内存提示，用于包含到系统提示中。
 * 根据启用的内存系统进行分发：
 *   - auto + team：组合提示（两个目录）
 *   - 仅 auto：内存指令（单个目录）
 * 团队记忆要求 auto 记忆启用（由 isTeamMemoryEnabled 强制），因此没有仅团队的分支。
 *
 * 当 auto 记忆禁用时返回 null。
 */
export async function loadMemoryPrompt(): Promise<string | null> {
  const autoEnabled = isAutoMemoryEnabled()

  const skipIndex = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_moth_copse',
    false,
  )

  // KAIROS 每日日志模式优先于 TEAMMEM：仅追加的日志范式无法与团队同步组合（后者期望双方都读写共享的 MEMORY.md）。
  // 此处对 `autoEnabled` 的门控意味着当 !autoEnabled 时，会走到下面的 tengu_memdir_disabled 遥测块，与非 KAIROS 路径一致。
  if (feature('KAIROS') && autoEnabled && getKairosActive()) {
    logMemoryDirCounts(getAutoMemPath(), {
      memory_type:
        'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return buildAssistantDailyLogPrompt(skipIndex)
  }

  // Cowork 通过环境变量注入记忆策略文本；将其线程化到所有构建器中。
  const coworkExtraGuidelines =
    process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES
  const extraGuidelines =
    coworkExtraGuidelines && coworkExtraGuidelines.trim().length > 0
      ? [coworkExtraGuidelines]
      : undefined

  if (feature('TEAMMEM')) {
    if (teamMemPaths!.isTeamMemoryEnabled()) {
      const autoDir = getAutoMemPath()
      const teamDir = teamMemPaths!.getTeamMemPath()
      // 工具保证这些目录已存在，以便模型无需检查即可写入。提示文本反映了这一点（“已存在”）。
      // 仅创建 teamDir 就已足够：getTeamMemPath() 定义为 join(getAutoMemPath(), 'team')，
      // 因此递归 mkdir 团队目录会作为副作用创建 auto 目录。如果将来团队目录移出 auto 目录，
      // 请在此处为 autoDir 添加第二个 ensureMemoryDirExists 调用。
      await ensureMemoryDirExists(teamDir)
      logMemoryDirCounts(autoDir, {
        memory_type:
          'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      logMemoryDirCounts(teamDir, {
        memory_type:
          'team' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      return teamMemPrompts!.buildCombinedMemoryPrompt(
        extraGuidelines,
        skipIndex,
      )
    }
  }

  if (autoEnabled) {
    const autoDir = getAutoMemPath()
    // 工具保证目录已存在，以便模型无需检查即可写入。提示文本反映了这一点（“已存在”）。
    await ensureMemoryDirExists(autoDir)
    logMemoryDirCounts(autoDir, {
      memory_type:
        'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return buildMemoryLines(
      'auto memory',
      autoDir,
      extraGuidelines,
      skipIndex,
    ).join('\n')
  }

  logEvent('tengu_memdir_disabled', {
    disabled_by_env_var: isEnvTruthy(
      process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
    ),
    disabled_by_setting:
      !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY) &&
      getInitialSettings().autoMemoryEnabled === false,
  })
  // 直接基于 GB 标志判断，而不是 isTeamMemoryEnabled() —— 该函数首先检查 isAutoMemoryEnabled()，
  // 在此分支中 autoEnabled 必然为 false。我们想知道“此用户是否属于团队记忆试验组”。
  if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_herring_clock', false)) {
    logEvent('tengu_team_memdir_disabled', {})
  }
  return null
}