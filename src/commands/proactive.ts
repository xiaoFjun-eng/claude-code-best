/** /proactive — 切换主动（自主驱动）模式。

启用后，模型会定期接收 <tick> 提示，并在用户输入之间自主工作。SleepTool 控制节奏。 */
import { feature } from 'bun:bundle'
import type { ToolUseContext } from '../Tool.js'
import type {
  Command,
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../types/command.js'

const proactive = {
  bridgeSafe: true,
  type: 'local-jsx',
  name: 'proactive',
  description: '切换主动（自主）模式',
  isEnabled: () => {
    if (feature('PROACTIVE') || feature('KAIROS')) {
      return true
    }
    return false
  },
  immediate: true,
  load: () =>
    Promise.resolve({
      async call(
        onDone: LocalJSXCommandOnDone,
        _context: ToolUseContext & LocalJSXCommandContext,
      ): Promise<React.ReactNode> {
        // 动态引入以避免将 proactive 模块拉入非门控构建
        const mod =
          require('../proactive/index.js') as typeof import('../proactive/index.js')

        if (mod.isProactiveActive()) {
          mod.deactivateProactive()
          onDone('主动模式已禁用', { display: 'system' })
        } else {
          mod.activateProactive('slash_command')
          onDone(
            '主动模式已启用 — 模型将在 tick 之间自主工作',
            {
              display: 'system',
              metaMessages: [
                '<system-reminder>\n主动模式现已启用。你将定期接收 <tick> 提示。在每个 tick 上执行有用工作，若无事可做则调用 Sleep。不要输出“仍在等待”——要么行动，要么休眠。\n</system-reminder>',
              ],
            },
          )
        }
        return null
      },
    }),
} satisfies Command

export default proactive
