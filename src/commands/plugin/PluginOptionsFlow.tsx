/** 安装后/启用后配置提示。

给定一个 LoadedPlugin，检查顶层清单的 userConfig 和特定频道的 userConfig。引导 PluginOptionsDialog 遍历每个未配置项，通过相应的存储函数保存。如果无需填写任何内容，则立即调用 onDone('skipped')。 */

import * as React from 'react'
import type { LoadedPlugin } from '../../types/plugin.js'
import { errorMessage } from '../../utils/errors.js'
import {
  loadMcpServerUserConfig,
  saveMcpServerUserConfig,
} from '../../utils/plugins/mcpbHandler.js'
import {
  getUnconfiguredChannels,
  type UnconfiguredChannel,
} from '../../utils/plugins/mcpPluginIntegration.js'
import { loadAllPlugins } from '../../utils/plugins/pluginLoader.js'
import {
  getUnconfiguredOptions,
  loadPluginOptions,
  type PluginOptionSchema,
  type PluginOptionValues,
  savePluginOptions,
} from '../../utils/plugins/pluginOptionsStorage.js'
import { PluginOptionsDialog } from './PluginOptionsDialog.js'

/** 安装后查找：返回刚安装的 pluginId 对应的 LoadedPlugin，以便调用方可以跳转到 PluginOptionsFlow。如果插件因故未成功加载到新实例中，则返回 undefined —— 调用方将 undefined 视为“继续关闭”。

安装过程应已清除缓存；loadAllPlugins 会读取最新数据。 */
export async function findPluginOptionsTarget(
  pluginId: string,
): Promise<LoadedPlugin | undefined> {
  const { enabled, disabled } = await loadAllPlugins()
  return [...enabled, ...disabled].find(
    p => p.repository === pluginId || p.source === pluginId,
  )
}

/** 遍历过程中的单个对话框步骤。顶层选项和频道配置都归结为此结构 —— 唯一的区别在于运行哪个保存函数。 */
type ConfigStep = {
  key: string
  title: string
  subtitle: string
  schema: PluginOptionSchema
  /** 返回任何已保存的值，以便 PluginOptionsDialog 可以预填充并在重新配置时跳过未更改的敏感字段。 */
  load: () => PluginOptionValues | undefined
  save: (values: PluginOptionValues) => void
}

type Props = {
  plugin: LoadedPlugin
  /** `name@marketplace` —— savePluginOptions / saveMcpServerUserConfig 的键。 */
  pluginId: string
  /** `configured` = 用户填写了所有字段。`skipped` = 无需配置任何内容，或用户点击了取消。`error` = 保存时抛出异常。 */
  onDone: (outcome: 'configured' | 'skipped' | 'error', detail?: string) => void
}

export function PluginOptionsFlow({
  plugin,
  pluginId,
  onDone,
}: Props): React.ReactNode {
  // 在挂载时一次性构建步骤列表。保存后重新调用会丢弃我
  // 们刚刚配置的项。
  const [steps] = React.useState<ConfigStep[]>(() => {
    const result: ConfigStep[] = []

    // 顶层清单的 userConfig
    const unconfigured = getUnconfiguredOptions(plugin)
    if (Object.keys(unconfigured).length > 0) {
      result.push({
        key: 'top-level',
        title: `Configure ${plugin.name}`,
        subtitle: '插件选项',
        schema: unconfigured,
        load: () => loadPluginOptions(pluginId),
        save: values =>
          savePluginOptions(pluginId, values, plugin.manifest.userConfig!),
      })
    }

    // 按频道的 userConfig（助手模式频道）
    const channels: UnconfiguredChannel[] = getUnconfiguredChannels(plugin)
    for (const channel of channels) {
      result.push({
        key: `channel:${channel.server}`,
        title: `Configure ${channel.displayName}`,
        subtitle: `Plugin: ${plugin.name}`,
        schema: channel.configSchema,
        load: () =>
          loadMcpServerUserConfig(pluginId, channel.server) ?? undefined,
        save: values =>
          saveMcpServerUserConfig(
            pluginId,
            channel.server,
            values,
            channel.configSchema,
          ),
      })
    }

    return result
  })

  const [index, setIndex] = React.useState(0)

  // 最新引用：允许 effect 闭包捕获当前的 onDon
  // e，避免父组件重新渲染时重新运行。
  const onDoneRef = React.useRef(onDone)
  onDoneRef.current = onDone

  // 无需配置 → 通知调用方且不渲染任何内容。使用 effect 而
  // 非内联调用：在渲染期间调用父组件的 setState 违反了
  // React 的 Hooks 规则。
  React.useEffect(() => {
    if (steps.length === 0) {
      onDoneRef.current('skipped')
    }
  }, [steps.length])

  if (steps.length === 0) {
    return null
  }

  const current = steps[index]!

  function handleSave(values: PluginOptionValues): void {
    try {
      current.save(values)
    } catch (err) {
      onDone('error', errorMessage(err))
      return
    }
    const next = index + 1
    if (next < steps.length) {
      setIndex(next)
    } else {
      onDone('configured')
    }
  }

  // key 在前进到下一步时强制重新挂载 —— 否则 React
  // 会复用实例并保留 PluginOptionsDialog
  // 内部的 useState（字段索引、输入值）。
  return (
    <PluginOptionsDialog
      key={current.key}
      title={current.title}
      subtitle={current.subtitle}
      configSchema={current.schema}
      initialValues={current.load()}
      onSave={handleSave}
      onCancel={() => onDone('skipped')}
    />
  )
}
