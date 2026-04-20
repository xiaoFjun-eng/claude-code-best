import { feature } from 'bun:bundle'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import {
  copyFile,
  stat as fsStat,
  truncate as fsTruncate,
  link,
} from 'fs/promises'
import * as React from 'react'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import type { AppState } from 'src/state/AppState.js'
import { z } from 'zod/v4'
import { getKairosActive } from 'src/bootstrap/state.js'
import { TOOL_SUMMARY_MAX_LENGTH } from 'src/constants/toolLimits.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { notifyVscodeFileUpdated } from 'src/services/mcp/vscodeSdkMcp.js'
import type {
  SetToolJSXFn,
  ToolCallProgress,
  ToolUseContext,
  ValidationResult,
} from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import {
  backgroundExistingForegroundTask,
  markTaskNotified,
  registerForeground,
  spawnShellTask,
  unregisterForeground,
} from 'src/tasks/LocalShellTask/LocalShellTask.js'
import type { AgentId } from 'src/types/ids.js'
import type { AssistantMessage } from 'src/types/message.js'
import { parseForSecurity } from 'src/utils/bash/ast.js'
import {
  splitCommand_DEPRECATED,
  splitCommandWithOperators,
} from 'src/utils/bash/commands.js'
import { extractClaudeCodeHints } from 'src/utils/claudeCodeHints.js'
import { detectCodeIndexingFromCommand } from 'src/utils/codeIndexing.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'
import { isENOENT, ShellError } from 'src/utils/errors.js'
import {
  detectFileEncoding,
  detectLineEndings,
  getFileModificationTime,
  writeTextContent,
} from 'src/utils/file.js'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from 'src/utils/fileHistory.js'
import { truncate } from 'src/utils/format.js'
import { getFsImplementation } from 'src/utils/fsOperations.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { expandPath } from 'src/utils/path.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import { maybeRecordPluginHint } from 'src/utils/plugins/hintRecommendation.js'
import { exec } from 'src/utils/Shell.js'
import type { ExecResult } from 'src/utils/ShellCommand.js'
import { SandboxManager } from 'src/utils/sandbox/sandbox-adapter.js'
import { semanticBoolean } from 'src/utils/semanticBoolean.js'
import { semanticNumber } from 'src/utils/semanticNumber.js'
import { EndTruncatingAccumulator } from 'src/utils/stringUtils.js'
import { getTaskOutputPath } from 'src/utils/task/diskOutput.js'
import { TaskOutput } from 'src/utils/task/TaskOutput.js'
import { isOutputLineTruncated } from 'src/utils/terminal.js'
import {
  buildLargeToolResultMessage,
  ensureToolResultsDir,
  generatePreview,
  getToolResultPath,
  PREVIEW_SIZE_BYTES,
} from 'src/utils/toolResultStorage.js'
import { userFacingName as fileEditUserFacingName } from '../FileEditTool/UI.js'
import { trackGitOperations } from '../shared/gitOperationTracking.js'
import {
  bashToolHasPermission,
  commandHasAnyCd,
  matchWildcardPattern,
  permissionRuleExtractPrefix,
} from './bashPermissions.js'
import { interpretCommandResult } from './commandSemantics.js'
import {
  getDefaultTimeoutMs,
  getMaxTimeoutMs,
  getSimplePrompt,
} from './prompt.js'
import { checkReadOnlyConstraints } from './readOnlyValidation.js'
import { parseSedEditCommand } from './sedEditParser.js'
import { shouldUseSandbox } from './shouldUseSandbox.js'
import { BASH_TOOL_NAME } from './toolName.js'
import {
  BackgroundHint,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseQueuedMessage,
} from './UI.js'
import {
  buildImageToolResult,
  isImageOutput,
  resetCwdIfOutsideProject,
  resizeShellImageOutput,
  stdErrAppendShellResetMessage,
  stripEmptyLines,
} from './utils.js'

const EOL = '\n'

// 进度显示常量
const PROGRESS_THRESHOLD_MS = 2000 // 2秒后显示进度 在助
// 手模式下，主代理在此毫秒数后阻塞的bash命令会自动后台化
const ASSISTANT_BLOCKING_BUDGET_MS = 15_000

// 用于可折叠显示的搜索命令（grep、find等）
const BASH_SEARCH_COMMANDS = new Set([
  'find',
  'grep',
  'rg',
  'ag',
  'ack',
  'locate',
  'which',
  'whereis',
])

// 用于可折叠显示的读取/查看命令（cat、head等）
const BASH_READ_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  // 分析命令
  'wc',
  'stat',
  'file',
  'strings',
  // 数据处理 — 通常用于在管道中解析/转换文件内容
  'jq',
  'awk',
  'cut',
  'sort',
  'uniq',
  'tr',
])

// 用于可折叠显示的目录列表命令（ls、tree、du）。从BASH
// _READ_COMMANDS中分离出来，这样摘要会显示“列出了N个目录
// ”，而不是误导性的“读取了N个文件”。
const BASH_LIST_COMMANDS = new Set(['ls', 'tree', 'du'])

// 在任何位置都语义中性的命令 — 纯输出/状态命令，不会改变整个管道
// 的读取/搜索性质。例如，`ls dir && echo
// "---" && ls dir2` 仍然是一个只读复合命令。
const BASH_SEMANTIC_NEUTRAL_COMMANDS = new Set([
  'echo',
  'printf',
  'true',
  'false',
  ':', // bash无操作命令
])

// 通常成功时不产生标准输出的命令
const BASH_SILENT_COMMANDS = new Set([
  'mv',
  'cp',
  'rm',
  'mkdir',
  'rmdir',
  'chmod',
  'chown',
  'chgrp',
  'touch',
  'ln',
  'cd',
  'export',
  'unset',
  'wait',
])

/** 检查bash命令是否为搜索或读取操作。
用于确定UI中是否应折叠该命令。
返回一个指示它是搜索还是读取操作的对象。

对于管道（例如，`cat file | bq`），所有部分都必须是搜索/读取命令，
整个命令才能被视为可折叠。

语义中性命令（echo、printf、true、false、:）在任何位置都会被跳过，
因为它们是纯输出/状态命令，不影响管道的读取/搜索性质（例如，`ls dir && echo "---" && ls dir2` 仍然是读取操作）。 */
export function isSearchOrReadBashCommand(command: string): {
  isSearch: boolean
  isRead: boolean
  isList: boolean
} {
  let partsWithOperators: string[]
  try {
    partsWithOperators = splitCommandWithOperators(command)
  } catch {
    // 如果由于语法错误无法解析命令，则它
    // 不是搜索/读取命令
    return { isSearch: false, isRead: false, isList: false }
  }

  if (partsWithOperators.length === 0) {
    return { isSearch: false, isRead: false, isList: false }
  }

  let hasSearch = false
  let hasRead = false
  let hasList = false
  let hasNonNeutralCommand = false
  let skipNextAsRedirectTarget = false

  for (const part of partsWithOperators) {
    if (skipNextAsRedirectTarget) {
      skipNextAsRedirectTarget = false
      continue
    }

    if (part === '>' || part === '>>' || part === '>&') {
      skipNextAsRedirectTarget = true
      continue
    }

    if (part === '||' || part === '&&' || part === '|' || part === ';') {
      continue
    }

    const baseCommand = part.trim().split(/\s+/)[0]
    if (!baseCommand) {
      continue
    }

    if (BASH_SEMANTIC_NEUTRAL_COMMANDS.has(baseCommand)) {
      continue
    }

    hasNonNeutralCommand = true

    const isPartSearch = BASH_SEARCH_COMMANDS.has(baseCommand)
    const isPartRead = BASH_READ_COMMANDS.has(baseCommand)
    const isPartList = BASH_LIST_COMMANDS.has(baseCommand)

    if (!isPartSearch && !isPartRead && !isPartList) {
      return { isSearch: false, isRead: false, isList: false }
    }

    if (isPartSearch) hasSearch = true
    if (isPartRead) hasRead = true
    if (isPartList) hasList = true
  }

  // 只有中性命令（例如，仅仅是“echo foo”）— 不可折叠
  if (!hasNonNeutralCommand) {
    return { isSearch: false, isRead: false, isList: false }
  }

  return { isSearch: hasSearch, isRead: hasRead, isList: hasList }
}

/** 检查bash命令成功时是否预期不产生标准输出。
用于在UI中显示“完成”而不是“（无输出）”。 */
function isSilentBashCommand(command: string): boolean {
  let partsWithOperators: string[]
  try {
    partsWithOperators = splitCommandWithOperators(command)
  } catch {
    return false
  }

  if (partsWithOperators.length === 0) {
    return false
  }

  let hasNonFallbackCommand = false
  let lastOperator: string | null = null
  let skipNextAsRedirectTarget = false

  for (const part of partsWithOperators) {
    if (skipNextAsRedirectTarget) {
      skipNextAsRedirectTarget = false
      continue
    }

    if (part === '>' || part === '>>' || part === '>&') {
      skipNextAsRedirectTarget = true
      continue
    }

    if (part === '||' || part === '&&' || part === '|' || part === ';') {
      lastOperator = part
      continue
    }

    const baseCommand = part.trim().split(/\s+/)[0]
    if (!baseCommand) {
      continue
    }

    if (
      lastOperator === '||' &&
      BASH_SEMANTIC_NEUTRAL_COMMANDS.has(baseCommand)
    ) {
      continue
    }

    hasNonFallbackCommand = true

    if (!BASH_SILENT_COMMANDS.has(baseCommand)) {
      return false
    }
  }

  return hasNonFallbackCommand
}

// 不应自动后台化的命令
const DISALLOWED_AUTO_BACKGROUND_COMMANDS = [
  'sleep', // sleep命令应在前台运行，除非用户显式地将其后台化
]

// 检查模块加载时后台任务是否被禁用
const isBackgroundTasksDisabled =
  // eslint-disable-next-line custom-rules/no-process-env-top-level -- 有意为之：模式必须在模块加载时定义
  isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)

const fullInputSchema = lazySchema(() =>
  z.strictObject({
    command: z.string().describe('要执行的命令'),
    timeout: semanticNumber(z.number().optional()).describe(
      `可选的超时时间（毫秒）（最大 ${getMaxTimeoutMs()}）`,
    ),
    description: z
      .string()
      .optional()
      .describe(`用主动语态清晰、简洁地描述此命令的功能。描述中切勿使用“复杂”或“风险”等词语 — 只需描述其作用。

对于简单命令（git、npm、标准CLI工具），保持简短（5-10个词）：
- ls → “列出当前目录中的文件”
- git status → “显示工作树状态”
- npm install → “安装包依赖项”

对于较难一眼看懂的复杂命令（管道命令、晦涩的标志等），添加足够的上下文以阐明其功能：
- find . -name "*.tmp" -exec rm {} \\; → “递归查找并删除所有.tmp文件”
- git reset --hard origin/main → “丢弃所有本地更改并匹配远程main分支”
- curl -s url | jq '.data[]' → “从URL获取JSON并提取数据数组元素”`),
    run_in_background: semanticBoolean(z.boolean().optional()).describe(
      `设置为true以在后台运行此命令。使用Read工具稍后读取输出。`,
    ),
    dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional()).describe(
      '将此设置为true以危险地覆盖沙箱模式，并在无沙箱保护的情况下运行命令。',
    ),
    _simulatedSedEdit: z
      .object({
        filePath: z.string(),
        newContent: z.string(),
      })
      .optional()
      .describe('内部：来自预览的预计算sed编辑结果'),
  }),
)

// 始终从面向模型的模式中省略_simulatedSedEdit。它是一个
// 仅供内部使用的字段，由SedEditPermissionRequest
// 在用户批准sed编辑预览后设置。在模式中暴露此字段会让模型通过将一
// 个无害命令与任意文件写入配对来绕过权限检查和沙箱。同时，当后
// 台任务被禁用时，有条件地移除run_in_background字段。
const inputSchema = lazySchema(() =>
  isBackgroundTasksDisabled
    ? fullInputSchema().omit({
        run_in_background: true,
        _simulatedSedEdit: true,
      })
    : fullInputSchema().omit({ _simulatedSedEdit: true }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 使用fullInputSchema作为类型，以始终包含run_i
// n_background（即使模式中省略了它，代码也需要处理它）
export type BashToolInput = z.infer<ReturnType<typeof fullInputSchema>>

const COMMON_BACKGROUND_COMMANDS = [
  'npm',
  'yarn',
  'pnpm',
  'node',
  'python',
  'python3',
  'go',
  'cargo',
  'make',
  'docker',
  'terraform',
  'webpack',
  'vite',
  'jest',
  'pytest',
  'curl',
  'wget',
  'build',
  'test',
  'serve',
  'watch',
  'dev',
] as const

function getCommandTypeForLogging(
  command: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  const parts = splitCommand_DEPRECATED(command)
  if (parts.length === 0)
    return 'other' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

  // 检查命令的每个部分，看是否有匹配常见后台命令的
  for (const part of parts) {
    const baseCommand = part.split(' ')[0] || ''
    if (
      COMMON_BACKGROUND_COMMANDS.includes(
        baseCommand as (typeof COMMON_BACKGROUND_COMMANDS)[number],
      )
    ) {
      return baseCommand as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    }
  }

  return 'other' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

const outputSchema = lazySchema(() =>
  z.object({
    stdout: z.string().describe('命令的标准输出'),
    stderr: z.string().describe('命令的标准错误输出'),
    rawOutputPath: z
      .string()
      .optional()
      .describe('大型MCP工具输出的原始输出文件路径'),
    interrupted: z.boolean().describe('命令是否被中断'),
    isImage: z
      .boolean()
      .optional()
      .describe('指示标准输出是否包含图像数据的标志'),
    backgroundTaskId: z
      .string()
      .optional()
      .describe(
        '如果命令在后台运行，则为后台任务的ID',
      ),
    backgroundedByUser: z
      .boolean()
      .optional()
      .describe(
        '如果用户使用Ctrl+B手动将命令后台化，则为true',
      ),
    assistantAutoBackgrounded: z
      .boolean()
      .optional()
      .describe(
        '如果助手模式自动将长时间运行的阻塞命令后台化，则为true',
      ),
    dangerouslyDisableSandbox: z
      .boolean()
      .optional()
      .describe('指示沙箱模式是否被覆盖的标志'),
    returnCodeInterpretation: z
      .string()
      .optional()
      .describe(
        '对具有特殊含义的非错误退出代码的语义解释',
      ),
    noOutputExpected: z
      .boolean()
      .optional()
      .describe(
        '命令成功时是否预期不产生输出',
      ),
    structuredContent: z
      .array(z.any())
      .optional()
      .describe('结构化内容块'),
    persistedOutputPath: z
      .string()
      .optional()
      .describe(
        '持久化完整输出到tool-results目录的路径（当输出过大无法内联时设置）',
      ),
    persistedOutputSize: z
      .number()
      .optional()
      .describe(
        '输出的总大小（字节）（当输出过大无法内联时设置）',
      ),
  }),
)

type OutputSchema = ReturnType<typeof outputSchema>
export type Out = z.infer<OutputSchema>

// 从集中式类型重新导出BashProgress以打破导入循环
export type { BashProgress } from 'src/types/tools.js'

import type { BashProgress } from 'src/types/tools.js'

/** 检查命令是否允许自动后台化
@param command 要检查的命令
@returns 对于不应自动后台化的命令（如sleep）返回false */
function isAutobackgroundingAllowed(command: string): boolean {
  const parts = splitCommand_DEPRECATED(command)
  if (parts.length === 0) return true

  // 获取第一部分，它应该是基本命令
  const baseCommand = parts[0]?.trim()
  if (!baseCommand) return true

  return !DISALLOWED_AUTO_BACKGROUND_COMMANDS.includes(baseCommand)
}

/** 检测应使用Monitor工具的独立或开头的`sleep N`模式。
捕获`sleep 5`、`sleep 5 && check`、`sleep 5; check` — 但
不捕获管道、子shell或脚本内部的sleep（那些没问题）。 */
export function detectBlockedSleepPattern(command: string): string | null {
  const parts = splitCommand_DEPRECATED(command)
  if (parts.length === 0) return null

  const first = parts[0]?.trim() ?? ''
  // 裸`sleep N`或`sleep N.N`作为第一个子
  // 命令。允许浮点持续时间（sleep 0.5）— 那些是合法的节奏控制，而非轮询。
  const m = /^sleep\s+(\d+)\s*$/.exec(first)
  if (!m) return null
  const secs = parseInt(m[1]!, 10)
  if (secs < 2) return null // 2秒以下的sleep没问题（用于速率限制、节奏控制）

  // 单独的`sleep N` → “你在等待什么？” `sleep N &
  // & check` → “使用Monitor { command: check }”
  const rest = parts.slice(1).join(' ').trim()
  return rest
    ? `sleep ${secs} 后接：${rest}`
    : `独立的sleep ${secs}`
}

/** 检查命令是否包含不应在沙箱中运行的工具
这包括：
- 基于动态配置的禁用命令和子字符串（tengu_sandbox_disabled_commands）
- 来自settings.json的用户配置命令（sandbox.excludedCommands）

用户配置的命令支持与权限规则相同的模式语法：
- 精确匹配："npm run lint"
- 前缀模式："npm run test:*" */

type SimulatedSedEditResult = {
  data: Out
}

type SimulatedSedEditContext = Pick<
  ToolUseContext,
  'readFileState' | 'updateFileHistoryState'
>

/** 直接应用模拟的sed编辑，而不是运行sed。
权限对话框使用此功能来确保用户预览的内容
正是写入文件的内容。 */
async function applySedEdit(
  simulatedEdit: { filePath: string; newContent: string },
  toolUseContext: SimulatedSedEditContext,
  parentMessage?: AssistantMessage,
): Promise<SimulatedSedEditResult> {
  const { filePath, newContent } = simulatedEdit
  const absoluteFilePath = expandPath(filePath)
  const fs = getFsImplementation()

  // 为VS Code通知读取原始内容
  const encoding = detectFileEncoding(absoluteFilePath)
  let originalContent: string
  try {
    originalContent = await fs.readFile(absoluteFilePath, { encoding })
  } catch (e) {
    if (isENOENT(e)) {
      return {
        data: {
          stdout: '',
          stderr: `sed: ${filePath}: 没有那个文件或目录
退出代码 1`,
          interrupted: false,
        },
      }
    }
    throw e
  }

  // 在更改前跟踪文件历史记录（用于支持撤销）
  if (fileHistoryEnabled() && parentMessage) {
    await fileHistoryTrackEdit(
      toolUseContext.updateFileHistoryState,
      absoluteFilePath,
      parentMessage.uuid,
    )
  }

  // 检测行尾并写入新内容
  const endings = detectLineEndings(absoluteFilePath)
  writeTextContent(absoluteFilePath, newContent, encoding, endings)

  // 通知VS Code文件更改
  notifyVscodeFileUpdated(absoluteFilePath, originalContent, newContent)

  // 更新读取时间戳以使过时的写入失效
  toolUseContext.readFileState.set(absoluteFilePath, {
    content: newContent,
    timestamp: getFileModificationTime(absoluteFilePath),
    offset: undefined,
    limit: undefined,
  })

  // 返回与sed输出格式匹配的成功结果（sed成功时不产生输出）
  return {
    data: {
      stdout: '',
      stderr: '',
      interrupted: false,
    },
  }
}

export const BashTool = buildTool({
  name: BASH_TOOL_NAME,
  searchHint: '执行shell命令',
  // 30K字符 - 工具结果持久化阈值
  maxResultSizeChars: 30_000,
  strict: true,
  async description({ description }) {
    return description || '运行shell命令'
  },
  async prompt() {
    return getSimplePrompt()
  },
  isConcurrencySafe(input) {
    return this.isReadOnly?.(input) ?? false
  },
  isReadOnly(input) {
    const compoundCommandHasCd = commandHasAnyCd(input.command)
    const result = checkReadOnlyConstraints(input, compoundCommandHasCd)
    return result.behavior === 'allow'
  },
  toAutoClassifierInput(input) {
    return input.command
  },
  async preparePermissionMatcher({ command }) {
    // 钩子`if`过滤是“无匹配 → 跳过钩子”（类似拒绝的语义），因此
    // 复合命令如果任何子命令匹配，就必须触发钩子。如果不拆分，`ls &
    // & git push`会绕过`Bash(git *)`安全钩子。
    const parsed = await parseForSecurity(command)
    if (parsed.kind !== 'simple') {
      // 解析不可用/过于复杂：通过运行钩子安全地失败。
      return () => true
    }
    // 在argv上匹配（去除前导VAR=val），因此`FOO=bar git push`仍匹
    // 配`Bash(git *)`。
    const subcommands = parsed.commands.map(c => c.argv.join(' '))
    return pattern => {
      const prefix = permissionRuleExtractPrefix(pattern)
      return subcommands.some(cmd => {
        if (prefix !== null) {
          return cmd === prefix || cmd.startsWith(`${prefix} `)
        }
        return matchWildcardPattern(pattern, cmd)
      })
    }
  },
  isSearchOrReadCommand(input) {
    const parsed = inputSchema().safeParse(input)
    if (!parsed.success)
      return { isSearch: false, isRead: false, isList: false }
    return isSearchOrReadBashCommand(parsed.data.command)
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName(input) {
    if (!input) {
      return 'Bash'
    }
    // 将sed原地编辑渲染为文件编辑
    if (input.command) {
      const sedInfo = parseSedEditCommand(input.command)
      if (sedInfo) {
        return fileEditUserFacingName({
          file_path: sedInfo.filePath,
          old_string: 'x',
        })
      }
    }
    // 环境变量FIRST：shouldUseSandbox → splitCommand_DEPRE
    // CATED → shell-quote的`new RegExp`每次调用。userFac
    // ingName为历史记录中的每条bash消息每次渲染都运行；在约50条消息 + 一个分词缓
    // 慢的命令时，这会超过shimmer tick → 转换中止 → 无限重试（#21605）。
    return isEnvTruthy(process.env.CLAUDE_CODE_BASH_SANDBOX_SHOW_INDICATOR) &&
      shouldUseSandbox(input)
      ? 'SandboxedBash'
      : 'Bash'
  },
  getToolUseSummary(input) {
    if (!input?.command) {
      return null
    }
    const { command, description } = input
    if (description) {
      return description
    }
    return truncate(command, TOOL_SUMMARY_MAX_LENGTH)
  },
  getActivityDescription(input) {
    if (!input?.command) {
      return '正在运行命令'
    }
    const desc =
      input.description ?? truncate(input.command, TOOL_SUMMARY_MAX_LENGTH)
    return `Running ${desc}`
  },
  async validateInput(input: BashToolInput): Promise<ValidationResult> {
    if (
      feature('MONITOR_TOOL') &&
      !isBackgroundTasksDisabled &&
      !input.run_in_background
    ) {
      const sleepPattern = detectBlockedSleepPattern(input.command)
      if (sleepPattern !== null) {
        return {
          result: false,
          message: `已阻止：${sleepPattern}。使用run_in_background: true在后台运行阻塞命令 — 完成后您将收到完成通知。对于流式事件（监视日志、轮询API），请使用Monitor工具。如果您确实需要延迟（速率限制、有意节奏控制），请将其控制在2秒以内。`,
          errorCode: 10,
        }
      }
    }
    return { result: true }
  },
  async checkPermissions(input, context): Promise<PermissionResult> {
    return bashToolHasPermission(input, context)
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseQueuedMessage,
  renderToolResultMessage,
  // BashToolResultMessage显示<OutputLine content={stdout}>
  // + stderr。UI从不显示persistedOutputPath包装器、backgroundInfo —
  // 那些是面向模型的（下面的mapToolResult...）。
  extractSearchText({ stdout, stderr }) {
    return stderr ? `${stdout}\n${stderr}` : stdout
  },
  mapToolResultToToolResultBlockParam(
    {
      interrupted,
      stdout,
      stderr,
      isImage,
      backgroundTaskId,
      backgroundedByUser,
      assistantAutoBackgrounded,
      structuredContent,
      persistedOutputPath,
      persistedOutputSize,
    },
    toolUseID,
  ): ToolResultBlockParam {
    // 处理结构化内容
    if (structuredContent && structuredContent.length > 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: structuredContent,
      }
    }

    // 对于图像数据，格式化为Claude的图像内容块
    if (isImage) {
      const block = buildImageToolResult(stdout, toolUseID)
      if (block) return block
    }

    let processedStdout = stdout
    if (stdout) {
      // 替换任何前导换行符或仅包含空白字符的行
      processedStdout = stdout.replace(/^(\s*\n)+/, '')
      // 仍然像以前一样修剪末尾
      processedStdout = processedStdout.trimEnd()
    }

    // 对于已持久化到磁盘的大型输出，为模型构建<persisted-out
    // put>消息。UI永远看不到这个 — 它使用data.stdout。
    if (persistedOutputPath) {
      const preview = generatePreview(processedStdout, PREVIEW_SIZE_BYTES)
      processedStdout = buildLargeToolResultMessage({
        filepath: persistedOutputPath,
        originalSize: persistedOutputSize ?? 0,
        isJson: false,
        preview: preview.preview,
        hasMore: preview.hasMore,
      })
    }

    let errorMessage = stderr.trim()
    if (interrupted) {
      if (stderr) errorMessage += EOL
      errorMessage += '<error>命令在完成前被中止</error>'
    }

    let backgroundInfo = ''
    if (backgroundTaskId) {
      const outputPath = getTaskOutputPath(backgroundTaskId)
      if (assistantAutoBackgrounded) {
        backgroundInfo = `命令超出了助手模式的阻塞预算（${ASSISTANT_BLOCKING_BUDGET_MS / 1000}秒），并已移至后台，ID：${backgroundTaskId}。它仍在运行 — 完成后您将收到通知。输出正在写入：${outputPath}。在助手模式下，请将长时间运行的工作委托给子代理或使用run_in_background以保持此对话响应迅速。`
      } else if (backgroundedByUser) {
        backgroundInfo = `命令已被用户手动后台化，ID：${backgroundTaskId}。输出正在写入：${outputPath}`
      } else {
        backgroundInfo = `命令正在后台运行，ID：${backgroundTaskId}。输出正在写入：${outputPath}`
      }
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [processedStdout, errorMessage, backgroundInfo]
        .filter(Boolean)
        .join('\n'),
      is_error: interrupted,
    }
  },
  async call(
    input: BashToolInput,
    toolUseContext,
    _canUseTool?: CanUseToolFn,
    parentMessage?: AssistantMessage,
    onProgress?: ToolCallProgress<BashProgress>,
  ) {
    // 处理模拟的sed编辑 - 直接应用而不是运行
    // sed 这确保用户预览的内容正是写入的内容
    if (input._simulatedSedEdit) {
      return applySedEdit(
        input._simulatedSedEdit,
        toolUseContext,
        parentMessage,
      )
    }

    const { abortController, getAppState, setAppState, setToolJSX } =
      toolUseContext

    const stdoutAccumulator = new EndTruncatingAccumulator()
    let stderrForShellReset = ''
    let interpretationResult:
      | ReturnType<typeof interpretCommandResult>
      | undefined

    let progressCounter = 0
    let wasInterrupted = false
    let result: ExecResult

    const isMainThread = !toolUseContext.agentId
    const preventCwdChanges = !isMainThread

    try {
      // 使用新的异步生成器版本的 runShellCommand
      const commandGenerator = runShellCommand({
        input,
        abortController,
        // 使用 always-shared 任务通道，以便异步代理的后
        // 台 bash 任务能够被实际注册（并在代理退出时可被终止）。
        setAppState: toolUseContext.setAppStateForTasks ?? setAppState,
        setToolJSX,
        preventCwdChanges,
        isMainThread,
        toolUseId: toolUseContext.toolUseId,
        agentId: toolUseContext.agentId,
      })

      // 消费生成器并捕获返回值
      let generatorResult
      do {
        generatorResult = await commandGenerator.next()
        if (!generatorResult.done && onProgress) {
          const progress = generatorResult.value
          onProgress({
            toolUseID: `bash-progress-${progressCounter++}`,
            data: {
              type: 'bash_progress',
              output: progress.output,
              fullOutput: progress.fullOutput,
              elapsedTimeSeconds: progress.elapsedTimeSeconds,
              totalLines: progress.totalLines,
              totalBytes: progress.totalBytes,
              taskId: progress.taskId,
              timeoutMs: progress.timeoutMs,
            },
          })
        }
      } while (!generatorResult.done)

      // 从生成器的返回值中获取最终结果
      result = generatorResult.value

      trackGitOperations(input.command, result.code, result.stdout)

      const isInterrupt =
        result.interrupted && abortController.signal.reason === 'interrupt'

      // stderr 交错在 stdout 中（合并的文件描述符）—— result.stdout 包含两者
      stdoutAccumulator.append((result.stdout || '').trimEnd() + EOL)

      // 使用语义规则解释命令结果
      interpretationResult = interpretCommandResult(
        input.command,
        result.code,
        result.stdout || '',
        '',
      )

      // 检查 git index.lock 错误（stderr 现在在 stdout 中）
      if (
        result.stdout &&
        result.stdout.includes(".git/index.lock'：文件已存在")
      ) {
        logEvent('tengu_git_index_lock_error', {})
      }

      if (interpretationResult.isError && !isInterrupt) {
        // 仅在确实是错误时才添加退出码
        if (result.code !== 0) {
          stdoutAccumulator.append(`退出码 ${result.code}`)
        }
      }

      if (!preventCwdChanges) {
        const appState = getAppState()
        if (resetCwdIfOutsideProject(appState.toolPermissionContext)) {
          stderrForShellReset = stdErrAppendShellResetMessage('')
        }
      }

      // 如果存在沙箱违规，则在输出中添加注释（stderr 在 stdout 中）
      const outputWithSbFailures =
        SandboxManager.annotateStderrWithSandboxFailures(
          input.command,
          result.stdout || '',
        )

      if (result.preSpawnError) {
        throw new Error(result.preSpawnError)
      }
      if (interpretationResult.isError && !isInterrupt) {
        // stderr 已合并到 stdout（合并的文件描述符）；outputWithSbFa
        // ilures 已包含完整输出。为 stdout 传递 '' 以避免在 getE
        // rrorParts() 和 processBashCommand 中重复。
        throw new ShellError(
          '',
          outputWithSbFailures,
          result.code,
          result.interrupted,
        )
      }
      wasInterrupted = result.interrupted
    } finally {
      if (setToolJSX) setToolJSX(null)
    }

    // 从累加器中获取最终字符串
    const stdout = stdoutAccumulator.toString()

    // 大输出：磁盘上的文件超过 getMaxOutputLength() 字节。s
    // tdout 已包含第一个块（来自 getStdout()）。将输出文件复
    // 制到 tool-results 目录，以便模型可以通过 FileRe
    // ad 读取。如果 > 64 MB，则在复制后截断。
    const MAX_PERSISTED_SIZE = 64 * 1024 * 1024
    let persistedOutputPath: string | undefined
    let persistedOutputSize: number | undefined
    if (result.outputFilePath && result.outputTaskId) {
      try {
        const fileStat = await fsStat(result.outputFilePath)
        persistedOutputSize = fileStat.size

        await ensureToolResultsDir()
        const dest = getToolResultPath(result.outputTaskId, false)
        if (fileStat.size > MAX_PERSISTED_SIZE) {
          await fsTruncate(result.outputFilePath, MAX_PERSISTED_SIZE)
        }
        try {
          await link(result.outputFilePath, dest)
        } catch {
          await copyFile(result.outputFilePath, dest)
        }
        persistedOutputPath = dest
      } catch {
        // 文件可能已不存在 —— stdout 预览已足够
      }
    }

    const commandType = input.command.split(' ')[0]

    logEvent('tengu_bash_tool_command_executed', {
      command_type:
        commandType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      stdout_length: stdout.length,
      stderr_length: 0,
      exit_code: result.code,
      interrupted: wasInterrupted,
    })

    // 记录代码索引工具使用情况
    const codeIndexingTool = detectCodeIndexingFromCommand(input.command)
    if (codeIndexingTool) {
      logEvent('tengu_code_indexing_tool_used', {
        tool: codeIndexingTool as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        source:
          'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        success: result.code === 0,
      })
    }

    let strippedStdout = stripEmptyLines(stdout)

    // Claude Code 提示协议：受 CLAUDECODE=1 控制的 CLI
    // /SDK 会向 stderr（此处已合并到 stdout）发出一个 `<clau
    // de-code-hint />` 标签。扫描、记录以供 useClaudeC
    // odeHintRecommendation 使用并展示，然后剥离该标签
    // ，确保模型永远不会看到它 —— 这是一个零令牌的侧信道。剥离操作无条件运行（子代
    // 理的输出也必须保持干净）；只有对话记录是仅限主线程的。
    const extracted = extractClaudeCodeHints(strippedStdout, input.command)
    strippedStdout = extracted.stripped
    if (isMainThread && extracted.hints.length > 0) {
      for (const hint of extracted.hints) maybeRecordPluginHint(hint)
    }

    let isImage = isImageOutput(strippedStdout)

    // 如果存在，则限制图像尺寸 + 大小（CC-304 ——
    // 参见 resizeShellImageOutput）。限定解码缓冲区的范围，以
    // 便在构建输出 Out 对象之前可以回收它。
    let compressedStdout = strippedStdout
    if (isImage) {
      const resized = await resizeShellImageOutput(
        strippedStdout,
        result.outputFilePath,
        persistedOutputSize,
      )
      if (resized) {
        compressedStdout = resized
      } else {
        // 解析失败或文件过大（例如，超过 MAX_IMAGE_FILE_SIZE）
        // 。保持 isImage 与实际发送的内容同步，以便 UI 标签保持准确 —
        // — mapToolResultToToolResultBloc
        // kParam 的防御性回退将发送文本，而不是图像块。
        isImage = false
      }
    }

    const data: Out = {
      stdout: compressedStdout,
      stderr: stderrForShellReset,
      interrupted: wasInterrupted,
      isImage,
      returnCodeInterpretation: interpretationResult?.message,
      noOutputExpected: isSilentBashCommand(input.command),
      backgroundTaskId: result.backgroundTaskId,
      backgroundedByUser: result.backgroundedByUser,
      assistantAutoBackgrounded: result.assistantAutoBackgrounded,
      dangerouslyDisableSandbox:
        'dangerouslyDisableSandbox' in input
          ? (input.dangerouslyDisableSandbox as boolean | undefined)
          : undefined,
      persistedOutputPath,
      persistedOutputSize,
    }

    return {
      data,
    }
  },
  renderToolUseErrorMessage,
  isResultTruncated(output: Out): boolean {
    return (
      isOutputLineTruncated(output.stdout) ||
      isOutputLineTruncated(output.stderr)
    )
  },
} satisfies ToolDef<InputSchema, Out, BashProgress>)

async function* runShellCommand({
  input,
  abortController,
  setAppState,
  setToolJSX,
  preventCwdChanges,
  isMainThread,
  toolUseId,
  agentId,
}: {
  input: BashToolInput
  abortController: AbortController
  setAppState: (f: (prev: AppState) => AppState) => void
  setToolJSX?: SetToolJSXFn
  preventCwdChanges?: boolean
  isMainThread?: boolean
  toolUseId?: string
  agentId?: AgentId
}): AsyncGenerator<
  {
    type: 'progress'
    output: string
    fullOutput: string
    elapsedTimeSeconds: number
    totalLines: number
    totalBytes?: number
    taskId?: string
    timeoutMs?: number
  },
  ExecResult,
  void
> {
  const { command, description, timeout, run_in_background } = input
  const timeoutMs = timeout || getDefaultTimeoutMs()

  let fullOutput = ''
  let lastProgressOutput = ''
  let lastTotalLines = 0
  let lastTotalBytes = 0
  let backgroundShellId: string | undefined = undefined
  let assistantAutoBackgrounded = false

  // 进度信号：由共享轮询器的 onProgress 回
  // 调解析，唤醒生成器以产生进度更新。
  let resolveProgress: (() => void) | null = null
  function createProgressSignal(): Promise<null> {
    return new Promise<null>(resolve => {
      resolveProgress = () => resolve(null)
    })
  }

  // 确定是否应启用自动后台化
  // 仅对允许自动后台化的命令启用，并且
  // 当后台任务未被禁用时
  const shouldAutoBackground =
    !isBackgroundTasksDisabled && isAutobackgroundingAllowed(command)

  const shellCommand = await exec(command, abortController.signal, 'bash', {
    timeout: timeoutMs,
    onProgress(lastLines, allLines, totalLines, totalBytes, isIncomplete) {
      lastProgressOutput = lastLines
      fullOutput = allLines
      lastTotalLines = totalLines
      lastTotalBytes = isIncomplete ? totalBytes : 0
      // 唤醒生成器，使其产生新的进度数据
      const resolve = resolveProgress
      if (resolve) {
        resolveProgress = null
        resolve()
      }
    },
    preventCwdChanges,
    shouldUseSandbox: shouldUseSandbox(input),
    shouldAutoBackground,
  })

  // 开始命令执行
  const resultPromise = shellCommand.result

  // 用于生成后台任务并返回其 ID 的辅助函数
  async function spawnBackgroundTask(): Promise<string> {
    const handle = await spawnShellTask(
      {
        command,
        description: description || command,
        shellCommand,
        toolUseId,
        agentId,
      },
      {
        abortController,
        getAppState: () => {
          // 我们在此处无法直接访问 getAppState，但 spa
          // wn 在生成过程中实际上并不使用它
          throw new Error(
            '在 runShellCommand 上下文中无法使用 getAppState',
          )
        },
        setAppState,
      },
    )
    return handle.taskId
  }

  // 用于启动后台化并可选记录日志的辅助函数
  function startBackgrounding(
    eventName: string,
    backgroundFn?: (shellId: string) => void,
  ): void {
    // 如果前台任务已注册（通过进度循环中的 registerForegr
    // ound），则就地将其后台化，而不是重新生成。重新生成会覆盖 tas
    // ks[taskId]，发出重复的 task_started SD
    // K 事件，并泄漏第一个清理回调。
    if (foregroundTaskId) {
      if (
        !backgroundExistingForegroundTask(
          foregroundTaskId,
          shellCommand,
          description || command,
          setAppState,
          toolUseId,
        )
      ) {
        return
      }
      backgroundShellId = foregroundTaskId
      logEvent(eventName, {
        command_type: getCommandTypeForLogging(command),
      })
      backgroundFn?.(foregroundTaskId)
      return
    }

    // 没有注册前台任务 —— 生成一个新的后台任务
    // 注意：尽管是异步的，spawn 本质上是同步的
    void spawnBackgroundTask().then(shellId => {
      backgroundShellId = shellId

      // 唤醒生成器的 Promise.race，使其看到 backg
      // roundShellId。如果不这样做，如果轮询器已为此任
      // 务停止计时（无输出 + 共享轮询器与兄弟 stopPolli
      // ng 调用的竞争）且进程在 I/O 上挂起，则约第 13
      // 57 行的竞争永远不会解析，尽管已后台化，生成器仍会死锁。
      const resolve = resolveProgress
      if (resolve) {
        resolveProgress = null
        resolve()
      }

      logEvent(eventName, {
        command_type: getCommandTypeForLogging(command),
      })

      if (backgroundFn) {
        backgroundFn(shellId)
      }
    })
  }

  // 如果启用，则设置超时自动后台化
  // 仅对允许自动后台化的命令进行后台化（非 sleep 等）
  if (shellCommand.onTimeout && shouldAutoBackground) {
    shellCommand.onTimeout(backgroundFn => {
      startBackgrounding(
        'tengu_bash_command_timeout_backgrounded',
        backgroundFn,
      )
    })
  }

  // 在助手模式下，主代理应保持响应。在 ASSISTANT_BL
  // OCKING_BUDGET_MS 后自动后台化阻塞命令，以便
  // 代理可以继续协调而不是等待。命令继续运行 —— 无状态丢失。
  if (
    feature('KAIROS') &&
    getKairosActive() &&
    isMainThread &&
    !isBackgroundTasksDisabled &&
    run_in_background !== true
  ) {
    setTimeout(() => {
      if (
        shellCommand.status === 'running' &&
        backgroundShellId === undefined
      ) {
        assistantAutoBackgrounded = true
        startBackgrounding('tengu_bash_command_assistant_auto_backgrounded')
      }
    }, ASSISTANT_BLOCKING_BUDGET_MS).unref()
  }

  // 处理 Claude 明确要求将其在后台运行的情况 当
  // 通过 run_in_background 明确请求时，始终尊重该请
  // 求，无论命令类型如何（isAutobackgroundingAllowed 仅适用于自动
  // 后台化） 如果后台任务被禁用，则跳过 —— 改为在前台运行
  if (run_in_background === true && !isBackgroundTasksDisabled) {
    const shellId = await spawnBackgroundTask()

    logEvent('tengu_bash_command_explicitly_backgrounded', {
      command_type: getCommandTypeForLogging(command),
    })

    return {
      stdout: '',
      stderr: '',
      code: 0,
      interrupted: false,
      backgroundTaskId: shellId,
    }
  }

  // 在显示进度前等待初始阈值
  const startTime = Date.now()
  let foregroundTaskId: string | undefined = undefined

  {
    const initialResult = await Promise.race([
      resultPromise,
      new Promise<null>(resolve => {
        const t = setTimeout(
          (r: (v: null) => void) => r(null),
          PROGRESS_THRESHOLD_MS,
          resolve,
        )
        t.unref()
      }),
    ])

    if (initialResult !== null) {
      shellCommand.cleanup()
      return initialResult
    }

    if (backgroundShellId) {
      return {
        stdout: '',
        stderr: '',
        code: 0,
        interrupted: false,
        backgroundTaskId: backgroundShellId,
        assistantAutoBackgrounded,
      }
    }
  }

  // 开始轮询输出文件以获取进度。轮询器的 #tick 每秒调用 onPr
  // ogress，这会解析下面的 progressSignal。
  TaskOutput.startPolling(shellCommand.taskOutput.taskId)

  // 进度循环：唤醒由共享轮询器调用 onProgress 驱动，该调用解
  // 析 progressSignal。
  try {
    while (true) {
      const progressSignal = createProgressSignal()
      const result = await Promise.race([resultPromise, progressSignal])

      if (result !== null) {
        // 竞争情况：后台化已触发（15 秒计时器 / onTimeout / Ctrl+
        // B），但命令在下一次轮询计时前完成。#handleExit 设置了 ba
        // ckgroundTaskId 但跳过了 outputFilePath（它假设后台
        // 消息或 <task_notification> 将携带路径）。剥离 b
        // ackgroundTaskId 以便模型看到一个干净的已完成命令，为大型
        // 输出重建 outputFilePath，并抑制来自 .then() 处理程
        // 序的冗余 <task_notification>。检查 resul
        // t.backgroundTaskId（而非闭包变量）以同时覆盖 Ctrl+B，
        // 后者直接调用 shellCommand.background()。
        if (result.backgroundTaskId !== undefined) {
          markTaskNotified(result.backgroundTaskId, setAppState)
          const fixedResult: ExecResult = {
            ...result,
            backgroundTaskId: undefined,
          }
          // 镜像 ShellCommand.#handleExit 的大型输出分支，该分支因
          // #backgroundTaskId 被设置而被跳过。
          const { taskOutput } = shellCommand
          if (taskOutput.stdoutToFile && !taskOutput.outputFileRedundant) {
            fixedResult.outputFilePath = taskOutput.path
            fixedResult.outputFileSize = taskOutput.outputFileSize
            fixedResult.outputTaskId = taskOutput.taskId
          }
          shellCommand.cleanup()
          return fixedResult
        }
        // 命令已完成 - 返回实际结果
        // 如果我们注册为前台任务，则取消注册
        if (foregroundTaskId) {
          unregisterForeground(foregroundTaskId, setAppState)
        }
        // 清理前台命令的流资源（后台化命令由
        // LocalShellTask 清理）
        shellCommand.cleanup()
        return result
      }

      // 检查命令是否已后台化（通过旧机制或新的 backgroundAll）
      if (backgroundShellId) {
        return {
          stdout: '',
          stderr: '',
          code: 0,
          interrupted: false,
          backgroundTaskId: backgroundShellId,
          assistantAutoBackgrounded,
        }
      }

      // 检查此前台任务是否通过 backgroundAll() 后台化
      if (foregroundTaskId) {
        // 当 background() 被调用时，shellCommand.status 变为 'backgrounded'
        if (shellCommand.status === 'backgrounded') {
          return {
            stdout: '',
            stderr: '',
            code: 0,
            interrupted: false,
            backgroundTaskId: foregroundTaskId,
            backgroundedByUser: true,
          }
        }
      }

      // 进行进度更新的时间
      const elapsed = Date.now() - startTime
      const elapsedSeconds = Math.floor(elapsed / 1000)

      // 如果可用，显示最小化的后台化 U
      // I 如果后台任务被禁用，则跳过
      if (
        !isBackgroundTasksDisabled &&
        backgroundShellId === undefined &&
        elapsedSeconds >= PROGRESS_THRESHOLD_MS / 1000 &&
        setToolJSX
      ) {
        // 将此命令注册为前台任务，以便可以通过 Ctrl+B 将其后台化
        if (!foregroundTaskId) {
          foregroundTaskId = registerForeground(
            {
              command,
              description: description || command,
              shellCommand,
              agentId,
            },
            setAppState,
            toolUseId,
          )
        }

        setToolJSX({
          jsx: <BackgroundHint />,
          shouldHidePromptInput: false,
          shouldContinueAnimation: true,
          showSpinner: true,
        })
      }
      yield {
        type: 'progress',
        fullOutput,
        output: lastProgressOutput,
        elapsedTimeSeconds: elapsedSeconds,
        totalLines: lastTotalLines,
        totalBytes: lastTotalBytes,
        taskId: shellCommand.taskOutput.taskId,
        ...(timeout ? { timeoutMs } : undefined),
      }
    }
  } finally {
    TaskOutput.stopPolling(shellCommand.taskOutput.taskId)
  }
}
