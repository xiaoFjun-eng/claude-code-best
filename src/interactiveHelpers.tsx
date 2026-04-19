import { feature } from 'bun:bundle'
import { appendFileSync } from 'fs'
import React from 'react'
import { logEvent } from 'src/services/analytics/index.js'
import {
  gracefulShutdown,
  gracefulShutdownSync,
} from 'src/utils/gracefulShutdown.js'
import {
  type ChannelEntry,
  getAllowedChannels,
  setAllowedChannels,
  setHasDevChannels,
  setSessionTrustAccepted,
  setStatsStore,
} from './bootstrap/state.js'
import type { Command } from './commands.js'
import { createStatsStore, type StatsStore } from './context/stats.js'
import { getSystemContext } from './context.js'
import { initializeTelemetryAfterTrust } from './entrypoints/init.js'
import { isSynchronizedOutputSupported } from '@anthropic/ink'
import type { RenderOptions, Root, TextProps } from '@anthropic/ink'
import { KeybindingSetup } from './keybindings/KeybindingProviderSetup.js'
import { startDeferredPrefetches } from './main.js'
import {
  checkGate_CACHED_OR_BLOCKING,
  initializeGrowthBook,
  resetGrowthBook,
} from './services/analytics/growthbook.js'
import { isQualifiedForGrove } from './services/api/grove.js'
import { handleMcpjsonServerApprovals } from './services/mcpServerApproval.js'
import { AppStateProvider } from './state/AppState.js'
import { onChangeAppState } from './state/onChangeAppState.js'
import { normalizeApiKeyForConfig } from './utils/authPortable.js'
import {
  getExternalClaudeMdIncludes,
  getMemoryFiles,
  shouldShowClaudeMdExternalIncludesWarning,
} from './utils/claudemd.js'
import {
  checkHasTrustDialogAccepted,
  getCustomApiKeyStatus,
  getGlobalConfig,
  saveGlobalConfig,
} from './utils/config.js'
import { updateDeepLinkTerminalPreference } from './utils/deepLink/terminalPreference.js'
import { isEnvTruthy, isRunningOnHomespace } from './utils/envUtils.js'
import { type FpsMetrics, FpsTracker } from './utils/fpsTracker.js'
import { updateGithubRepoPathMapping } from './utils/githubRepoPathMapping.js'
import { applyConfigEnvironmentVariables } from './utils/managedEnv.js'
import type { PermissionMode } from './utils/permissions/PermissionMode.js'
import { getBaseRenderOptions } from './utils/renderOptions.js'
import { getSettingsWithAllErrors } from './utils/settings/allErrors.js'
import {
  hasAutoModeOptIn,
  hasSkipDangerousModePermissionPrompt,
} from './utils/settings/settings.js'

export function completeOnboarding(): void {
  saveGlobalConfig(current => ({
    ...current,
    hasCompletedOnboarding: true,
    lastOnboardingVersion: MACRO.VERSION,
  }))
}
export function showDialog<T = void>(
  root: Root,
  renderer: (done: (result: T) => void) => React.ReactNode,
): Promise<T> {
  return new Promise<T>(resolve => {
    const done = (result: T): void => void resolve(result)
    root.render(renderer(done))
  })
}

/** 通过 Ink 渲染错误信息，然后卸载并退出。
在 Ink 根节点创建后，对于致命错误使用此方法——
console.error 会被 Ink 的 patchConsole 吞掉，因此我们改为通过 React 树进行渲染。 */
export async function exitWithError(
  root: Root,
  message: string,
  beforeExit?: () => Promise<void>,
): Promise<never> {
  return exitWithMessage(root, message, { color: 'error', beforeExit })
}

/** 通过 Ink 渲染一条信息，然后卸载并退出。
在 Ink 根节点创建后，对于信息输出使用此方法——
控制台输出会被 Ink 的 patchConsole 吞掉，因此我们改为通过 React 树进行渲染。 */
export async function exitWithMessage(
  root: Root,
  message: string,
  options?: {
    color?: TextProps['color']
    exitCode?: number
    beforeExit?: () => Promise<void>
  },
): Promise<never> {
  const { Text } = await import('@anthropic/ink')
  const color = options?.color
  const exitCode = options?.exitCode ?? 1
  root.render(
    color ? <Text color={color}>{message}</Text> : <Text>{message}</Text>,
  )
  root.unmount()
  await options?.beforeExit?.()
  // eslint-disable-next-line custom-rules/no-process-exit -- 在 Ink 卸载后退出
  process.exit(exitCode)
}

/** 显示一个包裹在 AppStateProvider + KeybindingSetup 中的设置对话框。
减少 showSetupScreens() 中的样板代码，因为每个对话框都需要这些包装器。 */
export function showSetupDialog<T = void>(
  root: Root,
  renderer: (done: (result: T) => void) => React.ReactNode,
  options?: { onChangeAppState?: typeof onChangeAppState },
): Promise<T> {
  return showDialog<T>(root, done => (
    <AppStateProvider onChangeAppState={options?.onChangeAppState}>
      <KeybindingSetup>{renderer(done)}</KeybindingSetup>
    </AppStateProvider>
  ))
}

/** 将主 UI 渲染到根节点并等待其退出。
处理通用的收尾工作：启动延迟预取，等待退出，优雅关闭。 */
export async function renderAndRun(
  root: Root,
  element: React.ReactNode,
): Promise<void> {
  root.render(element)
  startDeferredPrefetches()
  await root.waitUntilExit()
  await gracefulShutdown(0)
}

export async function showSetupScreens(
  root: Root,
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
  commands?: Command[],
  claudeInChrome?: boolean,
  devChannels?: ChannelEntry[],
): Promise<boolean> {
  if (
    process.env.NODE_ENV === 'test' ||
    isEnvTruthy(false) ||
    process.env.IS_DEMO // 在演示模式下跳过新手引导
  ) {
    return false
  }

  const config = getGlobalConfig()
  let onboardingShown = false
  if (
    !config.theme ||
    !config.hasCompletedOnboarding // 始终至少显示一次新手引导
  ) {
    onboardingShown = true
    const { Onboarding } = await import('./components/Onboarding.js')
    await showSetupDialog(
      root,
      done => (
        <Onboarding
          onDone={() => {
            completeOnboarding()
            void done()
          }}
        />
      ),
      { onChangeAppState },
    )
  }

  // 在交互式会话中始终显示信任对话框，无论权限模式如何。信任对话框是工作空间信
  // 任边界——它会警告不受信任的仓库并检查 CLAUDE.md 的外部包含。
  // bypassPermissions 模式仅影响工具执行
  // 权限，不影响工作空间信任。注意：非交互式会话（使用 -
  // p 的 CI/CD）根本不会进入 showSetupScreens。在 c
  // laubbit 中跳过权限检查
  if (!isEnvTruthy(process.env.CLAUBBIT)) {
    // 快速路径：当当前工作目录已被信任时，跳过 TrustDialog
    // 的导入和渲染。如果它返回 true，则 TrustDialog
    // 将自动解析，无论安全功能如何，因此我们可以跳过动态导入和渲染周期。
    if (!checkHasTrustDialogAccepted()) {
      const { TrustDialog } = await import(
        './components/TrustDialog/TrustDialog.js'
      )
      await showSetupDialog(root, done => (
        <TrustDialog commands={commands} onDone={done} />
      ))
    }

    // 标记此会话的信任已验证。Growth
    // Book 会检查此项以决定是否包含认证头。
    setSessionTrustAccepted(true)

    // 在信任建立后重置并重新初始化 GrowthBook
    // 。针对登录/注销的防御：清除任何先前的客户端，以便下一
    // 次初始化获取新的认证头。
    resetGrowthBook()
    void initializeGrowthBook()

    // 既然信任已建立，如果尚未预取系统上下文，则现在预取
    void getSystemContext()

    // 如果设置有效，检查是否有任何需要批准的 mcp.json 服务器
    const { errors: allErrors } = getSettingsWithAllErrors()
    if (allErrors.length === 0) {
      await handleMcpjsonServerApprovals(root)
    }

    // 检查是否有需要批准的 claude.md 包含项
    if (await shouldShowClaudeMdExternalIncludesWarning()) {
      const externalIncludes = getExternalClaudeMdIncludes(
        await getMemoryFiles(true),
      )
      const { ClaudeMdExternalIncludesDialog } = await import(
        './components/ClaudeMdExternalIncludesDialog.js'
      )
      await showSetupDialog(root, done => (
        <ClaudeMdExternalIncludesDialog
          onDone={done}
          isStandaloneDialog
          externalIncludes={externalIncludes}
        />
      ))
    }
  }

  // 为传送目录切换（发射后不管）跟踪当前仓库路径
  // 。这必须在信任建立后发生，以防止不受信任的目录污染映射
  void updateGithubRepoPathMapping()
  if (feature('LODESTONE')) {
    updateDeepLinkTerminalPreference()
  }

  // 在信任对话框被接受后或在绕过模式下应用完整的环境变量。
  // 在绕过模式（CI/CD、自动化）下，我们信任环境，因此
  // 应用所有变量。在正常模式下，这发生在信任对
  // 话框被接受后。这包括来自不受信任源的潜在危险环境变量
  applyConfigEnvironmentVariables()

  // 在环境变量应用后初始化遥测，以便 OTEL 端点环境变量和 o
  // telHeadersHelper（需要信任才能执行）可
  // 用。延迟到下一个 tick，以便 OTel 动态导入在首次渲
  // 染后解析，而不是在预渲染微任务队列期间。
  setImmediate(() => initializeTelemetryAfterTrust())

  if (await isQualifiedForGrove()) {
    const { GroveDialog } = await import('src/components/grove/Grove.js')
    const decision = await showSetupDialog<string>(root, done => (
      <GroveDialog
        showIfAlreadyViewed={false}
        location={onboardingShown ? 'onboarding' : 'policy_update_modal'}
        onDone={done}
      />
    ))
    if (decision === 'escape') {
      logEvent('tengu_grove_policy_exited', {})
      gracefulShutdownSync(0)
      return false
    }
  }

  // 检查自定义 API 密钥。在 h
  // omespace 上，ANTHROPIC_API_KEY 会保留在 process.env 中
  // 供子进程使用，但会被 Claude Code 本身忽略（参见 auth.ts）。
  if (process.env.ANTHROPIC_API_KEY && !isRunningOnHomespace()) {
    const customApiKeyTruncated = normalizeApiKeyForConfig(
      process.env.ANTHROPIC_API_KEY,
    )
    const keyStatus = getCustomApiKeyStatus(customApiKeyTruncated)
    if (keyStatus === 'new') {
      const { ApproveApiKey } = await import('./components/ApproveApiKey.js')
      await showSetupDialog<boolean>(
        root,
        done => (
          <ApproveApiKey
            customApiKeyTruncated={customApiKeyTruncated}
            onDone={done}
          />
        ),
        { onChangeAppState },
      )
    }
  }

  if (
    (permissionMode === 'bypassPermissions' ||
      allowDangerouslySkipPermissions) &&
    !hasSkipDangerousModePermissionPrompt()
  ) {
    const { BypassPermissionsModeDialog } = await import(
      './components/BypassPermissionsModeDialog.js'
    )
    await showSetupDialog(root, done => (
      <BypassPermissionsModeDialog onAccept={done} />
    ))
  }

  if (feature('TRANSCRIPT_CLASSIFIER')) {
    // 仅当自动模式实际解析时才显示选择加入对话框——如果门控拒
    // 绝了它（组织不在允许列表中、设置已禁用），为一个不可用
    // 的功能显示同意是没有意义的。verifyAu
    // toModeGateAccess 通知将解释原因。
    if (permissionMode === 'auto' && !hasAutoModeOptIn()) {
      const { AutoModeOptInDialog } = await import(
        './components/AutoModeOptInDialog.js'
      )
      await showSetupDialog(root, done => (
        <AutoModeOptInDialog
          onAccept={done}
          onDecline={() => gracefulShutdownSync(1)}
          declineExits
        />
      ))
    }
  }

  // --dangerously-load-development-channels 确
  // 认。接受后，将开发频道追加到 main.tsx 中已设置的任何 --channel
  // s 列表。组织策略不会被绕过——gateChannelServer() 仍会运行；
  // 此标志仅用于绕过 --channels 已批准服务器的允许列表。
  if (devChannels && devChannels.length > 0) {
    const { DevChannelsDialog } = await import(
      './components/DevChannelsDialog.js'
    )
    await showSetupDialog(root, done => (
      <DevChannelsDialog
        channels={devChannels}
        onAccept={() => {
          // 按条目标记开发条目，以便当两个标志都传递时，允许列表绕
          // 过不会泄漏到 --channels 条目。
          setAllowedChannels([
            ...getAllowedChannels(),
            ...devChannels.map(c => ({ ...c, dev: true })),
          ])
          setHasDevChannels(true)
          void done()
        }}
      />
    ))
  }

  // 为首次在 Chrome 中使用 Claude 的用户显示 Chrome 新手引导
  if (
    claudeInChrome &&
    !getGlobalConfig().hasCompletedClaudeInChromeOnboarding
  ) {
    const { ClaudeInChromeOnboarding } = await import(
      './components/ClaudeInChromeOnboarding.js'
    )
    await showSetupDialog(root, done => (
      <ClaudeInChromeOnboarding onDone={done} />
    ))
  }

  return onboardingShown
}

export function getRenderContext(exitOnCtrlC: boolean): {
  renderOptions: RenderOptions
  getFpsMetrics: () => FpsMetrics | undefined
  stats: StatsStore
} {
  let lastFlickerTime = 0
  const baseOptions = getBaseRenderOptions(exitOnCtrlC)

  // 当 stdin 覆盖激活时记录分析事件
  if (baseOptions.stdin) {
    logEvent('tengu_stdin_interactive', {})
  }

  const fpsTracker = new FpsTracker()
  const stats = createStatsStore()
  setStatsStore(stats)

  // 基准测试模式：设置后，将每帧阶段计时作为 JSONL 追加，供 ben
  // ch/repl-scroll.ts 进行离线分析。捕获完整的 TU
  // I 渲染流水线（yoga → 屏幕缓冲区 → diff → 优化 →
  // stdout），以便任何阶段的性能工作都可以根据真实用户流程进行验证。
  const frameTimingLogPath = process.env.CLAUDE_CODE_FRAME_TIMING_LOG
  return {
    getFpsMetrics: () => fpsTracker.getMetrics(),
    stats,
    renderOptions: {
      ...baseOptions,
      onFrame: event => {
        fpsTracker.record(event.durationMs)
        stats.observe('frame_duration_ms', event.durationMs)
        if (frameTimingLogPath && event.phases) {
          // 仅基准测试的环境变量门控路径：同步写入，以便在突然退出时不会
          // 丢帧。≤60fps 时约 100 字节可忽略不计。rss/c
          // pu 是单次系统调用；cpu 是累积的——基准测试端计算增量。
          const line =
            // eslint-disable-next-line custom-rules/no-direct-json-operations -- 小对象，热基准测试路径
            JSON.stringify({
              total: event.durationMs,
              ...event.phases,
              rss: process.memoryUsage.rss(),
              cpu: process.cpuUsage(),
            }) + '\n'
          // eslint-disable-next-line custom-rules/no-sync-fs -- 仅基准测试，同步以便退出时不丢帧
          appendFileSync(frameTimingLogPath, line)
        }
        // 为具有同步输出的终端跳过闪烁报告——DEC 2026 在
        // BSU/ESU 之间缓冲，因此清除+重绘是原子的。
        if (isSynchronizedOutputSupported()) {
          return
        }
        for (const flicker of event.flickers) {
          if (flicker.reason === 'resize') {
            continue
          }
          const now = Date.now()
          if (now - lastFlickerTime < 1000) {
            logEvent('tengu_flicker', {
              desiredHeight: flicker.desiredHeight,
              actualHeight: flicker.availableHeight,
              reason: flicker.reason,
            } as unknown as Record<string, boolean | number | undefined>)
          }
          lastFlickerTime = now
        }
      },
    },
  }
}
