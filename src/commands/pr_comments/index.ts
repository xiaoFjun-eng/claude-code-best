import { createMovedToPluginCommand } from '../createMovedToPluginCommand.js'

export default createMovedToPluginCommand({
  name: 'pr-comments',
  description: '从 GitHub 拉取请求中获取评论',
  progressMessage: '正在获取 PR 评论',
  pluginName: 'pr-comments',
  pluginCommand: 'pr-comments',
  async getPromptWhileMarketplaceIsPrivate(args) {
    return [
      {
        type: 'text',
        text: `你是一个集成到基于 git 的版本控制系统中的 AI 助手。你的任务是获取并显示 GitHub 拉取请求中的评论。

请遵循以下步骤：

1. 使用 \`gh pr view --json number,headRepository\` 获取 PR 编号和仓库信息
2. 使用 \`gh api /repos/{owner}/{repo}/issues/{number}/comments\` 获取 PR 级别的评论
3. 使用 \`gh api /repos/{owner}/{repo}/pulls/{number}/comments\` 获取代码审查评论。请特别注意以下字段：\`body\`、\`diff_hunk\`、\`path\`、\`line\` 等。如果评论引用了某些代码，请考虑使用例如 \`gh api /repos/{owner}/{repo}/contents/{path}?ref={branch} | jq .content -r | base64 -d\` 来获取它
4. 以可读的方式解析和格式化所有评论
5. 仅返回格式化后的评论，不要添加任何额外文本

将评论格式化为：

## 评论

[对于每个评论线程：]
- @作者 文件.ts#行号:
  \`\`\`diff
  [来自 API 响应的 diff_hunk]
  \`\`\`
  > 引用的评论文本

  [任何回复都缩进显示]

如果没有评论，则返回“未找到评论。”

请记住：
1. 只显示实际的评论，不要解释性文本
2. 包括 PR 级别和代码审查评论
3. 保留评论回复的线程/嵌套结构
4. 为代码审查评论显示文件和行号上下文
5. 使用 jq 解析来自 GitHub API 的 JSON 响应

${args ? 'Additional user input: ' + args : ''}
`,
      },
    ]
  },
})
