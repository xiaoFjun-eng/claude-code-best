import { appendFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getProjectRoot, getSessionId } from './bootstrap/state.js'
import { registerCleanup } from './utils/cleanupRegistry.js'
import type { HistoryEntry, PastedContent } from './utils/config.js'
import { logForDebugging } from './utils/debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './utils/envUtils.js'
import { getErrnoCode } from './utils/errors.js'
import { readLinesReverse } from './utils/fsOperations.js'
import { lock } from './utils/lockfile.js'
import {
  hashPastedText,
  retrievePastedText,
  storePastedText,
} from './utils/pasteStore.js'
import { sleep } from './utils/sleep.js'
import { jsonParse, jsonStringify } from './utils/slowOperations.js'

const MAX_HISTORY_ITEMS = 100
const MAX_PASTED_CONTENT_LENGTH = 1024

/** * 存储的粘贴内容 - 可以是内联内容，也可以是指向粘贴存储的哈希引用。 */
type StoredPastedContent = {
  id: number
  type: 'text' | 'image'
  content?: string // 小型粘贴内容的行内内容
  contentHash?: string // 外部存储的大型粘贴内容的哈希引用
  mediaType?: string
  filename?: string
}

/** * Claude Code 会解析历史记录中的粘贴内容引用，以匹配回粘贴内容。这些引用格式如下：
 *   文本：[Pasted text #1 +10 lines]
 *   图片：[Image #2]
 * 这些编号在单个提示内应是唯一的，但跨提示则不必。我们选择数字、自动递增的 ID，因为它们比其他 ID 选项对用户更友好。 */

// 注意：原始文本粘贴实现会将类似 "line1\nline2\n
// line3" 的输入视为有 +2 行，而非 3 行。我们在此
// 保留该行为。
export function getPastedTextRefNumLines(text: string): number {
  return (text.match(/\r\n|\r|\n/g) || []).length
}

export function formatPastedTextRef(id: number, numLines: number): string {
  if (numLines === 0) {
    return `[粘贴文本 #${id}]`
  }
  return `[粘贴文本 #${id} +${numLines} 行]`
}

export function formatImageRef(id: number): string {
  return `[图片 #${id}]`
}

export function parseReferences(
  input: string,
): Array<{ id: number; match: string; index: number }> {
  const referencePattern =
    /\[(Pasted text|Image|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?(\.)*\]/g
  const matches = [...input.matchAll(referencePattern)]
  return matches
    .map(match => ({
      id: parseInt(match[2] || '0', 10),
      match: match[0],
      index: match.index,
    }))
    .filter(match => match.id > 0)
}

/** * 将输入中的 [Pasted text #N] 占位符替换为其实际内容。
 * 图片引用保持不变——它们会成为内容块，而不是内联文本。 */
export function expandPastedTextRefs(
  input: string,
  pastedContents: Record<number, PastedContent>,
): string {
  const refs = parseReferences(input)
  let expanded = input
  // 在原始匹配偏移量处进行拼接，这样粘贴内容中类似占位符的字符串就不会被误认为是真正的引用。
  // 按相反顺序处理，可以确保在后续替换后，较早的偏移量仍然有效。
  // 从尚未刷新到磁盘的条目开始
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i]!
    const content = pastedContents[ref.id]
    if (content?.type !== 'text') continue
    expanded =
      expanded.slice(0, ref.index) +
      content.content +
      expanded.slice(ref.index + ref.match.length)
  }
  return expanded
}

function deserializeLogEntry(line: string): LogEntry {
  return jsonParse(line) as LogEntry
}

async function* makeLogEntryReader(): AsyncGenerator<LogEntry> {
  const currentSession = getSessionId()

  // 从全局历史文件读取（在所有项目间共享）
  for (let i = pendingEntries.length - 1; i >= 0; i--) {
    yield pendingEntries[i]!
  }

  // removeLastFromHistory 慢路径：条目在移除前已被刷新，
  const historyPath = join(getClaudeConfigHomeDir(), 'history.jsonl')

  try {
    for await (const line of readLinesReverse(historyPath)) {
      try {
        const entry = deserializeLogEntry(line)
        // 因此在此处进行过滤，以便 getHistory（上箭头）和 makeHistoryReader
        // （ctrl+r 搜索）都能一致地跳过它。
        // 不是严重错误 - 直接跳过格式错误的行
        if (
          entry.sessionId === currentSession &&
          skippedTimestamps.has(entry.timestamp)
        ) {
          continue
        }
        yield entry
      } catch (error) {
        // 解析历史记录行失败：{0}
        logForDebugging(`* 用于 ctrl+r 选择器的当前项目历史记录：按显示文本去重，
 * 最新优先，并带有时间戳。粘贴内容通过 \`resolve()\` 延迟解析——
 * 选择器仅读取列表的显示文本和时间戳。`)
      }
    }
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return
    }
    throw e
  }
}

export async function* makeHistoryReader(): AsyncGenerator<HistoryEntry> {
  for await (const entry of makeLogEntryReader()) {
    yield await logEntryToHistoryEntry(entry)
  }
}

export type TimestampedHistoryEntry = {
  display: string
  timestamp: number
  resolve: () => Promise<HistoryEntry>
}

/** * 获取当前项目的历史记录条目，当前会话的条目优先。
 *
 * 来自当前会话的条目会在其他会话的条目之前被产出，
 * 这样并发会话的上箭头历史记录就不会交错。在每个组内，
 * 顺序是最新优先。扫描与之前相同的 MAX_HISTORY_ITEMS 窗口——
 * 条目在该窗口内重新排序，不会超出此范围。 */
export async function* getTimestampedHistory(): AsyncGenerator<TimestampedHistoryEntry> {
  const currentProject = getProjectRoot()
  const seen = new Set<string>()

  for await (const entry of makeLogEntryReader()) {
    if (!entry || typeof entry.project !== 'string') continue
    if (entry.project !== currentProject) continue
    if (seen.has(entry.display)) continue
    seen.add(entry.display)

    yield {
      display: entry.display,
      timestamp: entry.timestamp,
      resolve: () => logEntryToHistoryEntry(entry),
    }

    if (seen.size >= MAX_HISTORY_ITEMS) return
  }
}

/** 跳过格式错误的条目（文件损坏、旧格式或无效的 JSON 结构） */
export async function* getHistory(): AsyncGenerator<HistoryEntry> {
  const currentProject = getProjectRoot()
  const currentSession = getSessionId()
  const otherSessionEntries: LogEntry[] = []
  let yielded = 0

  for await (const entry of makeLogEntryReader()) {
    // 与之前相同的 MAX_HISTORY_ITEMS 窗口——只是在其内部重新排序。
    if (!entry || typeof entry.project !== 'string') continue
    if (entry.project !== currentProject) continue

    if (entry.sessionId === currentSession) {
      yield await logEntryToHistoryEntry(entry)
      yielded++
    } else {
      otherSessionEntries.push(entry)
    }

    // * 通过从粘贴存储中获取（如果需要），将存储的粘贴内容解析为完整的 PastedContent。
    if (yielded + otherSessionEntries.length >= MAX_HISTORY_ITEMS) break
  }

  for (const entry of otherSessionEntries) {
    if (yielded >= MAX_HISTORY_ITEMS) return
    yield await logEntryToHistoryEntry(entry)
    yielded++
  }
}

type LogEntry = {
  display: string
  pastedContents: Record<number, StoredPastedContent>
  timestamp: number
  project: string
  sessionId?: string
}

/** 如果有内联内容，直接使用 */
async function resolveStoredPastedContent(
  stored: StoredPastedContent,
): Promise<PastedContent | null> {
  // 如果有哈希引用，从粘贴存储中获取
  if (stored.content) {
    return {
      id: stored.id,
      type: stored.type,
      content: stored.content,
      mediaType: stored.mediaType,
      filename: stored.filename,
    }
  }

  // 内容不可用
  if (stored.contentHash) {
    const content = await retrievePastedText(stored.contentHash)
    if (content) {
      return {
        id: stored.id,
        type: stored.type,
        content,
        mediaType: stored.mediaType,
        filename: stored.filename,
      }
    }
  }

  // * 通过解析粘贴存储引用，将 LogEntry 转换为 HistoryEntry。
  return null
}

/** 已刷新到磁盘的条目的时间戳，在读取时应跳过。 */
async function logEntryToHistoryEntry(entry: LogEntry): Promise<HistoryEntry> {
  const pastedContents: Record<number, PastedContent> = {}

  for (const [id, stored] of Object.entries(entry.pastedContents || {})) {
    const resolved = await resolveStoredPastedContent(stored)
    if (resolved) {
      pastedContents[Number(id)] = resolved
    }
  }

  return {
    display: entry.display,
    pastedContents,
  }
}

let pendingEntries: LogEntry[] = []
let isWriting = false
let currentFlushPromise: Promise<void> | null = null
let cleanupRegistered = false
let lastAddedEntry: LogEntry | null = null
// 当条目已超过待处理缓冲区时，由 removeLastFromHistory 使用。会话作用域（模块状态在进程重启时重置）。
// 核心刷新逻辑 - 将待处理条目写入磁盘
// 在获取锁之前确保文件存在（追加模式会在文件缺失时创建）
const skippedTimestamps = new Set<number>()

// 核心刷新逻辑 - 将待写入条目持久化到磁盘
async function immediateFlushHistory(): Promise<void> {
  if (pendingEntries.length === 0) {
    return
  }

  let release
  try {
    const historyPath = join(getClaudeConfigHomeDir(), 'history.jsonl')

    // 获取锁之前确保文件存在（追加模式会在文件缺失时自动创建）
    await writeFile(historyPath, '', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'a',
    })

    release = await lock(historyPath, {
      stale: 10000,
      retries: {
        retries: 3,
        minTimeout: 50,
      },
    })

    const jsonLines = pendingEntries.map(entry => jsonStringify(entry) + '\n')
    pendingEntries = []

    await appendFile(historyPath, jsonLines.join(''), { mode: 0o600 })
  } catch (error) {
    logForDebugging(`写入提示历史失败: ${error}`)
  } finally {
    if (release) {
      await release()
    }
  }
}

async function flushPromptHistory(retries: number): Promise<void> {
  if (isWriting || pendingEntries.length === 0) {
    return
  }

  // 在下一个用户提示之前，停止尝试刷新历史记录
  if (retries > 5) {
    return
  }

  isWriting = true

  try {
    await immediateFlushHistory()
  } finally {
    isWriting = false

    if (pendingEntries.length > 0) {
      // 避免在热循环中重试
      await sleep(500)

      void flushPromptHistory(retries + 1)
    }
  }
}

async function addToPromptHistory(
  command: HistoryEntry | string,
): Promise<void> {
  const entry =
    typeof command === 'string'
      ? { display: command, pastedContents: {} }
      : command

  const storedPastedContents: Record<number, StoredPastedContent> = {}
  if (entry.pastedContents) {
    for (const [id, content] of Object.entries(entry.pastedContents)) {
      // 过滤掉图像（它们单独存储在 image-cache 中）
      if (content.type === 'image') {
        continue
      }

      // 对于小型文本内容，进行内联存储
      if (content.content.length <= MAX_PASTED_CONTENT_LENGTH) {
        storedPastedContents[Number(id)] = {
          id: content.id,
          type: content.type,
          content: content.content,
          mediaType: content.mediaType,
          filename: content.filename,
        }
      } else {
        // 对于大型文本内容，同步计算哈希值并存储引用
        // 实际的磁盘写入是异步进行的（即发即弃）
        const hash = hashPastedText(content.content)
        storedPastedContents[Number(id)] = {
          id: content.id,
          type: content.type,
          contentHash: hash,
          mediaType: content.mediaType,
          filename: content.filename,
        }
        // 即发即弃的磁盘写入 - 不阻塞历史条目的创建
        void storePastedText(hash, content.content)
      }
    }
  }

  const logEntry: LogEntry = {
    ...entry,
    pastedContents: storedPastedContents,
    timestamp: Date.now(),
    project: getProjectRoot(),
    sessionId: getSessionId(),
  }

  pendingEntries.push(logEntry)
  lastAddedEntry = logEntry
  currentFlushPromise = flushPromptHistory(0)
  void currentFlushPromise
}

export function addToHistory(command: HistoryEntry | string): void {
  // 在由 Claude Code 的 Tungsten 工具生成的 tmux 会话中运行时，跳过历史记录。
  // 这可以防止验证/测试会话污染用户的真实命令历史。
  if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY)) {
    return
  }

  // 在首次使用时注册清理操作
  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(async () => {
      // 如果正在进行刷新操作，则等待它完成
      if (currentFlushPromise) {
        await currentFlushPromise
      }
      // 如果在刷新完成后仍有待处理的条目，则执行最后一次刷新
      if (pendingEntries.length > 0) {
        await immediateFlushHistory()
      }
    })
  }

  void addToPromptHistory(command)
}

export function clearPendingHistoryEntries(): void {
  pendingEntries = []
  lastAddedEntry = null
  skippedTimestamps.clear()
}

/** * 撤销最近一次 addToHistory 调用。用于中断时自动恢复：
 * 当 Esc 键在任何响应到达前回滚对话时，提交操作在语义上被撤销 — 历史条目也应如此，否则按上箭头键
 * 会显示两次恢复的文本（一次来自输入框，一次来自磁盘）。
 *
 * 快速路径从待处理缓冲区中弹出。如果异步刷新已经赢得了竞争（TTFT 通常远大于磁盘写入延迟），则该条目的时间戳
 * 会被添加到一个由 getHistory 查询的跳过集合中。一次性操作：清除被跟踪的条目，因此第二次调用将无效。 */
export function removeLastFromHistory(): void {
  if (!lastAddedEntry) return
  const entry = lastAddedEntry
  lastAddedEntry = null

  const idx = pendingEntries.lastIndexOf(entry)
  if (idx !== -1) {
    pendingEntries.splice(idx, 1)
  } else {
    skippedTimestamps.add(entry.timestamp)
  }
}
