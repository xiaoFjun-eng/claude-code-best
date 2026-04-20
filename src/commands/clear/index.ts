/** * 清除命令 - 仅包含最小元数据。
 * 实现从 clear.ts 延迟加载以减少启动时间。
 * 实用函数：
 * - clearSessionCaches：从 './clear/caches.js' 导入
 * - clearConversation：从 './clear/conversation.js' 导入 */
import type { Command } from '../../commands.js'

const clear = {
  type: 'local',
  name: 'clear',
  description: '清除对话历史并释放上下文',
  aliases: ['reset', 'new'],
  supportsNonInteractive: false, // 应该直接创建一个新会话
  load: () => import('./clear.js'),
} satisfies Command

export default clear
