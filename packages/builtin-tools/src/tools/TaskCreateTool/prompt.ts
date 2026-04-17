import { isAgentSwarmsEnabled } from 'src/utils/agentSwarmsEnabled.js'

export const DESCRIPTION = '在任务列表中创建一个新任务'

export function getPrompt(): string {
  const teammateContext = isAgentSwarmsEnabled()
    ? ' and potentially assigned to teammates'
    : ''

  const teammateTips = isAgentSwarmsEnabled()
    ? `- 在 description 中包含足够细节，便于其他 agent 理解并完成该任务
- 新任务会以 status 为 'pending' 且没有 owner 的状态创建——用 TaskUpdate 的 \`owner\` 参数为其分配负责人
`
    : ''

  return `使用此工具为当前编码会话创建结构化的任务列表。这能帮助你跟踪进度、组织复杂工作，并向用户体现严谨性。
它也能帮助用户理解任务进展以及他们整体诉求的推进情况。

## 何时使用此工具

在以下场景中主动使用该工具：

- 复杂多步骤任务——当任务需要 3 个或以上不同步骤/行动时
- 非平凡的复杂任务——需要仔细规划或多次操作的任务${teammateContext}
- 计划模式——使用计划模式时，创建任务列表来跟踪工作
- 用户明确要求 todo 列表——用户直接要求你使用 todo 列表时
- 用户提供了多个任务——用户以列表形式给出待办（编号或逗号分隔）时
- 收到新的指令后——立刻把用户需求捕获为任务
- 开始做某个任务时——在开始之前先把它标记为 in_progress
- 完成任务后——标记为 completed，并把实现过程中发现的后续工作补充为新任务

## 何时不要使用此工具

满足以下情况时跳过该工具：
- 只有一个简单直接的任务
- 任务很琐碎，跟踪它没有组织收益
- 任务可以在少于 3 个琐碎步骤内完成
- 任务纯属对话/信息解释

注意：如果只有一个琐碎任务，不要用该工具；此时直接做任务更合适。

## 任务字段

- **subject**：简短、可执行的祈使句标题（例如："Fix authentication bug in login flow"）
- **description**：需要完成的工作内容
- **activeForm**（可选）：当任务为 in_progress 时，spinner 显示的进行时文案（例如："Fixing authentication bug"）。若省略，则 spinner 显示 subject。

所有任务都会以 \`pending\` 状态创建。

## 提示

 - 用清晰、具体、描述结果的 subject 创建任务
 - 创建任务后，如有需要用 TaskUpdate 设置依赖（blocks/blockedBy）
${teammateTips}- 创建前先查看 TaskList，避免重复创建任务
`
}
