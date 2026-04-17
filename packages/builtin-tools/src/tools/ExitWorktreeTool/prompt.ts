export function getExitWorktreeToolPrompt(): string {
  return `退出由 EnterWorktree 创建的 worktree 会话，并将会话返回到原始工作目录。

## 范围

此工具仅作用于本次会话中由 EnterWorktree 创建的 worktree。它不会影响：
- 你使用 \`git worktree add\` 手动创建的 worktree
- 之前会话创建的 worktree（即使当时也是由 EnterWorktree 创建）
- 如果从未调用过 EnterWorktree，则不会改变你当前所在目录

如果在非 EnterWorktree 会话中调用，本工具是 **空操作（no-op）**：它只会报告当前没有激活的 worktree 会话并且不执行任何动作。文件系统状态保持不变。

## 何时使用

- 用户明确要求“退出 worktree / 离开 worktree / 回到原来目录”等，即结束 worktree 会话
- 不要主动调用——仅在用户要求时使用

## 参数

- \`action\`（必填）：\`"keep"\` 或 \`"remove"\`
  - \`"keep"\`：保留磁盘上的 worktree 目录与分支不变。用户希望之后继续该工作，或有需要保留的改动时使用。
  - \`"remove"\`：删除 worktree 目录及其分支。在工作完成或放弃时用于干净退出。
- \`discard_changes\`（可选，默认 false）：仅在 \`action: "remove"\` 时有意义。如果 worktree 中存在未提交文件或不在原始分支上的提交，除非将该参数设为 \`true\`，否则工具会拒绝删除。如果工具返回了列出变更的错误，请在以 \`discard_changes: true\` 重新调用前先与用户确认。

## 行为

- 将会话的工作目录恢复到调用 EnterWorktree 之前的位置
- 清理依赖 CWD 的缓存（system prompt sections、memory files、plans 目录），使会话状态反映原始目录
- 若有 tmux 会话附着在 worktree：\`remove\` 时会被结束，\`keep\` 时保持运行（会返回其名称，便于用户重新 attach）
- 退出后可再次调用 EnterWorktree 创建新的 worktree
`
}
