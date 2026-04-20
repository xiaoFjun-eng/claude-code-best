import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { saveGlobalConfig } from 'src/utils/config.js'
import {
  CODE_REVIEW_PLUGIN_WORKFLOW_CONTENT,
  PR_BODY,
  PR_TITLE,
  WORKFLOW_CONTENT,
} from '../../constants/github-app.js'
import { openBrowser } from '../../utils/browser.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { logError } from '../../utils/log.js'
import type { Workflow } from './types.js'

async function createWorkflowFile(
  repoName: string,
  branchName: string,
  workflowPath: string,
  workflowContent: string,
  secretName: string,
  message: string,
  context?: {
    useCurrentRepo?: boolean
    workflowExists?: boolean
    secretExists?: boolean
  },
): Promise<void> {
  // 检查工作流文件是否已存在
  const checkFileResult = await execFileNoThrow('gh', [
    'api',
    `repos/${repoName}/contents/${workflowPath}`,
    '--jq',
    '.sha',
  ])

  let fileSha: string | null = null
  if (checkFileResult.code === 0) {
    fileSha = checkFileResult.stdout.trim()
  }

  let content = workflowContent
  if (secretName === 'CLAUDE_CODE_OAUTH_TOKEN') {
    // 对于 OAuth 令牌，请使用 claude_code_oauth_token 参数
    content = workflowContent.replace(
      /anthropic_api_key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/g,
      `claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`,
    )
  } else if (secretName !== 'ANTHROPIC_API_KEY') {
    // 对于其他自定义密钥名称，请继续使用 anthropic_api_key 参数
    content = workflowContent.replace(
      /anthropic_api_key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/g,
      `anthropic_api_key: \${{ secrets.${secretName} }}`,
    )
  }
  const base64Content = Buffer.from(content).toString('base64')

  const apiParams = [
    'api',
    '--method',
    'PUT',
    `repos/${repoName}/contents/${workflowPath}`,
    '-f',
    `message=${fileSha ? `"更新 ${message}"` : `"${message}"`}`,
    '-f',
    `content=${base64Content}`,
    '-f',
    `branch=${branchName}`,
  ]

  if (fileSha) {
    apiParams.push('-f', `sha=${fileSha}`)
  }

  const createFileResult = await execFileNoThrow('gh', apiParams)
  if (createFileResult.code !== 0) {
    if (
      createFileResult.stderr.includes('422') &&
      createFileResult.stderr.includes('sha')
    ) {
      logEvent('tengu_setup_github_actions_failed', {
        reason:
          'failed_to_create_workflow_file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        exit_code: createFileResult.code,
        ...context,
      })
      throw new Error(
        `创建工作流文件 ${workflowPath} 失败：此仓库中已存在 Claude 工作流文件。请先移除它或手动更新。`,
      )
    }

    logEvent('tengu_setup_github_actions_failed', {
      reason:
        'failed_to_create_workflow_file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      exit_code: createFileResult.code,
      ...context,
    })

    const helpText =
      '\n\n需要帮助？常见问题：\n' +
      '· 权限被拒绝 → 运行：gh auth refresh -h github.com -s repo,workflow\n' +
      '· 未授权 → 确保您拥有该仓库的管理员访问权限\n' +
      '· 手动设置 → 访问：https://github.com/anthropics/claude-code-action'

    throw new Error(
      `创建工作流文件 ${workflowPath} 失败：${createFileResult.stderr}${helpText}`,
    )
  }
}

export async function setupGitHubActions(
  repoName: string,
  apiKeyOrOAuthToken: string | null,
  secretName: string,
  updateProgress: () => void,
  skipWorkflow = false,
  selectedWorkflows: Workflow[],
  authType: 'api_key' | 'oauth_token',
  context?: {
    useCurrentRepo?: boolean
    workflowExists?: boolean
    secretExists?: boolean
  },
) {
  try {
    logEvent('tengu_setup_github_actions_started', {
      skip_workflow: skipWorkflow,
      has_api_key: !!apiKeyOrOAuthToken,
      using_default_secret_name: secretName === 'ANTHROPIC_API_KEY',
      selected_claude_workflow: selectedWorkflows.includes('claude'),
      selected_claude_review_workflow:
        selectedWorkflows.includes('claude-review'),
      ...context,
    })

    // 检查仓库是否存在
    const repoCheckResult = await execFileNoThrow('gh', [
      'api',
      `repos/${repoName}`,
      '--jq',
      '.id',
    ])
    if (repoCheckResult.code !== 0) {
      logEvent('tengu_setup_github_actions_failed', {
        reason:
          'repo_not_found' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        exit_code: repoCheckResult.code,
        ...context,
      })
      throw new Error(
        `访问仓库 ${repoName} 失败：${repoCheckResult.stderr}`,
      )
    }

    // 获取默认分支
    const defaultBranchResult = await execFileNoThrow('gh', [
      'api',
      `repos/${repoName}`,
      '--jq',
      '.default_branch',
    ])
    if (defaultBranchResult.code !== 0) {
      logEvent('tengu_setup_github_actions_failed', {
        reason:
          'failed_to_get_default_branch' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        exit_code: defaultBranchResult.code,
        ...context,
      })
      throw new Error(
        `获取默认分支失败：${defaultBranchResult.stderr}`,
      )
    }
    const defaultBranch = defaultBranchResult.stdout.trim()

    // 获取默认分支的 SHA
    const shaResult = await execFileNoThrow('gh', [
      'api',
      `repos/${repoName}/git/ref/heads/${defaultBranch}`,
      '--jq',
      '.object.sha',
    ])
    if (shaResult.code !== 0) {
      logEvent('tengu_setup_github_actions_failed', {
        reason:
          'failed_to_get_branch_sha' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        exit_code: shaResult.code,
        ...context,
      })
      throw new Error(`获取分支 SHA 失败：${shaResult.stderr}`)
    }
    const sha = shaResult.stdout.trim()

    let branchName: string | null = null

    if (!skipWorkflow) {
      updateProgress()
      // 创建新分支
      branchName = `add-claude-github-actions-${Date.now()}`
      const createBranchResult = await execFileNoThrow('gh', [
        'api',
        '--method',
        'POST',
        `repos/${repoName}/git/refs`,
        '-f',
        `ref=refs/heads/${branchName}`,
        '-f',
        `sha=${sha}`,
      ])
      if (createBranchResult.code !== 0) {
        logEvent('tengu_setup_github_actions_failed', {
          reason:
            'failed_to_create_branch' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_code: createBranchResult.code,
          ...context,
        })
        throw new Error(`创建分支失败：${createBranchResult.stderr}`)
      }

      updateProgress()
      // 创建选定的工作流文件
      const workflows = []

      if (selectedWorkflows.includes('claude')) {
        workflows.push({
          path: '.github/workflows/claude.yml',
          content: WORKFLOW_CONTENT,
          message: 'Claude PR 助手工作流',
        })
      }

      if (selectedWorkflows.includes('claude-review')) {
        workflows.push({
          path: '.github/workflows/claude-code-review.yml',
          content: CODE_REVIEW_PLUGIN_WORKFLOW_CONTENT,
          message: 'Claude 代码审查工作流',
        })
      }

      for (const workflow of workflows) {
        await createWorkflowFile(
          repoName,
          branchName,
          workflow.path,
          workflow.content,
          secretName,
          workflow.message,
          context,
        )
      }
    }

    updateProgress()
    // 如果提供了 API 密钥，则将其设置为密钥
    if (apiKeyOrOAuthToken) {
      const setSecretResult = await execFileNoThrow('gh', [
        'secret',
        'set',
        secretName,
        '--body',
        apiKeyOrOAuthToken,
        '--repo',
        repoName,
      ])
      if (setSecretResult.code !== 0) {
        logEvent('tengu_setup_github_actions_failed', {
          reason:
            'failed_to_set_api_key_secret' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_code: setSecretResult.code,
          ...context,
        })

        const helpText =
          '\n\n需要帮助？常见问题：\n' +
          '· 权限被拒绝 → 运行：gh auth refresh -h github.com -s repo\n' +
          '· 未授权 → 请确保您拥有该仓库的管理员访问权限\n' +
          '· 如需手动设置 → 请访问：https://github.com/anthropics/claude-code-action'

        throw new Error(
          `设置 API 密钥密钥失败：${setSecretResult.stderr || 'Unknown error'}${helpText}`,
        )
      }
    }

    if (!skipWorkflow && branchName) {
      updateProgress()
      // 创建 PR 模板 URL，而不是直接创建 PR
      const compareUrl = `https://github.com/${repoName}/compare/${defaultBranch}...${branchName}?quick_pull=1&title=${encodeURIComponent(PR_TITLE)}&body=${encodeURIComponent(PR_BODY)}`

      await openBrowser(compareUrl)
    }

    logEvent('tengu_setup_github_actions_completed', {
      skip_workflow: skipWorkflow,
      has_api_key: !!apiKeyOrOAuthToken,
      auth_type:
        authType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      using_default_secret_name: secretName === 'ANTHROPIC_API_KEY',
      selected_claude_workflow: selectedWorkflows.includes('claude'),
      selected_claude_review_workflow:
        selectedWorkflows.includes('claude-review'),
      ...context,
    })
    saveGlobalConfig(current => ({
      ...current,
      githubActionSetupCount: (current.githubActionSetupCount ?? 0) + 1,
    }))
  } catch (error) {
    if (
      !error ||
      !(error instanceof Error) ||
      !error.message.includes('未能')
    ) {
      logEvent('tengu_setup_github_actions_failed', {
        reason:
          'unexpected_error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...context,
      })
    }
    if (error instanceof Error) {
      logError(error)
    }
    throw error
  }
}
