import * as React from 'react'
import {
  type GroveDecision,
  GroveDialog,
  PrivacySettingsDialog,
} from '../../components/grove/Grove.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import {
  getGroveNoticeConfig,
  getGroveSettings,
  isQualifiedForGrove,
} from '../../services/api/grove.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

const FALLBACK_MESSAGE =
  '请在 https://claude.ai/settings/data-privacy-controls 查看和管理您的隐私设置'

export async function call(
  onDone: LocalJSXCommandOnDone,
): Promise<React.ReactNode | null> {
  const qualified = await isQualifiedForGrove()
  if (!qualified) {
    onDone(FALLBACK_MESSAGE)
    return null
  }

  const [settingsResult, configResult] = await Promise.all([
    getGroveSettings(),
    getGroveNoticeConfig(),
  ])
  // API 调用失败后（重试后）隐藏对话框
  if (!settingsResult.success) {
    onDone(FALLBACK_MESSAGE)
    return null
  }
  const settings = settingsResult.data
  const config = configResult.success ? configResult.data : null

  async function onDoneWithDecision(decision: GroveDecision) {
    if (decision === 'escape' || decision === 'defer') {
      onDone('隐私设置对话框已关闭', {
        display: 'system',
      })
      return
    }
    await onDoneWithSettingsCheck()
  }

  async function onDoneWithSettingsCheck() {
    const updatedSettingsResult = await getGroveSettings()
    if (!updatedSettingsResult.success) {
      onDone('无法获取更新后的隐私设置', {
        display: 'system',
      })
      return
    }
    const updatedSettings = updatedSettingsResult.data
    const groveStatus = updatedSettings.grove_enabled ? 'true' : 'false'
    onDone(`"帮助改进 Claude" 已设置为 ${groveStatus}。`)
    if (
      settings.grove_enabled !== null &&
      settings.grove_enabled !== updatedSettings.grove_enabled
    ) {
      logEvent('tengu_grove_policy_toggled', {
        state:
          updatedSettings.grove_enabled as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        location:
          'settings' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
  }

  // 如果用户已接受条款，则直接显示隐私
  // 设置
  if (settings.grove_enabled !== null) {
    return (
      <PrivacySettingsDialog
        settings={settings}
        domainExcluded={config?.domain_excluded}
        onDone={onDoneWithSettingsCheck}
      ></PrivacySettingsDialog>
    )
  }

  // 为尚未接受条款的用户显示 GroveDialog
  return (
    <GroveDialog
      showIfAlreadyViewed={true}
      onDone={onDoneWithDecision}
      location={'settings'}
    />
  )
}
