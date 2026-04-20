import {
  checkAdminRequestEligibility,
  createAdminRequest,
  getMyAdminRequests,
} from '../../services/api/adminRequests.js'
import { invalidateOverageCreditGrantCache } from '../../services/api/overageCreditGrant.js'
import { type ExtraUsage, fetchUtilization } from '../../services/api/usage.js'
import { getSubscriptionType } from '../../utils/auth.js'
import { hasClaudeAiBillingAccess } from '../../utils/billing.js'
import { openBrowser } from '../../utils/browser.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logError } from '../../utils/log.js'

type ExtraUsageResult =
  | { type: 'message'; value: string }
  | { type: 'browser-opened'; url: string; opened: boolean }

export async function runExtraUsage(): Promise<ExtraUsageResult> {
  if (!getGlobalConfig().hasVisitedExtraUsage) {
    saveGlobalConfig(prev => ({ ...prev, hasVisitedExtraUsage: true }))
  }
  // 仅使当前组织的条目失效，以便后续读取重新获取授
  // 权状态。与访问标志分开，因为用户在迭代声明流程
  // 时可能多次运行 /extra-usage。
  invalidateOverageCreditGrantCache()

  const subscriptionType = getSubscriptionType()
  const isTeamOrEnterprise =
    subscriptionType === 'team' || subscriptionType === 'enterprise'
  const hasBillingAccess = hasClaudeAiBillingAccess()

  if (!hasBillingAccess && isTeamOrEnterprise) {
    // 镜像 apps/claude-ai 的 useHasUnlimited
    // Overage() 逻辑：如果启用了超额使用且没有月度上限，则无需请求。
    // 获取出错时，继续执行并让用户询问（匹配 web 端的“错误倾向展示”行为）。
    let extraUsage: ExtraUsage | null | undefined
    try {
      const utilization = await fetchUtilization()
      extraUsage = utilization?.extra_usage
    } catch (error) {
      logError(error as Error)
    }

    if (extraUsage?.is_enabled && extraUsage.monthly_limit === null) {
      return {
        type: 'message',
        value:
          '您的组织已拥有无限额外使用额度。无需请求。',
      }
    }

    try {
      const eligibility = await checkAdminRequestEligibility('limit_increase')
      if (eligibility?.is_allowed === false) {
        return {
          type: 'message',
          value: '请联系您的管理员管理额外使用设置。',
        }
      }
    } catch (error) {
      logError(error as Error)
      // 如果资格检查失败，继续执行 — 创建端点将在必要时强制执行
    }

    try {
      const pendingOrDismissedRequests = await getMyAdminRequests(
        'limit_increase',
        ['pending', 'dismissed'],
      )
      if (pendingOrDismissedRequests && pendingOrDismissedRequests.length > 0) {
        return {
          type: 'message',
          value:
            '您已向管理员提交了额外使用请求。',
        }
      }
    } catch (error) {
      logError(error as Error)
      // 继续执行下方创建新请求的流程
    }

    try {
      await createAdminRequest({
        request_type: 'limit_increase',
        details: null,
      })
      return {
        type: 'message',
        value: extraUsage?.is_enabled
          ? '已向管理员发送增加额外使用额度的请求。'
          : '已向管理员发送启用额外使用的请求。',
      }
    } catch (error) {
      logError(error as Error)
      // 继续执行下方的通用消息
    }

    return {
      type: 'message',
      value: '请联系您的管理员管理额外使用设置。',
    }
  }

  const url = isTeamOrEnterprise
    ? 'https://claude.ai/admin-settings/usage'
    : 'https://claude.ai/settings/usage'

  try {
    const opened = await openBrowser(url)
    return { type: 'browser-opened', url, opened }
  } catch (error) {
    logError(error as Error)
    return {
      type: 'message',
      value: `无法打开浏览器。请访问 ${url} 管理额外使用。`,
    }
  }
}
