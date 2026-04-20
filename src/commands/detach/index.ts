import type { Command } from '../../commands.js'

const detach = {
  type: 'local',
  name: 'detach',
  description: '从子 CLI 断开连接（或断开所有已连接的子 CLI）',
  supportsNonInteractive: false,
  load: () => import('./detach.js'),
} satisfies Command

export default detach
