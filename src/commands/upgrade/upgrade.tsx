import * as React from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import { getOauthProfileFromOauthToken } from '../../services/oauth/getOauthProfile.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  getClaudeAIOAuthTokens,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { openBrowser } from '../../utils/browser.js'
import { logError } from '../../utils/log.js'
import { Login } from '../login/login.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode | null> {
  try {
    // 检查用户是否已处于最高等级的 Max 套餐（20 倍用量）
    if (isClaudeAISubscriber()) {
      const tokens = getClaudeAIOAuthTokens()
      let isMax20x = false

      if (tokens?.subscriptionType && tokens?.rateLimitTier) {
        isMax20x =
          tokens.subscriptionType === 'max' &&
          tokens.rateLimitTier === 'default_claude_max_20x'
      } else if (tokens?.accessToken) {
        const profile = await getOauthProfileFromOauthToken(tokens.accessToken)
        isMax20x =
          profile?.organization?.organization_type === 'claude_max' &&
          profile?.organization?.rate_limit_tier === 'default_claude_max_20x'
      }

      if (isMax20x) {
        setTimeout(
          onDone,
          0,
          '您已订阅最高等级的 Max 套餐。如需更多用量，请运行 /login 切换到按 API 使用量计费的账户。',
        )
        return null
      }
    }

    const url = 'https://claude.ai/upgrade/max'
    await openBrowser(url)

    return (
      <Login
        startingMessage={
          '在 /upgrade 后开始新的登录流程。按 Ctrl-C 退出以使用现有账户。'
        }
        onDone={success => {
          context.onChangeAPIKey()
          onDone(success ? '登录成功' : '登录已中断')
        }}
      />
    )
  } catch (error) {
    logError(error as Error)
    setTimeout(
      onDone,
      0,
      '无法打开浏览器。请访问 https://claude.ai/upgrade/max 进行升级。',
    )
  }
  return null
}
