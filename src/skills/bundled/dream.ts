// 手动 /dream 技能 —— 交互式运行记忆整合提示
// 。从 KAIROS 功能门中提取，因此只要启用了自动记
// 忆，它就可以无条件使用。

import { getAutoMemPath, isAutoMemoryEnabled } from '../../memdir/paths.js'
import { buildConsolidationPrompt } from '../../services/autoDream/consolidationPrompt.js'
import { recordConsolidation } from '../../services/autoDream/consolidationLock.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getProjectDir } from '../../utils/sessionStorage.js'
import { registerBundledSkill } from '../bundledSkills.js'

const DREAM_PROMPT_PREFIX = `# 梦境：记忆整合（手动运行）

你正在执行一次手动梦境 —— 对你的记忆文件进行一次反思性遍历。与自动后台梦境不同，这次运行拥有完整的工具权限，并且用户正在观察。请将你最近学到的东西综合成持久、组织良好的记忆，以便未来的会话能够快速定位。

`

export function registerDreamSkill(): void {
  registerBundledSkill({
    name: 'dream',
    description:
      '手动触发记忆整合 —— 回顾、整理并修剪你的自动记忆文件。',
    whenToUse:
      '当用户输入 /dream 或想要手动整合记忆、整理记忆文件或清理陈旧条目时使用。',
    userInvocable: true,
    isEnabled: () => isAutoMemoryEnabled(),
    async getPromptForCommand(args) {
      const memoryRoot = getAutoMemPath()
      const transcriptDir = getProjectDir(getOriginalCwd())

      // 乐观地为整合操作加锁（与 KAIROS 路径相同）。
      await recordConsolidation()

      const basePrompt = buildConsolidationPrompt(memoryRoot, transcriptDir, '')
      let prompt = DREAM_PROMPT_PREFIX + basePrompt

      if (args) {
        prompt += `

## 来自用户的额外上下文

${args}`
      }

      return [{ type: 'text', text: prompt }]
    },
  })
}
