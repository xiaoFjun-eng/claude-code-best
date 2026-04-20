import React, { useCallback, useState } from 'react'
import TextInput from '../../components/TextInput.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, color, Text, useTheme } from '@anthropic/ink'
import { useKeybindings } from '../../keybindings/useKeybinding.js'

interface CheckExistingSecretStepProps {
  useExistingSecret: boolean
  secretName: string
  onToggleUseExistingSecret: (useExisting: boolean) => void
  onSecretNameChange: (value: string) => void
  onSubmit: () => void
}

export function CheckExistingSecretStep({
  useExistingSecret,
  secretName,
  onToggleUseExistingSecret,
  onSecretNameChange,
  onSubmit,
}: CheckExistingSecretStepProps) {
  const [cursorOffset, setCursorOffset] = useState(0)
  const terminalSize = useTerminalSize()
  const [theme] = useTheme()

  // 当文本输入框可见时，省略 confirm:yes，这样裸的 'y'
  // 会传递给输入框而非提交。TextInput 的 onSubmit 会处理
  // Enter 键。保持确认上下文（而非设置），以避免 j/k 键绑定冲突。
  const handlePrevious = useCallback(
    () => onToggleUseExistingSecret(true),
    [onToggleUseExistingSecret],
  )
  const handleNext = useCallback(
    () => onToggleUseExistingSecret(false),
    [onToggleUseExistingSecret],
  )
  useKeybindings(
    {
      'confirm:previous': handlePrevious,
      'confirm:next': handleNext,
      'confirm:yes': onSubmit,
    },
    { context: 'Confirmation', isActive: useExistingSecret },
  )
  useKeybindings(
    {
      'confirm:previous': handlePrevious,
      'confirm:next': handleNext,
    },
    { context: 'Confirmation', isActive: !useExistingSecret },
  )

  return (
    <>
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>安装 GitHub App</Text>
          <Text dimColor>设置 API key secret</Text>
        </Box>
        <Box marginBottom={1}>
          <Text color="warning">
            ANTHROPIC_API_KEY 已存在于仓库 secrets 中！</Text>
        </Box>
        <Box marginBottom={1}>
          <Text>您希望：</Text>
        </Box>
        <Box marginBottom={1}>
          <Text>
            {useExistingSecret ? color('success', theme)('> ') : '  '}
            使用现有的 API key</Text>
        </Box>
        <Box marginBottom={1}>
          <Text>
            {!useExistingSecret ? color('success', theme)('> ') : '  '}
            使用不同名称创建新的 secret</Text>
        </Box>
        {!useExistingSecret && (
          <>
            <Box marginBottom={1}>
              <Text>
                输入新的 secret 名称（仅限字母数字和下划线）：</Text>
            </Box>
            <TextInput
              value={secretName}
              onChange={onSecretNameChange}
              onSubmit={onSubmit}
              focus={true}
              placeholder="例如：CLAUDE_API_KEY"
              columns={terminalSize.columns}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
              showCursor={true}
            />
          </>
        )}
      </Box>
      <Box marginLeft={3}>
        <Text dimColor>↑/↓ 选择 · Enter 继续</Text>
      </Box>
    </>
  )
}
