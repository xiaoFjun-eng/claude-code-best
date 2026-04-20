import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'

/** /ultrareview 的运行时门控。GB 配置的 `enabled` 字段控制可见性 —— 当其为 false 时，命令过滤器上的 isEnabled() 会将其从 getCommands() 中过滤掉，因此未获许可的用户完全看不到该命令。 */
export function isUltrareviewEnabled(): boolean {
  const cfg = getFeatureValue_CACHED_MAY_BE_STALE<Record<
    string,
    unknown
  > | null>('tengu_review_bughunter_config', null)
  return cfg?.enabled === true
}
