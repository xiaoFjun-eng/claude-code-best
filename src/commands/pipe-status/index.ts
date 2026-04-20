import type { Command } from '../../commands.js'

const pipeStatus = {
  type: 'local',
  name: 'pipe-status',
  description: '显示当前管道连接状态',
  supportsNonInteractive: true,
  load: () => import('./pipe-status.js'),
} satisfies Command

export default pipeStatus
