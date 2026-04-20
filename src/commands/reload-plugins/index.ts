/** /reload-plugins — 三层刷新。将待处理的插件更改应用到当前运行会话中。实现为懒加载。 */
import type { Command } from '../../commands.js'

const reloadPlugins = {
  type: 'local',
  name: 'reload-plugins',
  description: '在当前会话中激活待处理的插件更改',
  // SDK 调用方应使用 query.reloadPlugins()（控制请求）而
  // 非将其作为文本提示发送——该方法会返回结构化数据（commands、ag
  // ents、plugins、mcpServers）用于 UI 更新。
  supportsNonInteractive: false,
  load: () => import('./reload-plugins.js'),
} satisfies Command

export default reloadPlugins
