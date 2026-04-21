import { feature } from 'bun:bundle'
import * as React from 'react'
import { resetCostState } from '../../bootstrap/state.js'
import {
  clearTrustedDeviceToken,
  enrollTrustedDevice,
} from '../../bridge/trustedDevice.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js'
import { Dialog } from '@anthropic/ink'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { Text } from '@anthropic/ink'
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js'
import { refreshPolicyLimits } from '../../services/policyLimits/index.js'
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import {
  checkAndDisableAutoModeIfNeeded,
  resetAutoModeGateCheck,
} from '../../utils/permissions/bypassPermissionsKillswitch.js'
import { resetUserCache } from '../../utils/user.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return (
    <Login
      onDone={async success => {
        context.onChangeAPIKey()
        // 带有签名的区块（thinking、connector_text）与 AP
        // I 密钥绑定——移除它们，以免新密钥拒绝过期的签名。
        context.setMessages(stripSignatureBlocks)
        if (success) {
          // 登录后的刷新逻辑。与 src/interactiveHelpers.tsx 中的新用户
          // 引导流程保持同步。切换账户时重置成本状态
          resetCostState()
          // 登录后刷新远程管理的设置（非阻塞）
          void refreshRemoteManagedSettings()
          // 登录后刷新策略限制（非阻塞）
          void refreshPolicyLimits()
          // 在刷新 GrowthBook 之前清除用户数据缓存，以便它获取最新的凭据
          resetUserCache()
          // 登录后刷新 GrowthBook 以获取更新的功能标志（例如，用于 claude.ai MCPs）
          refreshGrowthBookAfterAuthChange()
          // 在重新注册之前，清除先前账户中任何过期的受信任设备令牌—
          // —防止在异步 enrollTrustedDevice()
          // 进行期间，在桥接调用中发送旧令牌。
          clearTrustedDeviceToken()
          // 注册为远程控制的受信任设备（10分钟新会话窗口）
          void enrollTrustedDevice()
          // 重置 killswitch 门检查，并使用新组织重新运行
          resetAutoModeGateCheck()
          const appState = context.getAppState()
          void checkAndDisableAutoModeIfNeeded(
            appState.toolPermissionContext,
            context.setAppState,
            appState.fastMode,
          )
          // 递增 authVersion 以触发钩子中重新获取依赖认证的数据（例如，MCP 服务器）
          context.setAppState(prev => ({
            ...prev,
            authVersion: prev.authVersion + 1,
          }))
        }
        onDone(success ? '登录成功' : '登录中断')
      }}
    />
  )
}

export function Login(props: {
  onDone: (success: boolean, mainLoopModel: string) => void
  startingMessage?: string
}): React.ReactNode {
  const mainLoopModel = useMainLoopModel()

  return (
    <Dialog
      title="Login"
      onCancel={() => props.onDone(false, mainLoopModel)}
      color="permission"
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} 再次输入以退出</Text>
        ) : (
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="cancel"
          />
        )
      }
    >
      <ConsoleOAuthFlow
        onDone={() => props.onDone(true, mainLoopModel)}
        startingMessage={props.startingMessage}
      />
    </Dialog>
  )
}
