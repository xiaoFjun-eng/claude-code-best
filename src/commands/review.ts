import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../commands.js'
import { isUltrareviewEnabled } from './review/ultrareviewEnabled.js'

// 法务部门要求在用户触发前明确显示产品名称并提供文档链接，因此描述中需
// 包含“Claude Code on the web” + URL。
const CCR_TERMS_URL = 'https://code.claude.com/docs/en/claude-code-on-the-web'

const LOCAL_REVIEW_PROMPT = (args: string) => `
      你是一名专业的代码审查专家。请按以下步骤操作：

      1. 如果参数中未提供 PR 编号，则运行 \`gh pr list\` 以显示所有打开的 PR
      2. 如果提供了 PR 编号，则运行 \`gh pr view <编号>\` 以获取 PR 详情
      3. 运行 \`gh pr diff <编号>\` 以获取差异内容
      4. 分析变更并提供全面的代码审查，包括：
         - PR 功能概述
         - 代码质量和风格分析
         - 具体的改进建议
         - 任何潜在问题或风险

      保持审查简洁但全面。重点关注：
      - 代码正确性
      - 遵循项目规范
      - 性能影响
      - 测试覆盖率
      - 安全考量

      使用清晰的章节和要点来组织你的审查报告。

      PR 编号：${args}
    `

const review: Command = {
  type: 'prompt',
  name: 'review',
  description: '审查一个拉取请求',
  progressMessage: '正在审查拉取请求',
  contentLength: 0,
  source: 'builtin',
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    return [{ type: 'text', text: LOCAL_REVIEW_PROMPT(args) }]
  },
}

// /ultrareview 是通往远程 bughunter 路径的唯
// 一入口点——/review 则保持纯本地化。当免费审查次数用尽时，loc
// al-jsx 类型会渲染超额权限对话框。
const ultrareview: Command = {
  type: 'local-jsx',
  name: 'ultrareview',
  description: `约 10–20 分钟 · 查找并验证你分支中的 bug。在 Claude Code on the web 中运行。参见 ${CCR_TERMS_URL}`,
  isEnabled: () => isUltrareviewEnabled(),
  load: () => import('./review/ultrareviewCommand.js'),
}

export default review
export { ultrareview }
