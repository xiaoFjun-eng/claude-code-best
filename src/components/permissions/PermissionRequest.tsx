import { feature } from 'bun:bundle'
import * as React from 'react'
import { EnterPlanModeTool } from '@claude-code-best/builtin-tools/tools/EnterPlanModeTool/EnterPlanModeTool.js'
import { ExitPlanModeV2Tool } from '@claude-code-best/builtin-tools/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { useNotifyAfterTimeout } from '../../hooks/useNotifyAfterTimeout.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { AnyObject, Tool, ToolUseContext } from '../../Tool.js'
import { AskUserQuestionTool } from '@claude-code-best/builtin-tools/tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { BashTool } from '@claude-code-best/builtin-tools/tools/BashTool/BashTool.js'
import { FileEditTool } from '@claude-code-best/builtin-tools/tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from '@claude-code-best/builtin-tools/tools/FileReadTool/FileReadTool.js'
import { FileWriteTool } from '@claude-code-best/builtin-tools/tools/FileWriteTool/FileWriteTool.js'
import { GlobTool } from '@claude-code-best/builtin-tools/tools/GlobTool/GlobTool.js'
import { GrepTool } from '@claude-code-best/builtin-tools/tools/GrepTool/GrepTool.js'
import { NotebookEditTool } from '@claude-code-best/builtin-tools/tools/NotebookEditTool/NotebookEditTool.js'
import { PowerShellTool } from '@claude-code-best/builtin-tools/tools/PowerShellTool/PowerShellTool.js'
import { SkillTool } from '@claude-code-best/builtin-tools/tools/SkillTool/SkillTool.js'
import { WebFetchTool } from '@claude-code-best/builtin-tools/tools/WebFetchTool/WebFetchTool.js'
import type { AssistantMessage } from '../../types/message.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { AskUserQuestionPermissionRequest } from './AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.js'
import { BashPermissionRequest } from './BashPermissionRequest/BashPermissionRequest.js'
import { EnterPlanModePermissionRequest } from './EnterPlanModePermissionRequest/EnterPlanModePermissionRequest.js'
import { ExitPlanModePermissionRequest } from './ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.js'
import { FallbackPermissionRequest } from './FallbackPermissionRequest.js'
import { FileEditPermissionRequest } from './FileEditPermissionRequest/FileEditPermissionRequest.js'
import { FilesystemPermissionRequest } from './FilesystemPermissionRequest/FilesystemPermissionRequest.js'
import { FileWritePermissionRequest } from './FileWritePermissionRequest/FileWritePermissionRequest.js'
import { NotebookEditPermissionRequest } from './NotebookEditPermissionRequest/NotebookEditPermissionRequest.js'
import { PowerShellPermissionRequest } from './PowerShellPermissionRequest/PowerShellPermissionRequest.js'
import { SkillPermissionRequest } from './SkillPermissionRequest/SkillPermissionRequest.js'
import { WebFetchPermissionRequest } from './WebFetchPermissionRequest/WebFetchPermissionRequest.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const ReviewArtifactTool = feature('REVIEW_ARTIFACT')
  ? (
      require('@claude-code-best/builtin-tools/tools/ReviewArtifactTool/ReviewArtifactTool.js') as typeof import('@claude-code-best/builtin-tools/tools/ReviewArtifactTool/ReviewArtifactTool.js')
    ).ReviewArtifactTool
  : null

const ReviewArtifactPermissionRequest = feature('REVIEW_ARTIFACT')
  ? (
      require('./ReviewArtifactPermissionRequest/ReviewArtifactPermissionRequest.js') as typeof import('./ReviewArtifactPermissionRequest/ReviewArtifactPermissionRequest.js')
    ).ReviewArtifactPermissionRequest
  : null

const WorkflowTool = feature('WORKFLOW_SCRIPTS')
  ? (
      require('@claude-code-best/builtin-tools/tools/WorkflowTool/WorkflowTool.js') as typeof import('@claude-code-best/builtin-tools/tools/WorkflowTool/WorkflowTool.js')
    ).WorkflowTool
  : null

const WorkflowPermissionRequest = feature('WORKFLOW_SCRIPTS')
  ? (
      require('@claude-code-best/builtin-tools/tools/WorkflowTool/WorkflowPermissionRequest.js') as typeof import('@claude-code-best/builtin-tools/tools/WorkflowTool/WorkflowPermissionRequest.js')
    ).WorkflowPermissionRequest
  : null

const MonitorTool = feature('MONITOR_TOOL')
  ? (
      require('@claude-code-best/builtin-tools/tools/MonitorTool/MonitorTool.js') as typeof import('@claude-code-best/builtin-tools/tools/MonitorTool/MonitorTool.js')
    ).MonitorTool
  : null

const MonitorPermissionRequest = feature('MONITOR_TOOL')
  ? (
      require('./MonitorPermissionRequest/MonitorPermissionRequest.js') as typeof import('./MonitorPermissionRequest/MonitorPermissionRequest.js')
    ).MonitorPermissionRequest
  : null

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
/* eslint-enable @typescript-eslint/no-require-imports */
import type { z } from 'zod/v4'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import type { WorkerBadgeProps } from './WorkerBadge.js'

function permissionComponentForTool(
  tool: Tool,
): React.ComponentType<PermissionRequestProps> {
  switch (tool) {
    case FileEditTool:
      return FileEditPermissionRequest
    case FileWriteTool:
      return FileWritePermissionRequest
    case BashTool:
      return BashPermissionRequest
    case PowerShellTool:
      return PowerShellPermissionRequest
    case ReviewArtifactTool:
      return ReviewArtifactPermissionRequest ?? FallbackPermissionRequest
    case WebFetchTool:
      return WebFetchPermissionRequest
    case NotebookEditTool:
      return NotebookEditPermissionRequest
    case ExitPlanModeV2Tool:
      return ExitPlanModePermissionRequest
    case EnterPlanModeTool:
      return EnterPlanModePermissionRequest
    case SkillTool:
      return SkillPermissionRequest
    case AskUserQuestionTool:
      return AskUserQuestionPermissionRequest
    case WorkflowTool:
      return WorkflowPermissionRequest ?? FallbackPermissionRequest
    case MonitorTool:
      return MonitorPermissionRequest ?? FallbackPermissionRequest
    case GlobTool:
    case GrepTool:
    case FileReadTool:
      return FilesystemPermissionRequest
    default:
      return FallbackPermissionRequest
  }
}

export type PermissionRequestProps<Input extends AnyObject = AnyObject> = {
  toolUseConfirm: ToolUseConfirm<Input>
  toolUseContext: ToolUseContext
  onDone(): void
  onReject(): void
  verbose: boolean
  workerBadge: WorkerBadgeProps | undefined
  /** 注册 JSX 以在可滚动区域下方的固定页脚中渲染。
仅限全屏模式（非全屏模式没有固定区域——终端
滚动回退会将所有内容一起移动）。传入 null 可清除。

由 ExitPlanModePermissionRequest 使用，以便在用户滚动浏览长计划时
保持响应选项可见。回调是稳定的——
传入的 JSX 应使用 ref 来引用那些闭包捕获组件状态的回调，
以避免闭包过时（React 会协调 JSX，保留 Select 的
内部焦点/输入状态）。 */
  setStickyFooter?: (jsx: React.ReactNode | null) => void
}

export type ToolUseConfirm<Input extends AnyObject = AnyObject> = {
  assistantMessage: AssistantMessage
  tool: Tool<Input>
  description: string
  input: z.infer<Input>
  toolUseContext: ToolUseContext
  toolUseID: string
  permissionResult: PermissionDecision
  permissionPromptStartTimeMs: number
  /** 当用户与权限对话框交互时调用（例如，方向键、Tab 键、输入）。
这可以防止异步自动批准机制（如 bash 分类器）在用户
正在积极操作对话框时将其关闭。 */
  classifierCheckInProgress?: boolean
  classifierAutoApproved?: boolean
  classifierMatchedRule?: string
  workerBadge?: WorkerBadgeProps
  onUserInteraction(): void
  onAbort(): void
  onDismissCheckmark?(): void
  onAllow(
    updatedInput: z.infer<Input>,
    permissionUpdates: PermissionUpdate[],
    feedback?: string,
    contentBlocks?: ContentBlockParam[],
  ): void
  onReject(feedback?: string, contentBlocks?: ContentBlockParam[]): void
  recheckPermission(): Promise<void>
}

function getNotificationMessage(toolUseConfirm: ToolUseConfirm): string {
  const toolName = toolUseConfirm.tool.userFacingName(
    toolUseConfirm.input as never,
  )

  if (toolUseConfirm.tool === ExitPlanModeV2Tool) {
    return 'Claude Code 需要您批准该计划'
  }

  if (toolUseConfirm.tool === EnterPlanModeTool) {
    return 'Claude Code 想要进入计划模式'
  }

  if (
    feature('REVIEW_ARTIFACT') &&
    toolUseConfirm.tool === ReviewArtifactTool
  ) {
    return 'Claude 需要您批准一个审查制品'
  }

  if (!toolName || toolName.trim() === '') {
    return 'Claude Code 需要您的注意'
  }

  return `Claude 需要您的许可才能使用 ${toolName}`
}

// TODO：将此移至 Tool.renderPermissionRequest
export function PermissionRequest({
  toolUseConfirm,
  toolUseContext,
  onDone,
  onReject,
  verbose,
  workerBadge,
  setStickyFooter,
}: PermissionRequestProps): React.ReactNode {
  // 处理 Ctrl+C（app:interrupt）以拒绝
  useKeybinding(
    'app:interrupt',
    () => {
      onDone()
      onReject()
      toolUseConfirm.onReject()
    },
    { context: 'Confirmation' },
  )

  const notificationMessage = getNotificationMessage(toolUseConfirm)
  useNotifyAfterTimeout(notificationMessage, 'permission_prompt')

  const PermissionComponent = permissionComponentForTool(toolUseConfirm.tool)

  return (
    <PermissionComponent
      toolUseContext={toolUseContext}
      toolUseConfirm={toolUseConfirm}
      onDone={onDone}
      onReject={onReject}
      verbose={verbose}
      workerBadge={workerBadge}
      setStickyFooter={setStickyFooter}
    />
  )
}
