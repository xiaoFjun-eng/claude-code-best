import { feature } from 'bun:bundle'
import { microcompactMessages } from '../../services/compact/microCompact.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { Tools, ToolUseContext } from '../../Tool.js'
import type { AgentDefinitionsResult } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import type { Message } from '../../types/message.js'
import {
  analyzeContextUsage,
  type ContextData,
} from '../../utils/analyzeContext.js'
import { formatTokens } from '../../utils/format.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import { getSourceDisplayName } from '../../utils/settings/constants.js'
import { plural } from '../../utils/stringUtils.js'

/** `/context`（斜杠命令）与 SDK `get_context_usage` 控制请求共享的数据收集路径。镜像 query.ts 的 API 前转换（紧凑边界、项目视图、微紧凑），使令牌计数反映模型实际所见内容。 */
type CollectContextDataInput = {
  messages: Message[]
  getAppState: () => AppState
  options: {
    mainLoopModel: string
    tools: Tools
    agentDefinitions: AgentDefinitionsResult
    customSystemPrompt?: string
    appendSystemPrompt?: string
  }
}

export async function collectContextData(
  context: CollectContextDataInput,
): Promise<ContextData> {
  const {
    messages,
    getAppState,
    options: {
      mainLoopModel,
      tools,
      agentDefinitions,
      customSystemPrompt,
      appendSystemPrompt,
    },
  } = context

  let apiView = getMessagesAfterCompactBoundary(messages)
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { projectView } =
      require('../../services/contextCollapse/operations.js') as typeof import('../../services/contextCollapse/operations.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    apiView = projectView(apiView)
  }

  const { messages: compactedMessages } = await microcompactMessages(apiView)
  const appState = getAppState()

  return analyzeContextUsage(
    compactedMessages,
    mainLoopModel,
    async () => appState.toolPermissionContext,
    tools,
    agentDefinitions,
    undefined, // terminalWid
    // th analyzeContextUsage 仅读取 options.{customSystemPrompt,appendSy
    // stemPrompt}，但其签名声明了完整的 Pick<ToolUseContext, 'options'>。
    { options: { customSystemPrompt, appendSystemPrompt } } as Pick<
      ToolUseContext,
      'options'
    >,
    undefined, // mainThreadAgentDefinition
    apiView, // 用于 API 使用情况提取的原始消息
  )
}

export async function call(
  _args: string,
  context: ToolUseContext,
): Promise<{ type: 'text'; value: string }> {
  const data = await collectContextData(context)
  return {
    type: 'text' as const,
    value: formatContextAsMarkdownTable(data),
  }
}

function formatContextAsMarkdownTable(data: ContextData): string {
  const {
    categories,
    totalTokens,
    rawMaxTokens,
    percentage,
    model,
    memoryFiles,
    mcpTools,
    agents,
    skills,
    messageBreakdown,
    systemTools,
    systemPromptSections,
  } = data

  let output = `## 上下文使用情况

`
  output += `**Model:** ${model}  \n`
  output += `**令牌数：** ${formatTokens(totalTokens)} / ${formatTokens(rawMaxTokens)} (${percentage}%)
`

  // 上下文折叠状态。当运行时门控开启时始终显示
  // ——用户需要知道在触发任何操作之前，哪种
  // 策略正在管理其上下文。
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getStats, isContextCollapseEnabled } =
      require('../../services/contextCollapse/index.js') as typeof import('../../services/contextCollapse/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) {
      const s = getStats()
      const { health: h } = s

      const parts = []
      if (s.collapsedSpans > 0) {
        parts.push(
          `${s.collapsedSpans} ${plural(s.collapsedSpans, 'span')} 已总结（${s.collapsedMessages} 条消息）`,
        )
      }
      if (s.stagedSpans > 0) parts.push(`${s.stagedSpans} staged`)
      const summary =
        parts.length > 0
          ? parts.join(', ')
          : h.totalSpawns > 0
            ? `${h.totalSpawns} ${plural(h.totalSpawns, 'spawn')}，尚无暂存内容`
            : '等待首次触发'
      output += `**上下文策略：** 折叠 (${summary})
`

      if (h.totalErrors > 0) {
        output += `**折叠错误：** ${h.totalErrors}/${h.totalSpawns} 次生成失败`
        if (h.lastError) {
          output += `（最近：${h.lastError.slice(0, 80)}）`
        }
        output += '\n'
      } else if (h.emptySpawnWarningEmitted) {
        output += `**折叠空闲：** ${h.totalEmptySpawns} 次连续空运行
`
      }
    }
  }
  output += '\n'

  // 主要类别表
  const visibleCategories = categories.filter(
    cat =>
      cat.tokens > 0 &&
      cat.name !== '空闲空间' &&
      cat.name !== '自动紧凑缓冲区',
  )

  if (visibleCategories.length > 0) {
    output += `### 按类别估算使用情况

`
    output += `| 类别 | 令牌数 | 百分比 |
`
    output += `|----------|--------|------------|\n`

    for (const cat of visibleCategories) {
      const percentDisplay = ((cat.tokens / rawMaxTokens) * 100).toFixed(1)
      output += `| ${cat.name} | ${formatTokens(cat.tokens)} | ${percentDisplay}% |\n`
    }

    const freeSpaceCategory = categories.find(c => c.name === '空闲空间')
    if (freeSpaceCategory && freeSpaceCategory.tokens > 0) {
      const percentDisplay = (
        (freeSpaceCategory.tokens / rawMaxTokens) *
        100
      ).toFixed(1)
      output += `| 空闲空间 | ${formatTokens(freeSpaceCategory.tokens)} | ${percentDisplay}% |
`
    }

    const autocompactCategory = categories.find(
      c => c.name === '自动紧凑缓冲区',
    )
    if (autocompactCategory && autocompactCategory.tokens > 0) {
      const percentDisplay = (
        (autocompactCategory.tokens / rawMaxTokens) *
        100
      ).toFixed(1)
      output += `| 自动紧凑缓冲区 | ${formatTokens(autocompactCategory.tokens)} | ${percentDisplay}% |
`
    }

    output += `\n`
  }

  // MCP 工具
  if (mcpTools.length > 0) {
    output += `### MCP 工具

`
    output += `| 工具 | 服务器 | 令牌数 |
`
    output += `|------|--------|--------|\n`
    for (const tool of mcpTools) {
      output += `| ${tool.name} | ${tool.serverName} | ${formatTokens(tool.tokens)} |\n`
    }
    output += `\n`
  }

  // 系统工具（仅限 ANT）
  if (
    systemTools &&
    systemTools.length > 0 &&
    process.env.USER_TYPE === 'ant'
  ) {
    output += `### [仅限 ANT] 系统工具

`
    output += `| 工具 | 令牌数 |
`
    output += `|------|--------|\n`
    for (const tool of systemTools) {
      output += `| ${tool.name} | ${formatTokens(tool.tokens)} |\n`
    }
    output += `\n`
  }

  // 系统提示词部分（仅限 ANT）
  if (
    systemPromptSections &&
    systemPromptSections.length > 0 &&
    process.env.USER_TYPE === 'ant'
  ) {
    output += `### [仅限 ANT] 系统提示词部分

`
    output += `| 部分 | 令牌数 |
`
    output += `|---------|--------|\n`
    for (const section of systemPromptSections) {
      output += `| ${section.name} | ${formatTokens(section.tokens)} |\n`
    }
    output += `\n`
  }

  // 自定义智能体
  if (agents.length > 0) {
    output += `### 自定义智能体

`
    output += `| 智能体类型 | 来源 | 令牌数 |
`
    output += `|------------|--------|--------|\n`
    for (const agent of agents) {
      let sourceDisplay: string
      switch (agent.source) {
        case 'projectSettings':
          sourceDisplay = 'Project'
          break
        case 'userSettings':
          sourceDisplay = 'User'
          break
        case 'localSettings':
          sourceDisplay = 'Local'
          break
        case 'flagSettings':
          sourceDisplay = 'Flag'
          break
        case 'policySettings':
          sourceDisplay = 'Policy'
          break
        case 'plugin':
          sourceDisplay = 'Plugin'
          break
        case 'built-in':
          sourceDisplay = 'Built-in'
          break
        default:
          sourceDisplay = String(agent.source)
      }
      output += `| ${agent.agentType} | ${sourceDisplay} | ${formatTokens(agent.tokens)} |\n`
    }
    output += `\n`
  }

  // 记忆文件
  if (memoryFiles.length > 0) {
    output += `### 记忆文件

`
    output += `| 类型 | 路径 | 令牌数 |
`
    output += `|------|------|--------|\n`
    for (const file of memoryFiles) {
      output += `| ${file.type} | ${file.path} | ${formatTokens(file.tokens)} |\n`
    }
    output += `\n`
  }

  // 技能
  if (skills && skills.tokens > 0 && skills.skillFrontmatter.length > 0) {
    output += `### 技能

`
    output += `| 技能 | 来源 | 令牌数 |
`
    output += `|-------|--------|--------|\n`
    for (const skill of skills.skillFrontmatter) {
      output += `| ${skill.name} | ${getSourceDisplayName(skill.source)} | ${formatTokens(skill.tokens)} |\n`
    }
    output += `\n`
  }

  // 消息细分（仅限 ANT）
  if (messageBreakdown && process.env.USER_TYPE === 'ant') {
    output += `### [仅限 ANT] 消息细分

`
    output += `| 类别 | 令牌数 |
`
    output += `|----------|--------|\n`
    output += `| 工具调用 | ${formatTokens(messageBreakdown.toolCallTokens)} |
`
    output += `| 工具结果 | ${formatTokens(messageBreakdown.toolResultTokens)} |
`
    output += `| 附件 | ${formatTokens(messageBreakdown.attachmentTokens)} |
`
    output += `| 助手消息（非工具类） | ${formatTokens(messageBreakdown.assistantMessageTokens)} |
`
    output += `| 用户消息（非工具结果类） | ${formatTokens(messageBreakdown.userMessageTokens)} |
`
    output += `\n`

    if (messageBreakdown.toolCallsByType.length > 0) {
      output += `#### 热门工具

`
      output += `| 工具 | 调用令牌数 | 结果令牌数 |
`
      output += `|------|-------------|---------------|\n`
      for (const tool of messageBreakdown.toolCallsByType) {
        output += `| ${tool.name} | ${formatTokens(tool.callTokens)} | ${formatTokens(tool.resultTokens)} |\n`
      }
      output += `\n`
    }

    if (messageBreakdown.attachmentsByType.length > 0) {
      output += `#### 热门附件

`
      output += `| 附件 | 令牌数 |
`
      output += `|------------|--------|\n`
      for (const attachment of messageBreakdown.attachmentsByType) {
        output += `| ${attachment.name} | ${formatTokens(attachment.tokens)} |\n`
      }
      output += `\n`
    }
  }

  return output
}
