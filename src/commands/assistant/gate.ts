import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'

/** * /assistant 命令可见性的运行时门控。
 *
 * 构建时要求：feature('KAIROS') 必须开启。
 * 运行时要求：tengu_kairos_assistant GrowthBook 标志（远程开关）。
 *
 * 不要求 kairosActive — /assistant 命令在激活前即可见，以便用户可以通过调用它来激活 KAIROS。 */
export function isAssistantEnabled(): boolean {
  if (!feature('KAIROS')) {
    return false
  }
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_kairos_assistant', false)) {
    return false
  }
  return true
}
