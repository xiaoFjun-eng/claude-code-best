import { createHash, type UUID } from 'crypto'
import { diffLines } from 'diff'
import type { Stats } from 'fs'
import {
  chmod,
  copyFile,
  link,
  mkdir,
  readFile,
  stat,
  unlink,
} from 'fs/promises'
import { dirname, isAbsolute, join, relative } from 'path'
import {
  getIsNonInteractiveSession,
  getOriginalCwd,
  getSessionId,
} from 'src/bootstrap/state.js'
import { logEvent } from 'src/services/analytics/index.js'
import { notifyVscodeFileUpdated } from 'src/services/mcp/vscodeSdkMcp.js'
import type { LogOption } from 'src/types/logs.js'
import { inspect } from 'util'
import { getGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { getErrnoCode, isENOENT } from './errors.js'
import { pathExists } from './file.js'
import { logError } from './log.js'
import { recordFileHistorySnapshot } from './sessionStorage.js'

type BackupFileName = string | null // null 值表示该文件在此版本中不存在

export type FileHistoryBackup = {
  backupFileName: BackupFileName
  version: number
  backupTime: Date
}

export type FileHistorySnapshot = {
  messageId: UUID // 此快照关联的消息 ID
  trackedFileBackups: Record<string, FileHistoryBackup> // 文件路径到备份版本的映射
  timestamp: Date
}

export type FileHistoryState = {
  snapshots: FileHistorySnapshot[]
  trackedFiles: Set<string>
  // 单调递增计数器，每次创建快照时递增，即使旧快照被淘汰时也会递增。
  // 被 useGitDiffStats 用作活动信号（达到上限后 s
  // napshots.length 会趋于稳定）。
  snapshotSequence: number
}

const MAX_SNAPSHOTS = 100
export type DiffStats =
  | {
      filesChanged?: string[]
      insertions: number
      deletions: number
    }
  | undefined

export function fileHistoryEnabled(): boolean {
  if (getIsNonInteractiveSession()) {
    return fileHistoryEnabledSdk()
  }
  return (
    getGlobalConfig().fileCheckpointingEnabled !== false &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING)
  )
}

function fileHistoryEnabledSdk(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING) &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING)
  )
}

/** 通过创建文件当前内容的备份（如有必要）来跟踪文件编辑（和添加）。

必须在文件实际被添加或编辑之前调用，以便我们能在编辑前保存其内容。 */
export async function fileHistoryTrackEdit(
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void,
  filePath: string,
  messageId: UUID,
): Promise<void> {
  if (!fileHistoryEnabled()) {
    return
  }

  const trackingPath = maybeShortenFilePath(filePath)

  // 阶段 1：检查是否需要备份。推测性写入会在每次重复调用时覆盖
  // 确定性的 {hash}@v1 备份 —— 编辑后的第二次
  // trackEdit 会用编辑后的内容破坏 v1 备份。
  let captured: FileHistoryState | undefined
  updateFileHistoryState(state => {
    captured = state
    return state
  })
  if (!captured) return
  const mostRecent = captured.snapshots.at(-1)
  if (!mostRecent) {
    logError(new Error('FileHistory：缺少最新快照'))
    logEvent('tengu_file_history_track_edit_failed', {})
    return
  }
  if (mostRecent.trackedFileBackups[trackingPath]) {
    // 已在最新快照中跟踪；下一次 makeSnapshot 将重新检
    // 查 mtime 并在更改时重新备份。请勿触碰 v1 备份。
    return
  }

  // 阶段 2：异步备份。
  let backup: FileHistoryBackup
  try {
    backup = await createBackup(filePath, 1)
  } catch (error) {
    logError(error)
    logEvent('tengu_file_history_track_edit_failed', {})
    return
  }
  const isAddingFile = backup.backupFileName === null

  // 阶段 3：提交。重新检查跟踪状态（另一个 trackEdit 调用可能在此期间竞争）。
  updateFileHistoryState((state: FileHistoryState) => {
    try {
      const mostRecentSnapshot = state.snapshots.at(-1)
      if (
        !mostRecentSnapshot ||
        mostRecentSnapshot.trackedFileBackups[trackingPath]
      ) {
        return state
      }

      // 此文件尚未在最新快照中被跟踪，因此我们需要在
      // 那里追溯性地跟踪一个备份。
      const updatedTrackedFiles = state.trackedFiles.has(trackingPath)
        ? state.trackedFiles
        : new Set(state.trackedFiles).add(trackingPath)

      // 浅层展开就足够了：备份值在插入后永远不会被改变，因此我们只需要新
      // 的顶层引用和 trackedFileBackups 引用以供 R
      // eact 变更检测。深度克隆会复制每个现有备份的 Date/s
      // tring 字段 —— 添加一个条目的成本为 O(n)。
      const updatedMostRecentSnapshot = {
        ...mostRecentSnapshot,
        trackedFileBackups: {
          ...mostRecentSnapshot.trackedFileBackups,
          [trackingPath]: backup,
        },
      }

      const updatedState = {
        ...state,
        snapshots: (() => {
          const copy = state.snapshots.slice()
          copy[copy.length - 1] = updatedMostRecentSnapshot
          return copy
        })(),
        trackedFiles: updatedTrackedFiles,
      }
      maybeDumpStateForDebug(updatedState)

      // 记录快照更新，因为它已更改。
      void recordFileHistorySnapshot(
        messageId,
        updatedMostRecentSnapshot,
        true, // isSnapshotUpdate
      ).catch(error => {
        logError(new Error(`FileHistory：记录快照失败：${error}`))
      })

      logEvent('tengu_file_history_track_edit_success', {
        isNewFile: isAddingFile,
        version: backup.version,
      })
      logForDebugging(`FileHistory：跟踪到文件修改：${filePath}`)

      return updatedState
    } catch (error) {
      logError(error)
      logEvent('tengu_file_history_track_edit_failed', {})
      return state
    }
  })
}

/** 在文件历史记录中添加一个快照，并备份任何已修改的跟踪文件。 */
export async function fileHistoryMakeSnapshot(
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void,
  messageId: UUID,
): Promise<void> {
  if (!fileHistoryEnabled()) {
    return undefined
  }

  // 阶段 1：使用无操作更新器捕获当前状态，以便我们知道需要备份
  // 哪些文件。返回相同的引用对于任何遵循相同引用返回规则的包装器
  // （src/CLAUDE.md 包装器规则）来说，这使其成为
  // 一个真正的无操作。无条件展开的包装器将触发一次额外的重新渲
  // 染；对于每轮一次的调用来说是可以接受的。
  let captured: FileHistoryState | undefined
  updateFileHistoryState(state => {
    captured = state
    return state
  })
  if (!captured) return // updateFileHistoryState 是一个无操作的存根（例如 mcp.ts）

  // 阶段 2：在更新器外部异步执行所有 IO 操作。
  const trackedFileBackups: Record<string, FileHistoryBackup> = {}
  const mostRecentSnapshot = captured.snapshots.at(-1)
  if (mostRecentSnapshot) {
    logForDebugging(`FileHistory：正在为消息 ${messageId} 创建快照`)
    await Promise.all(
      Array.from(captured.trackedFiles, async trackingPath => {
        try {
          const filePath = maybeExpandFilePath(trackingPath)
          const latestBackup =
            mostRecentSnapshot.trackedFileBackups[trackingPath]
          const nextVersion = latestBackup ? latestBackup.version + 1 : 1

          // 对文件执行一次 stat 操作；ENOENT 表示跟踪的文件已被删除。
          let fileStats: Stats | undefined
          try {
            fileStats = await stat(filePath)
          } catch (e: unknown) {
            if (!isENOENT(e)) throw e
          }

          if (!fileStats) {
            trackedFileBackups[trackingPath] = {
              backupFileName: null, // 使用 null 表示缺失的跟踪文件
              version: nextVersion,
              backupTime: new Date(),
            }
            logEvent('tengu_file_history_backup_deleted_file', {
              version: nextVersion,
            })
            logForDebugging(
              `FileHistory：缺少跟踪的文件：${trackingPath}`,
            )
            return
          }

          // 文件存在 - 检查是否需要备份
          if (
            latestBackup &&
            latestBackup.backupFileName !== null &&
            !(await checkOriginFileChanged(
              filePath,
              latestBackup.backupFileName,
              fileStats,
            ))
          ) {
            // 文件自最新版本以来未被修改，复用该版本
            trackedFileBackups[trackingPath] = latestBackup
            return
          }

          // 文件比最新备份更新，创建新备份
          trackedFileBackups[trackingPath] = await createBackup(
            filePath,
            nextVersion,
          )
        } catch (error) {
          logError(error)
          logEvent('tengu_file_history_backup_file_failed', {})
        }
      }),
    )
  }

  // 阶段 3：将新快照提交到状态。重新读取 state.trackedFiles ——
  // 如果 fileHistoryTrackEdit 在阶段 2 的异步窗口期间添加了一个
  // 文件，它会将备份写入 state.snapshots[-1].trackedFile
  // Backups。继承这些备份，以便新快照覆盖每个当前跟踪的文件。
  updateFileHistoryState((state: FileHistoryState) => {
    try {
      const lastSnapshot = state.snapshots.at(-1)
      if (lastSnapshot) {
        for (const trackingPath of state.trackedFiles) {
          if (trackingPath in trackedFileBackups) continue
          const inherited = lastSnapshot.trackedFileBackups[trackingPath]
          if (inherited) trackedFileBackups[trackingPath] = inherited
        }
      }
      const now = new Date()
      const newSnapshot: FileHistorySnapshot = {
        messageId,
        trackedFileBackups,
        timestamp: now,
      }

      const allSnapshots = [...state.snapshots, newSnapshot]
      const updatedState: FileHistoryState = {
        ...state,
        snapshots:
          allSnapshots.length > MAX_SNAPSHOTS
            ? allSnapshots.slice(-MAX_SNAPSHOTS)
            : allSnapshots,
        snapshotSequence: (state.snapshotSequence ?? 0) + 1,
      }
      maybeDumpStateForDebug(updatedState)

      void notifyVscodeSnapshotFilesUpdated(state, updatedState).catch(logError)

      // 将文件历史快照记录到会话存储中以支持恢复
      void recordFileHistorySnapshot(
        messageId,
        newSnapshot,
        false, // isSnapshotUpdate
      ).catch(error => {
        logError(new Error(`文件历史：记录快照失败：${error}`))
      })

      logForDebugging(
        `文件历史：已为 ${messageId} 添加快照，正在跟踪 ${state.trackedFiles.size} 个文件`,
      )
      logEvent('tengu_file_history_snapshot_success', {
        trackedFilesCount: state.trackedFiles.size,
        snapshotCount: updatedState.snapshots.length,
      })

      return updatedState
    } catch (error) {
      logError(error)
      logEvent('tengu_file_history_snapshot_failed', {})
      return state
    }
  })
}

/** 将文件系统回滚到之前的快照。 */
export async function fileHistoryRewind(
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void,
  messageId: UUID,
): Promise<void> {
  if (!fileHistoryEnabled()) {
    return
  }

  // 回滚是纯粹的文件系统副作用，不会改变 FileHist
  // oryState。使用无操作更新器捕获状态，然后异步执行 IO。
  let captured: FileHistoryState | undefined
  updateFileHistoryState(state => {
    captured = state
    return state
  })
  if (!captured) return

  const targetSnapshot = captured.snapshots.findLast(
    snapshot => snapshot.messageId === messageId,
  )
  if (!targetSnapshot) {
    logError(new Error(`文件历史：未找到 ${messageId} 的快照`))
    logEvent('tengu_file_history_rewind_failed', {
      trackedFilesCount: captured.trackedFiles.size,
      snapshotFound: false,
    })
    throw new Error('未找到选定的快照')
  }

  try {
    logForDebugging(
      `文件历史：[回滚] 正在回滚到 ${messageId} 的快照`,
    )
    const filesChanged = await applySnapshot(captured, targetSnapshot)

    logForDebugging(`文件历史：[回滚] 已完成回滚到 ${messageId}`)
    logEvent('tengu_file_history_rewind_success', {
      trackedFilesCount: captured.trackedFiles.size,
      filesChangedCount: filesChanged.length,
    })
  } catch (error) {
    logError(error)
    logEvent('tengu_file_history_rewind_failed', {
      trackedFilesCount: captured.trackedFiles.size,
      snapshotFound: true,
    })
    throw error
  }
}

export function fileHistoryCanRestore(
  state: FileHistoryState,
  messageId: UUID,
): boolean {
  if (!fileHistoryEnabled()) {
    return false
  }

  return state.snapshots.some(snapshot => snapshot.messageId === messageId)
}

/** 通过计算如果还原到该快照将会更改的文件数量，来计算文件快照的差异统计信息。 */
export async function fileHistoryGetDiffStats(
  state: FileHistoryState,
  messageId: UUID,
): Promise<DiffStats> {
  if (!fileHistoryEnabled()) {
    return undefined
  }

  const targetSnapshot = state.snapshots.findLast(
    snapshot => snapshot.messageId === messageId,
  )

  if (!targetSnapshot) {
    return undefined
  }

  const results = await Promise.all(
    Array.from(state.trackedFiles, async trackingPath => {
      try {
        const filePath = maybeExpandFilePath(trackingPath)
        const targetBackup = targetSnapshot.trackedFileBackups[trackingPath]

        const backupFileName: BackupFileName | undefined = targetBackup
          ? targetBackup.backupFileName
          : getBackupFileNameFirstVersion(trackingPath, state)

        if (backupFileName === undefined) {
          // 解析备份时出错，因此不要触碰该文件
          logError(
            new Error('文件历史：查找要应用的备份文件时出错'),
          )
          logEvent('tengu_file_history_rewind_restore_file_failed', {
            dryRun: true,
          })
          return null
        }

        const stats = await computeDiffStatsForFile(
          filePath,
          backupFileName === null ? undefined : backupFileName,
        )
        if (stats?.insertions || stats?.deletions) {
          return { filePath, stats }
        }
        if (backupFileName === null && (await pathExists(filePath))) {
          // 快照后创建了零字节文件：即使 diffLines 报
          // 告 0/0，也计为已更改。
          return { filePath, stats }
        }
        return null
      } catch (error) {
        logError(error)
        logEvent('tengu_file_history_rewind_restore_file_failed', {
          dryRun: true,
        })
        return null
      }
    }),
  )

  const filesChanged: string[] = []
  let insertions = 0
  let deletions = 0
  for (const r of results) {
    if (!r) continue
    filesChanged.push(r.filePath)
    insertions += r.stats?.insertions || 0
    deletions += r.stats?.deletions || 0
  }
  return { filesChanged, insertions, deletions }
}

/** 轻量级仅布尔值检查：回滚到此消息是否会更改磁盘上的任何文件？使用与 applySnapshot 的非试运行路径（checkOriginFileChanged）相同的状态/内容比较，而不是 computeDiffStatsForFile，因此它从不调用 diffLines。在第一个更改的文件处提前退出。当调用者只需要是/否答案时使用；fileHistoryGetDiffStats 仍用于显示插入/删除的调用者。 */
export async function fileHistoryHasAnyChanges(
  state: FileHistoryState,
  messageId: UUID,
): Promise<boolean> {
  if (!fileHistoryEnabled()) {
    return false
  }

  const targetSnapshot = state.snapshots.findLast(
    snapshot => snapshot.messageId === messageId,
  )
  if (!targetSnapshot) {
    return false
  }

  for (const trackingPath of state.trackedFiles) {
    try {
      const filePath = maybeExpandFilePath(trackingPath)
      const targetBackup = targetSnapshot.trackedFileBackups[trackingPath]
      const backupFileName: BackupFileName | undefined = targetBackup
        ? targetBackup.backupFileName
        : getBackupFileNameFirstVersion(trackingPath, state)

      if (backupFileName === undefined) {
        continue
      }
      if (backupFileName === null) {
        // 备份显示文件不存在；通过 stat 探测（先操作后捕获）。
        if (await pathExists(filePath)) return true
        continue
      }
      if (await checkOriginFileChanged(filePath, backupFileName)) return true
    } catch (error) {
      logError(error)
    }
  }
  return false
}

/** 将给定的文件快照状态应用到被跟踪的文件（在磁盘上写入/删除），返回已更改的文件路径列表。仅异步 IO。 */
async function applySnapshot(
  state: FileHistoryState,
  targetSnapshot: FileHistorySnapshot,
): Promise<string[]> {
  const filesChanged: string[] = []
  for (const trackingPath of state.trackedFiles) {
    try {
      const filePath = maybeExpandFilePath(trackingPath)
      const targetBackup = targetSnapshot.trackedFileBackups[trackingPath]

      const backupFileName: BackupFileName | undefined = targetBackup
        ? targetBackup.backupFileName
        : getBackupFileNameFirstVersion(trackingPath, state)

      if (backupFileName === undefined) {
        // 解析备份时出错，因此不要触碰该文件
        logError(
          new Error('文件历史：查找要应用的备份文件时出错'),
        )
        logEvent('tengu_file_history_rewind_restore_file_failed', {
          dryRun: false,
        })
        continue
      }

      if (backupFileName === null) {
        // 文件在目标版本中不存在；如果存在则删除它。
        try {
          await unlink(filePath)
          logForDebugging(`文件历史：[回滚] 已删除 ${filePath}`)
          filesChanged.push(filePath)
        } catch (e: unknown) {
          if (!isENOENT(e)) throw e
          // 已不存在；无需操作。
        }
        continue
      }

      // 文件应存在于特定版本。仅在内容不同时恢复。
      if (await checkOriginFileChanged(filePath, backupFileName)) {
        await restoreBackup(filePath, backupFileName)
        logForDebugging(
          `文件历史：[回滚] 从 ${backupFileName} 恢复了 ${filePath}`,
        )
        filesChanged.push(filePath)
      }
    } catch (error) {
      logError(error)
      logEvent('tengu_file_history_rewind_restore_file_failed', {
        dryRun: false,
      })
    }
  }
  return filesChanged
}

/** 检查原始文件是否相对于备份文件已更改。可选地重用预获取的原始文件状态（当调用者已通过 stat 检查其存在性时，我们避免第二次系统调用）。

导出用于测试。 */
export async function checkOriginFileChanged(
  originalFile: string,
  backupFileName: string,
  originalStatsHint?: Stats,
): Promise<boolean> {
  const backupPath = resolveBackupPath(backupFileName)

  let originalStats: Stats | null = originalStatsHint ?? null
  if (!originalStats) {
    try {
      originalStats = await stat(originalFile)
    } catch (e: unknown) {
      if (!isENOENT(e)) return true
    }
  }
  let backupStats: Stats | null = null
  try {
    backupStats = await stat(backupPath)
  } catch (e: unknown) {
    if (!isENOENT(e)) return true
  }

  return compareStatsAndContent(originalStats, backupStats, async () => {
    try {
      const [originalContent, backupContent] = await Promise.all([
        readFile(originalFile, 'utf-8'),
        readFile(backupPath, 'utf-8'),
      ])
      return originalContent !== backupContent
    } catch {
      // 文件在 stat 和 read 之间被删除 -> 视为已更改。
      return true
    }
  })
}

/** 用于同步和异步更改检查的共享状态/内容比较逻辑。如果文件相对于备份已更改，则返回 true。 */
function compareStatsAndContent<T extends boolean | Promise<boolean>>(
  originalStats: Stats | null,
  backupStats: Stats | null,
  compareContent: () => T,
): T | boolean {
  // 一个存在，一个缺失 -> 已更改
  if ((originalStats === null) !== (backupStats === null)) {
    return true
  }
  // 两者都缺失 -> 无更改
  if (originalStats === null || backupStats === null) {
    return false
  }

  // 检查文件状态，如权限和文件大小
  if (
    originalStats.mode !== backupStats.mode ||
    originalStats.size !== backupStats.size
  ) {
    return true
  }

  // 这是一个依赖于正确设置修改时间的优化。如果
  // 原始文件的修改时间早于备份时间，那么我们可
  // 以跳过文件内容比较。
  if (originalStats.mtimeMs < backupStats.mtimeMs) {
    return false
  }

  // 使用开销更大的文件内容比较。回调函数自行处理其读取错误 ——
  // 对于异步回调，这里的 try/catch 无论如何都是无效的。
  return compareContent()
}

/** 计算差异中变更的行数。 */
async function computeDiffStatsForFile(
  originalFile: string,
  backupFileName?: string,
): Promise<DiffStats> {
  const filesChanged: string[] = []
  let insertions = 0
  let deletions = 0
  try {
    const backupPath = backupFileName
      ? resolveBackupPath(backupFileName)
      : undefined

    const [originalContent, backupContent] = await Promise.all([
      readFileAsyncOrNull(originalFile),
      backupPath ? readFileAsyncOrNull(backupPath) : null,
    ])

    if (originalContent === null && backupContent === null) {
      return {
        filesChanged,
        insertions,
        deletions,
      }
    }

    filesChanged.push(originalFile)

    // 计算差异
    const changes = diffLines(originalContent ?? '', backupContent ?? '')
    changes.forEach(c => {
      if (c.added) {
        insertions += c.count || 0
      }
      if (c.removed) {
        deletions += c.count || 0
      }
    })
  } catch (error) {
    logError(new Error(`FileHistory: 生成 diffStats 时出错: ${error}`))
  }

  return {
    filesChanged,
    insertions,
    deletions,
  }
}

function getBackupFileName(filePath: string, version: number): string {
  const fileNameHash = createHash('sha256')
    .update(filePath)
    .digest('hex')
    .slice(0, 16)
  return `${fileNameHash}@v${version}`
}

function resolveBackupPath(backupFileName: string, sessionId?: string): string {
  const configDir = getClaudeConfigHomeDir()
  return join(
    configDir,
    'file-history',
    sessionId || getSessionId(),
    backupFileName,
  )
}

/** 为 filePath 处的文件创建备份。如果文件不存在 (ENOENT)，则记录一个空备份（文件不存在标记）。所有 IO 操作都是异步的。惰性创建目录：先尝试 copyFile，遇到 ENOENT 时再创建目录。 */
async function createBackup(
  filePath: string | null,
  version: number,
): Promise<FileHistoryBackup> {
  if (filePath === null) {
    return { backupFileName: null, version, backupTime: new Date() }
  }

  const backupFileName = getBackupFileName(filePath, version)
  const backupPath = resolveBackupPath(backupFileName)

  // 先执行 Stat 操作：如果源文件缺失，则记录空备份并跳过复制。
  // 清晰地区分“源文件缺失”和“备份目录缺失”——如果对两者共享
  // 一个 catch 块，那么在 copyFile 成功和 sta
  // t 操作之间删除的文件会留下一个状态记录为空且孤立的备份。
  let srcStats: Stats
  try {
    srcStats = await stat(filePath)
  } catch (e: unknown) {
    if (isENOENT(e)) {
      return { backupFileName: null, version, backupTime: new Date() }
    }
    throw e
  }

  // copyFile 保留内容并避免将整个文件读入 JS 堆（之前的 re
  // adFileSync+writeFileSync 管道会这样做，导致大
  // 型跟踪文件内存溢出）。惰性创建目录：99% 的调用会走快速路径（目
  // 录已存在）；遇到 ENOENT 时，先创建目录然后重试。
  try {
    await copyFile(filePath, backupPath)
  } catch (e: unknown) {
    if (!isENOENT(e)) throw e
    await mkdir(dirname(backupPath), { recursive: true })
    await copyFile(filePath, backupPath)
  }

  // 保留备份文件的权限。
  await chmod(backupPath, srcStats.mode)

  logEvent('tengu_file_history_backup_file_created', {
    version: version,
    fileSize: srcStats.size,
  })

  return {
    backupFileName,
    version,
    backupTime: new Date(),
  }
}

/** 从备份路径恢复文件，并正确创建目录和设置权限。
惰性创建目录：先尝试 copyFile，遇到 ENOENT 时再创建目录。 */
async function restoreBackup(
  filePath: string,
  backupFileName: string,
): Promise<void> {
  const backupPath = resolveBackupPath(backupFileName)

  // 先执行 Stat 操作：如果备份缺失，则在尝试复制前
  // 记录日志并退出。区分“备份缺失”和“目标目录缺失”。
  let backupStats: Stats
  try {
    backupStats = await stat(backupPath)
  } catch (e: unknown) {
    if (isENOENT(e)) {
      logEvent('tengu_file_history_rewind_restore_file_failed', {})
      logError(
        new Error(`FileHistory: [回退] 未找到备份文件: ${backupPath}`),
      )
      return
    }
    throw e
  }

  // 惰性创建目录：99% 的调用会走快速路径（目标目录已存在）。
  try {
    await copyFile(backupPath, filePath)
  } catch (e: unknown) {
    if (!isENOENT(e)) throw e
    await mkdir(dirname(filePath), { recursive: true })
    await copyFile(backupPath, filePath)
  }

  // 恢复文件权限
  await chmod(filePath, backupStats.mode)
}

/** 获取文件的第一个（最早）备份版本，用于回退到文件尚未被跟踪的目标备份点。

@returns 第一个版本的备份文件名，如果文件在第一个版本中不存在则返回 null，或者如果完全找不到第一个版本则返回 undefined */
function getBackupFileNameFirstVersion(
  trackingPath: string,
  state: FileHistoryState,
): BackupFileName | undefined {
  for (const snapshot of state.snapshots) {
    const backup = snapshot.trackedFileBackups[trackingPath]
    if (backup !== undefined && backup.version === 1) {
      // 这可以是一个文件名或 null，null 表示文
      // 件在第一个版本中不存在。
      return backup.backupFileName
    }
  }

  // undefined 表示解析第一个版本时出错。
  return undefined
}

/** 使用相对路径作为键，以减少用于跟踪的会话存储空间。 */
function maybeShortenFilePath(filePath: string): string {
  if (!isAbsolute(filePath)) {
    return filePath
  }
  const cwd = getOriginalCwd()
  if (filePath.startsWith(cwd)) {
    return relative(cwd, filePath)
  }
  return filePath
}

function maybeExpandFilePath(filePath: string): string {
  if (isAbsolute(filePath)) {
    return filePath
  }
  return join(getOriginalCwd(), filePath)
}

/** 为给定的日志选项恢复文件历史快照状态。 */
export function fileHistoryRestoreStateFromLog(
  fileHistorySnapshots: FileHistorySnapshot[],
  onUpdateState: (newState: FileHistoryState) => void,
): void {
  if (!fileHistoryEnabled()) {
    return
  }
  // 在我们从绝对路径迁移到缩短的相对跟踪路
  // 径时，复制一份快照。
  const snapshots: FileHistorySnapshot[] = []
  // 从快照重建被跟踪的文件
  const trackedFiles = new Set<string>()
  for (const snapshot of fileHistorySnapshots) {
    const trackedFileBackups: Record<string, FileHistoryBackup> = {}
    for (const [path, backup] of Object.entries(snapshot.trackedFileBackups)) {
      const trackingPath = maybeShortenFilePath(path)
      trackedFiles.add(trackingPath)
      trackedFileBackups[trackingPath] = backup
    }
    snapshots.push({
      ...snapshot,
      trackedFileBackups: trackedFileBackups,
    })
  }
  onUpdateState({
    snapshots: snapshots,
    trackedFiles: trackedFiles,
    snapshotSequence: snapshots.length,
  })
}

/** 复制给定日志选项的文件历史快照。 */
export async function copyFileHistoryForResume(log: LogOption): Promise<void> {
  if (!fileHistoryEnabled()) {
    return
  }

  const fileHistorySnapshots = log.fileHistorySnapshots
  if (!fileHistorySnapshots || log.messages.length === 0) {
    return
  }
  const lastMessage = log.messages[log.messages.length - 1]
  const previousSessionId = lastMessage?.sessionId
  if (!previousSessionId) {
    logError(
      new Error(
        `FileHistory: 恢复时复制备份失败（无先前会话 ID）`,
      ),
    )
    return
  }

  const sessionId = getSessionId()
  if (previousSessionId === sessionId) {
    logForDebugging(
      `FileHistory: 无需为恢复相同会话 ID 复制文件历史记录: ${sessionId}`,
    )
    return
  }

  try {
    // 所有备份共享同一个目录: {configDir}/file-history/{ses
    // sionId}/ 预先一次性创建，而不是为每个备份文件创建一次
    const newBackupDir = join(
      getClaudeConfigHomeDir(),
      'file-history',
      sessionId,
    )
    await mkdir(newBackupDir, { recursive: true })

    // 将所有备份文件从上一个会话迁移到当前会话
    // 。并行处理所有快照；在每个快照内，链接也并行运行。
    let failedSnapshots = 0
    await Promise.allSettled(
      fileHistorySnapshots.map(async snapshot => {
        const backupEntries = Object.values(snapshot.trackedFileBackups).filter(
          (backup): backup is typeof backup & { backupFileName: string } =>
            backup.backupFileName !== null,
        )

        const results = await Promise.allSettled(
          backupEntries.map(async ({ backupFileName }) => {
            const oldBackupPath = resolveBackupPath(
              backupFileName,
              previousSessionId,
            )
            const newBackupPath = join(newBackupDir, backupFileName)

            try {
              await link(oldBackupPath, newBackupPath)
            } catch (e: unknown) {
              const code = getErrnoCode(e)
              if (code === 'EEXIST') {
                // 已迁移，跳过
                return
              }
              if (code === 'ENOENT') {
                logError(
                  new Error(
                    `FileHistory: 恢复时复制备份 ${backupFileName} 失败（备份文件在 ${previousSessionId} 中不存在）`,
                  ),
                )
                throw e
              }
              logError(
                new Error(
                  `FileHistory: 从上一个会话硬链接备份文件时出错`,
                ),
              )
              // 硬链接失败时回退到复制
              try {
                await copyFile(oldBackupPath, newBackupPath)
              } catch (copyErr) {
                logError(
                  new Error(
                    `FileHistory: 从上一个会话复制备份时出错`,
                  ),
                )
                throw copyErr
              }
            }

            logForDebugging(
              `FileHistory: 已将备份 ${backupFileName} 从会话 ${previousSessionId} 复制到 ${sessionId}`,
            )
          }),
        )

        const copyFailed = results.some(r => r.status === 'rejected')

        // 仅当成功迁移备份文件后才记录快照
        if (!copyFailed) {
          void recordFileHistorySnapshot(
            snapshot.messageId,
            snapshot,
            false, // isSnapshotUpdate
          ).catch(_ => {
            logError(
              new Error(`FileHistory: 记录复制备份快照失败`),
            )
          })
        } else {
          failedSnapshots++
        }
      }),
    )

    if (failedSnapshots > 0) {
      logEvent('tengu_file_history_resume_copy_failed', {
        numSnapshots: fileHistorySnapshots.length,
        failedSnapshots,
      })
    }
  } catch (error) {
    logError(error)
  }
}

/** 通知 VSCode 快照之间发生变化的文件。
比较前一个快照与新快照，并为内容发生变化的任何文件发送 file_updated 通知。
采用即发即弃方式（从 fileHistoryMakeSnapshot 中 void 派发）。 */
async function notifyVscodeSnapshotFilesUpdated(
  oldState: FileHistoryState,
  newState: FileHistoryState,
): Promise<void> {
  const oldSnapshot = oldState.snapshots.at(-1)
  const newSnapshot = newState.snapshots.at(-1)

  if (!newSnapshot) {
    return
  }

  for (const trackingPath of newState.trackedFiles) {
    const filePath = maybeExpandFilePath(trackingPath)
    const oldBackup = oldSnapshot?.trackedFileBackups[trackingPath]
    const newBackup = newSnapshot.trackedFileBackups[trackingPath]

    // 如果两个备份引用相同版本则跳过（无变化）
    if (
      oldBackup?.backupFileName === newBackup?.backupFileName &&
      oldBackup?.version === newBackup?.version
    ) {
      continue
    }

    // 从之前的备份中获取旧内容
    let oldContent: string | null = null
    if (oldBackup?.backupFileName) {
      const backupPath = resolveBackupPath(oldBackup.backupFileName)
      oldContent = await readFileAsyncOrNull(backupPath)
    }

    // 从新备份或当前文件中获取新内容
    let newContent: string | null = null
    if (newBackup?.backupFileName) {
      const backupPath = resolveBackupPath(newBackup.backupFileName)
      newContent = await readFileAsyncOrNull(backupPath)
    }
    // 如果 newBackup?.backupFileName === null，表示文件已被删除；newContent 保持为 null。

    // 仅在实际内容发生变化时通知
    if (oldContent !== newContent) {
      notifyVscodeFileUpdated(filePath, oldContent, newContent)
    }
  }
}

/** 异步读取，会吞掉所有错误并返回 null（尽力而为）。 */
async function readFileAsyncOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

const ENABLE_DUMP_STATE = false
function maybeDumpStateForDebug(state: FileHistoryState): void {
  if (ENABLE_DUMP_STATE) {
    // biome-ignore lint/suspicious/noConsole:: 有意输出到控制台
    console.error(inspect(state, false, 5))
  }
}
