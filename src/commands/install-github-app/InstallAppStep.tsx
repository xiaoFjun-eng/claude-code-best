import figures from 'figures'
import React from 'react'
import { GITHUB_ACTION_SETUP_DOCS_URL } from '../../constants/github-app.js'
import { Box, Text } from '@anthropic/ink'
import { useKeybinding } from '../../keybindings/useKeybinding.js'

interface InstallAppStepProps {
  repoUrl: string
  onSubmit: () => void
}

export function InstallAppStep({ repoUrl, onSubmit }: InstallAppStepProps) {
  // 按 Enter 键提交
  useKeybinding('confirm:yes', onSubmit, { context: 'Confirmation' })

  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>安装 Claude GitHub 应用</Text>
      </Box>
      <Box marginBottom={1}>
        <Text>正在打开浏览器以安装 Claude GitHub 应用…</Text>
      </Box>
      <Box marginBottom={1}>
        <Text>如果浏览器没有自动打开，请访问：</Text>
      </Box>
      <Box marginBottom={1}>
        <Text underline>https://github.com/apps/claude</Text>
      </Box>
      <Box marginBottom={1}>
        <Text>
          请为以下仓库安装应用：<Text bold>{repoUrl}</Text>
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>
          重要提示：请确保授予对此特定仓库的访问权限</Text>
      </Box>
      <Box>
        <Text bold color="permission">
          安装应用后，请按 Enter 键{figures.ellipsis}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          遇到问题？请查看手动设置说明：{' '}
          <Text color="claude">{GITHUB_ACTION_SETUP_DOCS_URL}</Text>
        </Text>
      </Box>
    </Box>
  )
}
