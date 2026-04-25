import type { AnyValueMap, Logger, logs } from '@opentelemetry/api-logs'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from '@opentelemetry/sdk-logs'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions'
import { randomUUID } from 'crypto'
import { isEqual } from 'lodash-es'
import { getOrCreateUserID } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { getPlatform, getWslVersion } from '../../utils/platform.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { profileCheckpoint } from '../../utils/startupProfiler.js'
import { getCoreUserData } from '../../utils/user.js'
import { isAnalyticsDisabled } from './config.js'
import { FirstPartyEventLoggingExporter } from './firstPartyEventLoggingExporter.js'
import type { GrowthBookUserAttributes } from './growthbook.js'
import { getDynamicConfig_CACHED_MAY_BE_STALE } from './growthbook.js'
import { getEventMetadata } from './metadata.js'
import { isSinkKilled } from './sinkKillswitch.js'

/**
 * 对各种事件类型的采样配置。
 * 每个事件名称映射到一个包含 sample_rate（0-1）的对象。
 * 不在配置中的事件以 100% 的速率记录。
 */
export type EventSamplingConfig = {
  [eventName: string]: {
    sample_rate: number
  }
}

const EVENT_SAMPLING_CONFIG_NAME = 'tengu_event_sampling_config'
/**
 * 从 GrowthBook 获取事件采样配置。
 * 如果可用则使用缓存值，在后台更新缓存。
 */
export function getEventSamplingConfig(): EventSamplingConfig {
  return getDynamicConfig_CACHED_MAY_BE_STALE<EventSamplingConfig>(
    EVENT_SAMPLING_CONFIG_NAME,
    {},
  )
}

/**
 * 根据事件采样率确定是否应对事件进行采样。
 * 如果事件应该被采样，则返回采样率；如果应该被丢弃，则返回 null。
 *
 * @param eventName - 要检查的事件名称
 * @returns 如果应记录事件则返回 sample_rate，如果应丢弃则返回 null
 */
export function shouldSampleEvent(eventName: string): number | null {
  const config = getEventSamplingConfig()
  const eventConfig = config[eventName]

  // 如果该事件没有配置，则按 100% 速率记录（不采样）
  if (!eventConfig) {
    return null
  }

  const sampleRate = eventConfig.sample_rate

  // 验证采样率在有效范围内
  if (typeof sampleRate !== 'number' || sampleRate < 0 || sampleRate > 1) {
    return null
  }

  // 采样率为 1 表示记录所有事件（无需添加元数据）
  if (sampleRate >= 1) {
    return null
  }

  // 采样率为 0 表示丢弃所有事件
  if (sampleRate <= 0) {
    return 0
  }

  // 随机决定是否对此事件进行采样
  return Math.random() < sampleRate ? sampleRate : 0
}

const BATCH_CONFIG_NAME = 'tengu_1p_event_batch_config'
type BatchConfig = {
  scheduledDelayMillis?: number
  maxExportBatchSize?: number
  maxQueueSize?: number
  skipAuth?: boolean
  maxAttempts?: number
  path?: string
  baseUrl?: string
}
function getBatchConfig(): BatchConfig {
  return getDynamicConfig_CACHED_MAY_BE_STALE<BatchConfig>(
    BATCH_CONFIG_NAME,
    {},
  )
}

// 事件日志记录的模块级状态（不全局暴露）
let firstPartyEventLogger: ReturnType<typeof logs.getLogger> | null = null
let firstPartyEventLoggerProvider: LoggerProvider | null = null
// 用于构造提供者的上一个批处理配置 — 由 reinitialize1PEventLoggingIfConfigChanged 使用，
// 以判断当 GrowthBook 刷新时是否需要重建。
let lastBatchConfig: BatchConfig | null = null

/**
 * 刷新并关闭第一方事件日志记录器。
 * 这应该在进程退出前的最后一步调用，以确保所有事件（包括来自 API 响应的延迟事件）都被导出。
 */
export async function shutdown1PEventLogging(): Promise<void> {
  if (!firstPartyEventLoggerProvider) {
    return
  }
  try {
    await firstPartyEventLoggerProvider.shutdown()
    if (process.env.USER_TYPE === 'ant') {
      logForDebugging('第一方事件日志记录：最终关闭完成')
    }
  } catch {
    // 忽略关闭错误
  }
}

/**
 * 检查第一方事件日志记录是否启用。
 * 遵循与其他分析接收器相同的退出机制：
 * - 测试环境
 * - 第三方云提供商（Bedrock/Vertex）
 * - 全局遥测退出
 * - 非必要流量禁用
 *
 * 注意：与 BigQuery 指标不同，事件日志记录不通过 API 检查组织级别的指标退出。
 * 它遵循与 Statsig 事件日志记录相同的模式。
 */
export function is1PEventLoggingEnabled(): boolean {
  // 遵循标准的分析退出机制
  return !isAnalyticsDisabled()
}

/**
 * 记录第一方事件用于内部分析（异步版本）。
 * 事件将被批处理并导出到 /api/event_logging/batch
 *
 * 此函数在记录时使用核心元数据（模型、会话、环境上下文等）丰富事件，
 * 类似于 logEventToStatsig。
 *
 * @param eventName - 事件名称（例如 'tengu_api_query'）
 * @param metadata - 事件的额外元数据（故意不使用字符串，以避免意外记录代码/文件路径）
 */
async function logEventTo1PAsync(
  firstPartyEventLogger: Logger,
  eventName: string,
  metadata: Record<string, number | boolean | undefined> = {},
): Promise<void> {
  try {
    // 在记录时使用核心元数据丰富事件（类似于 Statsig 的模式）
    const coreMetadata = await getEventMetadata({
      model: metadata.model,
      betas: metadata.betas,
    })

    // 构建属性 - OTel 通过 AnyValueMap 原生支持嵌套对象
    // 通过 unknown 进行转换，因为我们的嵌套对象在结构上是兼容的
    // 但由于缺少索引签名，TypeScript 无法识别
    const attributes = {
      event_name: eventName,
      event_id: randomUUID(),
      // 直接传递对象 - 无需 JSON 序列化
      core_metadata: coreMetadata,
      user_metadata: getCoreUserData(true),
      event_metadata: metadata,
    } as unknown as AnyValueMap

    // 如果可用，添加 user_id
    const userId = getOrCreateUserID()
    if (userId) {
      attributes.user_id = userId
    }

    // 启用调试模式时的调试日志记录
    if (process.env.USER_TYPE === 'ant') {
      logForDebugging(
        `[仅限 ANT] 第一方事件：${eventName} ${jsonStringify(metadata, null, 0)}`,
      )
    }

    // 发出日志记录
    firstPartyEventLogger.emit({
      body: eventName,
      attributes,
    })
  } catch (e) {
    if (process.env.NODE_ENV === 'development') {
      throw e
    }
    if (process.env.USER_TYPE === 'ant') {
      logError(e as Error)
    }
    // 静默处理
  }
}

/**
 * 记录第一方事件用于内部分析。
 * 事件将被批处理并导出到 /api/event_logging/batch
 *
 * @param eventName - 事件名称（例如 'tengu_api_query'）
 * @param metadata - 事件的额外元数据（故意不使用字符串，以避免意外记录代码/文件路径）
 */
export function logEventTo1P(
  eventName: string,
  metadata: Record<string, number | boolean | undefined> = {},
): void {
  if (!is1PEventLoggingEnabled()) {
    return
  }

  if (!firstPartyEventLogger || isSinkKilled('firstParty')) {
    return
  }

  // 即发即弃 — 不阻塞等待元数据丰富
  void logEventTo1PAsync(firstPartyEventLogger, eventName, metadata)
}

/**
 * 用于日志记录的 GrowthBook 实验事件数据
 */
export type GrowthBookExperimentData = {
  experimentId: string
  variationId: number
  userAttributes?: GrowthBookUserAttributes
  experimentMetadata?: Record<string, unknown>
}

// api.anthropic.com 只服务于 "production" GrowthBook 环境
// （参见 starling/starling/cli/cli.py 中的 DEFAULT_ENVIRONMENTS）。
// 暂存和开发环境不会导出到生产 API。
function getEnvironmentForGrowthBook(): string {
  return 'production'
}

/**
 * 记录 GrowthBook 实验分配事件到第一方事件系统。
 * 事件将被批处理并导出到 /api/event_logging/batch
 *
 * @param data - GrowthBook 实验分配数据
 */
export function logGrowthBookExperimentTo1P(
  data: GrowthBookExperimentData,
): void {
  if (!is1PEventLoggingEnabled()) {
    return
  }

  if (!firstPartyEventLogger || isSinkKilled('firstParty')) {
    return
  }

  const userId = getOrCreateUserID()
  const { accountUuid, organizationUuid } = getCoreUserData(true)

  // 为 GrowthbookExperimentEvent 构建属性
  const attributes = {
    event_type: 'GrowthbookExperimentEvent',
    event_id: randomUUID(),
    experiment_id: data.experimentId,
    variation_id: data.variationId,
    ...(userId && { device_id: userId }),
    ...(accountUuid && { account_uuid: accountUuid }),
    ...(organizationUuid && { organization_uuid: organizationUuid }),
    ...(data.userAttributes && {
      session_id: data.userAttributes.sessionId,
      user_attributes: jsonStringify(data.userAttributes),
    }),
    ...(data.experimentMetadata && {
      experiment_metadata: jsonStringify(data.experimentMetadata),
    }),
    environment: getEnvironmentForGrowthBook(),
  }

  if (process.env.USER_TYPE === 'ant') {
    logForDebugging(
      `[仅限 ANT] 第一方 GrowthBook 实验：${data.experimentId} 变体=${data.variationId}`,
    )
  }

  firstPartyEventLogger.emit({
    body: 'growthbook_experiment',
    attributes,
  })
}

const DEFAULT_LOGS_EXPORT_INTERVAL_MS = 10000
const DEFAULT_MAX_EXPORT_BATCH_SIZE = 200
const DEFAULT_MAX_QUEUE_SIZE = 8192

/**
 * 初始化第一方事件日志记录基础设施。
 * 这会为内部事件日志记录创建一个独立的 LoggerProvider，
 * 独立于客户的 OTLP 遥测。
 *
 * 它使用自己最小的资源配置，仅包含内部分析所需的属性
 * （服务名称、版本、平台信息）。
 */
export function initialize1PEventLogging(): void {
  profileCheckpoint('1p_event_logging_start')
  const enabled = is1PEventLoggingEnabled()

  if (!enabled) {
    if (process.env.USER_TYPE === 'ant') {
      logForDebugging('第一方事件日志记录未启用')
    }
    return
  }

  // 从 GrowthBook 动态配置中获取批处理处理器配置
  // 如果可用则使用缓存值，在后台刷新
  const batchConfig = getBatchConfig()
  lastBatchConfig = batchConfig
  profileCheckpoint('1p_event_after_growthbook_config')

  const scheduledDelayMillis =
    batchConfig.scheduledDelayMillis ||
    parseInt(
      process.env.OTEL_LOGS_EXPORT_INTERVAL ||
        DEFAULT_LOGS_EXPORT_INTERVAL_MS.toString(),
      10,
    )

  const maxExportBatchSize =
    batchConfig.maxExportBatchSize || DEFAULT_MAX_EXPORT_BATCH_SIZE

  const maxQueueSize = batchConfig.maxQueueSize || DEFAULT_MAX_QUEUE_SIZE

  // 为第一方事件日志记录构建我们自己的资源，使用最小属性
  const platform = getPlatform()
  const attributes: Record<string, string> = {
    [ATTR_SERVICE_NAME]: 'claude-code',
    [ATTR_SERVICE_VERSION]: MACRO.VERSION,
  }

  // 如果在 WSL 上运行，添加 WSL 特定属性
  if (platform === 'wsl') {
    const wslVersion = getWslVersion()
    if (wslVersion) {
      attributes['wsl.version'] = wslVersion
    }
  }

  const resource = resourceFromAttributes(attributes)

  // 创建一个带有 EventLoggingExporter 的新 LoggerProvider
  // 注意：这保持与客户遥测日志分离，以确保内部事件不会泄漏到客户端点，反之亦然。
  // 我们不会将其全局注册 — 它仅用于内部事件日志记录。
  const eventLoggingExporter = new FirstPartyEventLoggingExporter({
    maxBatchSize: maxExportBatchSize,
    skipAuth: batchConfig.skipAuth,
    maxAttempts: batchConfig.maxAttempts,
    path: batchConfig.path,
    baseUrl: batchConfig.baseUrl,
    isKilled: () => isSinkKilled('firstParty'),
  })
  firstPartyEventLoggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor(eventLoggingExporter, {
        scheduledDelayMillis,
        maxExportBatchSize,
        maxQueueSize,
      }),
    ],
  })

  // 从我们的内部提供者初始化事件日志记录器（而不是从全局 API）
  // 重要提示：我们必须从本地提供者获取日志记录器，而不是 logs.getLogger()
  // 因为 logs.getLogger() 返回的是来自全局提供者的日志记录器，该提供者是分离的，用于客户遥测。
  firstPartyEventLogger = firstPartyEventLoggerProvider.getLogger(
    'com.anthropic.claude_code.events',
    MACRO.VERSION,
  )
}

/**
 * 如果批处理配置发生变化，重建第一方事件日志记录管道。
 * 使用 onGrowthBookRefresh 注册此函数，以便长时间运行的会话能够获取批处理大小、延迟、端点等更改。
 *
 * 事件丢失安全性：
 * 1. 首先将日志记录器置为 null — 并发的 logEventTo1P() 调用会命中 !firstPartyEventLogger 守卫并在交换窗口期间退出。
 *    这会丢弃少量事件，但可以防止向正在排空的提供者发送事件。
 * 2. forceFlush() 将旧的 BatchLogRecordProcessor 缓冲区排空到导出器。导出失败会写入磁盘，路径由模块级的 BATCH_UUID + sessionId 决定 — 在重新初始化期间保持不变
 *    — 因此新导出器的磁盘后备重试会拾取它们。
 * 3. 切换到新的提供者/日志记录器；旧的提供者关闭在后台运行（缓冲区已排空，仅进行清理）。
 */
export async function reinitialize1PEventLoggingIfConfigChanged(): Promise<void> {
  if (!is1PEventLoggingEnabled() || !firstPartyEventLoggerProvider) {
    return
  }

  const newConfig = getBatchConfig()

  if (isEqual(newConfig, lastBatchConfig)) {
    return
  }

  if (process.env.USER_TYPE === 'ant') {
    logForDebugging(
      `第一方事件日志记录：${BATCH_CONFIG_NAME} 已更改，正在重新初始化`,
    )
  }

  const oldProvider = firstPartyEventLoggerProvider
  const oldLogger = firstPartyEventLogger
  firstPartyEventLogger = null

  try {
    await oldProvider.forceFlush()
  } catch {
    // 导出失败已写入磁盘；新的导出器将重试它们。
  }

  firstPartyEventLoggerProvider = null
  try {
    initialize1PEventLogging()
  } catch (e) {
    // 恢复状态，以便下次 GrowthBook 刷新时可以重试。oldProvider 仅被 forceFlush()，
    // 并未关闭 — 它仍然可用。没有这个恢复，两者都保持为 null，顶部的 !firstPartyEventLoggerProvider 门控将使恢复不可能。
    firstPartyEventLoggerProvider = oldProvider
    firstPartyEventLogger = oldLogger
    logError(e)
    return
  }

  void oldProvider.shutdown().catch(() => {})
}