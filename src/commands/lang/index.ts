import type { Command } from '../../commands.js'

const lang = {
  type: 'local-jsx',
  name: 'lang',
  description: '设置显示语言（en/zh/auto）',
  immediate: true,
  argumentHint: '<en|zh|auto>',
  load: () => import('./lang.js'),
} satisfies Command

export default lang
