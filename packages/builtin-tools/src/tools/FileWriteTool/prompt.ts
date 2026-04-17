import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

export const FILE_WRITE_TOOL_NAME = 'Write'
export const DESCRIPTION = '将文件写入本地文件系统。'

function getPreReadInstruction(): string {
  return `\n- 如果这是一个已存在的文件，你必须先使用 ${FILE_READ_TOOL_NAME} 读取文件内容；否则本工具会失败。`
}

export function getWriteToolDescription(): string {
  return `将文件写入本地文件系统。

用法：
- 如果提供的路径已存在文件，本工具会覆盖该文件。${getPreReadInstruction()}
- 修改已有文件时更推荐使用 Edit 工具——它只发送 diff。仅在创建新文件或需要完全重写时使用本工具。
- 除非用户明确要求，否则绝不要创建文档文件（*.md）或 README 文件。
- 只有在用户明确要求时才使用 emoji。除非被要求，否则避免把 emoji 写入文件。`
}
