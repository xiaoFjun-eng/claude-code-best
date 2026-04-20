import React, { useMemo, useState } from 'react'
import type {
  CommandResultDisplay,
  LocalJSXCommandContext,
} from '../../commands.js'
import {
  type OptionWithDescription,
  Select,
} from '../../components/CustomSelect/select.js'
import { Dialog } from '@anthropic/ink'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { logEvent } from '../../services/analytics/index.js'
import { useClaudeAiLimits } from '../../services/claudeAiLimitsHook.js'
import type { ToolUseContext } from '../../Tool.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  getOauthAccountInfo,
  getRateLimitTier,
  getSubscriptionType,
} from '../../utils/auth.js'
import { hasClaudeAiBillingAccess } from '../../utils/billing.js'
import { call as extraUsageCall } from '../extra-usage/extra-usage.js'
import { extraUsage } from '../extra-usage/index.js'
import upgrade from '../upgrade/index.js'
import { call as upgradeCall } from '../upgrade/upgrade.js'

type RateLimitOptionsMenuOptionType = 'upgrade' | 'extra-usage' | 'cancel'

type RateLimitOptionsMenuProps = {
  onDone: (
    result?: string,
    options?:
      | {
          display?: CommandResultDisplay | undefined
        }
      | undefined,
  ) => void
  context: ToolUseContext & LocalJSXCommandContext
}

function RateLimitOptionsMenu({
  onDone,
  context,
}: RateLimitOptionsMenuProps): React.ReactNode {
  const [subCommandJSX, setSubCommandJSX] = useState<React.ReactNode>(null)
  const claudeAiLimits = useClaudeAiLimits()
  const subscriptionType = getSubscriptionType()
  const rateLimitTier = getRateLimitTier()
  const hasExtraUsageEnabled =
    getOauthAccountInfo()?.hasExtraUsageEnabled === true
  const isMax = subscriptionType === 'max'
  const isMax20x = isMax && rateLimitTier === 'default_claude_max_20x'
  const isTeamOrEnterprise =
    subscriptionType === 'team' || subscriptionType === 'enterprise'
  const buyFirst = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_jade_anvil_4',
    false,
  )

  const options = useMemo<
    OptionWithDescription<RateLimitOptionsMenuOptionType>[]
  >(() => {
    const actionOptions: OptionWithDescription<RateLimitOptionsMenuOptionType>[] =
      []

    if (extraUsage.isEnabled()) {
      const hasBillingAccess = hasClaudeAiBillingAccess()
      const needsToRequestFromAdmin = isTeamOrEnterprise && !hasBillingAccess
      // 组织支出限额已耗尽 - 非管理员无法请求更多额度，因为已无可分配资源 - out_of_credits
      // : 钱包为空 - org_level
      // _disabled_until: 本月组织支出限额已用完 - org
      // _service_zero_credit_limit: 组织服务的信用额度为零
      const isOrgSpendCapDepleted =
        claudeAiLimits.overageDisabledReason === 'out_of_credits' ||
        claudeAiLimits.overageDisabledReason === 'org_level_disabled_until' ||
        claudeAiLimits.overageDisabledReason === 'org_service_zero_credit_limit'

      // 当组织支出限额耗尽时，对非管理员团队/企业用户隐藏
      if (needsToRequestFromAdmin && isOrgSpendCapDepleted) {
        // 不显示额外用量选项
      } else {
        const isOverageState =
          claudeAiLimits.overageStatus === 'rejected' ||
          claudeAiLimits.overageStatus === 'allowed_warning'

        let label: string
        if (needsToRequestFromAdmin) {
          label = isOverageState ? '请求更多' : '请求额外用量'
        } else {
          label = hasExtraUsageEnabled
            ? '添加资金以继续使用额外用量'
            : '切换到额外用量'
        }

        actionOptions.push({
          label,
          value: 'extra-usage',
        })
      }
    }

    if (!isMax20x && !isTeamOrEnterprise && upgrade.isEnabled()) {
      actionOptions.push({
        label: '升级您的套餐',
        value: 'upgrade',
      })
    }

    const cancelOption: OptionWithDescription<RateLimitOptionsMenuOptionType> =
      {
        label: '停止并等待限额重置',
        value: 'cancel',
      }

    if (buyFirst) {
      return [...actionOptions, cancelOption]
    }
    return [cancelOption, ...actionOptions]
  }, [
    buyFirst,
    isMax20x,
    isTeamOrEnterprise,
    hasExtraUsageEnabled,
    claudeAiLimits.overageStatus,
    claudeAiLimits.overageDisabledReason,
  ])

  function handleCancel(): void {
    logEvent('tengu_rate_limit_options_menu_cancel', {})
    onDone(undefined, { display: 'skip' })
  }

  function handleSelect(value: RateLimitOptionsMenuOptionType): void {
    if (value === 'upgrade') {
      logEvent('tengu_rate_limit_options_menu_select_upgrade', {})
      void upgradeCall(onDone, context).then(jsx => {
        if (jsx) {
          setSubCommandJSX(jsx)
        }
      })
    } else if (value === 'extra-usage') {
      logEvent('tengu_rate_limit_options_menu_select_extra_usage', {})
      void extraUsageCall(onDone, context).then(jsx => {
        if (jsx) {
          setSubCommandJSX(jsx)
        }
      })
    } else if (value === 'cancel') {
      handleCancel()
    }
  }

  if (subCommandJSX) {
    return subCommandJSX
  }

  return (
    <Dialog
      title="您想要做什么？"
      onCancel={handleCancel}
      color="suggestion"
    >
      <Select<RateLimitOptionsMenuOptionType>
        options={options}
        onChange={handleSelect}
        visibleOptionCount={options.length}
      />
    </Dialog>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return <RateLimitOptionsMenu onDone={onDone} context={context} />
}
