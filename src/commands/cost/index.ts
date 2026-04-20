/** 成本命令 - 仅包含最简元数据。
实现从 cost.ts 延迟加载，以减少启动时间。 */
import type { Command } from '../../commands.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'

const cost = {
  type: 'local',
  name: 'cost',
  description: '显示当前会话的总成本和持续时间',
  get isHidden() {
    // 即使 Ants 是订阅者，也保持对其可见（他们可以看到成本明细）
    if (process.env.USER_TYPE === 'ant') {
      return false
    }
    return isClaudeAISubscriber()
  },
  supportsNonInteractive: true,
  load: () => import('./cost.js'),
} satisfies Command

export default cost
