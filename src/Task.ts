import { randomBytes } from 'crypto'
import type { AppState } from './state/AppState.js'
import type { AgentId } from './types/ids.js'
import { getTaskOutputPath } from './utils/task/diskOutput.js'

export type TaskType =
  | 'local_bash'
  | 'local_agent'
  | 'remote_agent'
  | 'in_process_teammate'
  | 'local_workflow'
  | 'monitor_mcp'
  | 'dream'

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'

/** * 当任务处于终止状态且不再进一步转换时为 True。
 * 用于防止向已终止的队友注入消息、从 AppState 中驱逐已完成的任务，
 * 以及孤儿清理路径。 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

export type TaskHandle = {
  taskId: string
  cleanup?: () => void
}

export type SetAppState = (f: (prev: AppState) => AppState) => void

export type TaskContext = {
  abortController: AbortController
  getAppState: () => AppState
  setAppState: SetAppState
}

// 所有任务状态共享的基础字段
export type TaskStateBase = {
  id: string
  type: TaskType
  status: TaskStatus
  description: string
  toolUseId?: string
  startTime: number
  endTime?: number
  totalPausedMs?: number
  outputFile: string
  outputOffset: number
  notified: boolean
}

export type LocalShellSpawnInput = {
  command: string
  description: string
  timeout?: number
  toolUseId?: string
  agentId?: AgentId
  /** UI 显示变体：描述作为标签、对话框标题、状态栏药丸。 */
  kind?: 'bash' | 'monitor'
}

// getTaskByType 为 kill 操作所派发的：spawn/render 从未
// 被多态调用（已在 #22546 中移除）。所有六个 kill 实现
// 仅使用 setAppState — getAppState/abortController 是冗余的。
export type Task = {
  name: string
  type: TaskType
  kill(taskId: string, setAppState: SetAppState): Promise<void>
}

// 任务 ID 前缀
const TASK_ID_PREFIXES: Record<string, string> = {
  local_bash: 'b', // 为保持向后兼容性，请保留为 'b'
  local_agent: 'a',
  remote_agent: 'r',
  in_process_teammate: 't',
  local_workflow: 'w',
  monitor_mcp: 'm',
  dream: 'd',
}

// 获取任务 ID 前缀
function getTaskIdPrefix(type: TaskType): string {
  return TASK_ID_PREFIXES[type] ?? 'x'
}

// 用于任务 ID 的、不区分大小写的安全字母表（数字 + 小写字母）。
// 36^8 ≈ 2.8 万亿种组合，足以抵御暴力符号链接攻击。
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

export function generateTaskId(type: TaskType): string {
  const prefix = getTaskIdPrefix(type)
  const bytes = randomBytes(8)
  let id = prefix
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET[bytes[i]! % TASK_ID_ALPHABET.length]
  }
  return id
}

export function createTaskStateBase(
  id: string,
  type: TaskType,
  description: string,
  toolUseId?: string,
): TaskStateBase {
  return {
    id,
    type,
    status: 'pending',
    description,
    toolUseId,
    startTime: Date.now(),
    outputFile: getTaskOutputPath(id),
    outputOffset: 0,
    notified: false,
  }
}
