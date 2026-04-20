import chalk from 'chalk'
import type { UUID } from 'crypto'
import figures from 'figures'
import * as React from 'react'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import type { CommandResultDisplay, ResumeEntrypoint } from '../../commands.js'
import { LogSelector } from '../../components/LogSelector.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Spinner } from '../../components/Spinner.js'
import { useIsInsideModal } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { setClipboard } from '@anthropic/ink'
import { Box, Text } from '@anthropic/ink'
import type { LocalJSXCommandCall } from '../../types/command.js'
import type { LogOption } from '../../types/logs.js'
import { agenticSessionSearch } from '../../utils/agenticSessionSearch.js'
import { checkCrossProjectResume } from '../../utils/crossProjectResume.js'
import { getWorktreePaths } from '../../utils/getWorktreePaths.js'
import { logError } from '../../utils/log.js'
import {
  getLastSessionLog,
  getSessionIdFromLog,
  isCustomTitleEnabled,
  isLiteLog,
  loadAllProjectsMessageLogs,
  loadFullLog,
  loadSameRepoMessageLogs,
  searchSessionsByCustomTitle,
} from '../../utils/sessionStorage.js'
import { validateUuid } from '../../utils/uuid.js'

type ResumeResult =
  | { resultType: 'sessionNotFound'; arg: string }
  | { resultType: 'multipleMatches'; arg: string; count: number }

function resumeHelpMessage(result: ResumeResult): string {
  switch (result.resultType) {
    case 'sessionNotFound':
      return `未找到会话 ${chalk.bold(result.arg)}。`
    case 'multipleMatches':
      return `找到 ${result.count} 个与 ${chalk.bold(result.arg)} 匹配的会话。请使用 /resume 命令选择一个特定会话。`
  }
}

function ResumeError({
  message,
  args,
  onDone,
}: {
  message: string
  args: string
  onDone: () => void
}): React.ReactNode {
  React.useEffect(() => {
    const timer = setTimeout(onDone, 0)
    return () => clearTimeout(timer)
  }, [onDone])

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {figures.pointer} /resume {args}
      </Text>
      <MessageResponse>
        <Text>{message}</Text>
      </MessageResponse>
    </Box>
  )
}

function ResumeCommand({
  onDone,
  onResume,
}: {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  onResume: (
    sessionId: UUID,
    log: LogOption,
    entrypoint: ResumeEntrypoint,
  ) => Promise<void>
}): React.ReactNode {
  const [logs, setLogs] = React.useState<LogOption[]>([])
  const [worktreePaths, setWorktreePaths] = React.useState<string[]>([])
  const [loading, setLoading] = React.useState(true)
  const [resuming, setResuming] = React.useState(false)
  const [showAllProjects, setShowAllProjects] = React.useState(false)
  const { rows } = useTerminalSize()
  const insideModal = useIsInsideModal()

  const loadLogs = React.useCallback(
    async (allProjects: boolean, paths: string[]) => {
      setLoading(true)
      try {
        const allLogs = allProjects
          ? await loadAllProjectsMessageLogs()
          : await loadSameRepoMessageLogs(paths)
        const resumable = filterResumableSessions(allLogs, getSessionId())
        if (resumable.length === 0) {
          onDone('未找到可恢复的对话')
          return
        }
        setLogs(resumable)
      } catch (_err) {
        onDone('加载对话失败')
      } finally {
        setLoading(false)
      }
    },
    [onDone],
  )

  React.useEffect(() => {
    async function init() {
      const paths = await getWorktreePaths(getOriginalCwd())
      setWorktreePaths(paths)
      void loadLogs(false, paths)
    }
    void init()
  }, [loadLogs])

  const handleToggleAllProjects = React.useCallback(() => {
    const newValue = !showAllProjects
    setShowAllProjects(newValue)
    void loadLogs(newValue, worktreePaths)
  }, [showAllProjects, loadLogs, worktreePaths])

  async function handleSelect(log: LogOption) {
    const sessionId = validateUuid(getSessionIdFromLog(log))
    if (!sessionId) {
      onDone('恢复对话失败')
      return
    }

    // 为精简日志加载完整消息
    const fullLog = isLiteLog(log) ? await loadFullLog(log) : log

    // 检查此对话是否来自其他目录
    const crossProjectCheck = checkCrossProjectResume(
      fullLog,
      showAllProjects,
      worktreePaths,
    )
    if (crossProjectCheck.isCrossProject) {
      if (crossProjectCheck.isSameRepoWorktree) {
        // 相同仓库工作树 - 可直接恢复
        setResuming(true)
        void onResume(sessionId, fullLog, 'slash_command_picker')
        return
      }

      // 不同项目 - 显示命令而非恢复
      const raw = await setClipboard((crossProjectCheck as { command: string }).command)
      if (raw) process.stdout.write(raw)

      // 格式化输出消息
      const message = [
        '',
        '此对话来自其他目录。',
        '',
        '要恢复，请运行：',
        `  ${(crossProjectCheck as { command: string }).command}`,
        '',
        '（命令已复制到剪贴板）',
        '',
      ].join('\n')

      onDone(message, { display: 'user' })
      return
    }

    // 相同目录 - 继续恢复
    setResuming(true)
    void onResume(sessionId, fullLog, 'slash_command_picker')
  }

  function handleCancel() {
    onDone('恢复已取消', { display: 'system' })
  }

  if (loading) {
    return (
      <Box>
        <Spinner />
        <Text> 正在加载对话…</Text>
      </Box>
    )
  }

  if (resuming) {
    return (
      <Box>
        <Spinner />
        <Text> 正在恢复对话…</Text>
      </Box>
    )
  }

  return (
    <LogSelector
      logs={logs}
      maxHeight={insideModal ? Math.floor(rows / 2) : rows - 2}
      onCancel={handleCancel}
      onSelect={handleSelect}
      onLogsChanged={() => loadLogs(showAllProjects, worktreePaths)}
      showAllProjects={showAllProjects}
      onToggleAllProjects={handleToggleAllProjects}
      onAgenticSearch={agenticSessionSearch}
    />
  )
}

export function filterResumableSessions(
  logs: LogOption[],
  currentSessionId: string,
): LogOption[] {
  return logs.filter(
    l => !l.isSidechain && getSessionIdFromLog(l) !== currentSessionId,
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const onResume = async (
    sessionId: UUID,
    log: LogOption,
    entrypoint: ResumeEntrypoint,
  ) => {
    try {
      await context.resume?.(sessionId, log, entrypoint)
      onDone(undefined, { display: 'skip' })
    } catch (error) {
      logError(error as Error)
      onDone(`恢复失败：${(error as Error).message}`)
    }
  }

  const arg = args?.trim()

  // 未提供参数 - 显示选择器
  if (!arg) {
    return (
      <ResumeCommand key={Date.now()} onDone={onDone} onResume={onResume} />
    )
  }

  // 加载日志以搜索（包含同仓库工作树）
  const worktreePaths = await getWorktreePaths(getOriginalCwd())
  const logs = await loadSameRepoMessageLogs(worktreePaths)
  if (logs.length === 0) {
    const message = '未找到可恢复的对话。'
    return (
      <ResumeError
        message={message}
        args={arg}
        onDone={() => onDone(message)}
      />
    )
  }

  // 首先，检查参数是否为有效的 UUID
  const maybeSessionId = validateUuid(arg)
  if (maybeSessionId) {
    const matchingLogs = logs
      .filter(l => getSessionIdFromLog(l) === maybeSessionId)
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())

    if (matchingLogs.length > 0) {
      const log = matchingLogs[0]!
      const fullLog = isLiteLog(log) ? await loadFullLog(log) : log
      void onResume(maybeSessionId, fullLog, 'slash_command_session_id')
      return null
    }

    // 增强日志未找到它 — 尝试直接文件查找。这用于处理被 enr
    // ichLogs 过滤掉的会话（例如，首条消息 >16KB 导致
    // firstPrompt 提取失败，从而使该会话被丢弃）。
    const directLog = await getLastSessionLog(maybeSessionId)
    if (directLog) {
      void onResume(maybeSessionId, directLog, 'slash_command_session_id')
      return null
    }
  }

  // 接下来，尝试精确的自定义标题匹配（仅当功能启用时）
  if (isCustomTitleEnabled()) {
    const titleMatches = await searchSessionsByCustomTitle(arg, {
      exact: true,
    })
    if (titleMatches.length === 1) {
      const log = titleMatches[0]!
      const sessionId = getSessionIdFromLog(log)
      if (sessionId) {
        const fullLog = isLiteLog(log) ? await loadFullLog(log) : log
        void onResume(sessionId, fullLog, 'slash_command_title')
        return null
      }
    }

    // 多个匹配项 - 显示错误
    if (titleMatches.length > 1) {
      const message = resumeHelpMessage({
        resultType: 'multipleMatches',
        arg,
        count: titleMatches.length,
      })
      return (
        <ResumeError
          message={message}
          args={arg}
          onDone={() => onDone(message)}
        />
      )
    }
  }

  // 未找到匹配项 - 显示错误
  const message = resumeHelpMessage({ resultType: 'sessionNotFound', arg })
  return (
    <ResumeError message={message} args={arg} onDone={() => onDone(message)} />
  )
}
