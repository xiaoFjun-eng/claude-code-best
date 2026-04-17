/**
 * 后台记忆提取代理的提示模板。
 *
 * 提取代理作为主对话的完美分支运行 —— 相同的系统提示，相同的消息前缀。
 * 主代理的系统提示始终包含完整的保存指令；当主代理自己写入记忆时，
 * extractMemories.ts 会跳过该轮次（hasMemoryWritesSince）。
 * 此提示仅在主代理未写入时触发，因此此处的保存条件与系统提示中的重叠是无害的。
 */

import { feature } from 'bun:bundle'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TYPES_SECTION_COMBINED,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
} from '../../memdir/memoryTypes.js'
import { BASH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GrepTool/prompt.js'

/**
 * 两种提取提示变体共享的开头部分。
 */
function opener(newMessageCount: number, existingMemories: string): string {
  const manifest =
    existingMemories.length > 0
      ? `\n\n## 现有的记忆文件\n\n${existingMemories}\n\n在写入之前检查此列表 — 更新现有文件而不是创建重复文件。`
      : ''
  return [
    `您现在作为记忆提取子代理运行。分析上面最近的 ~${newMessageCount} 条消息，并使用它们来更新您的持久化记忆系统。`,
    '',
    `可用工具：${FILE_READ_TOOL_NAME}、${GREP_TOOL_NAME}、${GLOB_TOOL_NAME}、只读的 ${BASH_TOOL_NAME}（ls/find/cat/stat/wc/head/tail 等类似命令），以及仅针对记忆目录内路径的 ${FILE_EDIT_TOOL_NAME}/${FILE_WRITE_TOOL_NAME}。${BASH_TOOL_NAME} rm 不被允许。所有其他工具 — MCP、Agent、可写的 ${BASH_TOOL_NAME} 等 — 将被拒绝。`,
    '',
    `您的轮次预算有限。${FILE_EDIT_TOOL_NAME} 需要预先对同一文件进行 ${FILE_READ_TOOL_NAME}，因此高效的策略是：第 1 轮 — 对您可能更新的每个文件并行发出所有 ${FILE_READ_TOOL_NAME} 调用；第 2 轮 — 并行发出所有 ${FILE_WRITE_TOOL_NAME}/${FILE_EDIT_TOOL_NAME} 调用。不要跨多个轮次交错读写。`,
    '',
    `您必须仅使用最近 ~${newMessageCount} 条消息中的内容来更新您的持久化记忆。不要浪费任何轮次试图进一步调查或验证该内容 — 不要 grep 源文件，不要读取代码来确认模式是否存在，不要执行 git 命令。` +
      manifest,
  ].join('\n')
}

/**
 * 构建仅限自动记忆的提取提示（无团队记忆）。
 * 四类型分类，无作用域指导（单一目录）。
 */
export function buildExtractAutoOnlyPrompt(
  newMessageCount: number,
  existingMemories: string,
  skipIndex = false,
): string {
  const howToSave = skipIndex
    ? [
        '## 如何保存记忆',
        '',
        '将每条记忆写入其自己的文件（例如 `user_role.md`、`feedback_testing.md`），使用以下 frontmatter 格式：',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '- 按主题语义组织记忆，而不是按时间顺序',
        '- 更新或移除错误或过时的记忆',
        '- 不要写入重复的记忆。在写入新记忆之前，首先检查是否有可以更新的现有记忆。',
      ]
    : [
        '## 如何保存记忆',
        '',
        '保存记忆是一个两步过程：',
        '',
        '**第 1 步** — 将记忆写入其自己的文件（例如 `user_role.md`、`feedback_testing.md`），使用以下 frontmatter 格式：',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '**第 2 步** — 在 `MEMORY.md` 中添加指向该文件的指针。`MEMORY.md` 是一个索引，而不是记忆本身 — 每个条目应为一行的简短描述，不超过 ~150 个字符：`- [标题](file.md) — 单行钩子`。它没有 frontmatter。永远不要将记忆内容直接写入 `MEMORY.md`。',
        '',
        '- `MEMORY.md` 总是被加载到您的系统提示中 — 200 行之后的内容将被截断，因此请保持索引简洁',
        '- 按主题语义组织记忆，而不是按时间顺序',
        '- 更新或移除错误或过时的记忆',
        '- 不要写入重复的记忆。在写入新记忆之前，首先检查是否有可以更新的现有记忆。',
      ]

  return [
    opener(newMessageCount, existingMemories),
    '',
    '如果用户明确要求您记住某事，请立即以最合适的类型保存它。如果他们要求您忘记某事，请找到并删除相关条目。',
    '',
    ...TYPES_SECTION_INDIVIDUAL,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    ...howToSave,
  ].join('\n')
}

/**
 * 构建用于自动 + 团队记忆组合的提取提示。
 * 四类型分类，带有每种类型的 <scope> 指导（目录选择嵌入到每个类型块中，无需单独的路由部分）。
 */
export function buildExtractCombinedPrompt(
  newMessageCount: number,
  existingMemories: string,
  skipIndex = false,
): string {
  if (!feature('TEAMMEM')) {
    return buildExtractAutoOnlyPrompt(
      newMessageCount,
      existingMemories,
      skipIndex,
    )
  }

  const howToSave = skipIndex
    ? [
        '## 如何保存记忆',
        '',
        '将每条记忆写入所选目录（私有或团队，根据类型的作用域指导）中自己的文件，使用以下 frontmatter 格式：',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '- 按主题语义组织记忆，而不是按时间顺序',
        '- 更新或移除错误或过时的记忆',
        '- 不要写入重复的记忆。在写入新记忆之前，首先检查是否有可以更新的现有记忆。',
      ]
    : [
        '## 如何保存记忆',
        '',
        '保存记忆是一个两步过程：',
        '',
        '**第 1 步** — 将记忆写入所选目录（私有或团队，根据类型的作用域指导）中自己的文件，使用以下 frontmatter 格式：',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '**第 2 步** — 在同一目录的 `MEMORY.md` 中添加指向该文件的指针。每个目录（私有和团队）都有自己的 `MEMORY.md` 索引 — 每个条目应为一行的简短描述，不超过 ~150 个字符：`- [标题](file.md) — 单行钩子`。它们没有 frontmatter。永远不要将记忆内容直接写入 `MEMORY.md`。',
        '',
        '- 两个 `MEMORY.md` 索引都被加载到您的系统提示中 — 200 行之后的内容将被截断，因此请保持它们简洁',
        '- 按主题语义组织记忆，而不是按时间顺序',
        '- 更新或移除错误或过时的记忆',
        '- 不要写入重复的记忆。在写入新记忆之前，首先检查是否有可以更新的现有记忆。',
      ]

  return [
    opener(newMessageCount, existingMemories),
    '',
    '如果用户明确要求您记住某事，请立即以最合适的类型保存它。如果他们要求您忘记某事，请找到并删除相关条目。',
    '',
    ...TYPES_SECTION_COMBINED,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '- 您必须避免将敏感数据保存在共享的团队记忆中。例如，永远不要保存 API 密钥或用户凭证。',
    '',
    ...howToSave,
  ].join('\n')
}