/** * 读取工具输出限制。文本读取适用两个上限：
 *
 *   | 限制项         | 默认值   | 检查对象                    | 成本          | 溢出处理         |
 *   |---------------|---------|---------------------------|---------------|-----------------|
 *   | maxSizeBytes  | 256 KB  | 总文件大小（非输出内容） | 1 次状态检查  | 读取前抛出异常 |
 *   | maxTokens     | 25000   | 实际输出令牌数            | API 往返开销  | 读取后抛出异常 |
 *
 * 已知不匹配：maxSizeBytes 基于总文件大小设限，而非实际读取片段。
 * 已测试对超出字节上限的显式限制读取采用截断而非抛出异常（#21841，2026年3月）。
 * 已回退：工具错误率下降但平均令牌数上升——抛出路径产生约100字节的错误
 * 工具结果，而截断路径在达到上限时产生约25K令牌的内容。 */
import memoize from 'lodash-es/memoize.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { MAX_OUTPUT_SIZE } from 'src/utils/file.js'
export const DEFAULT_MAX_OUTPUT_TOKENS = 25000

/** * 用于覆盖最大输出令牌数的环境变量。当未设置或无效时返回 undefined，
 * 以便调用方可以回退到下一优先级层级。 */
function getEnvMaxTokens(): number | undefined {
  const override = process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS
  if (override) {
    const parsed = parseInt(override, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return undefined
}

export type FileReadingLimits = {
  maxTokens: number
  maxSizeBytes: number
  includeMaxSizeInPrompt?: boolean
  targetedRangeNudge?: boolean
}

/** * 当 ToolUseContext 未提供覆盖值时，Read 工具的默认限制。采用记忆化，
 * 确保 GrowthBook 值在首次调用时固定——避免后台标志刷新导致会话中途限制变更。
 *
 * maxTokens 的优先级：环境变量 > GrowthBook > DEFAULT_MAX_OUTPUT_TOKENS。
 * （环境变量是用户设置的覆盖项，应优先于实验基础设施。）
 *
 * 防御性设计：每个字段单独验证；无效值将回退到硬编码的默认值（不会导致上限=0）。 */
export const getDefaultFileReadingLimits = memoize((): FileReadingLimits => {
  const override =
    getFeatureValue_CACHED_MAY_BE_STALE<Partial<FileReadingLimits> | null>(
      'tengu_amber_wren',
      {},
    )

  const maxSizeBytes =
    typeof override?.maxSizeBytes === 'number' &&
    Number.isFinite(override.maxSizeBytes) &&
    override.maxSizeBytes > 0
      ? override.maxSizeBytes
      : MAX_OUTPUT_SIZE

  const envMaxTokens = getEnvMaxTokens()
  const maxTokens =
    envMaxTokens ??
    (typeof override?.maxTokens === 'number' &&
    Number.isFinite(override.maxTokens) &&
    override.maxTokens > 0
      ? override.maxTokens
      : DEFAULT_MAX_OUTPUT_TOKENS)

  const includeMaxSizeInPrompt =
    typeof override?.includeMaxSizeInPrompt === 'boolean'
      ? override.includeMaxSizeInPrompt
      : undefined

  const targetedRangeNudge =
    typeof override?.targetedRangeNudge === 'boolean'
      ? override.targetedRangeNudge
      : undefined

  return {
    maxSizeBytes,
    maxTokens,
    includeMaxSizeInPrompt,
    targetedRangeNudge,
  }
})
