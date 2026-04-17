export function getEnterWorktreeToolPrompt(): string {
  return `仅在用户明确要求在 worktree 中工作时才使用此工具。该工具会创建一个隔离的 git worktree，并将当前会话切换到其中。

## 何时使用

- 用户明确提到 “worktree”（例如：“开始一个 worktree / 在 worktree 里工作 / 创建 worktree / 使用 worktree”）

## 何时不要使用

- 用户要求创建分支、切换分支，或在其他分支上工作——请改用 git 命令
- 用户让你修 bug 或做功能——除非他们特别提到 worktree，否则使用常规 git 工作流
- 除非用户明确提到 “worktree”，否则不要使用该工具

## 要求

- 必须位于 git 仓库中，或已在 \`settings.json\` 配置 WorktreeCreate/WorktreeRemove hooks
- 当前不能已经在 worktree 中

## 行为

- 在 git 仓库中：在 \`.claude/worktrees/\` 内创建一个新的 git worktree，并基于 HEAD 创建新分支
- 不在 git 仓库中：委托给 WorktreeCreate/WorktreeRemove hooks，以实现与 VCS 无关的隔离
- 将会话的工作目录切换到新的 worktree
- 会话中途离开 worktree 请使用 ExitWorktree（keep 或 remove）。会话退出时如果仍在 worktree 中，会提示用户选择保留或删除

## 参数

- \`name\`（可选）：worktree 的名称。不提供则生成随机名称。
`
}
