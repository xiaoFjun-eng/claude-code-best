import { feature } from 'bun:bundle'
import { isBridgeEnabled } from '../../bridge/bridgeEnabled.js'
import type { Command } from '../../commands.js'

function isEnabled(): boolean {
  if (!feature('DAEMON') || !feature('BRIDGE_MODE')) {
    return false
  }
  return isBridgeEnabled()
}

const remoteControlServer = {
  type: 'local-jsx',
  name: 'remote-control-server',
  aliases: ['rcs'],
  description:
    '启动一个持久化的远程控制服务器（守护进程），该服务器可接受多个会话',
  isEnabled,
  get isHidden() {
    return !isEnabled()
  },
  immediate: true,
  load: () => import('./remoteControlServer.js'),
} satisfies Command

export default remoteControlServer
