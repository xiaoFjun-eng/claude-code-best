import React, { useCallback, useState } from 'react'
import TextInput from '../../components/TextInput.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '@anthropic/ink'
import { useKeybindings } from '../../keybindings/useKeybinding.js'

interface ChooseRepoStepProps {
  currentRepo: string | null
  useCurrentRepo: boolean
  repoUrl: string
  onRepoUrlChange: (value: string) => void
  onToggleUseCurrentRepo: (useCurrentRepo: boolean) => void
  onSubmit: () => void
}

export function ChooseRepoStep({
  currentRepo,
  useCurrentRepo,
  repoUrl,
  onRepoUrlChange,
  onSubmit,
  onToggleUseCurrentRepo,
}: ChooseRepoStepProps) {
  const [cursorOffset, setCursorOffset] = useState(0)
  const [showEmptyError, setShowEmptyError] = useState(false)
  const terminalSize = useTerminalSize()
  const textInputColumns = terminalSize.columns

  const handleSubmit = useCallback(() => {
    const repoName = useCurrentRepo ? currentRepo : repoUrl
    if (!repoName?.trim()) {
      setShowEmptyError(true)
      return
    }
    onSubmit()
  }, [useCurrentRepo, currentRepo, repoUrl, onSubmit])

  // 当文本输入框可见时，省略 confirm:yes，这样裸的 'y
  // ' 会传递给输入框而非提交。TextInput 的 onSubmit
  // 会处理回车键。保持确认上下文（而非设置上下文）以避免 j/k 键绑定。
  const isTextInputVisible = !useCurrentRepo || !currentRepo
  const handlePrevious = useCallback(() => {
    onToggleUseCurrentRepo(true)
    setShowEmptyError(false)
  }, [onToggleUseCurrentRepo])
  const handleNext = useCallback(() => {
    onToggleUseCurrentRepo(false)
    setShowEmptyError(false)
  }, [onToggleUseCurrentRepo])

  useKeybindings(
    {
      'confirm:previous': handlePrevious,
      'confirm:next': handleNext,
      'confirm:yes': handleSubmit,
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
          <Text dimColor>选择 GitHub 仓库</Text>
        </Box>
        {currentRepo && (
          <Box marginBottom={1}>
            <Text
              bold={useCurrentRepo}
              color={useCurrentRepo ? 'permission' : undefined}
            >
              {useCurrentRepo ? '> ' : '  '}
              使用当前仓库：{currentRepo}
            </Text>
          </Box>
        )}
        <Box marginBottom={1}>
          <Text
            bold={!useCurrentRepo || !currentRepo}
            color={!useCurrentRepo || !currentRepo ? 'permission' : undefined}
          >
            {!useCurrentRepo || !currentRepo ? '> ' : '  '}
            {currentRepo ? '输入其他仓库' : '输入仓库'}
          </Text>
        </Box>
        {(!useCurrentRepo || !currentRepo) && (
          <Box marginLeft={2} marginBottom={1}>
            <TextInput
              value={repoUrl}
              onChange={value => {
                onRepoUrlChange(value)
                setShowEmptyError(false)
              }}
              onSubmit={handleSubmit}
              focus={true}
              placeholder="输入仓库，格式为 owner/repo 或 https://github.com/owner/repo…"
              columns={textInputColumns}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
              showCursor={true}
            />
          </Box>
        )}
      </Box>
      {showEmptyError && (
        <Box marginLeft={3} marginBottom={1}>
          <Text color="error">请输入仓库名称以继续</Text>
        </Box>
      )}
      <Box marginLeft={3}>
        <Text dimColor>
          {currentRepo ? '↑/↓ 选择 · ' : ''}回车继续</Text>
      </Box>
    </>
  )
}
