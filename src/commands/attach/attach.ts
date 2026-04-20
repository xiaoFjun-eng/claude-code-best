import { feature } from 'bun:bundle'
import type { LocalCommandCall } from '../../types/command.js'
import {
  connectToPipe,
  getPipeIpc,
  isPipeControlled,
  type PipeClient,
  type PipeMessage,
  type TcpEndpoint,
} from '../../utils/pipeTransport.js'
import { addSlaveClient } from '../../hooks/useMasterMonitor.js'

export const call: LocalCommandCall = async (args, context) => {
  const targetName = args.trim()
  if (!targetName) {
    return {
      type: 'text',
      value: '用法：/attach <管道名称>\n使用 /pipes 列出可用管道。',
    }
  }

  const currentState = context.getAppState()

  // 检查是否已连接到此从属会话
  if (getPipeIpc(currentState).slaves[targetName]) {
    return {
      type: 'text',
      value: `已连接到 "${targetName}"。`,
    }
  }

  // 受控的子会话无法附加到其他子会话。
  if (isPipeControlled(getPipeIpc(currentState))) {
    return {
      type: 'text',
      value:
        '无法附加：此子进程当前由主进程控制。请先从主进程分离它。',
    }
  }

  // 为局域网对等节点解析 TCP 端点
  let tcpEndpoint: TcpEndpoint | undefined
  if (feature('LAN_PIPES')) {
    const pipeState = getPipeIpc(currentState)
    const discoveredPeer = pipeState.discoveredPipes.find(
      (p: { pipeName: string }) => p.pipeName === targetName,
    )
    if (discoveredPeer) {
      // 通过查找信标数据检查是否为局域网对等节点
      const { getLanBeacon } =
        require('../../utils/lanBeacon.js') as typeof import('../../utils/lanBeacon.js')
      const beaconRef = getLanBeacon()
      if (beaconRef) {
        const lanPeers = beaconRef.getPeers()
        const lanPeer = lanPeers.get(targetName)
        if (lanPeer) {
          tcpEndpoint = { host: lanPeer.ip, port: lanPeer.tcpPort }
        }
      }
    }
  }

  // 连接到目标管道服务器（UDS 或 TCP）
  let client: PipeClient
  try {
    const myName =
      getPipeIpc(currentState).serverName ?? `master-${process.pid}`
    client = await connectToPipe(targetName, myName, undefined, tcpEndpoint)
  } catch (err) {
    return {
      type: 'text',
      value: `连接到 "${targetName}"${tcpEndpoint ? ` (TCP ${tcpEndpoint.host}:${tcpEndpoint.port})` : ''} 失败：${err instanceof Error ? err.message : String(err)}`
    }
  }

  // 发送附加请求并等待响应
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      client.disconnect()
      resolve({
        type: 'text',
        value: `附加到 "${targetName}" 超时（5 秒内无响应）。`,
      })
    }, 5000)

    client.onMessage((msg: PipeMessage) => {
      if (msg.type === 'attach_accept') {
        clearTimeout(timeout)

        // 在模块级注册表中注册从属客户端
        addSlaveClient(targetName, client)

        // 更新 AppState：添加从属会话并切换为主控角色
        context.setAppState(prev => ({
          ...prev,
          pipeIpc: {
            ...getPipeIpc(prev),
            role: 'master',
            displayRole: 'master',
            slaves: {
              ...getPipeIpc(prev).slaves,
              [targetName]: {
                name: targetName,
                connectedAt: new Date().toISOString(),
                status: 'idle' as const,
                unreadCount: 0,
                history: [],
              },
            },
          },
        }))

        const slaveCount =
          Object.keys(getPipeIpc(currentState).slaves).length + 1
        resolve({
          type: 'text',
          value: `已作为主控角色附加到 "${targetName}"。当前监控 ${slaveCount} 个子会话。
使用 /send ${targetName} <消息> 发送任务。
使用 /status 查看所有连接的子会话。
使用 /detach ${targetName} 断开连接。`,
        })
      } else if (msg.type === 'attach_reject') {
        clearTimeout(timeout)
        client.disconnect()

        resolve({
          type: 'text',
          value: `附加请求被 "${targetName}" 拒绝：${msg.data ?? '未知原因'}`})
      }
    })

    // 包含 machineId，以便远程端区分局域网对等节点与本地对等节点
    const pipeState = getPipeIpc(currentState)
    client.send({
      type: 'attach_request',
      meta: { machineId: pipeState.machineId },
    })
  })
}
