import { feature } from 'bun:bundle'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { redownloadUserSettings } from '../../services/settingsSync/index.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { refreshActivePlugins } from '../../utils/plugins/refresh.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { plural } from '../../utils/stringUtils.js'

export const call: LocalCommandCall = async (_args, context) => {
  // CCR：在缓存清理前重新拉取用户设置，以便从用户本地 CLI（setti
  // ngsSync）推送的 enabledPlugins / extraKn
  // ownMarketplaces 生效。非 CCR 无头进程（例如 vsc
  // ode SDK 子进程）与写入设置的一方共享磁盘——文件监视器会传递变
  // 更，此处无需重新拉取。
  //
  // 托管设置有意不重新获取：它已每小时轮询一次（POLLING
  // _INTERVAL_MS），且策略执行在设计上是最终一致的
  // （获取失败时回退到陈旧缓存）。交互式 /reload
  // -plugins 也从未重新获取过它。
  //
  // 不重试：用户发起的命令，尝试一次 + 失败开放。用户可以重新运行
  // /reload-plugins 来重试。启动路径保留其重试机制。
  if (
    feature('DOWNLOAD_USER_SETTINGS') &&
    (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) || getIsRemoteMode())
  ) {
    const applied = await redownloadUserSettings()
    // applyRemoteEntriesToLocal 使用 markInternal
    // Write 来抑制文件监视器（适用于启动时，尚无监听器）；在此处触发 notify
    // Change，以便会话中的 applySettingsChange 运行。
    if (applied) {
      settingsChangeDetector.notifyChange('userSettings')
    }
  }

  const r = await refreshActivePlugins(context.setAppState)

  const parts = [
    n(r.enabled_count, 'plugin'),
    n(r.command_count, 'skill'),
    n(r.agent_count, 'agent'),
    n(r.hook_count, 'hook'),
    // “插件 MCP/LSP”用于区分用户配置/内置服务器，/reloa
    // d-plugins 不触及后者。命令/钩子仅适用于插件；agent_c
    // ount 是总代理数（包括内置代理）。(gh-31321)
    n(r.mcp_count, '插件 MCP 服务器'),
    n(r.lsp_count, '插件 LSP 服务器'),
  ]
  let msg = `Reloaded: ${parts.join(' · ')}`

  if (r.error_count > 0) {
    msg += `
加载期间 ${n(r.error_count, 'error')}。运行 /doctor 查看详情。`
  }

  return { type: 'text', value: msg }
}

function n(count: number, noun: string): string {
  return `${count} ${plural(count, noun)}`
}
