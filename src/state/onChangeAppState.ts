import { setMainLoopModelOverride } from '../bootstrap/state.js'
import {
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearGcpCredentialsCache,
} from '../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { toError } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { applyConfigEnvironmentVariables } from '../utils/managedEnv.js'
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from '../utils/permissions/PermissionMode.js'
import {
  notifyPermissionModeChanged,
  notifySessionMetadataChanged,
  type SessionExternalMetadata,
} from '../utils/sessionState.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import type { AppState } from './AppStateStore.js'

// 下方推送的逆操作——在 worker 重启时恢复。
export function externalMetadataToAppState(
  metadata: SessionExternalMetadata,
): (prev: AppState) => AppState {
  return prev => ({
    ...prev,
    ...(typeof metadata.permission_mode === 'string'
      ? {
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            mode: permissionModeFromString(metadata.permission_mode),
          },
        }
      : {}),
    ...(typeof metadata.is_ultraplan_mode === 'boolean'
      ? { isUltraplanMode: metadata.is_ultraplan_mode }
      : {}),
  })
}

export function onChangeAppState({
  newState,
  oldState,
}: {
  newState: AppState
  oldState: AppState
}) {
  // toolPermissionContext.mode —— CCR/SDK 模式同步的单一控制点。
  //
  // 在此代码块之前，模式变更仅通过 8 个以上变更路径中的 2 个传递给 CCR：print
  // .ts 中的一个定制 setAppState 包装器（仅限 headless/SDK 模式）
  // 以及 set_permission_mode 处理器中的一个手动通知。其他所有路径—
  // —Shift+Tab 循环切换、ExitPlanModePermissionReque
  // st 对话框选项、/plan 斜杠命令、rewind、REPL 桥的 onSetPe
  // rmissionMode——都修改了 AppState 而未通知 CC
  // R，导致 external_metadata.permission_mode 数据过时，且
  // Web UI 与 CLI 的实际模式不同步。
  //
  // 在此处挂钩 diff 意味着任何更改模式的 setAppState 调用都会通知 CCR（
  // 通过 notifySessionMetadataChanged → ccrClient.repo
  // rtMetadata）和 SDK 状态流（通过 notifyPermissionModeCh
  // anged → 在 print.ts 中注册）。上述分散的调用点无需任何更改。
  const prevMode = oldState.toolPermissionContext.mode
  const newMode = newState.toolPermissionContext.mode
  if (prevMode !== newMode) {
    // CCR external_metadata 不得接收仅限内部的模式名称（bu
    // bble, ungated auto）。首先进行外部化——如果
    // 外部模式未更改，则跳过 CCR 通知（例如，default→bub
    // ble→default 从 CCR 的视角看是噪音，因为两者都外部化
    // 为 'default'）。SDK 通道（notifyPermissionModeCha
    // nged）传递原始模式；其在 print.ts 中的监听器会应用自己的过滤器。
    const prevExternal = toExternalPermissionMode(prevMode)
    const newExternal = toExternalPermissionMode(newMode)
    if (prevExternal !== newExternal) {
      // Ultraplan = 仅首次计划周期。初始的 control_requ
      // est 原子性地设置模式和 isUltraplanMode，因此
      // 该标志的转换控制着它。null 根据 RFC 7396（移除该键）。
      const isUltraplan =
        newExternal === 'plan' &&
        newState.isUltraplanMode &&
        !oldState.isUltraplanMode
          ? true
          : null
      notifySessionMetadataChanged({
        permission_mode: newExternal,
        is_ultraplan_mode: isUltraplan,
      })
    }
    notifyPermissionModeChanged(newMode)
  }

  // mainLoopModel：将其从设置中移除？
  if (
    newState.mainLoopModel !== oldState.mainLoopModel &&
    newState.mainLoopModel === null
  ) {
    // 从设置中移除
    updateSettingsForSource('userSettings', { model: undefined })
    setMainLoopModelOverride(null)
  }

  // mainLoopModel：将其添加到设置中？
  if (
    newState.mainLoopModel !== oldState.mainLoopModel &&
    newState.mainLoopModel !== null
  ) {
    // 保存到设置
    updateSettingsForSource('userSettings', { model: newState.mainLoopModel })
    setMainLoopModelOverride(newState.mainLoopModel)
  }

  // expandedView → 持久化为 showExpandedTodos + showSpinnerTree 以实现向后兼容
  if (newState.expandedView !== oldState.expandedView) {
    const showExpandedTodos = newState.expandedView === 'tasks'
    const showSpinnerTree = newState.expandedView === 'teammates'
    if (
      getGlobalConfig().showExpandedTodos !== showExpandedTodos ||
      getGlobalConfig().showSpinnerTree !== showSpinnerTree
    ) {
      saveGlobalConfig(current => ({
        ...current,
        showExpandedTodos,
        showSpinnerTree,
      }))
    }
  }

  // verbose
  if (
    newState.verbose !== oldState.verbose &&
    getGlobalConfig().verbose !== newState.verbose
  ) {
    const verbose = newState.verbose
    saveGlobalConfig(current => ({
      ...current,
      verbose,
    }))
  }

  // tungstenPanelVisible（仅限 ant 的 tmux 面板粘性切换）
  if (process.env.USER_TYPE === 'ant') {
    if (
      newState.tungstenPanelVisible !== oldState.tungstenPanelVisible &&
      newState.tungstenPanelVisible !== undefined &&
      getGlobalConfig().tungstenPanelVisible !== newState.tungstenPanelVisible
    ) {
      const tungstenPanelVisible = newState.tungstenPanelVisible
      saveGlobalConfig(current => ({ ...current, tungstenPanelVisible }))
    }
  }

  // 设置：当设置更改时清除与认证相关的缓存 这确保
  // apiKeyHelper 和 AWS/GCP 凭据更改立即生效
  if (newState.settings !== oldState.settings) {
    try {
      clearApiKeyHelperCache()
      clearAwsCredentialsCache()
      clearGcpCredentialsCache()

      // 当 settings.env 更改时重新应用
      // 环境变量 这是仅添加操作：添加新变量，现有变量可能被覆盖，不删除任何内容
      if (newState.settings.env !== oldState.settings.env) {
        applyConfigEnvironmentVariables()
      }
    } catch (error) {
      logError(toError(error))
    }
  }
}
