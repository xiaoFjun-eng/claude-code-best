import chalk from 'chalk'
import figures from 'figures'
import React, { useEffect } from 'react'
import {
  getAdditionalDirectoriesForClaudeMd,
  setAdditionalDirectoriesForClaudeMd,
} from '../../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { AddWorkspaceDirectory } from '../../components/permissions/rules/AddWorkspaceDirectory.js'
import { Box, Text } from '@anthropic/ink'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  applyPermissionUpdate,
  persistPermissionUpdate,
} from '../../utils/permissions/PermissionUpdate.js'
import type { PermissionUpdateDestination } from '../../utils/permissions/PermissionUpdateSchema.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import {
  addDirHelpMessage,
  validateDirectoryForWorkspace,
} from './validation.js'

function AddDirError({
  message,
  args,
  onDone,
}: {
  message: string
  args: string
  onDone: () => void
}): React.ReactNode {
  useEffect(() => {
    // 我们需要延迟调用 onDone，以避免出现“返回 null”的 bug，即
    // 组件在 React 能够渲染错误信息之前就被卸载的情况。
    // 使用 setTimeout 可以确保在命令退出前显示错误信息。
    const timer = setTimeout(onDone, 0)
    return () => clearTimeout(timer)
  }, [onDone])

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {figures.pointer} /add-dir {args}
      </Text>
      <MessageResponse>
        <Text>{message}</Text>
      </MessageResponse>
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const directoryPath = (args ?? '').trim()
  const appState = context.getAppState()

  // 用于处理添加目录的辅助函数（在带路径和不带路径的情况下共享）
  const handleAddDirectory = async (path: string, remember = false) => {
    const destination: PermissionUpdateDestination = remember
      ? 'localSettings'
      : 'session'

    const permissionUpdate = {
      type: 'addDirectories' as const,
      directories: [path],
      destination,
    }

    // 应用到会话上下文
    const latestAppState = context.getAppState()
    const updatedContext = applyPermissionUpdate(
      latestAppState.toolPermissionContext,
      permissionUpdate,
    )
    context.setAppState(prev => ({
      ...prev,
      toolPermissionContext: updatedContext,
    }))

    // 更新沙箱配置，以便 Bash 命令可以访问新目录。
    // 引导状态是会话专用目录的唯一来源；持久化目录
    // 通过设置订阅获取，但我们在此主动刷新
    // 以避免用户在立即操作时出现竞态条件。
    const currentDirs = getAdditionalDirectoriesForClaudeMd()
    if (!currentDirs.includes(path)) {
      setAdditionalDirectoriesForClaudeMd([...currentDirs, path])
    }
    SandboxManager.refreshConfig()

    let message: string

    if (remember) {
      try {
        persistPermissionUpdate(permissionUpdate)
        message = `已将 ${chalk.bold(path)} 添加为工作目录并保存到本地设置`
      } catch (error) {
        message = `已将 ${chalk.bold(path)} 添加为工作目录。保存到本地设置失败：${error instanceof Error ? error.message : 'Unknown error'}`    } else {
      message = `已将 ${chalk.bold(path)} 添加为本次会话的工作目录`
    }

    const messageWithHint = `${message} ${chalk.dim('· /permissions to manage')}`
    onDone(messageWithHint)
  }

  // 当未提供路径时，直接显示 AddWorkspaceDirectory 输入表单
  // 并在确认后返回到 REPL
  if (!directoryPath) {
    return (
      <AddWorkspaceDirectory
        permissionContext={appState.toolPermissionContext}
        onAddDirectory={handleAddDirectory}
        onCancel={() => {
          onDone('未添加工作目录。')
        }}
      />
    )
  }

  const result = await validateDirectoryForWorkspace(
    directoryPath,
    appState.toolPermissionContext,
  )

  if (result.resultType !== 'success') {
    const message = addDirHelpMessage(result)

    return (
      <AddDirError
        message={message}
        args={args ?? ''}
        onDone={() => onDone(message)}
      />
    )
  }

  return (
    <AddWorkspaceDirectory
      directoryPath={result.absolutePath}
      permissionContext={appState.toolPermissionContext}
      onAddDirectory={handleAddDirectory}
      onCancel={() => {
        onDone(
          `未将 ${chalk.bold(result.absolutePath)} 添加为工作目录。`,
        )
      }}
    />
  )
}
