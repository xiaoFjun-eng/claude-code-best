import { isPDFSupported } from 'src/utils/pdfUtils.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'

// Use a string constant for tool names to avoid circular dependencies
export const FILE_READ_TOOL_NAME = 'Read'

export const FILE_UNCHANGED_STUB =
  '自上次读取以来文件未发生变化。本对话中先前 Read 的 tool_result 仍是最新内容——请直接引用它，不要重复读取。'

export const MAX_LINES_TO_READ = 2000

export const DESCRIPTION = 'Read a file from the local filesystem.'

export const LINE_FORMAT_INSTRUCTION =
  '- 结果以 cat -n 格式返回，行号从 1 开始'

export const OFFSET_INSTRUCTION_DEFAULT =
  '- 你可以选择性地指定行偏移与行数限制（长文件特别有用），但建议默认不提供这些参数以读取完整文件'

export const OFFSET_INSTRUCTION_TARGETED =
  '- 当你已经知道需要文件的哪一部分时，只读取那一段。这对大文件很重要。'

/**
 * Renders the Read tool prompt template.  The caller (FileReadTool) supplies
 * the runtime-computed parts.
 */
export function renderPromptTemplate(
  lineFormat: string,
  maxSizeInstruction: string,
  offsetInstruction: string,
): string {
  return `从本地文件系统读取文件。你可以使用此工具直接访问任意文件。
假设该工具能够读取机器上的所有文件。如果用户提供了文件路径，假设该路径是有效的。读取一个不存在的文件也是允许的；工具会返回错误。

用法：
- file_path 参数必须是绝对路径，不能是相对路径
- 默认从文件开头读取，最多读取 ${MAX_LINES_TO_READ} 行${maxSizeInstruction}
${offsetInstruction}
${lineFormat}
- 此工具允许 Claude Code 读取图片（例如 PNG、JPG 等）。读取图片文件时，内容会以可视方式呈现，因为 Claude Code 是多模态 LLM。${
    isPDFSupported()
      ? '\n- 此工具可以读取 PDF 文件（.pdf）。对于大型 PDF（超过 10 页），你必须提供 pages 参数来读取指定页范围（例如：pages: "1-5"）。不提供 pages 读取大型 PDF 会失败。每次请求最多 20 页。'
      : ''
  }
- 此工具可以读取 Jupyter notebook（.ipynb）并返回所有单元及其输出，包含代码、文本与可视化内容。
- 此工具只能读取文件，不能读取目录。要查看目录内容，请通过 ${BASH_TOOL_NAME} 使用 ls 命令。
- 你会经常被要求读取截图。如果用户提供了截图路径，务必使用此工具查看该路径下的文件。它适用于所有临时文件路径。
- 如果你读取的文件存在但内容为空，你会收到一条 system reminder 警告，替代文件内容返回。`
}
