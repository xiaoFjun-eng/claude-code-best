import type { Command } from '../../commands.js'

const poor = {
  type: 'local',
  name: 'poor',
  description: '切换省流模式 — 禁用记忆提取和提示建议以节省令牌',
  supportsNonInteractive: false,
  load: () => import('./poor.js'),
} satisfies Command

export default poor
