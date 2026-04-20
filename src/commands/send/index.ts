import type { Command } from '../../commands.js'

const send = {
  type: 'local',
  name: 'send',
  description: '向已连接的子 CLI 发送消息',
  supportsNonInteractive: false,
  load: () => import('./send.js'),
} satisfies Command

export default send
