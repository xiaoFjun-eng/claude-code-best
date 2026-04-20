import type { LocalCommandCall } from '../../types/command.js'
import { getAllSlaveClients } from '../../hooks/useMasterMonitor.js'
import {
  getPipeDisplayRole,
  getPipeIpc,
  isPipeControlled,
} from '../../utils/pipeTransport.js'

export const call: LocalCommandCall = async (_args, context) => {
  const currentState = context.getAppState()

  if (getPipeIpc(currentState).role === 'main') {
    return {
      type: 'text',
      value:
        '主模式 — 未连接到任何 CLI。\n使用 /attach <管道名称> 连接到子会话。',
    }
  }

  if (isPipeControlled(getPipeIpc(currentState))) {
    return {
      type: 'text',
      value: `${getPipeDisplayRole(getPipeIpc(currentState))} 模式 — 由 "${getPipeIpc(currentState).attachedBy}" 控制。
所有会话数据正在上报给主控端。`,
    }
  }

  // 主控模式
  const slaves = getPipeIpc(currentState).slaves
  const slaveNames = Object.keys(slaves)
  const clients = getAllSlaveClients()

  if (slaveNames.length === 0) {
    return {
      type: 'text',
      value:
        '主控模式，但无子会话连接。\n使用 /attach <管道名称> 进行连接。',
    }
  }

  const lines: string[] = [
    `主控模式 — 已连接 ${slaveNames.length} 个子会话：`,
    '',
  ]

  for (const name of slaveNames) {
    const slave = slaves[name]!
    const client = clients.get(name)
    const connected = client?.connected ? 'connected' : 'disconnected'
    const historyCount = slave.history.length
    const connectedAt = slave.connectedAt.slice(11, 19)

    lines.push(`  ${name}`)
    lines.push(`    状态:    ${slave.status} (${connected})`)
    lines.push(`    Connected: ${connectedAt}`)
    lines.push(`    历史记录:   ${historyCount} 条条目`)
    lines.push('')
  }

  lines.push('Commands:')
  lines.push('  /send <名称> <消息>  — 向子会话发送任务')
  lines.push('  /history <名称>     — 查看子会话记录')
  lines.push('  /detach [名称]      — 断开与子会话的连接（或全部断开）')

  return { type: 'text', value: lines.join('\n') }
}
