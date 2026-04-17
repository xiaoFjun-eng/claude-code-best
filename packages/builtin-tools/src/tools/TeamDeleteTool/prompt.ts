export function getPrompt(): string {
  return `
# TeamDelete

当 swarm（多 agent 并行协作）工作完成后，删除团队与任务目录。

该操作将：
- Removes the team directory (\`~/.claude/teams/{team-name}/\`)
- Removes the task directory (\`~/.claude/tasks/{team-name}/\`)
- Clears team context from the current session

**重要**：如果团队仍有活跃成员，TeamDelete 会失败。请先优雅终止队友（teammates），待所有队友都已关闭后再调用 TeamDelete。

当所有队友完成工作、你希望清理团队资源时使用此工具。team name 会从当前会话的团队上下文中自动确定。
`.trim()
}
