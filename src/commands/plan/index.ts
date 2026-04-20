import type { Command } from '../../commands.js'

const plan = {
  bridgeSafe: true,
  getBridgeInvocationError(args: string) {
    const subcommand = args.trim().split(/\s+/)[0]
    if (subcommand === 'open') {
      return "通过 /plan open 打开本地编辑器在远程控制中不可用。"
    }
    return undefined
  },
  type: 'local-jsx',
  name: 'plan',
  description: '启用计划模式或查看当前会话计划',
  argumentHint: '[open|<description>]',
  load: () => import('./plan.js'),
} satisfies Command

export default plan
