/**
* 隐私级别决定了非必要网络流量和遥测数据的传输量。
* 克劳德·科德生成这些数据。*
级别按照限制程度依次排列：
* 默认级别 < 无数据传输级别 < 重要流量级别*
* - 默认设置：所有功能均启用。
* - 不启用数据收集：分析/数据收集功能已关闭（Datadog、第一方事件、反馈调查）。
* - 关键型流量：所有非关键型网络流量均被禁用（包括数据收集与自动更新、grove、发布说明、模型功能等）。*
已设置的级别是以下各项中最为严格的限制信号：
*   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC  →  必要流量
*   DISABLE_TELEMETRY                         →  无遥测数据
* */
type PrivacyLevel = 'default' | 'no-telemetry' | 'essential-traffic'

export function getPrivacyLevel(): PrivacyLevel {
  if (process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) {
    return 'essential-traffic'
  }
  if (process.env.DISABLE_TELEMETRY) {
    return 'no-telemetry'
  }
  return 'default'
}

/**
 * True when all nonessential network traffic should be suppressed.
 * Equivalent to the old `process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` check.
 */
export function isEssentialTrafficOnly(): boolean {
  return getPrivacyLevel() === 'essential-traffic'
}

/**
* 当需要关闭遥测/分析功能时为真。
* 在“无遥测”和“关键流量”级别下均为真。
* */
export function isTelemetryDisabled(): boolean {
  return getPrivacyLevel() !== 'default'
}

/**
* 返回负责当前关键流量限制的环境变量名称，
* 若无限制则返回 null 。此值用于面向用户的“取消设置变量 X 以重新启用”提示信息。
* */
export function getEssentialTrafficOnlyReason(): string | null {
  if (process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) {
    return 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'
  }
  return null
}
