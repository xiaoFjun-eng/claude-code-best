import { getSessionId } from '../bootstrap/state.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import type { SessionId } from '../types/ids.js'
import { isEnvTruthy } from '../utils/envUtils.js'

// -- 配置

// 不可变值，在 query() 入口处快照一次。将这些值与每次迭代的 State 结
// 构体以及可变的 ToolUseContext 分离，使得未来的 step() 提取变
// 得可行——纯 reducer 可以接收 (state, event, config)，
// 其中 config 是纯数据。
//
// 有意排除了 feature() 门控——这些是 tree-shak
// ing 边界，必须内联在受保护的代码块中，以便进行死代码消除。
export type QueryConfig = {
  sessionId: SessionId

  // 运行时门控（环境变量/statsig）。不是 feature() 门控——见上文。
  gates: {
    // Statsig——CACHED_MAY_BE_STALE 已经允许数据过时
    // ，因此每次 query() 调用快照一次仍在现有契约范围内。
    streamingToolExecution: boolean
    emitToolUseSummaries: boolean
    isAnt: boolean
    fastModeEnabled: boolean
  }
}

export function buildQueryConfig(): QueryConfig {
  return {
    sessionId: getSessionId(),
    gates: {
      streamingToolExecution: checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
        'tengu_streaming_tool_execution2',
      ),
      emitToolUseSummaries: isEnvTruthy(
        process.env.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES,
      ),
      isAnt: process.env.USER_TYPE === 'ant',
      // 从 fastMode.ts 内联而来，以避免将其庞大的模块图（a
      // xios、settings、auth、model、oauth、con
      // fig）拉入之前未加载它的测试分片中——这会改变初始化顺序并破坏无关测试。
      fastModeEnabled: !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FAST_MODE),
    },
  }
}
