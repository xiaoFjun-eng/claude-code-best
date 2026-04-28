import type { Command } from '../../commands.js'

const skillSearch = {
  type: 'local-jsx',
  name: 'skill-search',
  description: '控制对话过程中的自动技能匹配',
  argumentHint: '[start|stop|about|status]',
  isHidden: false,
  load: () => import('./skillSearchPanel.js'),
} satisfies Command

export default skillSearch
