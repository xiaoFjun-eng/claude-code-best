import * as React from 'react'
import { clearTrustedDeviceTokenCache } from '../../bridge/trustedDevice.js'
import { Text } from '@anthropic/ink'
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js'
import {
  getGroveNoticeConfig,
  getGroveSettings,
} from '../../services/api/grove.js'
import { clearPolicyLimitsCache } from '../../services/policyLimits/index.js'
// flushTelemetry 被延迟加载，以避免在启动时引入约 1.1MB 的 OpenTelemetry
import { clearRemoteManagedSettingsCache } from '../../services/remoteManagedSettings/index.js'
import { getClaudeAIOAuthTokens, removeApiKey } from '../../utils/auth.js'
import { clearBetasCaches } from '../../utils/betas.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js'
import { resetUserCache } from '../../utils/user.js'

export async function performLogout({
  clearOnboarding = false,
}): Promise<void> {
  // 在清除凭据之前刷新遥测数据，以防止组织数据泄露
  const { flushTelemetry } = await import(
    '../../utils/telemetry/instrumentation.js'
  )
  await flushTelemetry()

  await removeApiKey()

  // 注销时清除所有安全存储数据
  const secureStorage = getSecureStorage()
  secureStorage.delete()

  await clearAuthRelatedCaches()
  saveGlobalConfig(current => {
    const updated = { ...current }
    if (clearOnboarding) {
      updated.hasCompletedOnboarding = false
      updated.subscriptionNoticeCount = 0
      updated.hasAvailableSubscription = false
      if (updated.customApiKeyResponses?.approved) {
        updated.customApiKeyResponses = {
          ...updated.customApiKeyResponses,
          approved: [],
        }
      }
    }
    updated.oauthAccount = undefined
    return updated
  })
}

// 清除所有缓存的、在用户/会话/认证信息变更时必须失效的数据
export async function clearAuthRelatedCaches(): Promise<void> {
  // 清除 OAuth 令牌缓存
  getClaudeAIOAuthTokens.cache?.clear?.()
  clearTrustedDeviceTokenCache()
  clearBetasCaches()
  clearToolSchemaCache()

  // 在刷新 GrowthBook 之前清除用户数据缓存，以便其获取新的凭据
  resetUserCache()
  refreshGrowthBookAfterAuthChange()

  // 清除 Grove 配置缓存
  getGroveNoticeConfig.cache?.clear?.()
  getGroveSettings.cache?.clear?.()

  // 清除远程管理设置缓存
  await clearRemoteManagedSettingsCache()

  // 清除策略限制缓存
  await clearPolicyLimitsCache()
}

export async function call(): Promise<React.ReactNode> {
  await performLogout({ clearOnboarding: true })

  const message = (
    <Text>已成功从您的 Anthropic 账户注销。</Text>
  )

  setTimeout(() => {
    gracefulShutdownSync(0, 'logout')
  }, 200)

  return message
}
