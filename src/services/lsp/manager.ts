import { logForDebugging } from '../../utils/debug.js'
import { isBareMode } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import {
  createLSPServerManager,
  type LSPServerManager,
} from './LSPServerManager.js'
import { registerLSPNotificationHandlers } from './passiveFeedback.js'

/** LSP服务器管理器的初始化状态 */
type InitializationState = 'not-started' | 'pending' | 'success' | 'failed'

/** LSP服务器管理器的全局单例实例。
在Claude Code启动期间初始化。 */
let lspManagerInstance: LSPServerManager | undefined

/** 当前初始化状态 */
let initializationState: InitializationState = 'not-started'

/** 上次初始化尝试的错误（如果有） */
let initializationError: Error | undefined

/** 生成计数器，防止过期的初始化Promise更新状态 */
let initializationGeneration = 0

/** 初始化完成（成功或失败）时resolve的Promise */
let initializationPromise: Promise<void> | undefined

/** 仅用于测试的同步重置。shutdownLspServerManager()是异步的，会关闭
真实连接；此函数仅清除模块作用域的单例状态，以便
reinitializeLspServerManager()在下游同一分片上的测试中
因状态为'not-started'而提前返回。 */
export function _resetLspManagerForTesting(): void {
  initializationState = 'not-started'
  initializationError = undefined
  initializationPromise = undefined
  initializationGeneration++
}

/** 获取单例的LSP服务器管理器实例。
如果尚未初始化、初始化失败或仍在进行中，则返回undefined。

调用方应检查undefined并优雅处理，因为初始化在Claude Code启动期间
异步进行。使用getInitializationStatus()来区分pending、failed和not-started状态。 */
export function getLspServerManager(): LSPServerManager | undefined {
  // 如果初始化失败，不返回损坏的实例
  if (initializationState === 'failed') {
    return undefined
  }
  return lspManagerInstance
}

/** 获取LSP服务器管理器的当前初始化状态。

@returns 包含当前状态和错误（如果失败）的状态对象 */
export function getInitializationStatus():
  | { status: 'not-started' }
  | { status: 'pending' }
  | { status: 'success' }
  | { status: 'failed'; error: Error } {
  if (initializationState === 'failed') {
    return {
      status: 'failed',
      error: initializationError || new Error('初始化失败'),
    }
  }
  if (initializationState === 'not-started') {
    return { status: 'not-started' }
  }
  if (initializationState === 'pending') {
    return { status: 'pending' }
  }
  return { status: 'success' }
}

/** 检查是否至少有一个语言服务器已连接且健康。
支持LSPTool.isEnabled()。 */
export function isLspConnected(): boolean {
  if (initializationState === 'failed') return false
  const manager = getLspServerManager()
  if (!manager) return false
  const servers = manager.getAllServers()
  if (servers.size === 0) return false
  for (const server of servers.values()) {
    if (server.state !== 'error') return true
  }
  return false
}

/** 等待LSP服务器管理器初始化完成。

如果初始化已完成（成功或失败），则立即返回。
如果初始化正在进行中，则等待其完成。
如果初始化尚未开始，则立即返回。

@returns 初始化完成时resolve的Promise */
export async function waitForInitialization(): Promise<void> {
  // 如果已初始化或已失败，立即返回
  if (initializationState === 'success' || initializationState === 'failed') {
    return
  }

  // 如果正在进行中且有Promise，则等待它
  if (initializationState === 'pending' && initializationPromise) {
    await initializationPromise
  }

  // 如果尚未开始，立即返回（无需等待）
}

/** 初始化LSP服务器管理器单例。

此函数在Claude Code启动期间调用。它会同步创建管理器实例，
然后在后台启动异步初始化（加载LSP配置），而不阻塞启动过程。

可安全多次调用——只会初始化一次（幂等）。
但如果之前初始化失败，再次调用将重试。 */
export function initializeLspServerManager(): void {
  // --bare / SIMPLE：无LSP。LSP用于编辑器集成（
  // 诊断、悬停、在REPL中跳转到定义）。脚本化的-p调用不需要它。
  if (isBareMode()) {
    return
  }
  logForDebugging('[LSP管理器] 调用了initializeLspServerManager()')

  // 如果已初始化或正在初始化，则跳过
  if (lspManagerInstance !== undefined && initializationState !== 'failed') {
    logForDebugging(
      '[LSP管理器] 已初始化或正在初始化，跳过',
    )
    return
  }

  // 如果之前初始化失败，重置状态以进行重试
  if (initializationState === 'failed') {
    lspManagerInstance = undefined
    initializationError = undefined
  }

  // 创建管理器实例并标记为pending
  lspManagerInstance = createLSPServerManager()
  initializationState = 'pending'
  logForDebugging('[LSP管理器] 已创建管理器实例，状态=pending')

  // 递增生成计数器以使任何待处理的初始化失效
  const currentGeneration = ++initializationGeneration
  logForDebugging(
    `[LSP管理器] 开始异步初始化（生成${currentGeneration}）`,
  )

  // 异步启动初始化而不阻塞。存储Promise，以便
  // 调用方可以通过waitForInitialization()等待它
  initializationPromise = lspManagerInstance
    .initialize()
    .then(() => {
      // 仅当这仍然是当前初始化时才更新状态
      if (currentGeneration === initializationGeneration) {
        initializationState = 'success'
        logForDebugging('LSP服务器管理器初始化成功')

        // 注册诊断的被动通知处理器
        if (lspManagerInstance) {
          registerLSPNotificationHandlers(lspManagerInstance)
        }
      }
    })
    .catch((error: unknown) => {
      // 仅当这仍然是当前初始化时才更新状态
      if (currentGeneration === initializationGeneration) {
        initializationState = 'failed'
        initializationError = error as Error
        // 清除实例，因为它不可用
        lspManagerInstance = undefined

        logError(error as Error)
        logForDebugging(
          `初始化LSP服务器管理器失败：${errorMessage(error)}`,
        )
      }
    })
}

/** 强制重新初始化LSP服务器管理器，即使之前已成功初始化。
在插件缓存清除后从refreshActivePlugins()调用，以便新加载的插件LSP服务器
被拾取。

修复https://github.com/anthropics/claude-code/issues/15521：
loadAllPlugins()是带记忆的，可能在启动早期（通过setup.ts中的
getCommands预取）在市场协调之前被调用，从而缓存了空的插件列表。
然后initializeLspServerManager()读取那个过时的记忆化结果，
并用0个服务器进行初始化。与commands/agents/hooks/MCP不同，
LSP在插件刷新时从未被重新初始化。

当没有LSP插件更改时调用是安全的：initialize()只是配置解析
（服务器在首次使用时懒启动）。在pending初始化期间也是安全的：
生成计数器会使正在进行的Promise失效。 */
export function reinitializeLspServerManager(): void {
  if (initializationState === 'not-started') {
    // initializeLspServerManager()从未被调用（例如无头子
    // 命令路径）。现在不要启动它。
    return
  }

  logForDebugging('[LSP管理器] 调用了reinitializeLspServerManager()')

  // 尽力关闭旧实例上任何正在运行的服务器，以便/reloa
  // d-plugins不会泄漏子进程。即发即弃：主要用例（
  // issue #15521）有0个服务器，因此这通常是无操作。
  if (lspManagerInstance) {
    void lspManagerInstance.shutdown().catch(err => {
      logForDebugging(
        `[LSP管理器] 重新初始化期间旧实例关闭失败：${errorMessage(err)}`,
      )
    })
  }

  // 强制initializeLspServerManager()
  // 中的幂等检查通过。生成计数器处理使任何正在进行的初始化失效。
  lspManagerInstance = undefined
  initializationState = 'not-started'
  initializationError = undefined

  initializeLspServerManager()
}

/** 关闭LSP服务器管理器并清理资源。

应在Claude Code关闭期间调用。停止所有正在运行的LSP服务器
并清除内部状态。未初始化时调用是安全的（无操作）。

注意：关闭期间的错误会被记录用于监控，但不会传播给调用方。
即使关闭失败，状态也始终会被清除，以防止资源累积。
这在应用程序退出且无法恢复时是可以接受的。

@returns 关闭完成时resolve的Promise（错误被吞掉） */
export async function shutdownLspServerManager(): Promise<void> {
  if (lspManagerInstance === undefined) {
    return
  }

  try {
    await lspManagerInstance.shutdown()
    logForDebugging('LSP服务器管理器关闭成功')
  } catch (error: unknown) {
    logError(error as Error)
    logForDebugging(
      `关闭LSP服务器管理器失败：${errorMessage(error)}`,
    )
  } finally {
    // 即使关闭失败也始终清除状态
    lspManagerInstance = undefined
    initializationState = 'not-started'
    initializationError = undefined
    initializationPromise = undefined
    // 递增生成计数器以使任何待处理的初始化失效
    initializationGeneration++
  }
}
