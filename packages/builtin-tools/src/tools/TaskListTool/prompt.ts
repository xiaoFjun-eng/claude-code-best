import { isAgentSwarmsEnabled } from 'src/utils/agentSwarmsEnabled.js'

export const DESCRIPTION = '列出任务列表中的所有任务'

export function getPrompt(): string {
  const teammateUseCase = isAgentSwarmsEnabled()
    ? `- 在把任务分配给队友之前，用于查看有哪些任务可领取
`
    : ''

  const idDescription = isAgentSwarmsEnabled()
    ? '- **id**: Task identifier (use with TaskGet, TaskUpdate)'
    : '- **id**: Task identifier (use with TaskGet, TaskUpdate)'

  const teammateWorkflow = isAgentSwarmsEnabled()
    ? `
## 队友工作流

当你作为队友工作时：
1. 完成当前任务后，调用 TaskList 查找可做工作
2. 寻找 status 为 'pending'、没有 owner、且 blockedBy 为空的任务
3. 当同时有多个任务可选时，**优先按 ID 顺序**（ID 越小越优先）处理，因为早期任务通常会为后续任务铺垫上下文
4. 使用 TaskUpdate 领取可用任务（将 \`owner\` 设为你的名字），或等待队长分配
5. 若被阻塞，优先处理解阻塞工作，或通知 team lead
`
    : ''

  return `使用此工具列出任务列表中的所有任务。

## 何时使用

- 查看当前有哪些可做任务（status 为 'pending'、没有 owner、且不被阻塞）
- 查看项目整体进度
- 查找被阻塞、需要先解决依赖的任务
${teammateUseCase}- 完成一个任务后，检查是否有新解锁的工作，或领取下一个可用任务
- 完成一个任务后，检查是否有新解锁的工作，或领取下一个可用任务
- 当同时有多个任务可选时，**优先按 ID 顺序**（ID 越小越优先）处理，因为早期任务通常会为后续任务铺垫上下文

## 输出

返回每个任务的摘要：
${idDescription}
- **subject**：任务简述
- **status**：'pending'、'in_progress' 或 'completed'
- **owner**：若已分配则为 agent ID；未分配则为空
- **blockedBy**：必须先解决的未完成任务 ID 列表（存在 blockedBy 时不可领取，直到依赖被解决）

使用 TaskGet + 具体 task ID 可查看包含 description 与 comments 的完整详情。
${teammateWorkflow}`
}
