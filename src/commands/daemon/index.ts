import type { Command } from '../../commands.js'
import { feature } from 'bun:bundle'

const daemon = {
  type: 'local-jsx',
  name: 'daemon',
  description: '管理后台会话与守护进程',
  argumentHint: '[status|start|stop|bg|attach|logs|kill]',
  isEnabled: () => {
    if (feature('DAEMON')) return true
    if (feature('BG_SESSIONS')) return true
    return false
  },
  load: () => import('./daemon.js'),
} satisfies Command

export default daemon
