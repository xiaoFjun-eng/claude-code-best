/**
 * 会话内存（Session Memory）会自动维护一个包含当前对话笔记的 Markdown 文件。
 * 它通过派生的子代理在后台定期运行，提取关键信息，而不会中断主对话流程。
 */

import { writeFile } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { feature } from 'bun:bundle'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import { getSystemContext, getUserContext } from '../../context.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { FILE_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileEditTool/constants.js'
import {
  FileReadTool,
  type Output as FileReadToolOutput,
} from '@claude-code-best/builtin-tools/tools/FileReadTool/FileReadTool.js'
import type { Message } from '../../types/message.js'
import { count } from '../../utils/array.js'
import {
  createCacheSafeParams,
  createSubagentContext,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import {
  type REPLHookContext,
  registerPostSamplingHook,
} from '../../utils/hooks/postSamplingHooks.js'
import {
  createUserMessage,
  hasToolCallsInLastAssistantTurn,
} from '../../utils/messages.js'
import {
  getSessionMemoryDir,
  getSessionMemoryPath,
} from '../../utils/permissions/filesystem.js'
import { sequential } from '../../utils/sequential.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { getTokenUsage, tokenCountWithEstimation } from '../../utils/tokens.js'
import { logEvent } from '../analytics/index.js'
import { isAutoCompactEnabled } from '../compact/autoCompact.js'
import {
  buildSessionMemoryUpdatePrompt,
  loadSessionMemoryTemplate,
} from './prompts.js'
import {
  DEFAULT_SESSION_MEMORY_CONFIG,
  getSessionMemoryConfig,
  getToolCallsBetweenUpdates,
  hasMetInitializationThreshold,
  hasMetUpdateThreshold,
  isSessionMemoryInitialized,
  markExtractionCompleted,
  markExtractionStarted,
  markSessionMemoryInitialized,
  recordExtractionTokenCount,
  type SessionMemoryConfig,
  setLastSummarizedMessageId,
  setSessionMemoryConfig,
} from './sessionMemoryUtils.js'

// ============================================================================
// 功能门控和配置（缓存 - 非阻塞）
// ============================================================================
// 这些函数立即从磁盘返回缓存值，不会阻塞等待 GrowthBook 初始化。
// 值可能过时，但会在后台更新。

import { errorMessage, getErrnoCode } from '../../utils/errors.js'
import {
  getDynamicConfig_CACHED_MAY_BE_STALE,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from '../analytics/growthbook.js'

/**
 * 检查会话内存功能是否启用。
 * 使用缓存的门控值 - 立即返回，不阻塞。
 */
function isSessionMemoryGateEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_session_memory', false)
}

/**
 * 从缓存中获取会话内存配置。
 * 立即返回，不阻塞 - 值可能过时。
 */
function getSessionMemoryRemoteConfig(): Partial<SessionMemoryConfig> {
  return getDynamicConfig_CACHED_MAY_BE_STALE<Partial<SessionMemoryConfig>>(
    'tengu_sm_config',
    {},
  )
}

// ============================================================================
// 模块状态
// ============================================================================

let lastMemoryMessageUuid: string | undefined

/**
 * 重置最后一条内存消息的 UUID（用于测试）
 */
export function resetLastMemoryMessageUuid(): void {
  lastMemoryMessageUuid = undefined
}

function countToolCallsSince(
  messages: Message[],
  sinceUuid: string | undefined,
): number {
  let toolCallCount = 0
  let foundStart = sinceUuid === null || sinceUuid === undefined

  for (const message of messages) {
    if (!foundStart) {
      if (message.uuid === sinceUuid) {
        foundStart = true
      }
      continue
    }

    if (message.type === 'assistant') {
      const content = message.message!.content
      if (Array.isArray(content)) {
        toolCallCount += count(content, block => block.type === 'tool_use')
      }
    }
  }

  return toolCallCount
}

export function shouldExtractMemory(messages: Message[]): boolean {
  // 检查是否满足初始化阈值
  // 使用总上下文窗口令牌（与自动压缩相同）以获得一致的行为
  const currentTokenCount = tokenCountWithEstimation(messages)
  if (!isSessionMemoryInitialized()) {
    if (!hasMetInitializationThreshold(currentTokenCount)) {
      return false
    }
    markSessionMemoryInitialized()
  }

  // 检查是否满足两次更新之间的最小令牌数阈值
  // 使用自上次提取以来的上下文窗口增长量（与初始化阈值相同的指标）
  const hasMetTokenThreshold = hasMetUpdateThreshold(currentTokenCount)

  // 检查是否满足工具调用次数阈值
  const toolCallsSinceLastUpdate = countToolCallsSince(
    messages,
    lastMemoryMessageUuid,
  )
  const hasMetToolCallThreshold =
    toolCallsSinceLastUpdate >= getToolCallsBetweenUpdates()

  // 检查最后一轮助手消息是否没有工具调用（可以安全提取）
  const hasToolCallsInLastTurn = hasToolCallsInLastAssistantTurn(messages)

  // 在以下情况下触发提取：
  // 1. 同时满足两个阈值（令牌数 AND 工具调用次数），或者
  // 2. 最后一轮没有工具调用且满足令牌数阈值
  //    （确保在自然对话间隙进行提取）
  //
  // 重要提示：令牌数阈值（minimumTokensBetweenUpdate）始终是必需的。
  // 即使工具调用次数阈值已满足，也必须满足令牌数阈值后才会进行提取。
  // 这可以防止过度提取。
  const shouldExtract =
    (hasMetTokenThreshold && hasMetToolCallThreshold) ||
    (hasMetTokenThreshold && !hasToolCallsInLastTurn)

  if (shouldExtract) {
    const lastMessage = messages[messages.length - 1]
    if (lastMessage?.uuid) {
      lastMemoryMessageUuid = lastMessage.uuid
    }
    return true
  }

  return false
}

async function setupSessionMemoryFile(
  toolUseContext: ToolUseContext,
): Promise<{ memoryPath: string; currentMemory: string }> {
  const fs = getFsImplementation()

  // 设置目录和文件
  const sessionMemoryDir = getSessionMemoryDir()
  await fs.mkdir(sessionMemoryDir, { mode: 0o700 })

  const memoryPath = getSessionMemoryPath()

  // 如果内存文件不存在则创建（wx = O_CREAT|O_EXCL）
  try {
    await writeFile(memoryPath, '', {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    })
    // 仅当文件刚刚创建时才加载模板
    const template = await loadSessionMemoryTemplate()
    await writeFile(memoryPath, template, {
      encoding: 'utf-8',
      mode: 0o600,
    })
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'EEXIST') {
      throw e
    }
  }

  // 删除任何缓存的条目，防止 FileReadTool 的去重机制返回 file_unchanged 存根
  // — 我们需要实际内容。Read 操作会重新填充缓存。
  toolUseContext.readFileState.delete(memoryPath)
  const result = await FileReadTool.call(
    { file_path: memoryPath },
    toolUseContext,
  )
  let currentMemory = ''

  const output = result.data as FileReadToolOutput
  if (output.type === 'text') {
    currentMemory = output.file.content
  }

  logEvent('tengu_session_memory_file_read', {
    content_length: currentMemory.length,
  })

  return { memoryPath, currentMemory }
}

/**
 * 从远程配置中初始化会话内存配置（延迟初始化）。
 * 已记忆化 - 每个会话只运行一次，后续调用立即返回。
 * 使用缓存的配置值 - 非阻塞。
 */
const initSessionMemoryConfigIfNeeded = memoize((): void => {
  // 从缓存加载配置（非阻塞，可能过时）
  const remoteConfig = getSessionMemoryRemoteConfig()

  // 仅当远程值被显式设置（非零正数）时才使用它们
  // 这确保合理的默认值不会被零值覆盖
  const config: SessionMemoryConfig = {
    minimumMessageTokensToInit:
      remoteConfig.minimumMessageTokensToInit &&
      remoteConfig.minimumMessageTokensToInit > 0
        ? remoteConfig.minimumMessageTokensToInit
        : DEFAULT_SESSION_MEMORY_CONFIG.minimumMessageTokensToInit,
    minimumTokensBetweenUpdate:
      remoteConfig.minimumTokensBetweenUpdate &&
      remoteConfig.minimumTokensBetweenUpdate > 0
        ? remoteConfig.minimumTokensBetweenUpdate
        : DEFAULT_SESSION_MEMORY_CONFIG.minimumTokensBetweenUpdate,
    toolCallsBetweenUpdates:
      remoteConfig.toolCallsBetweenUpdates &&
      remoteConfig.toolCallsBetweenUpdates > 0
        ? remoteConfig.toolCallsBetweenUpdates
        : DEFAULT_SESSION_MEMORY_CONFIG.toolCallsBetweenUpdates,
  }
  setSessionMemoryConfig(config)
})

/**
 * 会话内存的后采样钩子，负责提取和更新会话笔记
 */
// 跟踪本次会话是否已记录门控检查失败（避免日志泛滥）
let hasLoggedGateFailure = false

const extractSessionMemory = sequential(async function (
  context: REPLHookContext,
): Promise<void> {
  const { messages, toolUseContext, querySource } = context

  // 仅在主 REPL 线程上运行会话内存
  if (querySource !== 'repl_main_thread') {
    // 不记录此日志 - 对于子代理、队友等是预期行为
    return
  }

  // 穷鬼模式：跳过以减少令牌消耗
  if (feature('POOR')) {
    const { isPoorModeActive } = await import('../../commands/poor/poorMode.js')
    if (isPoorModeActive()) return
  }

  // 当钩子运行时延迟检查门控（缓存，非阻塞）
  if (!isSessionMemoryGateEnabled()) {
    // 每个会话记录一次门控失败（仅限 ant 内部）
    if (process.env.USER_TYPE === 'ant' && !hasLoggedGateFailure) {
      hasLoggedGateFailure = true
      logEvent('tengu_session_memory_gate_disabled', {})
    }
    return
  }

  // 从远程初始化配置（延迟，仅一次）
  initSessionMemoryConfigIfNeeded()

  if (!shouldExtractMemory(messages)) {
    return
  }

  markExtractionStarted()

  // 创建隔离的上下文用于设置，避免污染父级缓存
  const setupContext = createSubagentContext(toolUseContext)

  // 使用隔离的上下文设置文件系统并读取当前状态
  const { memoryPath, currentMemory } =
    await setupSessionMemoryFile(setupContext)

  // 创建提取消息
  const userPrompt = await buildSessionMemoryUpdatePrompt(
    currentMemory,
    memoryPath,
  )

  // 使用 runForkedAgent 运行会话内存提取，以利用提示缓存
  // runForkedAgent 创建隔离的上下文，防止变异父级状态
  // 传递 setupContext.readFileState，以便派生子代理可以编辑内存文件
  await runForkedAgent({
    promptMessages: [createUserMessage({ content: userPrompt })],
    cacheSafeParams: createCacheSafeParams(context),
    canUseTool: createMemoryFileCanUseTool(memoryPath),
    querySource: 'session_memory',
    forkLabel: 'session_memory',
    overrides: { readFileState: setupContext.readFileState },
  })

  // 记录提取事件以跟踪频率
  // 使用对话中最后一条消息的令牌使用情况
  const lastMessage = messages[messages.length - 1]
  const usage = lastMessage ? getTokenUsage(lastMessage) : undefined
  const config = getSessionMemoryConfig()
  logEvent('tengu_session_memory_extraction', {
    input_tokens: usage?.input_tokens,
    output_tokens: usage?.output_tokens,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? undefined,
    cache_creation_input_tokens:
      usage?.cache_creation_input_tokens ?? undefined,
    config_min_message_tokens_to_init: config.minimumMessageTokensToInit,
    config_min_tokens_between_update: config.minimumTokensBetweenUpdate,
    config_tool_calls_between_updates: config.toolCallsBetweenUpdates,
  })

  // 记录提取时的上下文大小，用于跟踪 minimumTokensBetweenUpdate
  recordExtractionTokenCount(tokenCountWithEstimation(messages))

  // 成功完成后更新 lastSummarizedMessageId
  updateLastSummarizedMessageIdIfSafe(messages)

  markExtractionCompleted()
})

/**
 * 通过注册后采样钩子来初始化会话内存。
 * 此函数是同步的，以避免启动期间的竞态条件。
 * 门控检查和配置加载会在钩子运行时延迟执行。
 */
export function initSessionMemory(): void {
  if (getIsRemoteMode()) return
  // 会话内存用于压缩，因此需要尊重自动压缩设置
  const autoCompactEnabled = isAutoCompactEnabled()

  // 记录初始化状态（仅限 ant 内部，避免外部日志中的噪音）
  if (process.env.USER_TYPE === 'ant') {
    logEvent('tengu_session_memory_init', {
      auto_compact_enabled: autoCompactEnabled,
    })
  }

  if (!autoCompactEnabled) {
    return
  }

  // 无条件注册钩子 - 门控检查在钩子运行时延迟进行
  registerPostSamplingHook(extractSessionMemory)
}

export type ManualExtractionResult = {
  success: boolean
  memoryPath?: string
  error?: string
}

/**
 * 手动触发会话内存提取，绕过阈值检查。
 * 由 /summary 命令使用。
 */
export async function manuallyExtractSessionMemory(
  messages: Message[],
  toolUseContext: ToolUseContext,
): Promise<ManualExtractionResult> {
  if (messages.length === 0) {
    return { success: false, error: '没有要总结的消息' }
  }
  markExtractionStarted()

  try {
    // 创建隔离的上下文用于设置，避免污染父级缓存
    const setupContext = createSubagentContext(toolUseContext)

    // 使用隔离的上下文设置文件系统并读取当前状态
    const { memoryPath, currentMemory } =
      await setupSessionMemoryFile(setupContext)

    // 创建提取消息
    const userPrompt = await buildSessionMemoryUpdatePrompt(
      currentMemory,
      memoryPath,
    )

    // 获取系统提示以用于缓存安全的参数
    const { tools, mainLoopModel } = toolUseContext.options
    const [rawSystemPrompt, userContext, systemContext] = await Promise.all([
      getSystemPrompt(tools, mainLoopModel),
      getUserContext(),
      getSystemContext(),
    ])
    const systemPrompt = asSystemPrompt(rawSystemPrompt)

    // 使用 runForkedAgent 运行会话内存提取
    await runForkedAgent({
      promptMessages: [createUserMessage({ content: userPrompt })],
      cacheSafeParams: {
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext: setupContext,
        forkContextMessages: messages,
      },
      canUseTool: createMemoryFileCanUseTool(memoryPath),
      querySource: 'session_memory',
      forkLabel: 'session_memory_manual',
      overrides: { readFileState: setupContext.readFileState },
    })

    // 记录手动提取事件
    logEvent('tengu_session_memory_manual_extraction', {})

    // 记录提取时的上下文大小，用于跟踪 minimumTokensBetweenUpdate
    recordExtractionTokenCount(tokenCountWithEstimation(messages))

    // 成功完成后更新 lastSummarizedMessageId
    updateLastSummarizedMessageIdIfSafe(messages)

    return { success: true, memoryPath }
  } catch (error) {
    return {
      success: false,
      error: errorMessage(error),
    }
  } finally {
    markExtractionCompleted()
  }
}

// 辅助函数

/**
 * 创建一个 canUseTool 函数，该函数仅允许对确切的内存文件进行编辑操作。
 */
export function createMemoryFileCanUseTool(memoryPath: string): CanUseToolFn {
  return async (tool: Tool, input: unknown) => {
    if (
      tool.name === FILE_EDIT_TOOL_NAME &&
      typeof input === 'object' &&
      input !== null &&
      'file_path' in input
    ) {
      const filePath = input.file_path
      if (typeof filePath === 'string' && filePath === memoryPath) {
        return { behavior: 'allow' as const, updatedInput: input }
      }
    }
    return {
      behavior: 'deny' as const,
      message: `只允许在 ${memoryPath} 上使用 ${FILE_EDIT_TOOL_NAME}`,
      decisionReason: {
        type: 'other' as const,
        reason: `只允许在 ${memoryPath} 上使用 ${FILE_EDIT_TOOL_NAME}`,
      },
    }
  }
}

/**
 * 成功提取后更新 lastSummarizedMessageId。
 * 仅当最后一条消息没有工具调用时才设置（避免遗留孤立的 tool_results）。
 */
function updateLastSummarizedMessageIdIfSafe(messages: Message[]): void {
  if (!hasToolCallsInLastAssistantTurn(messages)) {
    const lastMessage = messages[messages.length - 1]
    if (lastMessage?.uuid) {
      setLastSummarizedMessageId(lastMessage.uuid)
    }
  }
}