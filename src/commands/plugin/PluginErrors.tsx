import { getPluginErrorMessage, type PluginError } from '../../types/plugin.js'

export function formatErrorMessage(error: PluginError): string {
  switch (error.type) {
    case 'path-not-found':
      return `未找到路径 ${error.component}: ${error.path}`
    case 'git-auth-failed':
      return `Git ${error.authType.toUpperCase()} 认证失败，目标：${error.gitUrl}`
    case 'git-timeout':
      return `Git ${error.operation} 操作超时，目标：${error.gitUrl}`
    case 'network-error':
      return `访问 ${error.url}${error.details ? `: ${error.details}` : ''} 时发生网络错误`
    case 'manifest-parse-error':
      return `解析清单失败，位置：${error.manifestPath}，错误：${error.parseError}`
    case 'manifest-validation-error':
      return `清单无效，位置：${error.manifestPath}，错误：${error.validationErrors.join(', ')}`
    case 'plugin-not-found':
      return `在市场 "${error.marketplace}" 中未找到插件 "${error.pluginId}"`
    case 'marketplace-not-found':
      return `未找到市场 "${error.marketplace}"`
    case 'marketplace-load-failed':
      return `加载市场 "${error.marketplace}" 失败：${error.reason}`
    case 'mcp-config-invalid':
      return `MCP 服务器配置无效，插件："${error.serverName}"，错误：${error.validationError}`
    case 'mcp-server-suppressed-duplicate': {
      const dup = error.duplicateOf.startsWith('plugin:')
        ? `由插件 "${error.duplicateOf.split(':')[1] ?? '?'}" 提供的服务器`
        : `已配置的 "${error.duplicateOf}"`
      return `MCP 服务器 "${error.serverName}" 已跳过 — 其命令/URL 与 ${dup} 相同`
    }
    case 'hook-load-failed':
      return `从 ${error.hookPath} 加载钩子失败：${error.reason}`
    case 'component-load-failed':
      return `从 ${error.path} 加载 ${error.component} 失败：${error.reason}`
    case 'mcpb-download-failed':
      return `从 ${error.url} 下载 MCPB 失败：${error.reason}`
    case 'mcpb-extract-failed':
      return `解压 MCPB ${error.mcpbPath} 失败：${error.reason}`
    case 'mcpb-invalid-manifest':
      return `MCPB 清单无效，位置：${error.mcpbPath}，错误：${error.validationError}`
    case 'marketplace-blocked-by-policy':
      return error.blockedByBlocklist
        ? `市场 "${error.marketplace}" 被企业策略阻止`
        : `市场 "${error.marketplace}" 不在允许的市场列表中`
    case 'dependency-unsatisfied':
      return error.reason === 'not-enabled'
        ? `依赖项 "${error.dependency}" 已被禁用`
        : `依赖项 "${error.dependency}" 未安装`
    case 'lsp-config-invalid':
      return `LSP 服务器配置无效，插件："${error.serverName}"，错误：${error.validationError}`
    case 'lsp-server-start-failed':
      return `LSP 服务器 "${error.serverName}" 启动失败：${error.reason}`
    case 'lsp-server-crashed':
      return error.signal
        ? `LSP 服务器 "${error.serverName}" 因信号 ${error.signal} 而崩溃`
        : `LSP 服务器 "${error.serverName}" 以退出码 ${error.exitCode ?? 'unknown'} 崩溃`
    case 'lsp-request-timeout':
      return `LSP 服务器 "${error.serverName}" 在 ${error.method} 上超时，耗时 ${error.timeoutMs} 毫秒`
    case 'lsp-request-failed':
      return `LSP 服务器 "${error.serverName}" 的 ${error.method} 操作失败：${error.error}`
    case 'plugin-cache-miss':
      return `插件 "${error.plugin}" 未在 ${error.installPath} 处缓存`
    case 'generic-error':
      return error.error
  }
  const _exhaustive: never = error
  return getPluginErrorMessage(_exhaustive)
}

export function getErrorGuidance(error: PluginError): string | null {
  switch (error.type) {
    case 'path-not-found':
      return '请检查清单或市场配置中的路径是否正确'
    case 'git-auth-failed':
      return error.authType === 'ssh'
        ? '配置 SSH 密钥或改用 HTTPS URL'
        : '配置凭据或改用 SSH URL'
    case 'git-timeout':
    case 'network-error':
      return '检查网络连接后重试'
    case 'manifest-parse-error':
      return '检查插件目录中清单文件的语法'
    case 'manifest-validation-error':
      return '检查清单文件是否符合必需的架构'
    case 'plugin-not-found':
      return `插件可能不存在于市场 "${error.marketplace}"`
    case 'marketplace-not-found':
      return error.availableMarketplaces.length > 0
        ? `可用市场：${error.availableMarketplaces.join(', ')}`
        : '请先使用 /plugin marketplace add 添加市场'
    case 'mcp-config-invalid':
      return '检查 .mcp.json 或清单中的 MCP 服务器配置'
    case 'mcp-server-suppressed-duplicate': {
      // 当另一个插件赢得去重时，duplicateOf 为 "plug
      // in:name:srv" — 用户无法从其 MCP 配置中移除插
      // 件提供的服务器，因此请将其指向获胜的插件。
      if (error.duplicateOf.startsWith('plugin:')) {
        const winningPlugin =
          error.duplicateOf.split(':')[1] ?? '另一个插件'
        return `若想使用此插件的版本，请禁用插件 "${winningPlugin}"`
      }
      return `若想使用插件的版本，请从您的 MCP 配置中移除 "${error.duplicateOf}"`
    }
    case 'hook-load-failed':
      return '检查 hooks.json 文件的语法和结构'
    case 'component-load-failed':
      return `检查 ${error.component} 目录结构和文件权限`
    case 'mcpb-download-failed':
      return '检查网络连接和 URL 可访问性'
    case 'mcpb-extract-failed':
      return '验证 MCPB 文件有效且未损坏'
    case 'mcpb-invalid-manifest':
      return '关于无效清单，请联系插件作者'
    case 'marketplace-blocked-by-policy':
      if (error.blockedByBlocklist) {
        return '此市场源已被您的管理员明确阻止'
      }
      return error.allowedSources.length > 0
        ? `允许的源：${error.allowedSources.join(', ')}`
        : '请联系管理员配置允许的市场源'
    case 'dependency-unsatisfied':
      return error.reason === 'not-enabled'
        ? `启用 "${error.dependency}" 或卸载 "${error.plugin}"`
        : `安装 "${error.dependency}" 或卸载 "${error.plugin}"`
    case 'lsp-config-invalid':
      return '检查插件清单中的 LSP 服务器配置'
    case 'lsp-server-start-failed':
    case 'lsp-server-crashed':
    case 'lsp-request-timeout':
    case 'lsp-request-failed':
      return '使用 --debug 检查 LSP 服务器日志以获取详情'
    case 'plugin-cache-miss':
      return '运行 /plugins 刷新插件缓存'
    case 'marketplace-load-failed':
    case 'generic-error':
      return null
  }
  const _exhaustive: never = error
  return null
}
