import type { LocalCommandCall } from '../../types/command.js'
import { getSlaveClient } from '../../hooks/useMasterMonitor.js'
import { getPipeIpc } from '../../utils/pipeTransport.js'
import {
  addSendOverride,
  removeSendOverride,
  removeMasterPipeMute,
} from '../../utils/pipeMuteState.js'

export const call: LocalCommandCall = async (args, context) => {
  const currentState = context.getAppState()

  if (getPipeIpc(currentState).role !== 'master') {
    return {
      type: 'text',
      value: '未处于主控模式。请先使用 /attach <管道名称>。',
    }
  }

  // 解析：第一个词是管道名称，其余部分是消息
  const trimmed = args.trim()
  const spaceIdx = trimmed.indexOf(' ')
  if (spaceIdx === -1) {
    return {
      type: 'text',
      value: '用法：/send <管道名称> <消息>',
    }
  }

  const targetName = trimmed.slice(0, spaceIdx)
  const message = trimmed.slice(spaceIdx + 1).trim()

  if (!message) {
    return {
      type: 'text',
      value: '用法：/send <管道名称> <消息>',
    }
  }

  const client = getSlaveClient(targetName)
  if (!client) {
    return {
      type: 'text',
      value: `未连接到 "${targetName}"。使用 /status 查看已连接的子会话。`,
    }
  }

  if (!client.connected) {
    return {
      type: 'text',
      value: `到 "${targetName}" 的连接已关闭。请使用 /detach ${targetName} 并重新连接。`,
    }
  }

  try {
    // 临时覆盖此从属会话的静音，使其响应可见。覆盖将持续到从属会话发出 'done'
    // 或 'error' 为止（由 useMasterMonitor 的 at
    // tachPipeEntryEmitter 处理程序清除）。
    addSendOverride(targetName)
    removeMasterPipeMute(targetName)
    client.send({ type: 'relay_unmute' })
    client.send({
      type: 'prompt',
      data: message,
    })

    // 将发送的提示记录到历史中
    context.setAppState(prev => {
      const slave = getPipeIpc(prev).slaves[targetName]
      if (!slave) return prev
      return {
        ...prev,
        pipeIpc: {
          ...getPipeIpc(prev),
          slaves: {
            ...getPipeIpc(prev).slaves,
            [targetName]: {
              ...slave,
              status: 'busy' as const,
              lastActivityAt: new Date().toISOString(),
              lastSummary: `Queued: ${message}`,
              lastEventType: 'prompt',
              history: [
                ...slave.history,
                {
                  type: 'prompt' as const,
                  content: message,
                  from: getPipeIpc(currentState).serverName ?? 'master',
                  timestamp: new Date().toISOString(),
                },
              ],
            },
          },
        },
      }
    })

    return {
      type: 'text',
      value: `已发送到 "${targetName}": ${message.slice(0, 100)}${message.length > 100 ? '...' : ''}`,
    }
  } catch (err) {
    // 发送失败时回滚覆盖，以防止永久取消静音
    removeSendOverride(targetName)
    return {
      type: 'text',
      value: `发送到 "${targetName}" 失败: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
