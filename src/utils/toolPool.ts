import { feature } from 'bun:bundle'
import partition from 'lodash-es/partition.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { COORDINATOR_MODE_ALLOWED_TOOLS } from '../constants/tools.js'
import { isMcpTool } from '../services/mcp/utils.js'
import type { Tool, ToolPermissionContext, Tools } from '../Tool.js'

// 用于 PR 活动订阅的 MCP 工具名称后缀。这些是
// 协调器直接调用的轻量级编排操作，而非委托给工作器。通
// 过后缀匹配，因为 MCP 服务器名称前缀可能不同。
const PR_ACTIVITY_TOOL_SUFFIXES = [
  'subscribe_pr_activity',
  'unsubscribe_pr_activity',
]

export function isPrActivitySubscriptionTool(name: string): boolean {
  return PR_ACTIVITY_TOOL_SUFFIXES.some(suffix => name.endsWith(suffix))
}

// 死代码消除：针对功能门控模块的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/** * 将工具数组过滤为协调器模式下允许的集合。
 * 在 REPL 路径（mergeAndFilterTools）和无头路径（main.tsx）之间共享，以保持两者同步。
 *
 * PR 活动订阅工具始终允许，因为订阅管理属于编排操作。 */
export function applyCoordinatorToolFilter(tools: Tools): Tools {
  return tools.filter(
    t =>
      COORDINATOR_MODE_ALLOWED_TOOLS.has(t.name) ||
      isPrActivitySubscriptionTool(t.name),
  )
}

/** * 合并工具池并应用协调器模式过滤的纯函数。
 *
 * 位于无 React 的文件中，以便 print.ts 可以导入它，而不会将 react/ink 拉入 SDK 模块图。useMergedTools 钩子在 useMemo 内部委托给此函数。
 *
 * @param initialTools - 要包含的额外工具（内置工具 + 来自 props 的启动 MCP）。
 * @param assembled - 来自 assembleToolPool 的工具（内置工具 + MCP，已去重）。
 * @param mode - 权限上下文模式。
 * @returns 合并、去重并经过协调器过滤的工具数组。 */
export function mergeAndFilterTools(
  initialTools: Tools,
  assembled: Tools,
  mode: ToolPermissionContext['mode'],
): Tools {
  // 将 initialTools 合并到顶部——它们在去重时具有优先权
  // 。initialTools 可能包含与 assembled 工具重叠的内置工
  // 具（来自 REPL.tsx 中的 getTools()）。uni
  // qBy 处理此去重。分区排序以确保提示缓存的稳定性（与 assembl
  // eToolPool 相同）：内置工具必须保持为服务器缓存策略的连续前缀。
  const [mcp, builtIn] = partition(
    uniqBy([...initialTools, ...assembled], 'name'),
    isMcpTool,
  )
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  const tools = [...builtIn.sort(byName), ...mcp.sort(byName)]

  if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
    if (coordinatorModeModule.isCoordinatorMode()) {
      return applyCoordinatorToolFilter(tools)
    }
  }

  return tools
}
