import React from 'react'
import { logEvent } from 'src/services/analytics/index.js'
import { Box, Dialog, Link, Text } from '@anthropic/ink'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { Select } from './CustomSelect/index.js'

// 注意：此文案已经过法务审核 — 未经法务团队批准不得修改。
export const AUTO_MODE_DESCRIPTION =
  '自动模式让 Claude 自动处理权限提示 — Claude 在执行每个工具调用前会检查是否存在风险操作和提示注入。Claude 判定为安全的操作将被执行，判定为有风险的操作将被阻止，Claude 可能会尝试不同的方法。适用于长时间运行的任务。会话成本略高。Claude 可能会出错，导致有害命令运行，建议仅在隔离环境中使用。按 Shift+Tab 可更改模式。'

type Props = {
  onAccept(): void
  onDecline(): void
  // 启动时门控：拒绝会退出进程，因此相应地重新标记按钮。
  declineExits?: boolean
}

export function AutoModeOptInDialog({
  onAccept,
  onDecline,
  declineExits,
}: Props): React.ReactNode {
  React.useEffect(() => {
    logEvent('tengu_auto_mode_opt_in_dialog_shown', {})
  }, [])

  function onChange(value: 'accept' | 'accept-default' | 'decline') {
    switch (value) {
      case 'accept': {
        logEvent('tengu_auto_mode_opt_in_dialog_accept', {})
        updateSettingsForSource('userSettings', {
          skipAutoPermissionPrompt: true,
        })
        onAccept()
        break
      }
      case 'accept-default': {
        logEvent('tengu_auto_mode_opt_in_dialog_accept_default', {})
        updateSettingsForSource('userSettings', {
          skipAutoPermissionPrompt: true,
          permissions: { defaultMode: 'auto' },
        })
        onAccept()
        break
      }
      case 'decline': {
        logEvent('tengu_auto_mode_opt_in_dialog_decline', {})
        onDecline()
        break
      }
    }
  }

  return (
    <Dialog title="启用自动模式？" color="warning" onCancel={onDecline}>
      <Box flexDirection="column" gap={1}>
        <Text>{AUTO_MODE_DESCRIPTION}</Text>

        <Link url="https://code.claude.com/docs/en/security" />
      </Box>

      <Select
        options={[
          ...((process.env.USER_TYPE as string) !== 'ant'
            ? [
                {
                  label: '是，并将其设为我的默认模式',
                  value: 'accept-default' as const,
                },
              ]
            : []),
          { label: '是，启用自动模式', value: 'accept' as const },
          {
            label: declineExits ? '否，退出' : '否，返回',
            value: 'decline' as const,
          },
        ]}
        onChange={value =>
          onChange(value as 'accept' | 'accept-default' | 'decline')
        }
        onCancel={onDecline}
      />
    </Dialog>
  )
}