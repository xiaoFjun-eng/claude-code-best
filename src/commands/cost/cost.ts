import { formatTotalCost } from '../../cost-tracker.js'
import { currentLimits } from '../../services/claudeAiLimits.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'

export const call: LocalCommandCall = async () => {
  if (isClaudeAISubscriber()) {
    let value: string

    if (currentLimits.isUsingOverage) {
      value =
        '您当前正在使用超额额度来支持您的 Claude Code 使用。当您的订阅额度重置时，我们将自动切换回订阅速率限制'
    } else {
      value =
        '您当前正在使用订阅额度来支持您的 Claude Code 使用'
    }

    if (process.env.USER_TYPE === 'ant') {
      value += `

[仅限 ANT] 仍显示成本：
 ${formatTotalCost()}`
    }
    return { type: 'text', value }
  }
  return { type: 'text', value: formatTotalCost() }
}
