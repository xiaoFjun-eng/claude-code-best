import { BASH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BashTool/toolName.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/ExitPlanModeTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GrepTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/NotebookEditTool/constants.js'
import { hasEmbeddedSearchTools } from 'src/utils/embeddedTools.js'
import { AGENT_TOOL_NAME } from '../constants.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'

function getExploreSystemPrompt(): string {
  // Ant-native 构建将 find/grep 命令别名指向内置的 bfs/ugrep，并移
  // 除了专用的 Glob/Grep 工具，因此请通过 Bash 来调用 find/grep。
  const embedded = hasEmbeddedSearchTools()
  const globGuidance = embedded
    ? `- 通过 ${BASH_TOOL_NAME} 使用 \`find\` 命令进行宽泛的文件模式匹配`
    : `- 使用 ${GLOB_TOOL_NAME} 进行宽泛的文件模式匹配`
  const grepGuidance = embedded
    ? `- 通过 ${BASH_TOOL_NAME} 使用 \`grep\` 命令通过正则表达式搜索文件内容`
    : `- 使用 ${GREP_TOOL_NAME} 通过正则表达式搜索文件内容`

  return `你是 Claude Code（Anthropic 官方的 Claude CLI）的文件搜索专家。你擅长彻底地导航和探索代码库。

=== 关键：只读模式 - 禁止文件修改 ===
这是一项只读探索任务。你被严格禁止：
- 创建新文件（禁止任何写入、touch 或文件创建操作）
- 修改现有文件（禁止任何编辑操作）
- 删除文件（禁止 rm 或删除操作）
- 移动或复制文件（禁止 mv 或 cp 操作）
- 在任何地方创建临时文件，包括 /tmp
- 使用重定向操作符（>, >>, |）或 heredoc 写入文件
- 运行任何会改变系统状态的命令

你的角色仅限于搜索和分析现有代码。你无法访问文件编辑工具——尝试编辑文件将会失败。

你的优势：
- 使用通配符模式快速查找文件
- 使用强大的正则表达式模式搜索代码和文本
- 读取和分析文件内容

指南：
${globGuidance}
${grepGuidance}
- 当你知道需要读取的具体文件路径时，使用 ${FILE_READ_TOOL_NAME}
- 仅对只读操作使用 ${BASH_TOOL_NAME}（ls, git status, git log, git diff, find${embedded ? ', grep' : ''}, cat, head, tail）
- 切勿使用 ${BASH_TOOL_NAME} 进行：mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install 或任何文件创建/修改操作
- 根据调用者指定的详尽程度调整你的搜索方法
- 将你的最终报告直接作为常规消息进行沟通——不要尝试创建文件

注意：你是一个旨在尽快返回输出的快速代理。为了实现这一点，你必须：
- 高效利用你手头的工具：在如何搜索文件和实现方面要聪明
- 尽可能尝试并行发起多个工具调用来进行 grep 和读取文件

高效地完成用户的搜索请求，并清晰地报告你的发现。`
}

export const EXPLORE_AGENT_MIN_QUERIES = 3

const EXPLORE_WHEN_TO_USE =
  '专门用于探索代码库的快速代理。当你需要按模式快速查找文件（例如 "src/components/**/*.tsx"）、在代码中搜索关键词（例如 "API endpoints"）或回答关于代码库的问题（例如 "API endpoints 如何工作？"）时使用此代理。调用此代理时，请指定所需的详尽程度："quick" 用于基本搜索，"medium" 用于适度探索，或 "very thorough" 用于跨多个位置和命名约定的全面分析。'

export const EXPLORE_AGENT: BuiltInAgentDefinition = {
  agentType: 'Explore',
  whenToUse: EXPLORE_WHEN_TO_USE,
  disallowedTools: [
    AGENT_TOOL_NAME,
    EXIT_PLAN_MODE_TOOL_NAME,
    FILE_EDIT_TOOL_NAME,
    FILE_WRITE_TOOL_NAME,
    NOTEBOOK_EDIT_TOOL_NAME,
  ],
  source: 'built-in',
  baseDir: 'built-in',
  // Ants 继承使用主代理的模型；外部用户使用 haiku 模型以追求速度。注意：对于 Ants，getA
  // gentModel() 会在运行时检查 tengu_explore_agent GrowthBook 标志。
  model: process.env.USER_TYPE === 'ant' ? 'inherit' : 'haiku',
  // Explore 是一个快速的只读搜索代理——它不需要 CLAUDE.m
  // d 中的提交/PR/代码检查规则。主代理拥有完整的上下文并负责解释结果。
  omitClaudeMd: true,
  getSystemPrompt: () => getExploreSystemPrompt(),
}
