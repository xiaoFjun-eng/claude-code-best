import { feature } from 'bun:bundle'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { ToolUseContext } from '../Tool.js'
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { isBuiltInAgent } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { isEnvTruthy } from './envUtils.js'
import { asSystemPrompt, type SystemPrompt } from './systemPromptType.js'

export { asSystemPrompt, type SystemPrompt } from './systemPromptType.js'

// 死代码消除：用于主动模式的条件导入。
// 与 prompts.ts 相同的模式 —— 延迟 require 以避免将该模块拉入非主动构建中。
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? (require('../proactive/index.js') as typeof import('../proactive/index.js'))
    : null
/* eslint-enable @typescript-eslint/no-require-imports */

function isProactiveActive_SAFE_TO_CALL_ANYWHERE(): boolean {
  return proactiveModule?.isProactiveActive() ?? false
}

/**
 * 根据优先级构建有效的系统提示数组：
 * 0. 覆盖系统提示（如果设置，例如通过循环模式 - 替换所有其他提示）
 * 1. 协调器系统提示（如果协调器模式处于活动状态）
 * 2. Agent 系统提示（如果设置了 mainThreadAgentDefinition）
 *    - 在主动模式下：agent 提示被追加到默认提示之后（agent 在自主 agent 提示之上添加领域指令，类似于 teammates 的做法）
 *    - 否则：agent 提示替换默认提示
 * 3. 自定义系统提示（如果通过 --system-prompt 指定）
 * 4. 默认系统提示（标准 Claude Code 提示）
 *
 * 此外，如果指定了 appendSystemPrompt，它总是被添加到最后（除非设置了覆盖提示）。
 */
export function buildEffectiveSystemPrompt({
  mainThreadAgentDefinition,
  toolUseContext,
  customSystemPrompt,
  defaultSystemPrompt,
  appendSystemPrompt,
  overrideSystemPrompt,
}: {
  mainThreadAgentDefinition: AgentDefinition | undefined
  toolUseContext: Pick<ToolUseContext, 'options'>
  customSystemPrompt: string | undefined
  defaultSystemPrompt: string[]
  appendSystemPrompt: string | undefined
  overrideSystemPrompt?: string | null
}): SystemPrompt {
  if (overrideSystemPrompt) {
    return asSystemPrompt([overrideSystemPrompt])
  }
  // 协调器模式：使用协调器提示而不是默认提示
  // 使用内联 env 检查而不是 coordinatorModule，以避免测试模块加载期间的循环依赖问题。
  if (
    feature('COORDINATOR_MODE') &&
    isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE) &&
    !mainThreadAgentDefinition
  ) {
    // 延迟 require 以避免在模块加载时产生循环依赖
    const { getCoordinatorSystemPrompt } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js')
    return asSystemPrompt([
      getCoordinatorSystemPrompt(),
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])
  }

  const agentSystemPrompt = mainThreadAgentDefinition
    ? isBuiltInAgent(mainThreadAgentDefinition)
      ? mainThreadAgentDefinition.getSystemPrompt({
          toolUseContext: { options: toolUseContext.options },
        })
      : mainThreadAgentDefinition.getSystemPrompt()
    : undefined

  // 记录主循环 agent 的 agent 记忆加载事件
  if (mainThreadAgentDefinition?.memory) {
    logEvent('tengu_agent_memory_loaded', {
      ...(process.env.USER_TYPE === 'ant' && {
        agent_type:
          mainThreadAgentDefinition.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      scope:
        mainThreadAgentDefinition.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      source:
        'main-thread' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // 在主动模式下，agent 指令被追加到默认提示之后，而不是替换它。
  // 主动模式下的默认提示已经是精简的（自主 agent 身份 + 记忆 + 环境 + 主动部分），而 agent
  // 在此基础上添加特定领域的行为 —— 与 teammates 相同的模式。
  if (
    agentSystemPrompt &&
    (feature('PROACTIVE') || feature('KAIROS')) &&
    isProactiveActive_SAFE_TO_CALL_ANYWHERE()
  ) {
    return asSystemPrompt([
      ...defaultSystemPrompt,
      `\n# 自定义 Agent 指令\n${agentSystemPrompt}`,
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])
  }

  return asSystemPrompt([
    ...(agentSystemPrompt
      ? [agentSystemPrompt]
      : customSystemPrompt
        ? [customSystemPrompt]
        : defaultSystemPrompt),
    ...(appendSystemPrompt ? [appendSystemPrompt] : []),
  ])
}