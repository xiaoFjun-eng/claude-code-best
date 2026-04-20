import { homedir } from 'node:os'
import { join } from 'node:path'
import React, { useEffect, useState } from 'react'
import type { CommandResultDisplay } from 'src/commands.js'
import { logEvent } from 'src/services/analytics/index.js'
import { StatusIcon } from '@anthropic/ink'
import { Box, wrappedRender as render, Text } from '@anthropic/ink'
import { logForDebugging } from '../utils/debug.js'
import { env } from '../utils/env.js'
import { errorMessage } from '../utils/errors.js'
import {
  checkInstall,
  cleanupNpmInstallations,
  cleanupShellAliases,
  installLatest,
} from '../utils/nativeInstaller/index.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

interface InstallProps {
  onDone: (result: string, options?: { display?: CommandResultDisplay }) => void
  force?: boolean
  target?: string // 'latest'、'stable' 或版本号如 '1.0.34'
}

type InstallState =
  | { type: 'checking' }
  | { type: 'cleaning-npm' }
  | { type: 'installing'; version: string }
  | { type: 'setting-up' }
  | { type: 'set-up'; messages: string[] }
  | { type: 'success'; version: string; setupMessages?: string[] }
  | { type: 'error'; message: string; warnings?: string[] }

function getInstallationPath(): string {
  const isWindows = env.platform === 'win32'
  const homeDir = homedir()

  if (isWindows) {
    // 转换为 Windows 风格路径
    const windowsPath = join(homeDir, '.local', 'bin', 'claude.exe')
    // 为 Windows 显示替换正斜杠为反斜杠
    return windowsPath.replace(/\//g, '\\')
  }

  return '~/.local/bin/claude'
}

function SetupNotes({ messages }: { messages: string[] }): React.ReactNode {
  if (messages.length === 0) return null

  return (
    <Box flexDirection="column" gap={0} marginBottom={1}>
      <Box>
        <Text color="warning">
          <StatusIcon status="warning" withSpace />
          安装说明：</Text>
      </Box>
      {messages.map((message, index) => (
        <Box key={index} marginLeft={2}>
          <Text dimColor>• {message}</Text>
        </Box>
      ))}
    </Box>
  )
}

function Install({ onDone, force, target }: InstallProps): React.ReactNode {
  const [state, setState] = useState<InstallState>({ type: 'checking' })

  useEffect(() => {
    async function run() {
      try {
        logForDebugging(
          `安装：开始安装进程 (force=${force}, target=${target})`,
        )

        // 首先安装原生构建版本
        const channelOrVersion =
          target || getInitialSettings()?.autoUpdatesChannel || 'latest'
        setState({ type: 'installing', version: channelOrVersion })

        // 传递 force 标志以触发重新安装，即使已是最新版本
        logForDebugging(
          `安装：调用 installLatest(channelOrVersion=${channelOrVersion}, forceReinstall=${force})`,
        )
        const result = await installLatest(channelOrVersion, force)
        logForDebugging(
          `安装：installLatest 返回 version=${result.latestVersion}, wasUpdated=${result.wasUpdated}, lockFailed=${result.lockFailed}`,
        )

        // 特别检查锁定失败情况
        if (result.lockFailed) {
          throw new Error(
            '无法安装 - 另一个进程正在安装 Claude。请稍后再试。',
          )
        }

        // 如果无法获取版本信息，可能存在某些问题
        if (!result.latestVersion) {
          logForDebugging(
            '安装：在安装过程中未能检索到版本信息',
            { level: 'error' },
          )
        }

        if (!result.wasUpdated) {
          logForDebugging('安装：已是最新版本')
        }

        // 设置启动器和 Shell 集成
        setState({ type: 'setting-up' })
        const setupMessages = await checkInstall(true)

        logForDebugging(
          `安装：启动器设置完成，附带 ${setupMessages.length} 条消息`,
        )
        if (setupMessages.length > 0) {
          setupMessages.forEach(msg =>
            logForDebugging(`安装：设置消息：${msg.message}`),
          )
        }

        // 既然原生安装已成功，清理旧的 npm 安装
        logForDebugging(
          '安装：成功安装后清理 npm 安装',
        )
        const { removed, errors, warnings } = await cleanupNpmInstallations()

        if (removed > 0) {
          logForDebugging(`清理了 ${removed} 个 npm 安装`)
        }

        if (errors.length > 0) {
          logForDebugging(`清理错误：${errors.join(', ')}`)
          // 尽管有清理错误，仍继续 - 原生安装已成功
        }

        // 清理旧的 Shell 别名
        const aliasMessages = await cleanupShellAliases()
        if (aliasMessages.length > 0) {
          logForDebugging(
            `Shell 别名清理：${aliasMessages.map(m => m.message).join('; ')}`,
          )
        }

        // 记录成功事件
        logEvent('tengu_claude_install_command', {
          has_version: result.latestVersion ? 1 : 0,
          forced: force ? 1 : 0,
        })

        // 如果用户明确指定了渠道，将其保存到设置中
        if (target === 'latest' || target === 'stable') {
          updateSettingsForSource('userSettings', {
            autoUpdatesChannel: target,
          })
          logForDebugging(
            `安装：已将 autoUpdatesChannel=${target} 保存到用户设置`,
          )
        }

        // 合并所有警告/信息消息（将 SetupMessage 转换为字符串）
        const allWarnings = [...warnings, ...aliasMessages.map(m => m.message)]

        // 检查是否有任何设置错误或说明
        if (setupMessages.length > 0) {
          setState({
            type: 'set-up',
            messages: setupMessages.map(m => m.message),
          })
          // 仍标记为成功，但同时显示设置消息和清理警告
          setTimeout(setState, 2000, {
            type: 'success' as const,
            version: result.latestVersion || 'current',
            setupMessages: [
              ...setupMessages.map(m => m.message),
              ...allWarnings,
            ],
          })
        } else {
          // 无需设置消息，直接显示成功（但如果存在清理警告，仍会显示）
          logForDebugging('安装：Shell PATH 已配置')
          setState({
            type: 'success',
            version: result.latestVersion || 'current',
            setupMessages: allWarnings.length > 0 ? allWarnings : undefined,
          })
        }
      } catch (error) {
        logForDebugging(`安装命令失败：${error}`, {
          level: 'error',
        })
        setState({
          type: 'error',
          message: errorMessage(error),
        })
      }
    }

    void run()
  }, [force, target])

  useEffect(() => {
    if (state.type === 'success') {
      // 在退出前留出显示成功消息的时间
      setTimeout(
        onDone,
        2000,
        'Claude Code 安装成功完成',
        {
          display: 'system' as const,
        },
      )
    } else if (state.type === 'error') {
      // 在退出前留出显示错误消息的时间
      setTimeout(onDone, 3000, 'Claude Code 安装失败', {
        display: 'system' as const,
      })
    }
  }, [state, onDone])

  return (
    <Box flexDirection="column" marginTop={1}>
      {state.type === 'checking' && (
        <Text color="claude">正在检查安装状态...</Text>
      )}

      {state.type === 'cleaning-npm' && (
        <Text color="warning">正在清理旧的 npm 安装...</Text>
      )}

      {state.type === 'installing' && (
        <Text color="claude">
          正在安装 Claude Code 原生构建{state.version}...
        </Text>
      )}

      {state.type === 'setting-up' && (
        <Text color="claude">正在设置启动器和 shell 集成...</Text>
      )}

      {state.type === 'set-up' && <SetupNotes messages={state.messages} />}

      {state.type === 'success' && (
        <Box flexDirection="column" gap={1}>
          <Box>
            <StatusIcon status="success" withSpace />
            <Text color="success" bold>
              Claude Code 安装成功！</Text>
          </Box>
          <Box marginLeft={2} flexDirection="column" gap={1}>
            {state.version !== 'current' && (
              <Box>
                <Text dimColor>Version: </Text>
                <Text color="claude">{state.version}</Text>
              </Box>
            )}
            <Box>
              <Text dimColor>Location: </Text>
              <Text color="text">{getInstallationPath()}</Text>
            </Box>
          </Box>
          <Box marginLeft={2} flexDirection="column" gap={1}>
            <Box marginTop={1}>
              <Text dimColor>下一步：运行</Text>
              <Text color="claude" bold>
                claude --help</Text>
              <Text dimColor> 开始使用</Text>
            </Box>
          </Box>
          {state.setupMessages && <SetupNotes messages={state.setupMessages} />}
        </Box>
      )}

      {state.type === 'error' && (
        <Box flexDirection="column" gap={1}>
          <Box>
            <StatusIcon status="error" withSpace />
            <Text color="error">安装失败</Text>
          </Box>
          <Text color="error">{state.message}</Text>
          <Box marginTop={1}>
            <Text dimColor>尝试使用 --force 参数运行以跳过检查</Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}

// 这仅用于 cli.tsx，不作为斜杠命令使用
export const install = {
  type: 'local-jsx' as const,
  name: 'install',
  description: '安装 Claude Code 原生构建',
  argumentHint: '[options]',
  async call(
    onDone: (
      result: string,
      options?: { display?: CommandResultDisplay },
    ) => void,
    _context: unknown,
    args: string[],
  ) {
    // 解析参数
    const force = args.includes('--force')
    const nonFlagArgs = args.filter(arg => !arg.startsWith('--'))
    const target = nonFlagArgs[0] // 'latest'、'stable' 或版本号如 '1.0.34'

    const { unmount } = await render(
      <Install
        onDone={(result, options) => {
          unmount()
          onDone(result, options)
        }}
        force={force}
        target={target}
      />,
    )
  },
}
