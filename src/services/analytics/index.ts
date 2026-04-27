/**
 * 分析服务 - 事件日志记录公共 API
 *
 * 本模块作为 Claude CLI 中分析事件的主入口点。
 *
 * 设计说明：本模块没有依赖项，以避免循环导入。
 * 事件会被排队，直到应用初始化期间调用 attachAnalyticsSink()。
 * 该 sink 负责将事件路由到 Datadog 以及第一方事件日志记录。
 */

/**
 * 用于校验分析元数据不包含敏感数据的标记类型
 *
 * 此类型强制显式校验：被记录的字符串值不包含代码片段、文件路径或其他敏感信息。
 *
 * 用法：`myString as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never

/**
 * 标记类型，用于通过 `_PROTO_*` 负载键路由到带 PII 标记的 proto 列的值。
 * 目标 BQ 列具有特权访问控制，因此未脱敏的值是可接受的 —— 这与普通访问的后端不同。
 *
 * sink.ts 在分发给 Datadog 之前会剥离 `_PROTO_*` 键；只有第一方导出器（firstPartyEventLoggingExporter）会看到它们并将它们提升到顶级 proto 字段。
 * 一次 stripProtoFields 调用即可保护所有非第一方 sink —— 无需逐个 sink 过滤，避免遗漏。
 *
 * 用法：`rawName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED`
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = never

/**
 * 从要发送到通用访问存储的负载中剥离 `_PROTO_*` 键。
 * 用于：
 *   - sink.ts：在分发给 Datadog 之前（永远不会看到带 PII 标记的值）
 *   - firstPartyEventLoggingExporter：在将已知的 _PROTO_* 键提升为 proto 字段后，对 additional_metadata 进行防御性剥离 ——
 *     防止未来某个未被识别的 _PROTO_foo 悄然落入 BQ JSON blob 中。
 *
 * 当不存在 _PROTO_ 键时，返回未修改的输入（同一引用）。
 */
export function stripProtoFields<V>(
  metadata: Record<string, V>,
): Record<string, V> {
  let result: Record<string, V> | undefined
  for (const key in metadata) {
    if (key.startsWith('_PROTO_')) {
      if (result === undefined) {
        result = { ...metadata }
      }
      delete result[key]
    }
  }
  return result ?? metadata
}

// logEvent 元数据的内部类型 - 与 metadata.ts 中增强后的 EventMetadata 不同
type LogEventMetadata = { [key: string]: boolean | number | undefined }

type QueuedEvent = {
  eventName: string
  metadata: LogEventMetadata
  async: boolean
}

/**
 * 分析后端的 Sink 接口
 */
export type AnalyticsSink = {
  logEvent: (eventName: string, metadata: LogEventMetadata) => void
  logEventAsync: (
    eventName: string,
    metadata: LogEventMetadata,
  ) => Promise<void>
}

// 在 sink 附加之前记录的事件队列
const eventQueue: QueuedEvent[] = []

// Sink - 在应用启动期间初始化
let sink: AnalyticsSink | null = null

/**
 * 附加将接收所有事件的分析 sink。
 * 通过 queueMicrotask 异步清空排队的事件，以避免增加启动路径的延迟。
 *
 * 幂等性：如果已附加 sink，则此操作为空操作。这允许从 preAction 钩子（用于子命令）和 setup()（用于默认命令）调用，无需协调。
 */
export function attachAnalyticsSink(newSink: AnalyticsSink): void {
  if (sink !== null) {
    return
  }
  sink = newSink

  // 异步清空队列以避免阻塞启动
  if (eventQueue.length > 0) {
    const queuedEvents = [...eventQueue]
    eventQueue.length = 0

    // 为蚂蚁用户记录队列大小，以帮助调试分析初始化时机
    if (process.env.USER_TYPE === 'ant') {
      sink.logEvent('analytics_sink_attached', {
        queued_event_count: queuedEvents.length,
      })
    }

    queueMicrotask(() => {
      for (const event of queuedEvents) {
        if (event.async) {
          void sink!.logEventAsync(event.eventName, event.metadata)
        } else {
          sink!.logEvent(event.eventName, event.metadata)
        }
      }
    })
  }
}

/**
 * 将事件记录到分析后端（同步）
 *
 * 事件可能会根据 'tengu_event_sampling_config' 动态配置进行采样。
 * 当被采样时，sample_rate 会添加到事件元数据中。
 *
 * 如果未附加 sink，事件将被排队，待 sink 附加后清空。
 */
export function logEvent(
  eventName: string,
  // 故意不使用字符串类型，除非带有 AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS，
  // 以避免意外记录代码或文件路径
  metadata: LogEventMetadata,
): void {
  if (sink === null) {
    eventQueue.push({ eventName, metadata, async: false })
    return
  }
  sink.logEvent(eventName, metadata)
}

/**
 * 将事件记录到分析后端（异步）
 *
 * 事件可能会根据 'tengu_event_sampling_config' 动态配置进行采样。
 * 当被采样时，sample_rate 会添加到事件元数据中。
 *
 * 如果未附加 sink，事件将被排队，待 sink 附加后清空。
 */
export async function logEventAsync(
  eventName: string,
  // 故意不使用字符串类型，以避免意外记录代码或文件路径
  metadata: LogEventMetadata,
): Promise<void> {
  if (sink === null) {
    eventQueue.push({ eventName, metadata, async: true })
    return
  }
  await sink.logEventAsync(eventName, metadata)
}

/**
 * 仅用于测试目的重置分析状态。
 * @internal
 */
export function _resetForTesting(): void {
  sink = null
  eventQueue.length = 0
}