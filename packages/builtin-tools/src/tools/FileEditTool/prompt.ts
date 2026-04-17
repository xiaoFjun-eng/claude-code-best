import { isCompactLinePrefixEnabled } from 'src/utils/file.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

function getPreReadInstruction(): string {
  return `
- 在编辑之前，您必须在对话中至少使用一次您的 \`${FILE_READ_TOOL_NAME}\` 工具。如果您未读取文件就尝试编辑，此工具将报错。`
}

export function getEditToolDescription(): string {
  return getDefaultEditDescription()
}

function getDefaultEditDescription(): string {
  const prefixFormat = isCompactLinePrefixEnabled()
    ? 'line number + tab'
    : 'spaces + line number + arrow'
  const minimalUniquenessHint =
    process.env.USER_TYPE === 'ant'
      ? `
- 使用尽可能短但明确唯一的 old_string——通常相邻的 2-4 行就足够了。当较少的上下文已能唯一标识目标时，避免包含 10 行以上的上下文。`
      : ''
  return `在文件中执行精确的字符串替换。

用法：${getPreReadInstruction()}
- 当编辑来自 Read 工具输出的文本时，请确保保留与行号前缀之后完全一致的缩进（制表符/空格）。行号前缀的格式为：${prefixFormat}。其后的所有内容都是要匹配的实际文件内容。切勿在 old_string 或 new_string 中包含行号前缀的任何部分。
- 始终优先编辑代码库中的现有文件。除非明确要求，否则切勿写入新文件。
- 仅当用户明确要求时才使用表情符号。除非被要求，否则避免向文件中添加表情符号。
- 如果 \`old_string\` 在文件中不唯一，编辑将失败。要么提供包含更多周围上下文的更大字符串以使其唯一，要么使用 \`replace_all\` 来更改 \`old_string\` 的每个实例。${minimalUniquenessHint}
- 使用 \`replace_all\` 在整个文件中替换和重命名字符串。例如，如果您想重命名一个变量，此参数会很有用。`
}
