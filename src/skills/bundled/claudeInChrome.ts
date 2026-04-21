import { BROWSER_TOOLS } from '@ant/claude-for-chrome-mcp'
import { BASE_CHROME_PROMPT } from '../../utils/claudeInChrome/prompt.js'
import { shouldAutoEnableClaudeInChrome } from '../../utils/claudeInChrome/setup.js'
import { registerBundledSkill } from '../bundledSkills.js'

const CLAUDE_IN_CHROME_MCP_TOOLS = BROWSER_TOOLS.map(
  tool => `mcp__claude-in-chrome__${tool.name}`,
)

const SKILL_ACTIVATION_MESSAGE = `现在已调用此技能，你可以使用 Chrome 浏览器自动化工具。现在你可以使用 mcp__claude-in-chrome__* 工具与网页进行交互。

重要提示：首先调用 mcp__claude-in-chrome__tabs_context_mcp 来获取用户当前浏览器标签页的信息。`

export function registerClaudeInChromeSkill(): void {
  registerBundledSkill({
    name: 'claude-in-chrome',
    description:
      '自动化你的 Chrome 浏览器以与网页交互——点击元素、填写表单、捕获截图、读取控制台日志以及浏览网站。在你现有的 Chrome 会话中，在新标签页中打开页面。执行前需要站点级权限（在扩展程序中配置）。',
    whenToUse:
      '当用户想要与网页交互、自动化浏览器任务、捕获截图、读取控制台日志或执行任何基于浏览器的操作时使用。在尝试使用任何 mcp__claude-in-chrome__* 工具之前，务必先调用此工具。',
    allowedTools: CLAUDE_IN_CHROME_MCP_TOOLS,
    userInvocable: true,
    isEnabled: () => shouldAutoEnableClaudeInChrome(),
    async getPromptForCommand(args) {
      let prompt = `${BASE_CHROME_PROMPT}\n${SKILL_ACTIVATION_MESSAGE}`
      if (args) {
        prompt += `
## 任务

${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
