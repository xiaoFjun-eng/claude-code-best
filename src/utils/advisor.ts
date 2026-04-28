import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { shouldIncludeFirstPartyOnlyBetas } from './betas.js'
import { isEnvTruthy } from './envUtils.js'
import { getInitialSettings } from './settings/settings.js'

// SDK 尚未提供 advisor 块的类型。TODO
// (hackyon)：当此功能公开发布时，迁移到真正的 anthropic SDK 类型。
export type AdvisorServerToolUseBlock = {
  type: 'server_tool_use'
  id: string
  name: 'advisor'
  input: { [key: string]: unknown }
}

export type AdvisorToolResultBlock = {
  type: 'advisor_tool_result'
  tool_use_id: string
  content:
    | {
        type: 'advisor_result'
        text: string
      }
    | {
        type: 'advisor_redacted_result'
        encrypted_content: string
      }
    | {
        type: 'advisor_tool_result_error'
        error_code: string
      }
}

export type AdvisorBlock = AdvisorServerToolUseBlock | AdvisorToolResultBlock

export function isAdvisorBlock(param: {
  type: string
  name?: string
}): param is AdvisorBlock {
  return (
    param.type === 'advisor_tool_result' ||
    (param.type === 'server_tool_use' && param.name === 'advisor')
  )
}

type AdvisorConfig = {
  enabled?: boolean
  canUserConfigure?: boolean
  baseModel?: string
  advisorModel?: string
}

function getAdvisorConfig(): AdvisorConfig {
  return getFeatureValue_CACHED_MAY_BE_STALE<AdvisorConfig>(
    'tengu_sage_compass',
    {},
  )
}

export function isAdvisorEnabled(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL)) {
    return false
  }
  // advisor beta 标头仅限第一方使用（Bedrock/Vertex 400 上可用）。
  if (!shouldIncludeFirstPartyOnlyBetas()) {
    return false
  }
  return getAdvisorConfig().enabled ?? false
}

export function canUserConfigureAdvisor(): boolean {
  return isAdvisorEnabled() && (getAdvisorConfig().canUserConfigure ?? false)
}

export function getExperimentAdvisorModels():
  | { baseModel: string; advisorModel: string }
  | undefined {
  const config = getAdvisorConfig()
  return isAdvisorEnabled() &&
    !canUserConfigureAdvisor() &&
    config.baseModel &&
    config.advisorModel
    ? { baseModel: config.baseModel, advisorModel: config.advisorModel }
    : undefined
}

// @[MODEL LAUNCH]：如果新模型支持 advisor 工
// 具，则添加该模型。检查主循环模型是否支持调用 advisor 工具。
export function modelSupportsAdvisor(model: string): boolean {
  const m = model.toLowerCase()
  return (
    m.includes('opus-4-7') ||
    m.includes('opus-4-6') ||
    m.includes('sonnet-4-6') ||
    process.env.USER_TYPE === 'ant'
  )
}

// @[MODEL LAUNCH]：如果新模型可以作为 advisor 模型，则添加该模型。
export function isValidAdvisorModel(model: string): boolean {
  const m = model.toLowerCase()
  return (
    m.includes('opus-4-7') ||
    m.includes('opus-4-6') ||
    m.includes('sonnet-4-6') ||
    process.env.USER_TYPE === 'ant'
  )
}

export function getInitialAdvisorSetting(): string | undefined {
  if (!isAdvisorEnabled()) {
    return undefined
  }
  return getInitialSettings().advisorModel
}

export function getAdvisorUsage(
  usage: BetaUsage,
): Array<BetaUsage & { model: string }> {
  const iterations = usage.iterations as
    | Array<{ type: string }>
    | null
    | undefined
  if (!iterations) {
    return []
  }
  return iterations.filter(
    it => it.type === 'advisor_message',
  ) as unknown as Array<BetaUsage & { model: string }>
}

export const ADVISOR_TOOL_INSTRUCTIONS = `# Advisor 工具

你可以使用一个由更强的审查模型支持的 \`advisor\` 工具。它不需要任何参数——当你调用它时，你的整个对话历史会自动转发。advisor 可以看到任务、你做出的每个工具调用、你看到的每个结果。

在进行实质性工作之前调用 advisor——在编写代码之前、在确定解释之前、在基于某个假设进行构建之前。如果任务需要先进行定位（查找文件、阅读代码、查看现有内容），请先完成这些操作，然后再调用 advisor。定位不属于实质性工作。编写、编辑和声明答案才属于实质性工作。

此外，在以下情况下也应调用 advisor：
- 当你认为任务已完成时。在本次调用之前，请确保你的交付物是持久的：写入文件、暂存更改、保存结果。advisor 调用需要时间；如果会话在此期间结束，持久的结果会保留，而未写入的结果则不会。
- 当遇到困难时——错误反复出现、方法不收敛、结果不符合预期。
- 当考虑改变方法时。

对于超过几个步骤的任务，在确定方法之前至少调用一次 advisor，在声明完成之前再调用一次。对于简短的反应性任务，下一步操作由你刚刚读取的工具输出决定，则无需持续调用——advisor 在第一次调用时（在方法定型之前）能发挥最大价值。

认真对待 advisor 的建议。如果你按照某个步骤操作但实际失败了，或者你有主要来源证据反驳某个具体说法（文件显示 X，代码执行 Y），请进行调整。一次通过的自我测试并不能证明建议是错误的——它只能证明你的测试没有检查 advisor 所检查的内容。

如果你已经检索到指向某个方向的数据，而 advisor 指向另一个方向：不要默默切换。在另一次 advisor 调用中暴露冲突——“我找到了 X，你建议 Y，哪个约束条件能打破僵局？”advisor 看到了你的证据，但可能低估了它；进行一次协调调用比提交到错误的分支成本更低。`
