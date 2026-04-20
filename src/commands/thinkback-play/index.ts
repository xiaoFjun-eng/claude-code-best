import type { Command } from '../../commands.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'

// 隐藏命令，仅播放动画。在生成
// 完成后由 thinkback 技能调用
const thinkbackPlay = {
  type: 'local',
  name: 'thinkback-play',
  description: '播放 thinkback 动画',
  isEnabled: () =>
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_thinkback'),
  isHidden: true,
  supportsNonInteractive: false,
  load: () => import('./thinkback-play.js'),
} satisfies Command

export default thinkbackPlay
