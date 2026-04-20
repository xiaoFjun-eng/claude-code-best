/** 复制命令 - 仅包含最小元数据。
实现从 copy.tsx 延迟加载，以减少启动时间。 */
import type { Command } from '../../commands.js'

const copy = {
  type: 'local-jsx',
  name: 'copy',
  description:
    "将 Claude 的最后一条回复复制到剪贴板（或使用 /copy N 复制第 N 条最新回复）",
  load: () => import('./copy.js'),
} satisfies Command

export default copy
