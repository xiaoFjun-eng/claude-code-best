import { feature } from 'bun:bundle'
import { getIsNonInteractiveSession } from 'src/bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'
import { CLAUDE_CODE_GUIDE_AGENT } from './built-in/claudeCodeGuideAgent.js'
import { EXPLORE_AGENT } from './built-in/exploreAgent.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import { PLAN_AGENT } from './built-in/planAgent.js'
import { STATUSLINE_SETUP_AGENT } from './built-in/statuslineSetup.js'
import { VERIFICATION_AGENT } from './built-in/verificationAgent.js'
import type { AgentDefinition } from './loadAgentsDir.js'

export function areExplorePlanAgentsEnabled(): boolean {
  if (feature('BUILTIN_EXPLORE_PLAN_AGENTS')) {
    // 第三方默认值：true — Bedrock/Vertex 保持代理启用（与实验前的外部行为一致）。
    // A/B 测试处理将值设为 false，以衡量移除代理的影响。
    return getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_stoat', true)
  }
  return false
}

export function getBuiltInAgents(): AgentDefinition[] {
  // 允许通过环境变量禁用所有内置代理（对于希望使用空白状态 SDK 的用户很有用）
  // 仅适用于非交互模式（SDK/API 使用）
  if (
    isEnvTruthy(process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS) &&
    getIsNonInteractiveSession()
  ) {
    return []
  }

  // 在函数体内部使用惰性 require，以避免模块初始化时的循环依赖问题。
  // coordinatorMode 模块依赖于工具，而工具又依赖于 AgentTool，后者会导入此文件。
  if (feature('COORDINATOR_MODE')) {
    if (isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { getCoordinatorAgents } =
        require('src/coordinator/workerAgent.js') as typeof import('src/coordinator/workerAgent.js')
      /* eslint-enable @typescript-eslint/no-require-imports */
      return getCoordinatorAgents()
    }
  }

  const agents: AgentDefinition[] = [
    GENERAL_PURPOSE_AGENT,
    STATUSLINE_SETUP_AGENT,
  ]

  if (areExplorePlanAgentsEnabled()) {
    agents.push(EXPLORE_AGENT, PLAN_AGENT)
  }

  // 为非 SDK 入口点包含代码指南代理
  const isNonSdkEntrypoint =
    process.env.CLAUDE_CODE_ENTRYPOINT !== 'sdk-ts' &&
    process.env.CLAUDE_CODE_ENTRYPOINT !== 'sdk-py' &&
    process.env.CLAUDE_CODE_ENTRYPOINT !== 'sdk-cli'

  if (isNonSdkEntrypoint) {
    agents.push(CLAUDE_CODE_GUIDE_AGENT)
  }

  if (
    feature('VERIFICATION_AGENT') &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false)
  ) {
    agents.push(VERIFICATION_AGENT)
  }

  return agents
}