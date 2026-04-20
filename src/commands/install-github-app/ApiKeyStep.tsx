import React, { useCallback, useState } from 'react'
import TextInput from '../../components/TextInput.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, color, Text, useTheme } from '@anthropic/ink'
import { useKeybindings } from '../../keybindings/useKeybinding.js'

interface ApiKeyStepProps {
  existingApiKey: string | null
  useExistingKey: boolean
  apiKeyOrOAuthToken: string
  onApiKeyChange: (value: string) => void
  onToggleUseExistingKey: (useExisting: boolean) => void
  onSubmit: () => void
  onCreateOAuthToken?: () => void
  selectedOption?: 'existing' | 'new' | 'oauth'
  onSelectOption?: (option: 'existing' | 'new' | 'oauth') => void
}

export function ApiKeyStep({
  existingApiKey,
  apiKeyOrOAuthToken,
  onApiKeyChange,
  onSubmit,
  onToggleUseExistingKey,
  onCreateOAuthToken,
  selectedOption = existingApiKey
    ? 'existing'
    : onCreateOAuthToken
      ? 'oauth'
      : 'new',
  onSelectOption,
}: ApiKeyStepProps) {
  const [cursorOffset, setCursorOffset] = useState(0)
  const terminalSize = useTerminalSize()
  const [theme] = useTheme()

  const handlePrevious = useCallback(() => {
    if (selectedOption === 'new' && onCreateOAuthToken) {
      // 从 'new' 向上移动到 'oauth'
      onSelectOption?.('oauth')
    } else if (selectedOption === 'oauth' && existingApiKey) {
      // 从 'oauth' 向上移动到 'existing'（仅当它存在时）
      onSelectOption?.('existing')
      onToggleUseExistingKey(true)
    }
  }, [
    selectedOption,
    onCreateOAuthToken,
    existingApiKey,
    onSelectOption,
    onToggleUseExistingKey,
  ])

  const handleNext = useCallback(() => {
    if (selectedOption === 'existing') {
      // 从 'existing' 向下移动到 'oauth'（如果可用）或 'new'
      onSelectOption?.(onCreateOAuthToken ? 'oauth' : 'new')
      onToggleUseExistingKey(false)
    } else if (selectedOption === 'oauth') {
      // 从 'oauth' 向下移动到 'new'
      onSelectOption?.('new')
    }
  }, [
    selectedOption,
    onCreateOAuthToken,
    onSelectOption,
    onToggleUseExistingKey,
  ])

  const handleConfirm = useCallback(() => {
    if (selectedOption === 'oauth' && onCreateOAuthToken) {
      onCreateOAuthToken()
    } else {
      onSubmit()
    }
  }, [selectedOption, onCreateOAuthToken, onSubmit])

  // 当文本输入框可见时，省略 confirm:yes，这样单独的 'y' 会传递给输
  // 入框而不是提交。TextInput 的 onSubmit 处理 Enter 键。保持
  // Confirmation 上下文（而非 Settings）以避免 j/k 键绑定冲突。
  const isTextInputVisible = selectedOption === 'new'
  useKeybindings(
    {
      'confirm:previous': handlePrevious,
      'confirm:next': handleNext,
      'confirm:yes': handleConfirm,
    },
    { context: 'Confirmation', isActive: !isTextInputVisible },
  )
  useKeybindings(
    {
      'confirm:previous': handlePrevious,
      'confirm:next': handleNext,
    },
    { context: 'Confirmation', isActive: isTextInputVisible },
  )

  return (
    <>
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>安装 GitHub App</Text>
          <Text dimColor>选择 API 密钥</Text>
        </Box>
        {existingApiKey && (
          <Box marginBottom={1}>
            <Text>
              {selectedOption === 'existing'
                ? color('success', theme)('> ')
                : '  '}
              使用您现有的 Claude Code API 密钥</Text>
          </Box>
        )}
        {onCreateOAuthToken && (
          <Box marginBottom={1}>
            <Text>
              {selectedOption === 'oauth'
                ? color('success', theme)('> ')
                : '  '}
              使用您的 Claude 订阅创建一个长期有效的令牌</Text>
          </Box>
        )}
        <Box marginBottom={1}>
          <Text>
            {selectedOption === 'new' ? color('success', theme)('> ') : '  '}
            输入一个新的 API 密钥</Text>
        </Box>
        {selectedOption === 'new' && (
          <TextInput
            value={apiKeyOrOAuthToken}
            onChange={onApiKeyChange}
            onSubmit={onSubmit}
            onPaste={onApiKeyChange}
            focus={true}
            placeholder="sk-ant…（在 https://platform.claude.com/settings/keys 创建新密钥）"
            mask="*"
            columns={terminalSize.columns}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            showCursor={true}
          />
        )}
      </Box>
      <Box marginLeft={3}>
        <Text dimColor>↑/↓ 选择 · Enter 继续</Text>
      </Box>
    </>
  )
}
