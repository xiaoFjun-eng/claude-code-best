// 锁文件，其mtime即为lastConsolidatedAt。文件内容为持有者的PID。
//
// 位于内存目录（getAutoMemPath）内，因此与
// 内存一样以git根目录为键，并且即使内存路径来自父目录可
// 能不存在的环境/设置覆盖，该文件也是可写的。

import { mkdir, readFile, stat, unlink, utimes, writeFile } from 'fs/promises'
import { join } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getAutoMemPath } from '../../memdir/paths.js'
import { logForDebugging } from '../../utils/debug.js'
import { isProcessRunning } from '../../utils/genericProcessUtils.js'
import { listCandidates } from '../../utils/listSessionsImpl.js'
import { getProjectDir } from '../../utils/sessionStorage.js'

const LOCK_FILE = '.consolidate-lock'

// 即使PID存活，超过此时间也视为过期（PID重用防护）。
const HOLDER_STALE_MS = 60 * 60 * 1000

function lockPath(): string {
  return join(getAutoMemPath(), LOCK_FILE)
}

/** 锁文件的mtime = lastConsolidatedAt。若不存在则为0。
每次调用开销：一次stat。 */
export async function readLastConsolidatedAt(): Promise<number> {
  try {
    const s = await stat(lockPath())
    return s.mtimeMs
  } catch {
    return 0
  }
}

/** 获取：写入PID → mtime设为当前时间。返回获取前的mtime（用于回滚），若被阻塞或竞争失败则返回null。

  成功 → 不做任何操作。mtime保持为当前时间。
  失败 → rollbackConsolidationLock(priorMtime) 回退mtime。
  崩溃 → mtime卡住，PID已死 → 下一个进程回收。 */
export async function tryAcquireConsolidationLock(): Promise<number | null> {
  const path = lockPath()

  let mtimeMs: number | undefined
  let holderPid: number | undefined
  try {
    const [s, raw] = await Promise.all([stat(path), readFile(path, 'utf8')])
    mtimeMs = s.mtimeMs
    const parsed = parseInt(raw.trim(), 10)
    holderPid = Number.isFinite(parsed) ? parsed : undefined
  } catch {
    // ENOENT — 无先前锁。
  }

  if (mtimeMs !== undefined && Date.now() - mtimeMs < HOLDER_STALE_MS) {
    if (holderPid !== undefined && isProcessRunning(holderPid)) {
      logForDebugging(
        `[autoDream] 锁被存活的PID ${holderPid} 持有（mtime为 ${Math.round((Date.now() - mtimeMs) / 1000)} 秒前）`,
      )
      return null
    }
    // PID已死或内容无法解析 — 回收。
  }

  // 内存目录可能尚不存在。
  await mkdir(getAutoMemPath(), { recursive: true })
  await writeFile(path, String(process.pid))

  // 两个回收者同时写入 → 最后写入者赢得PID。失败者在重新读取后退出。
  let verify: string
  try {
    verify = await readFile(path, 'utf8')
  } catch {
    return null
  }
  if (parseInt(verify.trim(), 10) !== process.pid) return null

  return mtimeMs ?? 0
}

/** fork失败后将mtime回退到获取前的状态。清除PID内容——否则我们仍在运行的进程会看起来像持有锁。
priorMtime为0 → 删除文件（恢复为无文件状态）。 */
export async function rollbackConsolidationLock(
  priorMtime: number,
): Promise<void> {
  const path = lockPath()
  try {
    if (priorMtime === 0) {
      await unlink(path)
      return
    }
    await writeFile(path, '')
    const t = priorMtime / 1000 // utimes需要秒级时间
    await utimes(path, t, t)
  } catch (e: unknown) {
    logForDebugging(
      `[autoDream] 回滚失败：${(e as Error).message} — 下次触发延迟至minHours`,
    )
  }
}

/** mtime在sinceMs之后的会话ID。listCandidates负责UUID验证（排除agent-*.jsonl）和并行stat。

使用mtime（自某时间点以来被TOUCHED的会话），而非birthtime（ext4上为0）。
调用者排除当前会话。按每个cwd的transcripts扫描——这是一个跳过门，因此少算工作树会话是安全的。 */
export async function listSessionsTouchedSince(
  sinceMs: number,
): Promise<string[]> {
  const dir = getProjectDir(getOriginalCwd())
  const candidates = await listCandidates(dir, true)
  return candidates.filter(c => c.mtime > sinceMs).map(c => c.sessionId)
}

/** 来自手动/dream的时间戳。乐观策略——在提示构建时触发，无技能完成后的钩子。尽力而为。 */
export async function recordConsolidation(): Promise<void> {
  try {
    // 内存目录可能尚不存在（在任何自动触发之前的手动/dream）。
    await mkdir(getAutoMemPath(), { recursive: true })
    await writeFile(lockPath(), String(process.pid))
  } catch (e: unknown) {
    logForDebugging(
      `[autoDream] recordConsolidation写入失败：${(e as Error).message}`,
    )
  }
}
