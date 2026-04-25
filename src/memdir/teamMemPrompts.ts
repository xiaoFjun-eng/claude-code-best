import {
  buildSearchingPastContextSection,
  DIRS_EXIST_GUIDANCE,
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
} from './memdir.js'
import {
  MEMORY_DRIFT_CAVEAT,
  MEMORY_FRONTMATTER_EXAMPLE,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_COMBINED,
  WHAT_NOT_TO_SAVE_SECTION,
} from './memoryTypes.js'
import { getAutoMemPath } from './paths.js'
import { getTeamMemPath } from './teamMemPaths.js'

/**
 * 在自动内存和团队内存同时启用时构建组合提示。
 * 封闭的四类型分类（用户/反馈/项目/参考），每个类型的 <scope> 指导嵌入在 XML 风格的 <type> 块中。
 */
export function buildCombinedMemoryPrompt(
  extraGuidelines?: string[],
  skipIndex = false,
): string {
  const autoDir = getAutoMemPath()
  const teamDir = getTeamMemPath()

  const howToSave = skipIndex
    ? [
        '## 如何保存记忆',
        '',
        '使用以下前置元数据格式，将每条记忆写入所选目录（私有或团队，根据类型的范围指导）的自己的文件中：',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '- 保持记忆文件中的名称、描述和类型字段与内容同步',
        '- 按主题而不是按时间顺序组织记忆',
        '- 更新或删除那些被证明错误或过时的记忆',
        '- 不要写入重复的记忆。在写入新记忆前，先检查是否有可更新的现有记忆。',
      ]
    : [
        '## 如何保存记忆',
        '',
        '保存记忆分为两步：',
        '',
        '**第 1 步** — 使用以下前置元数据格式，将记忆写入所选目录（私有或团队，根据类型的范围指导）的自己的文件中：',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        `**第 2 步** — 在同一目录的 \`${ENTRYPOINT_NAME}\` 中添加指向该文件的指针。每个目录（私有和团队）都有自己的 \`${ENTRYPOINT_NAME}\` 索引 —— 每个条目应为一行，不超过约 150 个字符：\`- [标题](file.md) — 单行钩子\`。它们没有前置元数据。永远不要将记忆内容直接写入 \`${ENTRYPOINT_NAME}\`。`,
        '',
        `- 两个 \`${ENTRYPOINT_NAME}\` 索引都会加载到你的对话上下文中 —— 超过 ${MAX_ENTRYPOINT_LINES} 行的部分将被截断，请保持它们简洁`,
        '- 保持记忆文件中的名称、描述和类型字段与内容同步',
        '- 按主题而不是按时间顺序组织记忆',
        '- 更新或删除那些被证明错误或过时的记忆',
        '- 不要写入重复的记忆。在写入新记忆前，先检查是否有可更新的现有记忆。',
      ]

  const lines = [
    '# 记忆',
    '',
    `你有一个基于文件的持久化记忆系统，包含两个目录：私有目录位于 \`${autoDir}\`，共享团队目录位于 \`${teamDir}\`。${DIRS_EXIST_GUIDANCE}`,
    '',
    '你应该随着时间逐步构建这个记忆系统，以便未来的对话能够全面了解用户是谁、用户希望如何与你协作、需要避免或重复哪些行为，以及用户所给工作背后的上下文。',
    '',
    '如果用户明确要求你记住某事，请立即以最合适的类型保存它。如果他们要求你忘记某事，请找到并删除相关的条目。',
    '',
    '## 记忆范围',
    '',
    '有两个范围级别：',
    '',
    `- private：你和当前用户之间的私有记忆。它们仅与此特定用户跨会话持久化，并存储在根目录 \`${autoDir}\` 中。`,
    `- team：与此项目目录中工作的所有用户共享并贡献的记忆。团队记忆在每个会话开始时同步，并存储在 \`${teamDir}\` 中。`,
    '',
    ...TYPES_SECTION_COMBINED,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '- 你必须避免在共享团队记忆中保存敏感数据。例如，绝不要保存 API 密钥或用户凭据。',
    '',
    ...howToSave,
    '',
    '## 何时访问记忆',
    '- 当记忆（个人或团队）看起来相关，或用户引用之前与他们或组织中其他人的工作时。',
    '- 当用户明确要求你检查、召回或记住时，你必须访问记忆。',
    '- 如果用户说*忽略*或*不使用*记忆：就像 MEMORY.md 为空一样继续。不要应用记住的事实、引用、与之比较或提及记忆内容。',
    MEMORY_DRIFT_CAVEAT,
    '',
    ...TRUSTING_RECALL_SECTION,
    '',
    '## 记忆与其他持久化形式',
    '记忆是你在对话中帮助用户时可用的多种持久化机制之一。区别通常在于记忆可以在未来的对话中被回忆起来，而不应用于持久化仅在当前对话范围内有用的信息。',
    '- 何时使用或更新计划而不是记忆：如果你即将开始一项非平凡的实现任务，并希望就你的方法与用户达成一致，你应该使用计划，而不是将此信息保存到记忆中。类似地，如果对话中已有计划且你改变了方法，请通过更新计划来持久化该变更，而不是保存记忆。',
    '- 何时使用或更新任务而不是记忆：当你需要将当前对话中的工作分解为离散的步骤或跟踪进度时，请使用任务而不是保存记忆。任务非常适合持久化当前对话中需要完成的工作信息，但记忆应保留给对未来对话有用的信息。',
    ...(extraGuidelines ?? []),
    '',
    ...buildSearchingPastContextSection(autoDir),
  ]

  return lines.join('\n')
}