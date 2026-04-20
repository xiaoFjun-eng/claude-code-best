/** 颜色命令 - 仅包含最简元数据。
实现从 color.ts 延迟加载，以减少启动时间。 */
import type { Command } from '../../commands.js'

const color = {
  type: 'local-jsx',
  name: 'color',
  description: '为此会话设置提示栏颜色',
  immediate: true,
  argumentHint: '<color|default>',
  load: () => import('./color.js'),
} satisfies Command

export default color
