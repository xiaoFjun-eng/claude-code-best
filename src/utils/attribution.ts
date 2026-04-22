import { feature } from 'bun:bundle'
import { stat } from 'fs/promises'
import { getClientType } from '../bootstrap/state.js'
import {
  getRemoteSessionUrl,
  isRemoteSessionLocal,
  PRODUCT_URL,
} from '../constants/product.js'
import { TERMINAL_OUTPUT_TAGS } from '../constants/xml.js'
import type { AppState } from '../state/AppState.js'
import { FILE_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GrepTool/prompt.js'
import type { Entry } from '../types/logs.js'
import {
  type AttributionData,
  calculateCommitAttribution,
  isInternalModelRepo,
  isInternalModelRepoCached,
  sanitizeModelName,
} from './commitAttribution.js'
import { logForDebugging } from './debug.js'
import { parseJSONL } from './json.js'
import { logError } from './log.js'
import {
  getCanonicalName,
  getMainLoopModel,
  getPublicModelDisplayName,
  getPublicModelName,
} from './model/model.js'
import { isMemoryFileAccess } from './sessionFileAccessHooks.js'
import { getTranscriptPath } from './sessionStorage.js'
import { readTranscriptForLoad } from './sessionStoragePortable.js'
import { getInitialSettings } from './settings/settings.js'
import { isUndercover } from './undercover.js'

export type AttributionTexts = {
  commit: string
  pr: string
}

/**
 * 根据用户设置返回提交和 PR 的归因文本。
 * 处理：
 * - 通过 getPublicModelName() 获取动态模型名称
 * - 自定义归因设置（settings.attribution.commit/pr）
 * - 与已弃用的 includeCoAuthoredBy 设置保持向后兼容
 * - 远程模式：返回会话 URL 作为归因
 */
export function getAttributionTexts(): AttributionTexts {
  if (process.env.USER_TYPE === 'ant' && isUndercover()) {
    return { commit: '', pr: '' }
  }

  if (getClientType() === 'remote') {
    const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
    if (remoteSessionId) {
      const ingressUrl = process.env.SESSION_INGRESS_URL
      // 跳过本地开发环境 —— URL 不会持久化
      if (!isRemoteSessionLocal(remoteSessionId, ingressUrl)) {
        const sessionUrl = getRemoteSessionUrl(remoteSessionId, ingressUrl)
        return { commit: sessionUrl, pr: sessionUrl }
      }
    }
    return { commit: '', pr: '' }
  }

  // @[MODEL LAUNCH]: 更新下面的硬编码回退模型名称（防止代号泄露）。
  // 对于内部仓库，使用真实的模型名称。对于外部仓库，
  // 对于无法识别的模型回退到 "Claude Opus 4.6"，以避免泄露代号。
  const model = getMainLoopModel()
  const isKnownPublicModel = getPublicModelDisplayName(model) !== null
  const modelName =
    isInternalModelRepoCached() || isKnownPublicModel
      ? getPublicModelName(model)
      : 'Claude Opus 4.7'
  const defaultAttribution = `🤖 由 [Claude Code](${PRODUCT_URL}) 生成`
  const defaultCommit = `Co-Authored-By: ${modelName} <noreply@anthropic.com>`

  const settings = getInitialSettings()

  // 新的归因设置优先于已弃用的 includeCoAuthoredBy
  if (settings.attribution) {
    return {
      commit: settings.attribution.commit ?? defaultCommit,
      pr: settings.attribution.pr ?? defaultAttribution,
    }
  }

  // 向后兼容：已弃用的 includeCoAuthoredBy 设置
  if (settings.includeCoAuthoredBy === false) {
    return { commit: '', pr: '' }
  }

  return { commit: defaultCommit, pr: defaultAttribution }
}

/**
 * 检查消息内容字符串是否为终端输出而不是用户提示。
 * 终端输出包括 bash 输入/输出标签以及关于本地命令的提示信息。
 */
function isTerminalOutput(content: string): boolean {
  for (const tag of TERMINAL_OUTPUT_TAGS) {
    if (content.includes(`<${tag}>`)) {
      return true
    }
  }
  return false
}

/**
 * 统计非侧链消息列表中具有可见文本内容的用户消息数量。
 * 排除 tool_result 块、终端输出和空消息。
 *
 * 调用方应传入已过滤掉侧链消息的消息列表。
 */
export function countUserPromptsInMessages(
  messages: ReadonlyArray<{ type: string; message?: { content?: unknown } }>,
): number {
  let count = 0

  for (const message of messages) {
    if (message.type !== 'user') {
      continue
    }

    const content = message.message?.content
    if (!content) {
      continue
    }

    let hasUserText = false

    if (typeof content === 'string') {
      if (isTerminalOutput(content)) {
        continue
      }
      hasUserText = content.trim().length > 0
    } else if (Array.isArray(content)) {
      hasUserText = content.some(block => {
        if (!block || typeof block !== 'object' || !('type' in block)) {
          return false
        }
        return (
          (block.type === 'text' &&
            typeof block.text === 'string' &&
            !isTerminalOutput(block.text)) ||
          block.type === 'image' ||
          block.type === 'document'
        )
      })
    }

    if (hasUserText) {
      count++
    }
  }

  return count
}

/**
 * 统计对话记录条目中的非侧链用户消息数量。
 * 用于计算“引导”次数（用户提示数 - 1）。
 *
 * 统计包含用户实际输入文本的用户消息，
 * 排除 tool_result 块、侧链消息和终端输出。
 */
function countUserPromptsFromEntries(entries: ReadonlyArray<Entry>): number {
  const nonSidechain = entries.filter(
    entry =>
      entry.type === 'user' && !('isSidechain' in entry && entry.isSidechain),
  )
  return countUserPromptsInMessages(nonSidechain)
}

/**
 * 从提供的 AppState 的归因状态中获取完整的归因数据。
 * 使用归因状态中所有跟踪的文件（不仅仅是暂存文件），
 * 因为对于 PR 归因，文件可能尚未暂存。
 * 如果没有可用的归因数据，则返回 null。
 */
async function getPRAttributionData(
  appState: AppState,
): Promise<AttributionData | null> {
  const attribution = appState.attribution

  if (!attribution) {
    return null
  }

  // 处理 Map 和普通对象（以防序列化）
  const fileStates = attribution.fileStates
  const isMap = fileStates instanceof Map
  const trackedFiles = isMap
    ? Array.from(fileStates.keys())
    : Object.keys(fileStates)

  if (trackedFiles.length === 0) {
    return null
  }

  try {
    return await calculateCommitAttribution([attribution], trackedFiles)
  } catch (error) {
    logError(error as Error)
    return null
  }
}

const MEMORY_ACCESS_TOOL_NAMES = new Set([
  FILE_READ_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])

/**
 * 统计对话记录条目中的内存文件访问次数。
 * 使用与 PostToolUse 会话文件访问钩子相同的检测条件。
 */
function countMemoryFileAccessFromEntries(
  entries: ReadonlyArray<Entry>,
): number {
  let count = 0
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        block.type !== 'tool_use' ||
        !MEMORY_ACCESS_TOOL_NAMES.has(block.name)
      )
        continue
      if (isMemoryFileAccess(block.name, block.input)) count++
    }
  }
  return count
}

/**
 * 读取会话对话记录条目并计算提示计数和内存访问计数。
 * 压缩前的条目会被跳过 —— N-shot 计数和内存访问计数应仅反映当前对话弧，
 * 而不是压缩边界之前累积的提示。
 */
async function getTranscriptStats(): Promise<{
  promptCount: number
  memoryAccessCount: number
}> {
  try {
    const filePath = getTranscriptPath()
    const fileSize = (await stat(filePath)).size
    // 融合读取器：在 fd 级别跳过属性快照行（按字节计算，在长会话中占 84%），
    // 因此峰值随输出规模变化，而不是文件大小。文件末尾存留的一个属性快照对计数函数无影响
    // （两者都不检查 type === 'attribution-snapshot'）。当最后一个边界有 preservedSegment 时，
    // 读取器返回完整内容（无截断）；下面的 findLastIndex 仍然切片到边界之后。
    const scan = await readTranscriptForLoad(filePath, fileSize)
    const buf = scan.postBoundaryBuf
    const entries = parseJSONL<Entry>(buf)
    const lastBoundaryIdx = entries.findLastIndex(
      e =>
        e.type === 'system' &&
        'subtype' in e &&
        e.subtype === 'compact_boundary',
    )
    const postBoundary =
      lastBoundaryIdx >= 0 ? entries.slice(lastBoundaryIdx + 1) : entries
    return {
      promptCount: countUserPromptsFromEntries(postBoundary),
      memoryAccessCount: countMemoryFileAccessFromEntries(postBoundary),
    }
  } catch {
    return { promptCount: 0, memoryAccessCount: 0 }
  }
}

/**
 * 获取增强的 PR 归因文本，包含 Claude 贡献统计信息。
 *
 * 格式："🤖 由 Claude Code 生成 (93% 3-shotted by claude-opus-4-5)"
 *
 * 规则：
 * - 显示来自提交归因的 Claude 贡献百分比
 * - 显示 N-shotted，其中 N 是提示计数（1-shotted、2-shotted 等）
 * - 显示短模型名称（例如 claude-opus-4-5）
 * - 如果无法计算统计信息，则返回默认归因
 *
 * @param getAppState 获取当前 AppState 的函数（来自命令上下文）
 */
export async function getEnhancedPRAttribution(
  getAppState: () => AppState,
): Promise<string> {
  if (process.env.USER_TYPE === 'ant' && isUndercover()) {
    return ''
  }

  if (getClientType() === 'remote') {
    const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
    if (remoteSessionId) {
      const ingressUrl = process.env.SESSION_INGRESS_URL
      // 跳过本地开发环境 —— URL 不会持久化
      if (!isRemoteSessionLocal(remoteSessionId, ingressUrl)) {
        return getRemoteSessionUrl(remoteSessionId, ingressUrl)
      }
    }
    return ''
  }

  const settings = getInitialSettings()

  // 如果用户有自定义的 PR 归因，则使用它
  if (settings.attribution?.pr) {
    return settings.attribution.pr
  }

  // 向后兼容：已弃用的 includeCoAuthoredBy 设置
  if (settings.includeCoAuthoredBy === false) {
    return ''
  }

  const defaultAttribution = `🤖 由 [Claude Code](${PRODUCT_URL}) 生成`

  // 首先获取 AppState
  const appState = getAppState()

  logForDebugging(
    `PR 归因: appState.attribution 存在: ${!!appState.attribution}`,
  )
  if (appState.attribution) {
    const fileStates = appState.attribution.fileStates
    const isMap = fileStates instanceof Map
    const fileCount = isMap ? fileStates.size : Object.keys(fileStates).length
    logForDebugging(`PR 归因: fileStates 计数: ${fileCount}`)
  }

  // 获取归因统计信息（对话记录仅读取一次，用于提示计数和内存访问）
  const [attributionData, { promptCount, memoryAccessCount }, isInternal] =
    await Promise.all([
      getPRAttributionData(appState),
      getTranscriptStats(),
      isInternalModelRepo(),
    ])

  const claudePercent = attributionData?.summary.claudePercent ?? 0

  logForDebugging(
    `PR 归因: claudePercent: ${claudePercent}, promptCount: ${promptCount}, memoryAccessCount: ${memoryAccessCount}`,
  )

  // 获取短模型名称，对于非内部仓库进行清理
  const rawModelName = getCanonicalName(getMainLoopModel())
  const shortModelName = isInternal
    ? rawModelName
    : sanitizeModelName(rawModelName)

  // 如果没有归因数据，返回默认值
  if (claudePercent === 0 && promptCount === 0 && memoryAccessCount === 0) {
    logForDebugging('PR 归因: 返回默认值（无数据）')
    return defaultAttribution
  }

  // 构建增强归因： "🤖 由 Claude Code 生成 (93% 3-shotted by claude-opus-4-5, 2 memories recalled)"
  const memSuffix =
    memoryAccessCount > 0
      ? `, 调用了 ${memoryAccessCount} ${memoryAccessCount === 1 ? '条记忆' : '条记忆'}`
      : ''
  const summary = `🤖 由 [Claude Code](${PRODUCT_URL}) 生成 (${claudePercent}% ${promptCount}-shotted by ${shortModelName}${memSuffix})`

  // 为 squash 合并存活追加尾部行。仅适用于允许列表中的仓库
  // （INTERNAL_MODEL_REPOS）并且仅在启用了 COMMIT_ATTRIBUTION 的构建中 ——
  // attributionTrailer.ts 包含排除的字符串，因此通过 feature() 后面的动态导入访问它。
  // 当仓库配置为 squash_merge_commit_message=PR_BODY（cli, apps）时，
  // PR 正文将逐字成为 squash 提交正文 —— 末尾的尾部行成为 squash 提交上正确的 git 尾部。
  if (feature('COMMIT_ATTRIBUTION') && isInternal && attributionData) {
    const { buildPRTrailers } = await import('./attributionTrailer.js')
    const trailers = buildPRTrailers(attributionData, appState.attribution)
    const result = `${summary}\n\n${trailers.join('\n')}`
    logForDebugging(`PR 归因: 返回带尾部的结果: ${result}`)
    return result
  }

  logForDebugging(`PR 归因: 返回摘要: ${summary}`)
  return summary
}