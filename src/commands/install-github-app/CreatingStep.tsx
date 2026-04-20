import React from 'react'
import { Box, Text } from '@anthropic/ink'
import type { Workflow } from './types.js'

interface CreatingStepProps {
  currentWorkflowInstallStep: number
  secretExists: boolean
  useExistingSecret: boolean
  secretName: string
  skipWorkflow?: boolean
  selectedWorkflows: Workflow[]
}

export function CreatingStep({
  currentWorkflowInstallStep,
  secretExists,
  useExistingSecret,
  secretName,
  skipWorkflow = false,
  selectedWorkflows,
}: CreatingStepProps) {
  const progressSteps = skipWorkflow
    ? [
        '获取仓库信息',
        secretExists && useExistingSecret
          ? '使用现有的 API 密钥密钥'
          : `设置 ${secretName} 密钥`,
      ]
    : [
        '获取仓库信息',
        '创建分支',
        selectedWorkflows.length > 1
          ? '创建工作流文件'
          : '创建工作流文件',
        secretExists && useExistingSecret
          ? '使用现有的 API 密钥密钥'
          : `设置 ${secretName} 密钥`,
        '打开拉取请求页面',
      ]

  return (
    <>
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>安装 GitHub 应用</Text>
          <Text dimColor>创建 GitHub Actions 工作流</Text>
        </Box>
        {progressSteps.map((stepText, index) => {
          let status: 'completed' | 'in-progress' | 'pending' = 'pending'

          if (index < currentWorkflowInstallStep) {
            status = 'completed'
          } else if (index === currentWorkflowInstallStep) {
            status = 'in-progress'
          }

          return (
            <Box key={index}>
              <Text
                color={
                  status === 'completed'
                    ? 'success'
                    : status === 'in-progress'
                      ? 'warning'
                      : undefined
                }
              >
                {status === 'completed' ? '✓ ' : ''}
                {stepText}
                {status === 'in-progress' ? '…' : ''}
              </Text>
            </Box>
          )
        })}
      </Box>
    </>
  )
}
