import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { getSubscriptionType } from 'src/utils/auth.js'
import { hasEmbeddedSearchTools } from 'src/utils/embeddedTools.js'
import { isEnvDefinedFalsy, isEnvTruthy } from 'src/utils/envUtils.js'
import { isTeammate } from 'src/utils/teammate.js'
import { isInProcessTeammate } from 'src/utils/teammateContext.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { AGENT_TOOL_NAME } from './constants.js'
import { isForkSubagentEnabled } from './forkSubagent.js'
import type { AgentDefinition } from './loadAgentsDir.js'

function getToolsDescription(agent: AgentDefinition): string {
  const { tools, disallowedTools } = agent
  const hasAllowlist = tools && tools.length > 0
  const hasDenylist = disallowedTools && disallowedTools.length > 0

  if (hasAllowlist && hasDenylist) {
    // 两者都定义：按拒绝列表过滤允许列表以匹配运行时行为
    const denySet = new Set(disallowedTools)
    const effectiveTools = tools.filter(t => !denySet.has(t))
    if (effectiveTools.length === 0) {
      return '无'
    }
    return effectiveTools.join(', ')
  } else if (hasAllowlist) {
    // 仅允许列表：显示可用的特定工具
    return tools.join(', ')
  } else if (hasDenylist) {
    // 仅拒绝列表：显示“除 X, Y, Z 外的所有工具”
    return `除 ${disallowedTools.join(', ')} 外的所有工具`
  }
  // 无限制
  return '所有工具'
}

/**
 * 格式化 agent 列表中的一行，用于 agent_listing_delta 附件消息：
 * `- 类型: 使用时机 (工具: ...)`。
 */
export function formatAgentLine(agent: AgentDefinition): string {
  const toolsDescription = getToolsDescription(agent)
  return `- ${agent.agentType}: ${agent.whenToUse} (工具: ${toolsDescription})`
}

/**
 * 是否应该将 agent 列表作为附件消息注入，而不是嵌入到工具描述中。
 * 当为 true 时，getPrompt() 返回静态描述，attachments.ts 会发出 agent_listing_delta 附件。
 *
 * 动态 agent 列表约占集群缓存创建令牌的 10.2%：MCP 异步连接、/reload-plugins 或权限模式更改
 * 会使列表发生突变 → 描述变化 → 完整的工具 schema 缓存失效。
 *
 * 可通过 CLAUDE_CODE_AGENT_LIST_IN_MESSAGES=true/false 覆盖以进行测试。
 */
export function shouldInjectAgentListInMessages(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES)) return true
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES))
    return false
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_agent_list_attach', false)
}

export async function getPrompt(
  agentDefinitions: AgentDefinition[],
  isCoordinator?: boolean,
  allowedAgentTypes?: string[],
): Promise<string> {
  // 当 Agent(x,y) 限制可生成的 agent 类型时，按允许的类型过滤
  const effectiveAgents = allowedAgentTypes
    ? agentDefinitions.filter(a => allowedAgentTypes.includes(a.agentType))
    : agentDefinitions

  // 分支子代理功能：启用时，插入“何时分支”部分（分支语义、指令式提示）并替换为支持分支的示例。
  const forkEnabled = isForkSubagentEnabled()

  const whenToForkSection = forkEnabled
    ? `

## 何时分支

当中间工具输出不值得保留在你的上下文中时，可以分支自己（省略 \`subagent_type\`）。标准是定性的——“我以后还需要这个输出吗”——而不是任务大小。
- **调研**：对开放式问题进行分支。如果调研可以拆分为独立的问题，可以在一条消息中启动并行分支。为此使用分支优于使用全新的子代理——它继承上下文并共享你的缓存。
- **实现**：对于需要超过几次编辑的实现工作，优先使用分支。在跳转到实现之前先做好调研。

分支很便宜，因为它们共享你的提示缓存。不要在分支上设置 \`model\`——不同的模型无法复用父级的缓存。传入一个简短的 \`name\`（一两个词，小写），以便用户可以在团队面板中看到分支并在运行中引导它。

**不要偷看。** 工具结果中包含一个 \`output_file\` 路径——除非用户明确要求进度检查，否则不要读取或 tail 它。你会收到完成通知；信任它。在运行中读取 transcript 会将分支的工具噪音拉入你的上下文，这违背了分支的初衷。

**不要竞速。** 启动后，你对分支找到的内容一无所知。绝不要以任何形式编造或预测分支结果——无论是作为叙述、摘要还是结构化输出。通知会在稍后的轮次中以用户角色消息的形式到达；它绝不是你自己写的。如果用户在通知到达之前提出后续问题，告诉他们分支仍在运行——给出状态，而不是猜测。

**编写分支提示。** 由于分支继承了你的上下文，提示是一个*指令*——要做什么，而不是当前情况是什么。明确范围：什么包含在内，什么排除在外，另一个 agent 在处理什么。不要重新解释背景。
`
    : ''

  const writingThePromptSection = `

## 编写提示

${forkEnabled ? '当生成一个全新的 agent（带有 `subagent_type`）时，它从零上下文开始。' : ''}像给一位刚进房间的聪明同事做简报那样——它没有看过这个对话，不知道你尝试过什么，也不理解为什么这个任务很重要。
- 解释你想要完成什么以及为什么。
- 描述你已经了解到或排除的内容。
- 提供足够的上下文，说明相关的问题背景，以便 agent 能够做出判断，而不仅仅是遵循狭窄的指令。
- 如果你需要简短的回复，请明确说明（“用少于 200 词报告”）。
- 查找类任务：交出确切的命令。调研类任务：交出问题——当前提错误时，预设的步骤会成为累赘。

${forkEnabled ? '对于全新的 agent，简洁的' : '简洁的'}命令式提示会产生浅薄、通用的工作。

**永远不要委托理解。** 不要写“根据你的发现，修复这个 bug”或“根据调研，实现它。”这些短语把综合工作推给了 agent，而不是你自己去做。写出能证明你理解的提示：包含文件路径、行号、具体要修改什么。
`

  const forkExamples = `示例用法：

<example>
用户：“这个分支在发货前还剩下什么？”
助手：<thinking>为此进行分支——这是一个调查性问题。我需要的是待办清单，而不是把 git 输出留在我的上下文中。</thinking>
${AGENT_TOOL_NAME}({
  name: "ship-audit",
  description: "分支发货就绪审计",
  prompt: "审计这个分支在发货前还缺少什么。检查：未提交的更改、领先于 main 的提交、测试是否存在、GrowthBook 门控是否已连接、与 CI 相关的文件是否发生了变化。报告一个待办清单——已完成 vs 缺失。200 词以内。"
})
助手：发货就绪审计正在运行。
<commentary>
轮次在此结束。协调器此时对审计结果一无所知。接下来是一个独立的轮次——通知从外部到达，以用户角色消息的形式出现。它不是由协调器编写的。
</commentary>
[稍后的轮次 —— 通知作为用户消息到达]
助手：审计回来了。三个阻碍：新的提示路径没有测试，GrowthBook 门控已连接但不在 build_flags.yaml 中，还有一个未提交的文件。
</example>

<example>
用户：“所以门控到底连上了没有”
<commentary>
用户在等待中提问。启动的审计分支正是为了回答这个问题，但它还没有返回。协调器没有这个答案。给出状态，而不是编造结果。
</commentary>
助手：仍在等待审计——这是它正在检查的内容之一。应该很快就会出来。
</example>

<example>
用户：“你能再找个意见，看看这个迁移是否安全吗？”
助手：<thinking>我会调用 code-reviewer agent——它不会看到我的分析，因此可以给出独立的看法。</thinking>
<commentary>
指定了 subagent_type，因此 agent 会全新启动。它需要在提示中获得完整的上下文。简报说明了要评估什么以及为什么。
</commentary>
${AGENT_TOOL_NAME}({
  name: "migration-review",
  description: "独立的迁移评审",
  subagent_type: "code-reviewer",
  prompt: "评审迁移 0042_user_schema.sql 的安全性。背景：我们要在一个 5000 万行的表中添加一个 NOT NULL 列。现有行会被填充一个默认值。我希望对回填方法在并发写入下是否安全获得第二意见——我已经检查了锁行为，但需要独立的验证。报告：这安全吗？如果不安全，具体哪里会出问题？"
})
</example>
`

  const currentExamples = `示例用法：

<example_agent_descriptions>
"test-runner": 在你完成代码编写后使用此 agent 来运行测试
"greeting-responder": 使用此 agent 来回应问候语，回复一个友好的笑话
</example_agent_descriptions>

<example>
用户：“请编写一个检查数字是否为质数的函数”
助手：我将使用 ${FILE_WRITE_TOOL_NAME} 工具编写以下代码：
<code>
function isPrime(n) {
  if (n <= 1) return false
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false
  }
  return true
}
</code>
<commentary>
由于编写了重要的代码并且任务已完成，现在使用 test-runner agent 来运行测试
</commentary>
助手：使用 ${AGENT_TOOL_NAME} 工具启动 test-runner agent
</example>

<example>
用户：“你好”
<commentary>
由于用户正在问候，使用 greeting-responder agent 回复一个友好的笑话
</commentary>
助手：“我将使用 ${AGENT_TOOL_NAME} 工具启动 greeting-responder agent”
</example>
`

  // 当开关打开时，agent 列表位于 agent_listing_delta 附件中（参见 attachments.ts），而不是内联在此处。
  // 这使工具描述在 MCP/插件/权限变更时保持静态，从而避免每次加载 agent 时工具块提示缓存失效。
  const listViaAttachment = shouldInjectAgentListInMessages()

  const agentListSection = listViaAttachment
    ? `可用的 agent 类型会在对话的 <system-reminder> 消息中列出。`
    : `可用的 agent 类型及其可以访问的工具：
${effectiveAgents.map(agent => formatAgentLine(agent)).join('\n')}`

  // 协调器和非协调器模式共享的核心提示
  const shared = `启动一个新的 agent 来处理复杂的、多步骤的自治任务。

${AGENT_TOOL_NAME} 工具可以启动专门的 agent（子进程），这些 agent 能够自主处理复杂任务。每个 agent 类型都有特定的能力和可用的工具。

${agentListSection}

${
  forkEnabled
    ? `使用 ${AGENT_TOOL_NAME} 工具时，可以指定 subagent_type 来使用专门的 agent，或者省略它以分支自己 —— 分支会继承你的完整对话上下文。`
    : `使用 ${AGENT_TOOL_NAME} 工具时，指定 subagent_type 参数来选择要使用的 agent 类型。如果省略，则使用通用 agent。`
}`

  // 协调器模式使用精简提示 —— 协调器的系统提示已经涵盖了使用说明、示例和何时不用的指导。
  if (isCoordinator) {
    return shared
  }

  // Ant 原生构建将 find/grep 别名为嵌入式 bfs/ugrep，并移除了专用的 Glob/Grep 工具，
  // 因此通过 Bash 指向 find。
  const embedded = hasEmbeddedSearchTools()
  const fileSearchHint = embedded
    ? '通过 Bash 工具使用 `find`'
    : `${GLOB_TOOL_NAME} 工具`
  // “class Foo” 示例是关于内容搜索。非嵌入式保持 Glob（原始意图：查找包含该内容的文件）。
  // 嵌入式使用 grep，因为 find -name 不查看文件内容。
  const contentSearchHint = embedded
    ? '通过 Bash 工具使用 `grep`'
    : `${GLOB_TOOL_NAME} 工具`
  const whenNotToUseSection = forkEnabled
    ? ''
    : `
何时不要使用 ${AGENT_TOOL_NAME} 工具：
- 如果你想读取特定的文件路径，应使用 ${FILE_READ_TOOL_NAME} 工具或 ${fileSearchHint} 而不是 ${AGENT_TOOL_NAME} 工具，以更快地找到匹配项
- 如果你在搜索特定的类定义，例如 "class Foo"，应使用 ${contentSearchHint} 而不是 ${AGENT_TOOL_NAME} 工具，以更快地找到匹配项
- 如果你在某个特定文件或 2-3 个文件中搜索代码，应使用 ${FILE_READ_TOOL_NAME} 工具而不是 ${AGENT_TOOL_NAME} 工具，以更快地找到匹配项
- 其他与上述 agent 描述无关的任务
`

  // 当通过附件列出时，“启动多个 agent”的说明位于附件消息中（基于订阅条件）。
  // 当内联时，保持现有的每次调用 getSubscriptionType() 检查。
  const concurrencyNote =
    !listViaAttachment && getSubscriptionType() !== 'pro'
      ? `
- 尽可能同时启动多个 agent 以最大化性能；为此，使用包含多个工具使用的单条消息`
      : ''

  // 非协调器获取完整的提示，包含所有部分
  return `${shared}
${whenNotToUseSection}

使用说明：
- 始终包含一个简短的描述（3-5 个词）概述 agent 将要做什么${concurrencyNote}
- agent 完成后，会返回一条消息给你。agent 返回的结果对用户不可见。要向用户显示结果，你应该发回一条文本消息，简明扼要地总结结果。${
    // eslint-disable-next-line custom-rules/no-process-env-top-level
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) &&
    !isInProcessTeammate() &&
    !forkEnabled
      ? `
- 你可以选择使用 run_in_background 参数在后台运行 agent。当 agent 在后台运行时，你会自动收到完成通知——不要 sleep、轮询或主动检查其进度。继续处理其他工作或回复用户即可。
- **前台 vs 后台**：当你在继续之前需要 agent 的结果时使用前台（默认）——例如，调研 agent 的发现会指导你的后续步骤。当你确实有独立的工作需要并行处理时使用后台。`
      : ''
  }
- 要继续之前生成的 agent，使用 ${SEND_MESSAGE_TOOL_NAME}，并将 agent 的 ID 或名称作为 \`to\` 字段。agent 会以其完整上下文恢复运行。${forkEnabled ? '每次使用 subagent_type 调用全新的 Agent 都会从零上下文开始——请提供完整的任务描述。' : '每次 Agent 调用都是全新的——请提供完整的任务描述。'}
- agent 的输出通常应该被信任
- 明确告诉 agent 你希望它编写代码还是只做调研（搜索、文件读取、网络获取等）${forkEnabled ? '' : '，因为它不知道用户的意图'}
- 如果 agent 描述提到它应该被主动使用，那么你应尽力在用户未主动要求时使用它。运用你的判断力。
- 如果用户指定要“并行”运行 agent，你必须在单条消息中发送多个 ${AGENT_TOOL_NAME} 工具使用的内容块。例如，如果你需要同时启动 build-validator agent 和 test-runner agent，则发送一条包含两个工具调用的消息。
- 你可以选择设置 \`isolation: "worktree"\`，让 agent 在一个临时的 git worktree 中运行，为其提供仓库的隔离副本。如果 agent 没有做任何更改，worktree 会被自动清理；如果有更改，worktree 路径和分支会返回在结果中。${
    process.env.USER_TYPE === 'ant'
      ? `\n- 你可以设置 \`isolation: "remote"\`，让 agent 在远程 CCR 环境中运行。这始终是一个后台任务；完成时会通知你。适用于需要全新沙箱的长运行任务。`
      : ''
  }${
    isInProcessTeammate()
      ? `
- run_in_background、name、team_name 和 mode 参数在此上下文中不可用。仅支持同步子代理。`
      : isTeammate()
        ? `
- name、team_name 和 mode 参数在此上下文中不可用——队友无法生成其他队友。省略它们以生成子代理。`
        : ''
  }${whenToForkSection}${writingThePromptSection}

${forkEnabled ? forkExamples : currentExamples}`
}