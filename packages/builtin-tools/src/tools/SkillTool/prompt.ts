import { memoize } from 'lodash-es'
import type { Command } from 'src/commands.js'
import {
  getCommandName,
  getSkillToolCommands,
  getSlashCommandToolSkills,
} from 'src/commands.js'
import { COMMAND_NAME_TAG } from 'src/constants/xml.js'
import { stringWidth } from '@anthropic/ink'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { count } from 'src/utils/array.js'
import { logForDebugging } from 'src/utils/debug.js'
import { toError } from 'src/utils/errors.js'
import { truncate } from 'src/utils/format.js'
import { logError } from 'src/utils/log.js'

// 技能列表占用上下文窗口的 1%（按字符数计算）
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
export const CHARS_PER_TOKEN = 4
export const DEFAULT_CHAR_BUDGET = 8_000 // 后备方案：200k × 4 的 1%

// 每个条目的硬性上限。此列表仅用于发现——技能工具在调用时会加载
// 完整内容，因此冗长的 whenToUse 字符串会浪费首轮缓存创
// 建所需的 token，却无法提升匹配率。此限制适用于所有条目（包
// 括捆绑技能），因为上限足够宽松，足以保留核心用例。
export const MAX_LISTING_DESC_CHARS = 250

export function getCharBudget(contextWindowTokens?: number): number {
  if (Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)) {
    return Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)
  }
  if (contextWindowTokens) {
    return Math.floor(
      contextWindowTokens * CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT,
    )
  }
  return DEFAULT_CHAR_BUDGET
}

function getCommandDescription(cmd: Command): string {
  const desc = cmd.whenToUse
    ? `${cmd.description} - ${cmd.whenToUse}`
    : cmd.description
  return desc.length > MAX_LISTING_DESC_CHARS
    ? desc.slice(0, MAX_LISTING_DESC_CHARS - 1) + '\u2026'
    : desc
}

function formatCommandDescription(cmd: Command): string {
  // 调试：如果插件技能的 userFacingName 与 cmd.name 不同，则记录日志
  const displayName = getCommandName(cmd)
  if (
    cmd.name !== displayName &&
    cmd.type === 'prompt' &&
    cmd.source === 'plugin'
  ) {
    logForDebugging(
      `技能提示：显示“${cmd.name}”（userFacingName=“${displayName}”）`,
    )
  }

  return `- ${cmd.name}: ${getCommandDescription(cmd)}`
}

const MIN_DESC_LENGTH = 20

export function formatCommandsWithinBudget(
  commands: Command[],
  contextWindowTokens?: number,
): string {
  if (commands.length === 0) return ''

  const budget = getCharBudget(contextWindowTokens)

  // 首先尝试完整描述
  const fullEntries = commands.map(cmd => ({
    cmd,
    full: formatCommandDescription(cmd),
  }))
  // join('\n') 为 N 个条目生成 N-1 个换行符
  const fullTotal =
    fullEntries.reduce((sum, e) => sum + stringWidth(e.full), 0) +
    (fullEntries.length - 1)

  if (fullTotal <= budget) {
    return fullEntries.map(e => e.full).join('\n')
  }

  // 划分为捆绑技能（永不截断）和其他技能
  const bundledIndices = new Set<number>()
  const restCommands: Command[] = []
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]!
    if (cmd.type === 'prompt' && cmd.source === 'bundled') {
      bundledIndices.add(i)
    } else {
      restCommands.push(cmd)
    }
  }

  // 计算捆绑技能占用的空间（完整描述，始终保留）
  const bundledChars = fullEntries.reduce(
    (sum, e, i) =>
      bundledIndices.has(i) ? sum + stringWidth(e.full) + 1 : sum,
    0,
  )
  const remainingBudget = budget - bundledChars

  // 计算非捆绑命令的最大描述长度
  if (restCommands.length === 0) {
    return fullEntries.map(e => e.full).join('\n')
  }

  const restNameOverhead =
    restCommands.reduce((sum, cmd) => sum + stringWidth(cmd.name) + 4, 0) +
    (restCommands.length - 1)
  const availableForDescs = remainingBudget - restNameOverhead
  const maxDescLen = Math.floor(availableForDescs / restCommands.length)

  if (maxDescLen < MIN_DESC_LENGTH) {
    // 极端情况：非捆绑技能仅保留名称，捆绑技能保留描述
    if (process.env.USER_TYPE === 'ant') {
      logEvent('tengu_skill_descriptions_truncated', {
        skill_count: commands.length,
        budget,
        full_total: fullTotal,
        truncation_mode:
          'names_only' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        max_desc_length: maxDescLen,
        bundled_count: bundledIndices.size,
        bundled_chars: bundledChars,
      })
    }
    return commands
      .map((cmd, i) =>
        bundledIndices.has(i) ? fullEntries[i]!.full : `- ${cmd.name}`,
      )
      .join('\n')
  }

  // 截断非捆绑技能的描述以符合预算
  const truncatedCount = count(
    restCommands,
    cmd => stringWidth(getCommandDescription(cmd)) > maxDescLen,
  )
  if (process.env.USER_TYPE === 'ant') {
    logEvent('tengu_skill_descriptions_truncated', {
      skill_count: commands.length,
      budget,
      full_total: fullTotal,
      truncation_mode:
        'description_trimmed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      max_desc_length: maxDescLen,
      truncated_count: truncatedCount,
      // 此提示中包含的捆绑技能数量（排除已禁用模型调用的技能）
      bundled_count: bundledIndices.size,
      bundled_chars: bundledChars,
    })
  }
  return commands
    .map((cmd, i) => {
      // 捆绑技能始终获取完整描述
      if (bundledIndices.has(i)) return fullEntries[i]!.full
      const description = getCommandDescription(cmd)
      return `- ${cmd.name}: ${truncate(description, maxDescLen)}`
    })
    .join('\n')
}

export const getPrompt = memoize(async (_cwd: string): Promise<string> => {
  return `在主对话中执行技能

当用户要求你执行任务时，检查是否有任何可用技能匹配。技能提供专业能力和领域知识。

当用户提及“斜杠命令”或“/<某物>”（例如“/commit”、“/review-pr”）时，他们指的是一个技能。使用此工具来调用它。

如何调用：
- 使用此工具，指定技能名称和可选参数
- 示例：
  - \`skill: "pdf"\` - 调用 pdf 技能
  - \`skill: "commit", args: "-m 'Fix bug'"\` - 带参数调用
  - \`skill: "review-pr", args: "123"\` - 带参数调用
  - \`skill: "ms-office-suite:pdf"\` - 使用完全限定名调用

重要事项：
- 可用技能列表在对话的系统提醒消息中列出
- 当有技能匹配用户请求时，这是一个阻塞性要求：在生成任何关于该任务的其他响应之前，必须先调用相关的 Skill 工具
- 切勿提及技能而不实际调用此工具
- 不要调用已在运行的技能
- 不要将此工具用于内置 CLI 命令（如 /help、/clear 等）
- 如果在当前对话轮次中看到 <${COMMAND_NAME_TAG}> 标签，表示技能已经加载——请直接遵循其中的指令，而不要再次调用此工具`
})

export async function getSkillToolInfo(cwd: string): Promise<{
  totalCommands: number
  includedCommands: number
}> {
  const agentCommands = await getSkillToolCommands(cwd)

  return {
    totalCommands: agentCommands.length,
    includedCommands: agentCommands.length,
  }
}

// 返回 SkillTool 提示中包含的命令。所有命
// 令始终包含在内（描述可能会被截断以符合预算）。由 analyzeCont
// ext 用于统计技能 token 数量。
export function getLimitedSkillToolCommands(cwd: string): Promise<Command[]> {
  return getSkillToolCommands(cwd)
}

export function clearPromptCache(): void {
  getPrompt.cache?.clear?.()
}

export async function getSkillInfo(cwd: string): Promise<{
  totalSkills: number
  includedSkills: number
}> {
  try {
    const skills = await getSlashCommandToolSkills(cwd)

    return {
      totalSkills: skills.length,
      includedSkills: skills.length,
    }
  } catch (error) {
    logError(toError(error))

    // 返回零值而非抛出异常——让调用方决定如何处理
    return {
      totalSkills: 0,
      includedSkills: 0,
    }
  }
}
