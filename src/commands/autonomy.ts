import type { Command, LocalCommandCall } from '../types/command.js'
import {
  formatAutonomyFlowDetail,
  formatAutonomyFlowsList,
  formatAutonomyFlowsStatus,
  getAutonomyFlowById,
  listAutonomyFlows,
  requestManagedAutonomyFlowCancel,
} from '../utils/autonomyFlows.js'
import {
  formatAutonomyRunsList,
  formatAutonomyRunsStatus,
  listAutonomyRuns,
  markAutonomyRunCancelled,
  resumeManagedAutonomyFlowPrompt,
} from '../utils/autonomyRuns.js'
import {
  enqueuePendingNotification,
  removeByFilter,
} from '../utils/messageQueueManager.js'

function parseRunsLimit(raw?: string): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 10
  }
  return Math.min(parsed, 50)
}

const call: LocalCommandCall = async (args: string) => {
  const [subcommand = 'status', arg1, arg2] = args.trim().split(/\s+/, 3)
  const runs = await listAutonomyRuns()
  const flows = await listAutonomyFlows()

  if (subcommand === 'runs') {
    return {
      type: 'text',
      value: formatAutonomyRunsList(runs, parseRunsLimit(arg1)),
    }
  }

  if (subcommand === 'flows') {
    return {
      type: 'text',
      value: formatAutonomyFlowsList(flows, parseRunsLimit(arg1)),
    }
  }

  if (subcommand === 'flow') {
    if (arg1 === 'cancel') {
      const flowId = arg2 ?? ''
      const cancelled = await requestManagedAutonomyFlowCancel({ flowId })
      if (!cancelled) {
        return {
          type: 'text',
          value: '未找到自主流程。',
        }
      }
      if (!cancelled.accepted) {
        return {
          type: 'text',
          value: `自主流程 ${flowId} 已处于终止状态 (${cancelled.flow.status})。`,
        }
      }
      const removed = removeByFilter(cmd => cmd.autonomy?.flowId === flowId)
      for (const command of removed) {
        if (command.autonomy?.runId) {
          await markAutonomyRunCancelled(command.autonomy.runId)
        }
      }
      return {
        type: 'text',
        value:
          cancelled.flow.status === 'running'
            ? `已请求取消流程 ${flowId}。当前步骤仍在运行，且不会启动新步骤。`
            : `已取消流程 ${flowId}。移除了 ${removed.length} 个已排队的步骤。`,
      }
    }

    if (arg1 === 'resume') {
      const flowId = arg2 ?? ''
      const command = await resumeManagedAutonomyFlowPrompt({ flowId })
      if (!command) {
        return {
          type: 'text',
          value: '自主流程未处于等待状态或未找到。',
        }
      }
      enqueuePendingNotification(command)
      return {
        type: 'text',
        value: `已为流程 ${flowId} 排队下一个托管步骤。`,
      }
    }

    return {
      type: 'text',
      value: formatAutonomyFlowDetail(await getAutonomyFlowById(arg1 ?? '')),
    }
  }

  if (subcommand !== 'status' && subcommand !== '') {
    return {
      type: 'text',
      value:
        '用法: /autonomy [status|runs [limit]|flows [limit]|flow <id>|flow cancel <id>|flow resume <id>]',
    }
  }

  return {
    type: 'text',
    value: [formatAutonomyRunsStatus(runs), formatAutonomyFlowsStatus(flows)].join('\n'),
  }
}

const autonomy = {
  type: 'local',
  name: 'autonomy',
  description:
    '检查为主动触发和计划任务记录的自动自主运行',
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default autonomy
