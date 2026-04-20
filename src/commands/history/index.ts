import type { Command } from '../../commands.js'

const history = {
  type: 'local',
  name: 'history',
  aliases: ['hist'],
  description: '查看已连接子 CLI 的会话历史记录',
  supportsNonInteractive: false,
  load: () => import('./history.js'),
} satisfies Command

export default history
