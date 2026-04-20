import figures from 'figures'
import * as React from 'react'
import { Box, Text } from '@anthropic/ink'
import { getPluginTrustMessage } from '../../utils/plugins/marketplaceHelpers.js'

export function PluginTrustWarning(): React.ReactNode {
  const customMessage = getPluginTrustMessage()
  return (
    <Box marginBottom={1}>
      <Text color="claude">{figures.warning} </Text>
      <Text dimColor italic>
        在安装、更新或使用插件前，请确保你信任该插件。
        Anthropic 不控制插件中包含哪些 MCP 服务器、文件或其他软件，
        也无法验证它们是否能按预期工作或不会发生变更。
        更多信息请查看每个插件的主页。{customMessage ? ` ${customMessage}` : ''}
      </Text>
    </Box>
  )
}
