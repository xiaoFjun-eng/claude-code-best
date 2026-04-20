import React from 'react'
import { Box, Text } from '@anthropic/ink'

type SuccessStepProps = {
  secretExists: boolean
  useExistingSecret: boolean
  secretName: string
  skipWorkflow?: boolean
}

export function SuccessStep({
  secretExists,
  useExistingSecret,
  secretName,
  skipWorkflow = false,
}: SuccessStepProps): React.ReactNode {
  return (
    <>
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>安装 GitHub 应用</Text>
          <Text dimColor>Success</Text>
        </Box>
        {!skipWorkflow && (
          <Text color="success">✓ GitHub Actions 工作流已创建！</Text>
        )}
        {secretExists && useExistingSecret && (
          <Box marginTop={1}>
            <Text color="success">
              ✓ 使用现有的 ANTHROPIC_API_KEY 密钥</Text>
          </Box>
        )}
        {(!secretExists || !useExistingSecret) && (
          <Box marginTop={1}>
            <Text color="success">✓ API 密钥已保存为{secretName} secret</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text>后续步骤：</Text>
        </Box>
        {skipWorkflow ? (
          <>
            <Text>
              1. 如果尚未安装，请安装 Claude GitHub 应用</Text>
            <Text>2. 您的工作流文件保持不变</Text>
            <Text>3. API 密钥已配置完成，可供使用</Text>
          </>
        ) : (
          <>
            <Text>1. 已创建一个预填写的 PR 页面</Text>
            <Text>
              2. 如果尚未安装，请安装 Claude GitHub 应用</Text>
            <Text>3. 合并该 PR 以启用 Claude PR 助手</Text>
          </>
        )}
      </Box>
      <Box marginLeft={3}>
        <Text dimColor>按任意键退出</Text>
      </Box>
    </>
  )
}
