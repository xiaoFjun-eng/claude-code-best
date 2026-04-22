// biome-ignore-all assist/source/organizeImports: 仅限 Ant 内部的导入标记不得重新排序
import type { Theme } from './theme.js'
import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getCanonicalName } from './model/model.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { getAPIProvider } from './model/providers.js'
import { getSettingsWithErrors } from './settings/settings.js'
import { resolveAntModel } from './model/antModels.js'

export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }

/**
 * 构建时门控（feature）+ 运行时门控（GrowthBook）。构建标志控制外部构建中的代码包含；GB 标志控制发布。
 */
export function isUltrathinkEnabled(): boolean {
  if (!feature('ULTRATHINK')) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_turtle_carbon', true)
}

/**
 * 检查文本是否包含 "ultrathink" 关键词。
 */
export function hasUltrathinkKeyword(text: string): boolean {
  return /\bultrathink\b/i.test(text)
}

/**
 * 查找文本中 "ultrathink" 关键词的位置（用于 UI 高亮/通知）
 */
export function findThinkingTriggerPositions(text: string): Array<{
  word: string
  start: number
  end: number
}> {
  const positions: Array<{ word: string; start: number; end: number }> = []
  // 每次调用都使用新的 /g 字面量 — String.prototype.matchAll 会复制源正则表达式的 lastIndex，
  // 因此共享实例会导致 hasUltrathinkKeyword 的 .test() 中的状态泄漏到下一次渲染的此调用中。
  const matches = text.matchAll(/\bultrathink\b/gi)

  for (const match of matches) {
    if (match.index !== undefined) {
      positions.push({
        word: match[0],
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return positions
}

const RAINBOW_COLORS: Array<keyof Theme> = [
  'rainbow_red',
  'rainbow_orange',
  'rainbow_yellow',
  'rainbow_green',
  'rainbow_blue',
  'rainbow_indigo',
  'rainbow_violet',
]

const RAINBOW_SHIMMER_COLORS: Array<keyof Theme> = [
  'rainbow_red_shimmer',
  'rainbow_orange_shimmer',
  'rainbow_yellow_shimmer',
  'rainbow_green_shimmer',
  'rainbow_blue_shimmer',
  'rainbow_indigo_shimmer',
  'rainbow_violet_shimmer',
]

export function getRainbowColor(
  charIndex: number,
  shimmer: boolean = false,
): keyof Theme {
  const colors = shimmer ? RAINBOW_SHIMMER_COLORS : RAINBOW_COLORS
  return colors[charIndex % colors.length]!
}

// TODO(inigo): 添加通过 API 错误检测探测未知模型的支持
// 支持思维能力的提供者感知检测（与 betas.ts 中的 modelSupportsISP 对齐）
export function modelSupportsThinking(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'thinking')
  if (supported3P !== undefined) {
    return supported3P
  }
  if (process.env.USER_TYPE === 'ant') {
    if (resolveAntModel(model.toLowerCase())) {
      return true
    }
  }
  // 重要提示：未经模型发布负责人和研究团队通知，请勿更改思维能力支持。这会极大地影响模型质量和稳定性。
  const canonical = getCanonicalName(model)
  const provider = getAPIProvider()
  // 1P 和 Foundry：所有 Claude 4+ 模型（包括 Haiku 4.5）
  if (provider === 'foundry' || provider === 'firstParty') {
    return !canonical.includes('claude-3-')
  }
  // 3P（Bedrock/Vertex）：仅 Opus 4+ 和 Sonnet 4+
  return canonical.includes('sonnet-4') || canonical.includes('opus-4')
}

// @[MODEL LAUNCH]: 如果新模型支持自适应思维，请将其添加到允许列表中。
export function modelSupportsAdaptiveThinking(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'adaptive_thinking')
  if (supported3P !== undefined) {
    return supported3P
  }
  const canonical = getCanonicalName(model)
  // 由 Claude 4 模型的一个子集支持
  if (
    canonical.includes('opus-4-7') ||
    canonical.includes('opus-4-6') ||
    canonical.includes('sonnet-4-6')
  ) {
    return true
  }
  // 排除任何其他已知的旧模型（上面的允许列表首先捕获 4-6 变体）
  if (
    canonical.includes('opus') ||
    canonical.includes('sonnet') ||
    canonical.includes('haiku')
  ) {
    return false
  }
  // 重要提示：未经模型发布负责人和研究团队通知，请勿更改自适应思维能力支持。
  // 这会极大地影响模型质量和稳定性。

  // 较新的模型（4.6+）都经过自适应思维训练，并且必须为模型测试启用它。
  // 对于第一方，不要默认为 false，否则我们可能会无声地降低模型质量。

  // 对于第一方和 Foundry（因为 Foundry 是代理），对未知模型字符串默认为 true。
  // 不要对其他第三方默认为 true，因为它们的模型字符串具有不同的格式。
  const provider = getAPIProvider()
  return provider === 'firstParty' || provider === 'foundry'
}

export function shouldEnableThinkingByDefault(): boolean {
  if (process.env.MAX_THINKING_TOKENS) {
    return parseInt(process.env.MAX_THINKING_TOKENS, 10) > 0
  }

  const { settings } = getSettingsWithErrors()
  if (settings.alwaysThinkingEnabled === false) {
    return false
  }

  // 重要提示：未经模型发布负责人和研究团队通知，请勿更改默认的思维启用值。
  // 这会极大地影响模型质量和稳定性。

  // 除非显式禁用，否则默认启用思维。
  return true
}