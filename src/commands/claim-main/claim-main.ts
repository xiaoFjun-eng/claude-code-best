import type { LocalCommandCall } from '../../types/command.js'
import { getPipeIpc } from '../../utils/pipeTransport.js'
import {
  getMachineId,
  getMacAddress,
  claimMain,
  readRegistry,
} from '../../utils/pipeRegistry.js'
import { getLocalIp } from '../../utils/pipeTransport.js'

export const call: LocalCommandCall = async (_args, context) => {
  const currentState = context.getAppState()
  const pipeState = getPipeIpc(currentState)
  const myName = pipeState.serverName

  if (!myName) {
    return {
      type: 'text',
      value: '管道服务器未启动。无法声明主节点。',
    }
  }

  const machineId = await getMachineId()
  const registry = await readRegistry()

  // 已经是主节点？
  if (registry.mainMachineId === machineId && registry.main?.id === myName) {
    return {
      type: 'text',
      value: '此实例已是主节点。无需更改。',
    }
  }

  const { hostname } = require('os') as typeof import('os')

  const entry = {
    id: myName,
    pid: process.pid,
    machineId,
    startedAt: Date.now(),
    ip: getLocalIp(),
    mac: getMacAddress(),
    hostname: hostname(),
    pipeName: myName,
  }

  await claimMain(machineId, entry)

  // 更新本地状态
  context.setAppState(prev => ({
    ...prev,
    pipeIpc: {
      ...getPipeIpc(prev),
      role: 'main',
      subIndex: null,
      displayRole: 'main',
      machineId,
      attachedBy: null,
    },
  }))

  const lines: string[] = []
  lines.push('主角色声明成功。')
  lines.push(`机器 ID: ${machineId.slice(0, 8)}...`)
  lines.push(`管道:       ${myName}`)
  if (registry.mainMachineId && registry.mainMachineId !== machineId) {
    lines.push(
      `先前的主节点: ${registry.mainMachineId.slice(0, 8)}...`,
    )
  }
  lines.push('')
  lines.push('所有现有子节点现已绑定到此实例。')
  lines.push('使用 /pipes 进行验证。')

  return { type: 'text', value: lines.join('\n') }
}
