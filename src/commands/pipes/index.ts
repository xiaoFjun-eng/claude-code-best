import type { Command } from '../../commands.js'

const pipes = {
  type: 'local',
  name: 'pipes',
  description: '检查管道注册表状态并切换管道选择器',
  supportsNonInteractive: true,
  load: () => import('./pipes.js'),
} satisfies Command

export default pipes
