import type { Command } from '../../commands.js'

const peers = {
  type: 'local',
  name: 'peers',
  aliases: ['who'],
  description: '列出已连接的 Claude Code 对等节点',
  supportsNonInteractive: true,
  load: () => import('./peers.js'),
} satisfies Command

export default peers
