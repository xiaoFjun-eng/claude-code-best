/**
 * 会话内存工具函数，可以在不产生循环依赖的情况下导入。
 * 这些函数与主 sessionMemory.ts 分离，以避免导入 runAgent。
 */

import { isFsInaccessible } from '../../utils/errors.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { getSessionMemoryPath } from '../../utils/permissions/filesystem.js'
import { sleep } from '../../utils/sleep.js'
import { logEvent } from '../analytics/index.js'

const EXTRACTION_WAIT_TIMEOUT_MS = 15000
const EXTRACTION_STALE_THRESHOLD_MS = 60000 // 1 分钟

/**
 * 会话内存提取阈值的配置
 */
export type SessionMemoryConfig = {
  /** 初始化会话内存之前所需的最小上下文窗口令牌数。
   * 使用与自动压缩相同的令牌计数方式（输入 + 输出 + 缓存令牌），
   * 以确保两个功能的行为一致。 */
  minimumMessageTokensToInit: number
  /** 两次会话内存更新之间所需的最小上下文窗口增长量（以令牌计）。
   * 使用与自动压缩相同的令牌计数方式（tokenCountWithEstimation），
   * 以测量实际上下文增长量，而非累计的 API 使用量。 */
  minimumTokensBetweenUpdate: number
  /** 两次会话内存更新之间的工具调用次数 */
  toolCallsBetweenUpdates: number
}

// 默认配置值
export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  minimumMessageTokensToInit: 10000,
  minimumTokensBetweenUpdate: 5000,
  toolCallsBetweenUpdates: 3,
}

// 当前会话内存配置
let sessionMemoryConfig: SessionMemoryConfig = {
  ...DEFAULT_SESSION_MEMORY_CONFIG,
}

// 跟踪最后一条已总结消息的 ID（共享状态）
let lastSummarizedMessageId: string | undefined

// 跟踪提取状态及时间戳（由 sessionMemory.ts 设置）
let extractionStartedAt: number | undefined

// 跟踪上次内存提取时的上下文大小（用于 minimumTokensBetweenUpdate）
let tokensAtLastExtraction = 0

// 跟踪会话内存是否已初始化（已达到 minimumMessageTokensToInit）
let sessionMemoryInitialized = false

/**
 * 获取会话内存已更新到的消息 ID
 */
export function getLastSummarizedMessageId(): string | undefined {
  return lastSummarizedMessageId
}

/**
 * 设置最后一条已总结消息的 ID（由 sessionMemory.ts 调用）
 */
export function setLastSummarizedMessageId(
  messageId: string | undefined,
): void {
  lastSummarizedMessageId = messageId
}

/**
 * 标记提取已开始（由 sessionMemory.ts 调用）
 */
export function markExtractionStarted(): void {
  extractionStartedAt = Date.now()
}

/**
 * 标记提取已完成（由 sessionMemory.ts 调用）
 */
export function markExtractionCompleted(): void {
  extractionStartedAt = undefined
}

/**
 * 等待任何正在进行的会话内存提取完成（最长等待 15 秒）
 * 如果没有进行中的提取，或提取已过时（超过 1 分钟），则立即返回。
 */
export async function waitForSessionMemoryExtraction(): Promise<void> {
  const startTime = Date.now()
  while (extractionStartedAt) {
    const extractionAge = Date.now() - extractionStartedAt
    if (extractionAge > EXTRACTION_STALE_THRESHOLD_MS) {
      // 提取已过时，不再等待
      return
    }

    if (Date.now() - startTime > EXTRACTION_WAIT_TIMEOUT_MS) {
      // 超时，无论如何都继续
      return
    }

    await sleep(1000)
  }
}

/**
 * 获取当前会话内存的内容
 */
export async function getSessionMemoryContent(): Promise<string | null> {
  const fs = getFsImplementation()
  const memoryPath = getSessionMemoryPath()

  try {
    const content = await fs.readFile(memoryPath, { encoding: 'utf-8' })

    logEvent('tengu_session_memory_loaded', {
      content_length: content.length,
    })

    return content
  } catch (e: unknown) {
    if (isFsInaccessible(e)) return null
    throw e
  }
}

/**
 * 设置会话内存配置
 */
export function setSessionMemoryConfig(
  config: Partial<SessionMemoryConfig>,
): void {
  sessionMemoryConfig = {
    ...sessionMemoryConfig,
    ...config,
  }
}

/**
 * 获取当前会话内存配置
 */
export function getSessionMemoryConfig(): SessionMemoryConfig {
  return { ...sessionMemoryConfig }
}

/**
 * 记录提取时的上下文大小。
 * 用于测量上下文增长量，以判断是否达到 minimumTokensBetweenUpdate 阈值。
 */
export function recordExtractionTokenCount(currentTokenCount: number): void {
  tokensAtLastExtraction = currentTokenCount
}

/**
 * 检查会话内存是否已初始化（是否已达到 minimumTokensToInit 阈值）
 */
export function isSessionMemoryInitialized(): boolean {
  return sessionMemoryInitialized
}

/**
 * 将会话内存标记为已初始化
 */
export function markSessionMemoryInitialized(): void {
  sessionMemoryInitialized = true
}

/**
 * 检查是否已达到初始化会话内存的阈值。
 * 使用总上下文窗口令牌数（与自动压缩相同）以获得一致的行为。
 */
export function hasMetInitializationThreshold(
  currentTokenCount: number,
): boolean {
  return currentTokenCount >= sessionMemoryConfig.minimumMessageTokensToInit
}

/**
 * 检查是否已达到下一次更新的阈值。
 * 测量自上次提取以来的实际上下文窗口增长量
 * （与自动压缩和初始化阈值使用相同的指标）。
 */
export function hasMetUpdateThreshold(currentTokenCount: number): boolean {
  const tokensSinceLastExtraction = currentTokenCount - tokensAtLastExtraction
  return (
    tokensSinceLastExtraction >= sessionMemoryConfig.minimumTokensBetweenUpdate
  )
}

/**
 * 获取配置的两次更新之间的工具调用次数
 */
export function getToolCallsBetweenUpdates(): number {
  return sessionMemoryConfig.toolCallsBetweenUpdates
}

/**
 * 重置会话内存状态（用于测试）
 */
export function resetSessionMemoryState(): void {
  sessionMemoryConfig = { ...DEFAULT_SESSION_MEMORY_CONFIG }
  tokensAtLastExtraction = 0
  sessionMemoryInitialized = false
  lastSummarizedMessageId = undefined
  extractionStartedAt = undefined
}