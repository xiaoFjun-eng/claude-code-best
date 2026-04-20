/** 用于展示智能体信息的共享工具。
供 CLI `claude agents` 处理器和交互式 `/agents` 命令共同使用。 */

import { getDefaultSubagentModel } from 'src/utils/model/agent.js'
import {
  getSourceDisplayName,
  type SettingSource,
} from 'src/utils/settings/constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'

type AgentSource = SettingSource | 'built-in' | 'plugin'

export type AgentSourceGroup = {
  label: string
  source: AgentSource
}

/** 用于展示的智能体来源组的有序列表。
CLI 和交互式 UI 都应使用此列表以确保排序一致。 */
export const AGENT_SOURCE_GROUPS: AgentSourceGroup[] = [
  { label: '用户智能体', source: 'userSettings' },
  { label: '项目智能体', source: 'projectSettings' },
  { label: '本地智能体', source: 'localSettings' },
  { label: '托管智能体', source: 'policySettings' },
  { label: '插件智能体', source: 'plugin' },
  { label: 'CLI 参数智能体', source: 'flagSettings' },
  { label: '内置智能体', source: 'built-in' },
]

export type ResolvedAgent = AgentDefinition & {
  overriddenBy?: AgentSource
}

/** 通过与当前活动（胜出）智能体列表进行比较，为智能体添加覆盖信息注释。当一个来自更高优先级来源的同类型智能体获得优先权时，原智能体即被“覆盖”。

同时，通过 (agentType, source) 进行去重，以处理 git worktree 中从工作树和主仓库同时加载同一智能体文件的重复情况。 */
export function resolveAgentOverrides(
  allAgents: AgentDefinition[],
  activeAgents: AgentDefinition[],
): ResolvedAgent[] {
  const activeMap = new Map<string, AgentDefinition>()
  for (const agent of activeAgents) {
    activeMap.set(agent.agentType, agent)
  }

  const seen = new Set<string>()
  const resolved: ResolvedAgent[] = []

  // 遍历所有智能体，根据活动智能体列表为每个智能体添加覆盖信息注释。通过 (agent
  // Type, source) 进行去重，以处理 git worktree 重复项。
  for (const agent of allAgents) {
    const key = `${agent.agentType}:${agent.source}`
    if (seen.has(key)) continue
    seen.add(key)

    const active = activeMap.get(agent.agentType)
    const overriddenBy =
      active && active.source !== agent.source ? active.source : undefined
    resolved.push({ ...agent, overriddenBy })
  }

  return resolved
}

/** 解析智能体的显示模型字符串。
返回模型别名或用于显示的 'inherit'。 */
export function resolveAgentModelDisplay(
  agent: AgentDefinition,
): string | undefined {
  const model = agent.model || getDefaultSubagentModel()
  if (!model) return undefined
  return model === 'inherit' ? 'inherit' : model
}

/** 获取覆盖某个智能体的来源的可读标签。
返回小写形式，例如 "user"、"project"、"managed"。 */
export function getOverrideSourceLabel(source: AgentSource): string {
  return getSourceDisplayName(source).toLowerCase()
}

/** 按名称（不区分大小写）对智能体进行字母顺序比较。 */
export function compareAgentsByName(
  a: AgentDefinition,
  b: AgentDefinition,
): number {
  return a.agentType.localeCompare(b.agentType, undefined, {
    sensitivity: 'base',
  })
}
