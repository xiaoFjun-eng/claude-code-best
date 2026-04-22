import { feature } from 'bun:bundle'
import { isReplBridgeActive } from 'src/bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import type { Tool } from 'src/Tool.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'

// 死代码消除：仅在启用 KAIROS 或 KAIROS_BRIEF 时需要 Brief 工具名称
/* eslint-disable @typescript-eslint/no-require-imports */
const BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('../BriefTool/prompt.js') as typeof import('../BriefTool/prompt.js')
      ).BRIEF_TOOL_NAME
    : null
const SEND_USER_FILE_TOOL_NAME: string | null = feature('KAIROS')
  ? (
      require('../SendUserFileTool/prompt.js') as typeof import('../SendUserFileTool/prompt.js')
    ).SEND_USER_FILE_TOOL_NAME
  : null

/* eslint-enable @typescript-eslint/no-require-imports */

export { TOOL_SEARCH_TOOL_NAME } from './constants.js'

import { TOOL_SEARCH_TOOL_NAME } from './constants.js'

const PROMPT_HEAD = `获取被延迟加载（deferred）的工具的完整 schema 定义，使其变为可调用。

`

// 匹配 toolSearch.ts 中的 isDeferredToolsDeltaEnabled（未导入 — toolSearch.ts 从本文件导入）。
// 启用时：工具通过 system-reminder 附件宣布。禁用时：使用前置的 <available-deferred-tools> 块（门控前的行为）。
function getToolLocationHint(): string {
  const deltaEnabled =
    process.env.USER_TYPE === 'ant' ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_glacier_2xr', false)
  return deltaEnabled
    ? '延迟工具会以名称的形式出现在 <system-reminder> 消息中。'
    : '延迟工具会以名称的形式出现在 <available-deferred-tools> 消息中。'
}

const PROMPT_TAIL = `在被获取之前，系统只知道工具名称——没有参数 schema，因此工具无法被调用。该工具接收一个 query，将其与延迟工具列表进行匹配，并在一个 <functions> 块内返回匹配到的工具的完整 JSONSchema 定义。一旦某个工具的 schema 出现在结果中，它就可以像提示顶部定义的任何工具一样被调用。

结果格式：每个匹配到的工具会以一行 <function>{"description": "...", "name": "...", "parameters": {...}}</function> 的形式出现在 <functions> 块中——编码方式与提示顶部的工具列表一致。

query 形式：
- "select:Read,Edit,Grep"：按名称精确获取这些工具
- "notebook jupyter"：关键词搜索，返回最多 max_results 个最佳匹配
- "+slack send"：要求名称中包含 "slack"，并用剩余关键词进行排序`

/**
 * 检查某个工具是否应该被延迟（需要 ToolSearch 来加载）。
 * 满足以下条件之一的工具会被延迟：
 * - 它是 MCP 工具（总是延迟 —— 工作流相关）
 * - 它具有 shouldDefer: true
 *
 * 如果工具具有 alwaysLoad: true，则永远不会被延迟（MCP 工具通过 _meta['anthropic/alwaysLoad'] 设置此项）。
 * 此检查最先执行，在所有其他规则之前。
 */
export function isDeferredTool(tool: Tool): boolean {
  // 通过 _meta['anthropic/alwaysLoad'] 显式退出 —— 工具会以完整 schema 出现在初始提示中。
  // 首先检查，以便 MCP 工具可以选择退出。
  if (tool.alwaysLoad === true) return false

  // MCP 工具总是被延迟（工作流相关）
  if (tool.isMcp === true) return true

  // 永远不要延迟 ToolSearch 本身 —— 模型需要它来加载其他所有工具
  if (tool.name === TOOL_SEARCH_TOOL_NAME) return false

  // Fork 优先实验：Agent 必须在第一轮就可用，不能放在 ToolSearch 后面。
  // 懒加载：静态导入 forkSubagent → coordinatorMode 会在模块初始化时通过 constants/tools.ts 产生循环依赖。
  if (feature('FORK_SUBAGENT') && tool.name === AGENT_TOOL_NAME) {
    type ForkMod = typeof import('../AgentTool/forkSubagent.js')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('../AgentTool/forkSubagent.js') as ForkMod
    if (m.isForkSubagentEnabled()) return false
  }

  // Brief 是工具存在时的主要通信通道。
  // 其提示包含了文本可见性约定，模型必须在不经过 ToolSearch 往返的情况下看到它。
  // 此处不需要运行时门控：此工具的 isEnabled() 就是 isBriefEnabled()，因此询问其延迟状态意味着门控已经通过。
  if (
    (feature('KAIROS') || feature('KAIROS_BRIEF')) &&
    BRIEF_TOOL_NAME &&
    tool.name === BRIEF_TOOL_NAME
  ) {
    return false
  }

  // SendUserFile 是一个文件交付通信通道（与 Brief 类似）。
  // 必须立即可用，不能经过 ToolSearch 往返。
  if (
    feature('KAIROS') &&
    SEND_USER_FILE_TOOL_NAME &&
    tool.name === SEND_USER_FILE_TOOL_NAME &&
    isReplBridgeActive()
  ) {
    return false
  }

  return tool.shouldDefer === true
}

/**
 * 为 <available-deferred-tools> 用户消息格式化一行延迟工具信息。
 * 搜索提示（tool.searchHint）不会被渲染 —— 提示 A/B 测试（exp_xenhnnmn0smrx4，已于 3 月 21 日停止）未显示任何收益。
 */
export function formatDeferredToolLine(tool: Tool): string {
  return tool.name
}

export function getPrompt(): string {
  return PROMPT_HEAD + getToolLocationHint() + PROMPT_TAIL
}