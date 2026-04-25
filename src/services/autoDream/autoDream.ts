// biome-ignore-all assist/source/organizeImports: 仅限 ANT 内部的导入标记不得重新排序
// 后台记忆整合。当时间阈值满足且累积了足够数量的会话时，以派生子代理方式触发 /dream 提示。
//
// 门控顺序（成本最低优先）：
//   1. 时间：距上次整合 >= 最小小时数（一次 stat）
//   2. 会话：修改时间 > 上次整合时间的会话记录数量 >= 最小会话数
//   3. 锁：没有其他进程正在进行整合
//
// 状态在 initAutoDream() 内部闭包作用域中，而不是模块级
// （测试在 beforeEach 中调用 initAutoDream() 以获取新的闭包）。

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import {
  createCacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import {
  createUserMessage,
  createMemorySavedMessage,
} from '../../utils/messages.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import type { ToolUseContext } from '../../Tool.js'
import { logEvent } from '../analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { isAutoMemoryEnabled, getAutoMemPath } from '../../memdir/paths.js'
import { isAutoDreamEnabled } from './config.js'
import { getProjectDir } from '../../utils/sessionStorage.js'
import {
  getOriginalCwd,
  getKairosActive,
  getIsRemoteMode,
  getSessionId,
} from '../../bootstrap/state.js'
import { createAutoMemCanUseTool } from '../extractMemories/extractMemories.js'
import { buildConsolidationPrompt } from './consolidationPrompt.js'
import {
  readLastConsolidatedAt,
  listSessionsTouchedSince,
  tryAcquireConsolidationLock,
  rollbackConsolidationLock,
} from './consolidationLock.js'
import {
  registerDreamTask,
  addDreamTurn,
  completeDreamTask,
  failDreamTask,
  isDreamTask,
} from '../../tasks/DreamTask/DreamTask.js'
import { FILE_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileWriteTool/prompt.js'

// 扫描限流：当时间门控通过但会话门控不通过时，锁的 mtime 不会更新，因此每轮时间门控都会通过。
const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000

type AutoDreamConfig = {
  minHours: number
  minSessions: number
}

const DEFAULTS: AutoDreamConfig = {
  minHours: 24,
  minSessions: 5,
}

/**
 * 来自 tengu_onyx_plover 的阈值。启用门控位于 config.ts（isAutoDreamEnabled）；
 * 此函数仅返回调度参数。由于 GB 缓存可能返回过时的错误类型值，因此对每个字段进行防御性校验。
 */
function getConfig(): AutoDreamConfig {
  const raw =
    getFeatureValue_CACHED_MAY_BE_STALE<Partial<AutoDreamConfig> | null>(
      'tengu_onyx_plover',
      null,
    )
  return {
    minHours:
      typeof raw?.minHours === 'number' &&
      Number.isFinite(raw.minHours) &&
      raw.minHours > 0
        ? raw.minHours
        : DEFAULTS.minHours,
    minSessions:
      typeof raw?.minSessions === 'number' &&
      Number.isFinite(raw.minSessions) &&
      raw.minSessions > 0
        ? raw.minSessions
        : DEFAULTS.minSessions,
  }
}

function isGateOpen(): boolean {
  if (getKairosActive()) return false // KAIROS 模式使用磁盘技能 dream
  if (getIsRemoteMode()) return false
  if (!isAutoMemoryEnabled()) return false
  return isAutoDreamEnabled()
}

// 仅限 Ant 内部的测试覆盖。绕过启用/时间/会话门控，但不绕过锁（以免重复轮次堆积 dream）
// 以及内存目录前提条件。仍然会扫描会话，以便提示中的会话提示被填充。
function isForced(): boolean {
  return false
}

type AppendSystemMessageFn = NonNullable<ToolUseContext['appendSystemMessage']>

let runner:
  | ((
      context: REPLHookContext,
      appendSystemMessage?: AppendSystemMessageFn,
    ) => Promise<void>)
  | null = null

/**
 * 在启动时调用一次（与 initExtractMemories 一同在 backgroundHousekeeping 中），
 * 或在测试中每个 beforeEach 调用以获取新的闭包。
 */
export function initAutoDream(): void {
  let lastSessionScanAt = 0

  runner = async function runAutoDream(context, appendSystemMessage) {
    const cfg = getConfig()
    const force = isForced()
    if (!force && !isGateOpen()) return

    // --- 时间门控 ---
    let lastAt: number
    try {
      lastAt = await readLastConsolidatedAt()
    } catch (e: unknown) {
      logForDebugging(
        `[autoDream] readLastConsolidatedAt 失败：${(e as Error).message}`,
      )
      return
    }
    const hoursSince = (Date.now() - lastAt) / 3_600_000
    if (!force && hoursSince < cfg.minHours) return

    // --- 扫描限流 ---
    const sinceScanMs = Date.now() - lastSessionScanAt
    if (!force && sinceScanMs < SESSION_SCAN_INTERVAL_MS) {
      logForDebugging(
        `[autoDream] 扫描限流 — 时间门控已通过，但上次扫描在 ${Math.round(sinceScanMs / 1000)} 秒前`,
      )
      return
    }
    lastSessionScanAt = Date.now()

    // --- 会话门控 ---
    let sessionIds: string[]
    try {
      sessionIds = await listSessionsTouchedSince(lastAt)
    } catch (e: unknown) {
      logForDebugging(
        `[autoDream] listSessionsTouchedSince 失败：${(e as Error).message}`,
      )
      return
    }
    // 排除当前会话（其 mtime 总是最近的）
    const currentSession = getSessionId()
    sessionIds = sessionIds.filter(id => id !== currentSession)
    if (!force && sessionIds.length < cfg.minSessions) {
      logForDebugging(
        `[autoDream] 跳过 — 自上次整合以来有 ${sessionIds.length} 个会话，需要 ${cfg.minSessions} 个`,
      )
      return
    }

    // --- 锁 ---
    // 在 force 模式下，完全跳过获取锁 — 使用现有的 mtime，以便 kill 的回滚是无操作的（退回到原来的位置）。
    // 锁文件保持不变；下一个非 force 轮次会原样看到它。
    let priorMtime: number | null
    if (force) {
      priorMtime = lastAt
    } else {
      try {
        priorMtime = await tryAcquireConsolidationLock()
      } catch (e: unknown) {
        logForDebugging(
          `[autoDream] 获取锁失败：${(e as Error).message}`,
        )
        return
      }
      if (priorMtime === null) return
    }

    logForDebugging(
      `[autoDream] 触发 — 距上次整合 ${hoursSince.toFixed(1)} 小时，将审查 ${sessionIds.length} 个会话`,
    )
    logEvent('tengu_auto_dream_fired', {
      hours_since: Math.round(hoursSince),
      sessions_since: sessionIds.length,
    })

    const setAppState =
      context.toolUseContext.setAppStateForTasks ??
      context.toolUseContext.setAppState
    const abortController = new AbortController()
    const taskId = registerDreamTask(setAppState, {
      sessionsReviewing: sessionIds.length,
      priorMtime,
      abortController,
    })

    try {
      const memoryRoot = getAutoMemPath()
      const transcriptDir = getProjectDir(getOriginalCwd())
      // 工具约束说明放在 `extra` 中，而不是共享的提示正文中 —
      // 手动 /dream 在主循环中以正常权限运行，放在那里会产生误导。
      const extra = `\n\n**本次运行的工具约束：** Bash 仅限于只读命令（\`ls\`、\`find\`、\`grep\`、\`cat\`、\`stat\`、\`wc\`、\`head\`、\`tail\` 等）。任何写入、重定向到文件或修改状态的操作都将被拒绝。请以此为指导规划探索 — 不需要探测。\n\n自上次整合以来的会话（${sessionIds.length}）：\n${sessionIds.map(id => `- ${id}`).join('\n')}`
      const prompt = buildConsolidationPrompt(memoryRoot, transcriptDir, extra)

      const result = await runForkedAgent({
        promptMessages: [createUserMessage({ content: prompt })],
        cacheSafeParams: createCacheSafeParams(context),
        canUseTool: createAutoMemCanUseTool(memoryRoot),
        querySource: 'auto_dream',
        forkLabel: 'auto_dream',
        skipTranscript: true,
        overrides: { abortController },
        onMessage: makeDreamProgressWatcher(taskId, setAppState),
      })

      completeDreamTask(taskId, setAppState)
      // 在主对话记录中内联完成摘要（与 extractMemories 的“保存了 N 条记忆”消息相同的展示位置）。
      const dreamState = context.toolUseContext.getAppState().tasks?.[taskId]
      if (
        appendSystemMessage &&
        isDreamTask(dreamState) &&
        dreamState.filesTouched.length > 0
      ) {
        ;(appendSystemMessage as (msg: Message) => void)({
          ...createMemorySavedMessage(dreamState.filesTouched),
          verb: 'Improved',
        })
      }
      logForDebugging(
        `[autoDream] 完成 — 缓存：读取=${result.totalUsage.cache_read_input_tokens} 创建=${result.totalUsage.cache_creation_input_tokens}`,
      )
      logEvent('tengu_auto_dream_completed', {
        cache_read: result.totalUsage.cache_read_input_tokens,
        cache_created: result.totalUsage.cache_creation_input_tokens,
        output: result.totalUsage.output_tokens,
        sessions_reviewed: sessionIds.length,
      })
    } catch (e: unknown) {
      // 如果用户从后台任务对话框中终止，DreamTask.kill 已经中止、回滚了锁并将状态设为 killed。
      // 不要覆盖或双重回滚。
      if (abortController.signal.aborted) {
        logForDebugging('[autoDream] 用户中止')
        return
      }
      logForDebugging(`[autoDream] 派生失败：${(e as Error).message}`)
      logEvent('tengu_auto_dream_failed', {})
      failDreamTask(taskId, setAppState)
      // 回退 mtime，使时间门控再次通过。扫描限流就是退避机制。
      await rollbackConsolidationLock(priorMtime)
    }
  }
}

/**
 * 监视派生代理的消息。对于每个助手轮次，提取所有文本块（代理的推理/摘要 — 用户希望看到的内容），
 * 并将 tool_use 块折叠为计数。收集 Edit/Write 的文件路径用于阶段翻转和内联完成消息。
 */
function makeDreamProgressWatcher(
  taskId: string,
  setAppState: import('../../Task.js').SetAppState,
): (msg: Message) => void {
  return msg => {
    if (msg.type !== 'assistant') return
    let text = ''
    let toolUseCount = 0
    const touchedPaths: string[] = []
    const contentBlocks = msg.message!.content as ContentBlockParam[]
    for (const block of contentBlocks) {
      if (block.type === 'text') {
        text += block.text
      } else if (block.type === 'tool_use') {
        toolUseCount++
        if (
          block.name === FILE_EDIT_TOOL_NAME ||
          block.name === FILE_WRITE_TOOL_NAME
        ) {
          const input = block.input as { file_path?: unknown }
          if (typeof input.file_path === 'string') {
            touchedPaths.push(input.file_path)
          }
        }
      }
    }
    addDreamTurn(
      taskId,
      { text: text.trim(), toolUseCount },
      touchedPaths,
      setAppState,
    )
  }
}

/**
 * 来自 stopHooks 的入口点。在调用 initAutoDream() 之前是无操作的。
 * 启用时每轮的成本：一次 GB 缓存读取 + 一次 stat。
 */
export async function executeAutoDream(
  context: REPLHookContext,
  appendSystemMessage?: AppendSystemMessageFn,
): Promise<void> {
  await runner?.(context, appendSystemMessage)
}