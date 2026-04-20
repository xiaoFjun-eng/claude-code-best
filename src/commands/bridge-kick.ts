import { getBridgeDebugHandle } from '../bridge/bridgeDebug.js'
import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'

/** 仅限 Ant 用户：注入网桥故障状态以手动测试恢复路径。

  /bridge-kick close 1002            — 触发 ws_closed 事件，代码为 1002
  /bridge-kick close 1006            — 触发 ws_closed 事件，代码为 1006
  /bridge-kick poll 404              — 下一次轮询抛出 404/not_found_error
  /bridge-kick poll 404 <type>       — 下一次轮询抛出 404 并附带 error_type
  /bridge-kick poll 401              — 下一次轮询抛出 401（认证错误）
  /bridge-kick poll transient        — 下一次轮询抛出 axios 风格的拒绝错误
  /bridge-kick register fail         — 下一次注册（在 doReconnect 内部）暂时性失败
  /bridge-kick register fail 3       — 接下来 3 次注册暂时性失败
  /bridge-kick register fatal        — 下一次注册返回 403（终止性错误）
  /bridge-kick reconnect-session fail — POST /bridge/reconnect 失败（→ 策略 2）
  /bridge-kick heartbeat 401         — 下一次心跳返回 401（JWT 过期）
  /bridge-kick reconnect             — 直接调用 doReconnect（等同于 SIGUSR2）
  /bridge-kick status                — 打印当前网桥状态

工作流程：连接远程控制，运行子命令，`tail -f debug.log` 并观察 [bridge:repl] / [bridge:debug] 日志行以查看恢复反应。

复合序列 — BQ 数据中的故障模式是链式事件，而非单一事件。先排队故障，然后触发：

  # #22148 残留问题：ws_closed → 注册暂时性故障 → 是否拆除？
  /bridge-kick register fail 2
  /bridge-kick close 1002
  → 预期：doReconnect 尝试注册，失败，返回 false → 拆除
    （演示了需要修复的重试间隙）

  # 死网关：poll 404/not_found_error → onEnvironmentLost 是否触发？
  /bridge-kick poll 404
  → 预期：tengu_bridge_repl_fatal_error（网关已死 — 147K/周）
    修复后：tengu_bridge_repl_env_lost → doReconnect */

const USAGE = `/bridge-kick <子命令>
  close <代码>              触发 ws_closed 事件，使用给定代码（例如 1002）
  poll <状态码> [类型]      下一次轮询抛出 BridgeFatalError(状态码, 类型)
  poll transient            下一次轮询抛出 axios 风格的拒绝错误（5xx/网络）
  register fail [N]         接下来 N 次注册暂时性失败（默认为 1）
  register fatal            下一次注册返回 403（终止性错误）
  reconnect-session fail    下一次 POST /bridge/reconnect 失败
  heartbeat <状态码>        下一次心跳抛出 BridgeFatalError(状态码)
  reconnect                 直接调用 reconnectEnvironmentWithSession
  status                    打印网桥状态`

const call: LocalCommandCall = async args => {
  const h = getBridgeDebugHandle()
  if (!h) {
    return {
      type: 'text',
      value:
        '未注册网桥调试句柄。必须连接远程控制（USER_TYPE=ant）。',
    }
  }

  const [sub, a, b] = args.trim().split(/\s+/)

  switch (sub) {
    case 'close': {
      const code = Number(a)
      if (!Number.isFinite(code)) {
        return { type: 'text', value: `close: 需要一个数字代码
${USAGE}` }
      }
      h.fireClose(code)
      return {
        type: 'text',
        value: `已触发传输层关闭(${code})。请观察 debug.log 中的 [bridge:repl] 恢复日志。`,
      }
    }

    case 'poll': {
      if (a === 'transient') {
        h.injectFault({
          method: 'pollForWork',
          kind: 'transient',
          status: 503,
          count: 1,
        })
        h.wakePollLoop()
        return {
          type: 'text',
          value:
            '下一次轮询将抛出暂时性错误（axios 拒绝）。轮询循环已唤醒。',
        }
      }
      const status = Number(a)
      if (!Number.isFinite(status)) {
        return {
          type: 'text',
          value: `poll: 需要 'transient' 或一个状态码
${USAGE}`,
        }
      }
      // 默认使用服务器实际为 404 发送的内容（BQ 已验证），因此 `/bri
      // dge-kick poll 404` 可重现真实的每周 147K 状态。
      const errorType =
        b ?? (status === 404 ? 'not_found_error' : 'authentication_error')
      h.injectFault({
        method: 'pollForWork',
        kind: 'fatal',
        status,
        errorType,
        count: 1,
      })
      h.wakePollLoop()
      return {
        type: 'text',
        value: `下一次轮询将抛出 BridgeFatalError(${status}, ${errorType})。轮询循环已唤醒。`,
      }
    }

    case 'register': {
      if (a === 'fatal') {
        h.injectFault({
          method: 'registerBridgeEnvironment',
          kind: 'fatal',
          status: 403,
          errorType: 'permission_error',
          count: 1,
        })
        return {
          type: 'text',
          value:
            '下一次 registerBridgeEnvironment 将返回 403。通过 close/reconnect 触发。',
        }
      }
      const n = Number(b) || 1
      h.injectFault({
        method: 'registerBridgeEnvironment',
        kind: 'transient',
        status: 503,
        count: n,
      })
      return {
        type: 'text',
        value: `接下来 ${n} 次 registerBridgeEnvironment 调用将暂时性失败。通过 close/reconnect 触发。`,
      }
    }

    case 'reconnect-session': {
      h.injectFault({
        method: 'reconnectSession',
        kind: 'fatal',
        status: 404,
        errorType: 'not_found_error',
        count: 2,
      })
      return {
        type: 'text',
        value:
          '接下来 2 次 POST /bridge/reconnect 调用将返回 404。doReconnect 策略 1 将回退到策略 2。',
      }
    }

    case 'heartbeat': {
      const status = Number(a) || 401
      h.injectFault({
        method: 'heartbeatWork',
        kind: 'fatal',
        status,
        errorType: status === 401 ? 'authentication_error' : 'not_found_error',
        count: 1,
      })
      return {
        type: 'text',
        value: `下一次心跳将 ${status}。观察 onHeartbeatFatal → 工作状态拆除。`,
      }
    }

    case 'reconnect': {
      h.forceReconnect()
      return {
        type: 'text',
        value: '已调用 reconnectEnvironmentWithSession()。请观察 debug.log。',
      }
    }

    case 'status': {
      return { type: 'text', value: h.describe() }
    }

    default:
      return { type: 'text', value: USAGE }
  }
}

const bridgeKick = {
  type: 'local',
  name: 'bridge-kick',
  description: '注入网桥故障状态以进行手动恢复测试',
  isEnabled: () => process.env.USER_TYPE === 'ant',
  supportsNonInteractive: false,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default bridgeKick
