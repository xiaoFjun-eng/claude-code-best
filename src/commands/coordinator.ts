/** /coordinator — 切换协调器（多工作节点编排）模式。

启用后，CLI 将成为一个编排器，通过 Agent({ subagent_type: "worker" }) 将任务分派给工作节点代理。
协调器只能使用 Agent、SendMessage 和 TaskStop。 */
import { feature } from 'bun:bundle'
import type { ToolUseContext } from '../Tool.js'
import type {
  Command,
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../types/command.js'

const coordinator = {
  type: 'local-jsx',
  name: 'coordinator',
  description: '切换协调器（多工作节点）模式',
  isEnabled: () => {
    if (feature('COORDINATOR_MODE')) {
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
        const mod =
          require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js')

        if (mod.isCoordinatorMode()) {
          // 禁用：清除环境变量
          delete process.env.CLAUDE_CODE_COORDINATOR_MODE
          onDone('协调器模式已禁用 — 返回正常模式', {
            display: 'system',
            metaMessages: [
              '<system-reminder>\n协调器模式现已禁用。您已恢复使用所有标准工具。请直接工作，而无需分派给工作节点。\n</system-reminder>',
            ],
          })
        } else {
          // 启用：设置环境变量
          process.env.CLAUDE_CODE_COORDINATOR_MODE = '1'
          onDone(
            '协调器模式已启用 — 使用 Agent(subagent_type: "worker") 来分派任务',
            {
              display: 'system',
              metaMessages: [
                '<system-reminder>\n协调器模式现已启用。您现在是编排器。请使用 Agent({ subagent_type: "worker" }) 来创建工作节点，使用 SendMessage 来继续其任务，使用 TaskStop 来停止它们。请勿直接使用其他工具。\n</system-reminder>',
              ],
            },
          )
        }
        return null
      },
    }),
} satisfies Command

export default coordinator
