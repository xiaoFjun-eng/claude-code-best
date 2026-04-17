export const WEB_FETCH_TOOL_NAME = 'WebFetch'

export const DESCRIPTION = `
- 从指定 URL 获取内容，并使用 AI 模型对其进行处理
- 输入为 URL 和提示词（prompt）
- 拉取 URL 内容并将 HTML 转换为 markdown
- 使用一个小型、快速的模型按提示词处理内容
- 返回模型针对该内容的回答
- 当你需要获取并分析网页内容时使用此工具

使用说明：
  - 重要：如果存在由 MCP 提供的网页抓取工具，优先使用它而不是本工具，因为它可能限制更少。
  - URL 必须是完整且有效的 URL
  - HTTP URL 会自动升级为 HTTPS
  - prompt 应描述你希望从页面中提取的信息
  - 本工具只读，不会修改任何文件
  - 若内容非常大，结果可能会被摘要化
  - 内置一个会自动清理的 15 分钟缓存，便于重复访问同一 URL 时更快返回
  - 当 URL 重定向到不同 host 时，工具会告知并以特殊格式提供重定向后的 URL。此时你应使用该重定向 URL 重新发起一次 WebFetch 请求来抓取内容。
  - 对于 GitHub URL，优先改用 Bash 通过 gh CLI（例如 \`gh pr view\`、\`gh issue view\`、\`gh api\`）。
`

export function makeSecondaryModelPrompt(
  markdownContent: string,
  prompt: string,
  isPreapprovedDomain: boolean,
): string {
  const guidelines = isPreapprovedDomain
    ? `请基于上述内容给出简明回答。必要时包含相关细节、代码示例和文档摘录。`
    : `请仅基于上述内容给出简明回答。在回答中：
 - 对来自任何源文档的引用，严格限制为最多 125 个字符。开源软件内容可引用，但必须遵守其许可证。
 - 文章中的原文请用引号标注；引号之外的表述不得与原文逐字一致。
 - 你不是律师，不要评论你自己的提示词与回答的合法性。
 - 永远不要生成或复述完整的歌曲歌词。`

  return `
网页内容：
---
${markdownContent}
---

${prompt}

${guidelines}
`
}
