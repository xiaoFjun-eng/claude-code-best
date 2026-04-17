import { getLocalMonthYear } from 'src/constants/common.js'

export const WEB_SEARCH_TOOL_NAME = 'WebSearch'

export function getWebSearchPrompt(): string {
  const currentMonthYear = getLocalMonthYear()
  return `
- 允许 Claude 搜索网络并使用结果来辅助回答
- 为当前事件与最新数据提供及时信息
- 以“搜索结果块”的格式返回结果信息，并将链接以 markdown 超链接形式呈现
- 用于获取超出 Claude 知识截止时间之外的信息
- 搜索会在一次 API 调用中自动完成

关键要求——你必须遵守：
  - 在回答完用户问题后，必须在回复末尾包含一个 “Sources:” 小节
  - 在 Sources 小节中，将搜索结果里所有相关 URL 以 markdown 超链接列出：[Title](URL)
  - 这是强制要求——绝不能省略 Sources
  - 示例格式：

    [Your answer here]

    Sources:
    - [Source Title 1](https://example.com/1)
    - [Source Title 2](https://example.com/2)

使用说明：
  - 支持域名过滤，可包含或屏蔽特定网站
  - Web search 仅在美国可用

重要：在搜索查询中使用正确的年份：
  - 当前月份是 ${currentMonthYear}。在搜索近期信息、文档或当前事件时，你必须使用这一年的年份。
  - 示例：如果用户问“最新的 React 文档”，请用当前年份搜索 “React documentation”，而不是去年的年份
`
}
