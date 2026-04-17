import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'

export const GREP_TOOL_NAME = 'Grep'

export function getDescription(): string {
  return `基于 ripgrep 的强大搜索工具

  用法：
  - 搜索任务一律使用 ${GREP_TOOL_NAME}。绝不要把 \`grep\` 或 \`rg\` 当作 ${BASH_TOOL_NAME} 的命令去调用。${GREP_TOOL_NAME} 已针对权限与访问做了优化。
  - 支持完整的正则语法（例如 "log.*Error"、"function\\s+\\w+"）
  - 可用 glob 参数过滤文件（例如 "*.js"、"**/*.tsx"），或用 type 参数按语言类型过滤（例如 "js"、"py"、"rust"）
  - 输出模式： "content" 输出匹配行，"files_with_matches" 仅输出文件路径（默认），"count" 输出匹配计数
  - 需要多轮开放式搜索时，使用 ${AGENT_TOOL_NAME} 工具
  - 模式语法：使用 ripgrep（不是 grep）；字面量花括号需要转义（例如用 \`interface\\{\\}\` 搜索 Go 中的 \`interface{}\`）
  - 多行匹配：默认仅在单行内匹配；跨行模式（如 \`struct \\{[\\s\\S]*?field\`）请使用 \`multiline: true\`
`
}
