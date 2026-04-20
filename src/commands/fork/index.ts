import type { Command } from '../../commands.js'

const fork = {
  type: 'local-jsx',
  name: 'fork',
  description: '将当前会话分叉到一个新的子代理中',
  argumentHint: '<prompt>',
  load: () => import('./fork.js'),
} satisfies Command

export default fork
