import { z } from 'zod/v4'
import { lazySchema } from 'src/utils/lazySchema.js'
import { semanticBoolean } from 'src/utils/semanticBoolean.js'

// 包含可选 replace_all 参数的输入模式
const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe('待修改文件的绝对路径'),
    old_string: z.string().describe('要替换的文本'),
    new_string: z
      .string()
      .describe(
        '要替换成的文本（必须与 old_string 不同）',
      ),
    replace_all: semanticBoolean(
      z.boolean().default(false).optional(),
    ).describe('替换所有出现的 old_string（默认为 false）'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 解析后的输出 — call() 接收的内容。z.output 而非 z.input：附带
// 语义布尔值，输入侧未知（预处理接受任何内容）。
export type FileEditInput = z.output<InputSchema>

// 不包含 file_path 的独立编辑
export type EditInput = Omit<FileEditInput, 'file_path'>

// 始终定义 replace_all 的运行时版本
export type FileEdit = {
  old_string: string
  new_string: string
  replace_all: boolean
}

export const hunkSchema = lazySchema(() =>
  z.object({
    oldStart: z.number(),
    oldLines: z.number(),
    newStart: z.number(),
    newLines: z.number(),
    lines: z.array(z.string()),
  }),
)

export const gitDiffSchema = lazySchema(() =>
  z.object({
    filename: z.string(),
    status: z.enum(['modified', 'added']),
    additions: z.number(),
    deletions: z.number(),
    changes: z.number(),
    patch: z.string(),
    repository: z
      .string()
      .nullable()
      .optional()
      .describe('GitHub owner/repo（如果可用）'),
  }),
)

// FileEditTool 的输出模式
const outputSchema = lazySchema(() =>
  z.object({
    filePath: z.string().describe('已编辑的文件路径'),
    oldString: z.string().describe('被替换的原始字符串'),
    newString: z.string().describe('替换它的新字符串'),
    originalFile: z
      .string()
      .describe('编辑前的原始文件内容'),
    structuredPatch: z
      .array(hunkSchema())
      .describe('显示更改的差异补丁'),
    userModified: z
      .boolean()
      .describe('用户是否修改了建议的更改'),
    replaceAll: z.boolean().describe('是否替换了所有匹配项'),
    gitDiff: gitDiffSchema().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type FileEditOutput = z.infer<OutputSchema>

export { inputSchema, outputSchema }
