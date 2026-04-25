// Leaf 配置模块 — 有意保持最小化导入，以便 U
// I 组件无需引入 autoDream.ts 所依赖的分
// 支代理/任务注册表/消息构建链，即可读取自动梦境启用状态。

import { getInitialSettings } from '../../utils/settings/settings.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'

/** 是否应运行后台记忆整合。用户设置（settings.json 中的 autoDreamEnabled）在显式设置时会覆盖 GrowthBook 默认值；否则回退至 tengu_onyx_plover。 */
export function isAutoDreamEnabled(): boolean {
  const setting = getInitialSettings().autoDreamEnabled
  if (setting !== undefined) return setting
  const gb = getFeatureValue_CACHED_MAY_BE_STALE<{ enabled?: unknown } | null>(
    'tengu_onyx_plover',
    null,
  )
  return gb?.enabled === true
}
