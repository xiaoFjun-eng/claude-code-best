import axios from 'axios'
import chalk from 'chalk'
import { randomUUID } from 'crypto'
import React from 'react'
import { getOriginalCwd, getSessionId } from 'src/bootstrap/state.js'
import { checkGate_CACHED_OR_BLOCKING } from 'src/services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { isPolicyAllowed } from 'src/services/policyLimits/index.js'
import { z } from 'zod/v4'
import {
  getTeleportErrors,
  TeleportError,
  type TeleportLocalErrorType,
} from '../components/TeleportError.js'
import { getOauthConfig } from '../constants/oauth.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { Root } from '@anthropic/ink'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { queryHaiku } from '../services/api/claude.js'
import {
  getSessionLogsViaOAuth,
  getTeleportEvents,
} from '../services/api/sessionIngress.js'
import { getOrganizationUUID } from '../services/oauth/client.js'
import { AppStateProvider } from '../state/AppState.js'
import type { Message, SystemMessage } from '../types/message.js'
import type { PermissionMode } from '../types/permissions.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
} from './auth.js'
import { checkGithubAppInstalled } from './background/remote/preconditions.js'
import {
  deserializeMessages,
  type TeleportRemoteResponse,
} from './conversationRecovery.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import {
  detectCurrentRepositoryWithHost,
  parseGitHubRepository,
  parseGitRemote,
} from './detectRepository.js'
import { isEnvTruthy } from './envUtils.js'
import { TeleportOperationError, toError } from './errors.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { truncateToWidth } from './format.js'
import { findGitRoot, getDefaultBranch, getIsClean, gitExe } from './git.js'
import { safeParseJSON } from './json.js'
import { logError } from './log.js'
import { createSystemMessage, createUserMessage } from './messages.js'
import { getMainLoopModel } from './model/model.js'
import { isTranscriptMessage } from './sessionStorage.js'
import { getSettings_DEPRECATED } from './settings/settings.js'
import { jsonStringify } from './slowOperations.js'
import { asSystemPrompt } from './systemPromptType.js'
import {
  fetchSession,
  type GitRepositoryOutcome,
  type GitSource,
  getBranchFromSession,
  getOAuthHeaders,
  type SessionResource,
} from './teleport/api.js'
import { fetchEnvironments } from './teleport/environments.js'
import { createAndUploadGitBundle } from './teleport/gitBundle.js'

export type TeleportResult = {
  messages: Message[]
  branchName: string
}

export type TeleportProgressStep =
  | 'validating'
  | 'fetching_logs'
  | 'fetching_branch'
  | 'checking_out'
  | 'done'

export type TeleportProgressCallback = (step: TeleportProgressStep) => void

/** 创建系统消息，通知远程会话恢复
@returns 返回表示会话从另一台机器恢复的系统消息 */
function createTeleportResumeSystemMessage(
  branchError: Error | null,
): SystemMessage {
  if (branchError === null) {
    return createSystemMessage('会话已恢复', 'suggestion')
  }
  const formattedError =
    branchError instanceof TeleportOperationError
      ? branchError.formattedMessage
      : branchError.message
  return createSystemMessage(
    `会话恢复，未指定分支：${formattedError}`,
    'warning',
  )
}

/** 创建用户消息，通知模型远程会话恢复
@returns 返回表示会话从另一台机器恢复的用户消息 */
function createTeleportResumeUserMessage() {
  return createUserMessage({
    content: `此会话正从另一台机器继续。应用程序状态可能已更改。更新后的工作目录是 ${getOriginalCwd()}`,
    isMeta: true,
  })
}

type TeleportToRemoteResponse = {
  id: string
  title: string
}

const SESSION_TITLE_AND_BRANCH_PROMPT = `请根据提供的描述，为编码会话构思一个简洁的标题和 git 分支名称。标题应清晰、简洁，准确反映编码任务的内容。
标题应简短明了，最好不超过 6 个词。除非绝对必要，避免使用行话或过于技术性的术语。标题应易于任何阅读者理解。
标题使用句子大小写（仅首单词和专有名词大写），而非标题大小写。

分支名称应清晰、简洁，准确反映编码任务的内容。
分支应简短，最好不超过 4 个词。分支名称始终以 "claude/" 开头，全部小写，单词间用短横线分隔。

返回一个包含 "title" 和 "branch" 字段的 JSON 对象。

示例 1：{"title": "修复移动端登录按钮不工作", "branch": "claude/fix-mobile-login-button"}
示例 2：{"title": "更新 README 添加安装说明", "branch": "claude/update-readme"}
示例 3：{"title": "改进数据处理脚本性能", "branch": "claude/improve-data-processing"}

以下是会话描述：
<description>{description}</description>
请为此会话生成标题和分支名称。`

type TitleAndBranch = {
  title: string
  branchName: string
}

/** 使用 Claude Haiku 为编码会话生成标题和分支名称
@param description 会话的描述/提示
@returns Promise<TitleAndBranch> 生成的标题和分支名称 */
async function generateTitleAndBranch(
  description: string,
  signal: AbortSignal,
): Promise<TitleAndBranch> {
  const fallbackTitle = truncateToWidth(description, 75)
  const fallbackBranch = 'claude/task'

  try {
    const userPrompt = SESSION_TITLE_AND_BRANCH_PROMPT.replace(
      '{description}',
      description,
    )

    const response = await queryHaiku({
      systemPrompt: asSystemPrompt([]),
      userPrompt,
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            branch: { type: 'string' },
          },
          required: ['title', 'branch'],
          additionalProperties: false,
        },
      },
      signal,
      options: {
        querySource: 'teleport_generate_title',
        agents: [],
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    })

    // 从响应中提取文本
    const firstBlock = response.message!.content?.[0] as { type?: string; text?: string } | undefined
    if (firstBlock?.type !== 'text') {
      return { title: fallbackTitle, branchName: fallbackBranch }
    }

    const parsed = safeParseJSON(firstBlock.text!.trim())
    const parseResult = z
      .object({ title: z.string(), branch: z.string() })
      .safeParse(parsed)
    if (parseResult.success) {
      return {
        title: parseResult.data.title || fallbackTitle,
        branchName: parseResult.data.branch || fallbackBranch,
      }
    }

    return { title: fallbackTitle, branchName: fallbackBranch }
  } catch (error) {
    logError(new Error(`生成标题和分支时出错：${error}`))
    return { title: fallbackTitle, branchName: fallbackBranch }
  }
}

/** 验证 git 工作目录是否干净（忽略未跟踪文件）
忽略未跟踪文件是因为它们在分支切换时不会丢失 */
export async function validateGitState(): Promise<void> {
  const isClean = await getIsClean({ ignoreUntracked: true })
  if (!isClean) {
    logEvent('tengu_teleport_error_git_not_clean', {})
    const error = new TeleportOperationError(
      'Git 工作目录不干净。使用 --teleport 前请提交或暂存您的更改。',
      chalk.red(
        '错误：Git 工作目录不干净。使用 --teleport 前请提交或暂存您的更改。\n',
      ),
    )
    throw error
  }
}

/** 从远程 origin 获取特定分支
@param branch 要获取的分支。如果未指定，则获取所有分支。 */
async function fetchFromOrigin(branch?: string): Promise<void> {
  const fetchArgs = branch
    ? ['fetch', 'origin', `${branch}:${branch}`]
    : ['fetch', 'origin']

  const { code: fetchCode, stderr: fetchStderr } = await execFileNoThrow(
    gitExe(),
    fetchArgs,
  )
  if (fetchCode !== 0) {
    // 如果获取特定分支失败，可能该分支在本地尚不存
    // 在。尝试仅获取引用而不映射到本地分支
    if (branch && fetchStderr.includes('refspec')) {
      logForDebugging(
        `特定分支获取失败，尝试获取引用：${branch}`,
      )
      const { code: refFetchCode, stderr: refFetchStderr } =
        await execFileNoThrow(gitExe(), ['fetch', 'origin', branch])
      if (refFetchCode !== 0) {
        logError(
          new Error(`从远程 origin 获取失败：${refFetchStderr}`),
        )
      }
    } else {
      logError(new Error(`从远程 origin 获取失败：${fetchStderr}`))
    }
  }
}

/** 确保当前分支已设置上游
如果未设置，且远程分支 origin/<branchName> 存在，则将其设置为上游 */
async function ensureUpstreamIsSet(branchName: string): Promise<void> {
  // 检查上游是否已设置
  const { code: upstreamCheckCode } = await execFileNoThrow(gitExe(), [
    'rev-parse',
    '--abbrev-ref',
    `${branchName}@{upstream}`,
  ])

  if (upstreamCheckCode === 0) {
    // 上游已设置
    logForDebugging(`分支 '${branchName}' 已设置上游`)
    return
  }

  // 检查 origin/<branchName> 是否存在
  const { code: remoteCheckCode } = await execFileNoThrow(gitExe(), [
    'rev-parse',
    '--verify',
    `origin/${branchName}`,
  ])

  if (remoteCheckCode === 0) {
    // 远程分支存在，设置上游
    logForDebugging(
      `将 '${branchName}' 的上游设置为 'origin/${branchName}'`,
    )
    const { code: setUpstreamCode, stderr: setUpstreamStderr } =
      await execFileNoThrow(gitExe(), [
        'branch',
        '--set-upstream-to',
        `origin/${branchName}`,
        branchName,
      ])

    if (setUpstreamCode !== 0) {
      logForDebugging(
        `为 '${branchName}' 设置上游失败：${setUpstreamStderr}`,
      )
      // 不要抛出异常，仅记录日志 - 这不关键
    } else {
      logForDebugging(`成功为 '${branchName}' 设置上游`)
    }
  } else {
    logForDebugging(
      `远程分支 'origin/${branchName}' 不存在，跳过上游设置`,
    )
  }
}

/** 检出特定分支 */
async function checkoutBranch(branchName: string): Promise<void> {
  // 首先尝试直接检出分支（可能是本地分支）
  let { code: checkoutCode, stderr: checkoutStderr } = await execFileNoThrow(
    gitExe(),
    ['checkout', branchName],
  )

  // 如果失败，尝试从 origin 检出
  if (checkoutCode !== 0) {
    logForDebugging(
      `本地检出失败，尝试从 origin 检出：${checkoutStderr}`,
    )

    // 尝试检出远程分支并创建本地跟踪分支
    const result = await execFileNoThrow(gitExe(), [
      'checkout',
      '-b',
      branchName,
      '--track',
      `origin/${branchName}`,
    ])

    checkoutCode = result.code
    checkoutStderr = result.stderr

    // 如果这也失败，尝试不使用 -b 参数（以防分支存在但未检出）
    if (checkoutCode !== 0) {
      logForDebugging(
        `使用 -b 参数的远程检出失败，尝试不使用 -b：${checkoutStderr}`,
      )
      const finalResult = await execFileNoThrow(gitExe(), [
        'checkout',
        '--track',
        `origin/${branchName}`,
      ])
      checkoutCode = finalResult.code
      checkoutStderr = finalResult.stderr
    }
  }

  if (checkoutCode !== 0) {
    logEvent('tengu_teleport_error_branch_checkout_failed', {})
    throw new TeleportOperationError(
      `检出分支 '${branchName}' 失败：${checkoutStderr}`,
      chalk.red(`检出分支 '${branchName}' 失败
`),
    )
  }

  // 成功检出后，确保上游已设置
  await ensureUpstreamIsSet(branchName)
}

/** 获取当前分支名称 */
async function getCurrentBranch(): Promise<string> {
  const { stdout: currentBranch } = await execFileNoThrow(gitExe(), [
    'branch',
    '--show-current',
  ])
  return currentBranch.trim()
}

/** 处理远程恢复的消息，移除不完整的 tool_use 块
并添加远程通知消息
@param messages 对话消息
@param error 分支检出的可选错误
@returns 处理后的消息，准备恢复 */
export function processMessagesForTeleportResume(
  messages: Message[],
  error: Error | null,
): Message[] {
  // 与恢复功能共享处理中断会话记录的逻辑
  const deserializedMessages = deserializeMessages(messages)

  // 添加关于远程恢复的用户消息（对模型可见）
  const messagesWithTeleportNotice = [
    ...deserializedMessages,
    createTeleportResumeUserMessage(),
    createTeleportResumeSystemMessage(error),
  ]

  return messagesWithTeleportNotice
}

/** 为远程会话检出指定分支
@param branch 要检出的可选分支
@returns 当前分支名称和发生的任何错误 */
export async function checkOutTeleportedSessionBranch(
  branch?: string,
): Promise<{ branchName: string; branchError: Error | null }> {
  try {
    const currentBranch = await getCurrentBranch()
    logForDebugging(`远程前的当前分支：'${currentBranch}'`)

    if (branch) {
      logForDebugging(`正在切换到分支 '${branch}'...`)
      await fetchFromOrigin(branch)
      await checkoutBranch(branch)
      const newBranch = await getCurrentBranch()
      logForDebugging(`检出后的分支：'${newBranch}'`)
    } else {
      logForDebugging('未指定分支，保持当前分支')
    }

    const branchName = await getCurrentBranch()
    return { branchName, branchError: null }
  } catch (error) {
    const branchName = await getCurrentBranch()
    const branchError = toError(error)
    return { branchName, branchError }
  }
}

/** 远程操作的仓库验证结果 */
export type RepoValidationResult = {
  status: 'match' | 'mismatch' | 'not_in_repo' | 'no_repo_required' | 'error'
  sessionRepo?: string
  currentRepo?: string | null
  /** 会话仓库的主机（例如 "github.com" 或 "ghe.corp.com"）— 仅用于显示 */
  sessionHost?: string
  /** 当前仓库的主机（例如 "github.com" 或 "ghe.corp.com"）— 仅用于显示 */
  currentHost?: string
  errorMessage?: string
}

/** 验证当前仓库是否与会话的仓库匹配。
返回结果对象而非抛出异常，允许调用者处理不匹配情况。

@param sessionData 要验证的会话资源
@returns 包含状态和仓库信息的验证结果 */
export async function validateSessionRepository(
  sessionData: SessionResource,
): Promise<RepoValidationResult> {
  const currentParsed = await detectCurrentRepositoryWithHost()
  const currentRepo = currentParsed
    ? `${currentParsed.owner}/${currentParsed.name}`
    : null

  const gitSource = sessionData.session_context.sources.find(
    (source): source is GitSource => source.type === 'git_repository',
  )

  if (!gitSource?.url) {
    // 会话无仓库要求
    logForDebugging(
      currentRepo
        ? '会话无关联仓库，无需验证继续'
        : '会话无仓库要求且不在 git 目录中，继续',
    )
    return { status: 'no_repo_required' }
  }

  const sessionParsed = parseGitRemote(gitSource.url)
  const sessionRepo = sessionParsed
    ? `${sessionParsed.owner}/${sessionParsed.name}`
    : parseGitHubRepository(gitSource.url)
  if (!sessionRepo) {
    return { status: 'no_repo_required' }
  }

  logForDebugging(
    `会话针对仓库：${sessionRepo}，当前仓库：${currentRepo ?? 'none'}`,
  )

  if (!currentRepo) {
    // 不在 git 仓库中，但会话需要仓库
    return {
      status: 'not_in_repo',
      sessionRepo,
      sessionHost: sessionParsed?.host,
      currentRepo: null,
    }
  }

  // 比较所有者/仓库和主机以避免跨实例不匹配。比较主机前去
  // 除端口 — SSH 远程省略端口，而 HTTPS 远程
  // 可能包含非标准端口（例如 ghe.corp.com:84
  // 43），这会导致误判不匹配。
  const stripPort = (host: string): string => host.replace(/:\d+$/, '')
  const repoMatch = currentRepo.toLowerCase() === sessionRepo.toLowerCase()
  const hostMatch =
    !currentParsed ||
    !sessionParsed ||
    stripPort(currentParsed.host.toLowerCase()) ===
      stripPort(sessionParsed.host.toLowerCase())

  if (repoMatch && hostMatch) {
    return {
      status: 'match',
      sessionRepo,
      currentRepo,
    }
  }

  // 仓库不匹配 — 保持 sessionRepo/currentRepo 为纯
  // "owner/repo" 格式，以便下游使用者（例如 getKnownPathsF
  // orRepo）可将其用作查找键。将主机信息包含在单独的字段中用于显示。
  return {
    status: 'mismatch',
    sessionRepo,
    currentRepo,
    sessionHost: sessionParsed?.host,
    currentHost: currentParsed?.host,
  }
}

/** 处理从代码会话 ID 远程传输。
获取会话日志并验证仓库。
@param sessionId 要恢复的会话 ID
@param onProgress 进度更新的可选回调
@returns 原始会话日志和分支名称 */
export async function teleportResumeCodeSession(
  sessionId: string,
  onProgress?: TeleportProgressCallback,
): Promise<TeleportRemoteResponse> {
  if (!isPolicyAllowed('allow_remote_sessions')) {
    throw new Error(
      "远程会话已被您的组织策略禁用。",
    )
  }

  logForDebugging(`正在恢复代码会话 ID：${sessionId}`)

  try {
    const accessToken = getClaudeAIOAuthTokens()?.accessToken
    if (!accessToken) {
      logEvent('tengu_teleport_resume_error', {
        error_type:
          'no_access_token' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      throw new Error(
        'Claude Code 网页会话需要使用 Claude.ai 账户进行身份验证。API 密钥身份验证不足。请运行 /login 进行身份验证，或使用 /status 检查您的身份验证状态。',
      )
    }

    // 获取组织 UUID
    const orgUUID = await getOrganizationUUID()
    if (!orgUUID) {
      logEvent('tengu_teleport_resume_error', {
        error_type:
          'no_org_uuid' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      throw new Error(
        '无法获取组织 UUID 以构建会话 URL',
      )
    }

    // 恢复前获取并验证仓库匹配
    onProgress?.('validating')
    const sessionData = await fetchSession(sessionId)
    const repoValidation = await validateSessionRepository(sessionData)

    switch (repoValidation.status) {
      case 'match':
      case 'no_repo_required':
        // 继续远程传输
        break
      case 'not_in_repo': {
        logEvent('tengu_teleport_error_repo_not_in_git_dir_sessions_api', {
          sessionId:
            sessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        // 为 GHE 用户包含主机信息，以便他们知道仓库位于哪个实例
        const notInRepoDisplay =
          repoValidation.sessionHost &&
          repoValidation.sessionHost.toLowerCase() !== 'github.com'
            ? `${repoValidation.sessionHost}/${repoValidation.sessionRepo}`
            : repoValidation.sessionRepo
        throw new TeleportOperationError(
          `您必须在 ${notInRepoDisplay} 的检出中运行 claude --teleport ${sessionId}。`,
          chalk.red(
            `您必须在 ${chalk.bold(notInRepoDisplay)} 的检出中运行 claude --teleport ${sessionId}。
`,
          ),
        )
      }
      case 'mismatch': {
        logEvent('tengu_teleport_error_repo_mismatch_sessions_api', {
          sessionId:
            sessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        // 仅在实际主机不同时包含主机前缀以区分跨实例
        // 不匹配；对于同主机不匹配，主机信息是噪音。
        const hostsDiffer =
          repoValidation.sessionHost &&
          repoValidation.currentHost &&
          repoValidation.sessionHost.replace(/:\d+$/, '').toLowerCase() !==
            repoValidation.currentHost.replace(/:\d+$/, '').toLowerCase()
        const sessionDisplay = hostsDiffer
          ? `${repoValidation.sessionHost}/${repoValidation.sessionRepo}`
          : repoValidation.sessionRepo
        const currentDisplay = hostsDiffer
          ? `${repoValidation.currentHost}/${repoValidation.currentRepo}`
          : repoValidation.currentRepo
        throw new TeleportOperationError(
          `您必须在 ${sessionDisplay} 的检出中运行 claude --teleport ${sessionId}。
当前仓库是 ${currentDisplay}。`,
          chalk.red(
            `您必须在 ${chalk.bold(sessionDisplay)} 的检出中运行 claude --teleport ${sessionId}。
当前仓库是 ${chalk.bold(currentDisplay)}。
`,
          ),
        )
      }
      case 'error':
        throw new TeleportOperationError(
          repoValidation.errorMessage ||
            '验证会话仓库失败',
          chalk.red(
            `Error: ${repoValidation.errorMessage || '验证会话仓库失败'}\n`,
          ),
        )
      default: {
        const _exhaustive: never = repoValidation.status
        throw new Error(`未处理的仓库验证状态：${_exhaustive}`)
      }
    }

    return await teleportFromSessionsAPI(
      sessionId,
      orgUUID,
      accessToken,
      onProgress,
      sessionData,
    )
  } catch (error) {
    if (error instanceof TeleportOperationError) {
      throw error
    }

    const err = toError(error)
    logError(err)
    logEvent('tengu_teleport_resume_error', {
      error_type:
        'resume_session_id_catch' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    throw new TeleportOperationError(
      err.message,
      chalk.red(`Error: ${err.message}\n`),
    )
  }
}

/** 处理远程传输先决条件（身份验证和 git 状态）的辅助函数
如果需要，将 TeleportError 对话框渲染到现有根中 */
async function handleTeleportPrerequisites(
  root: Root,
  errorsToIgnore?: Set<TeleportLocalErrorType>,
): Promise<void> {
  const errors = await getTeleportErrors()
  if (errors.size > 0) {
    // 记录检测到的远程传输错误
    logEvent('tengu_teleport_errors_detected', {
      error_types: Array.from(errors).join(
        ',',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      errors_ignored: Array.from(errorsToIgnore || []).join(
        ',',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    // 显示 TeleportError 对话框供用户交互
    await new Promise<void>(resolve => {
      root.render(
        <AppStateProvider>
          <KeybindingSetup>
            <TeleportError
              errorsToIgnore={errorsToIgnore}
              onComplete={() => {
                // 记录错误解决时
                logEvent('tengu_teleport_errors_resolved', {
                  error_types: Array.from(errors).join(
                    ',',
                  ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                })
                void resolve()
              }}
            />
          </KeybindingSetup>
        </AppStateProvider>,
      )
    })
  }
}

/** 创建远程 Claude.ai 会话，包含错误处理和 UI 反馈。
如果需要，在现有根中显示先决条件错误对话框。
@param root 用于渲染对话框的现有 Ink 根
@param description 新会话的描述/提示（null 表示无初始提示）
@param signal 用于取消的 AbortSignal
@param branchName 远程会话使用的可选分支名称
@returns Promise<TeleportToRemoteResponse | null> 创建的会话，如果创建失败则返回 null */
export async function teleportToRemoteWithErrorHandling(
  root: Root,
  description: string | null,
  signal: AbortSignal,
  branchName?: string,
): Promise<TeleportToRemoteResponse | null> {
  const errorsToIgnore = new Set<TeleportLocalErrorType>(['needsGitStash'])
  await handleTeleportPrerequisites(root, errorsToIgnore)
  return teleportToRemote({
    initialMessage: description,
    signal,
    branchName,
    onBundleFail: msg => process.stderr.write(`\n${msg}\n`),
  })
}

/** 从会话入口 API (/v1/session_ingress/) 获取会话数据
使用会话日志而非 SDK 事件来获取正确的消息结构
@param sessionId 要获取的会话 ID
@param orgUUID 组织 UUID
@param accessToken OAuth 访问令牌
@param onProgress 进度更新的可选回调
@param sessionData 可选会话数据（用于提取分支信息）
@returns 返回 TeleportRemoteResponse，其中会话日志以 Message[] 形式存储 */
export async function teleportFromSessionsAPI(
  sessionId: string,
  orgUUID: string,
  accessToken: string,
  onProgress?: TeleportProgressCallback,
  sessionData?: SessionResource,
): Promise<TeleportRemoteResponse> {
  const startTime = Date.now()

  try {
    // 通过会话入口获取会话日志
    logForDebugging(`[teleport] 开始获取会话：${sessionId}`)
    onProgress?.('fetching_logs')

    const logsStartTime = Date.now()
    // 首先尝试 CCR v2（GetTeleportEvents — 服务器分发
    // Spanner/threadstore）。如果返回 null（端点尚未
    // 部署或出现瞬时错误），则回退到 session-ingress。一旦 sessi
    // on-ingress 被移除，回退将变为空操作 — getSessionLog
    // sViaOAuth 也会返回 null，我们会因“无法获取会话日志”而失败。
    let logs = await getTeleportEvents(sessionId, accessToken, orgUUID)
    if (logs === null) {
      logForDebugging(
        '[teleport] v2 端点返回 null，正在尝试 session-ingress',
      )
      logs = await getSessionLogsViaOAuth(sessionId, accessToken, orgUUID)
    }
    logForDebugging(
      `[teleport] 会话日志在 ${Date.now() - logsStartTime}ms 内获取完成`,
    )

    if (logs === null) {
      throw new Error('无法获取会话日志')
    }

    // 筛选仅获取转录消息，排除侧链消息
    const filterStartTime = Date.now()
    const messages = logs.filter(
      entry => isTranscriptMessage(entry) && !entry.isSidechain,
    ) as Message[]
    logForDebugging(
      `[teleport] 在 ${Date.now() - filterStartTime}ms 内将 ${logs.length} 个条目筛选为 ${messages.length} 条消息`,
    )

    // 从会话数据中提取分支信息
    onProgress?.('fetching_branch')
    const branch = sessionData ? getBranchFromSession(sessionData) : undefined
    if (branch) {
      logForDebugging(`[teleport] 找到分支：${branch}`)
    }

    logForDebugging(
      `[teleport] teleportFromSessionsAPI 总耗时：${Date.now() - startTime}ms`,
    )

    return {
      log: messages,
      branch,
    }
  } catch (error) {
    const err = toError(error)

    // 专门处理 404 错误
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      logEvent('tengu_teleport_error_session_not_found_404', {
        sessionId:
          sessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      throw new TeleportOperationError(
        `未找到 ${sessionId}。`,
        `未找到 ${sessionId}。
${chalk.dim('Run /status in Claude Code to check your account.')}`,
      )
    }

    logError(err)

    throw new Error(`无法从 Sessions API 获取会话：${err.message}`)
  }
}

/** 轮询远程会话事件的响应类型（使用 SDK 事件格式） */
export type PollRemoteSessionResponse = {
  newEvents: SDKMessage[]
  lastEventId: string | null
  branch?: string
  sessionStatus?: 'idle' | 'running' | 'requires_action' | 'archived'
}

/** 轮询远程会话事件。将先前响应的 `lastEventId` 作为 `afterId` 传入以仅获取增量。设置 `skipMetadata` 以避免在不需要分支/状态时进行每次调用的 GET /v1/sessions/{id}。 */
export async function pollRemoteSessionEvents(
  sessionId: string,
  afterId: string | null = null,
  opts?: { skipMetadata?: boolean },
): Promise<PollRemoteSessionResponse> {
  const accessToken = getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    throw new Error('没有用于轮询的访问令牌')
  }

  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    throw new Error('没有用于轮询的组织 UUID')
  }

  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID,
  }
  const eventsUrl = `${getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}/events`

  type EventsResponse = {
    data: unknown[]
    has_more: boolean
    first_id: string | null
    last_id: string | null
  }

  // Cap 是针对卡住游标的安全阀；稳态为 0–1 页。
  const MAX_EVENT_PAGES = 50
  const sdkMessages: SDKMessage[] = []
  let cursor = afterId
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const eventsResponse = await axios.get(eventsUrl, {
      headers,
      params: cursor ? { after_id: cursor } : undefined,
      timeout: 30000,
    })

    if (eventsResponse.status !== 200) {
      throw new Error(
        `无法获取会话事件：${eventsResponse.statusText}`,
      )
    }

    const eventsData: EventsResponse = eventsResponse.data
    if (!eventsData?.data || !Array.isArray(eventsData.data)) {
      throw new Error('无效的事件响应')
    }

    for (const event of eventsData.data) {
      if (event && typeof event === 'object' && 'type' in event) {
        if (
          event.type === 'env_manager_log' ||
          event.type === 'control_response'
        ) {
          continue
        }
        if ('session_id' in event) {
          sdkMessages.push(event as SDKMessage)
        }
      }
    }

    if (!eventsData.last_id) break
    cursor = eventsData.last_id
    if (!eventsData.has_more) break
  }

  if (opts?.skipMetadata) {
    return { newEvents: sdkMessages, lastEventId: cursor }
  }

  // 获取会话元数据（分支、状态）
  let branch: string | undefined
  let sessionStatus: PollRemoteSessionResponse['sessionStatus']
  try {
    const sessionData = await fetchSession(sessionId)
    branch = getBranchFromSession(sessionData)
    sessionStatus =
      sessionData.session_status as PollRemoteSessionResponse['sessionStatus']
  } catch (e) {
    logForDebugging(
      `teleport: 无法获取会话 ${sessionId} 的元数据：${e}`,
      { level: 'debug' },
    )
  }

  return { newEvents: sdkMessages, lastEventId: cursor, branch, sessionStatus }
}

/** 使用 Sessions API 创建远程 Claude.ai 会话。

两种源模式：
- GitHub（默认）：后端从仓库的原始 URL 克隆。需要 GitHub 远程 + CCR 端的 GitHub 连接。43% 的 CLI 会话具有原始远程；通过完整先决条件链的比例要低得多。
- Bundle（CCR_FORCE_BUNDLE=1）：CLI 创建 `git bundle --all`，通过 Files API 上传，并将 file_id 作为 seed_bundle_file_id 传递到会话上下文中。CCR 下载它并从 bundle 克隆。不依赖 GitHub — 适用于仅本地的仓库。覆盖范围：54% 的 CLI 会话（任何具有 .git/ 的仓库）。后端：anthropic#303856。 */
export async function teleportToRemote(options: {
  initialMessage: string | null
  branchName?: string
  title?: string
  /** 会话的描述。用于生成标题和会话分支名称（除非明确提供）。 */
  description?: string
  model?: string
  permissionMode?: PermissionMode
  ultraplan?: boolean
  signal: AbortSignal
  useDefaultEnvironment?: boolean
  /** 显式的 environment_id（例如 code_review 合成环境）。绕过 fetchEnvironments；常规的仓库检测 → git 源仍会运行，因此容器会获取已检出的仓库（编排器从 pwd 读取 --repo-dir，它不克隆）。 */
  environmentId?: string
  /** 每个会话的环境变量合并到 session_context.environment_variables 中。在 API 层为只写（从 Get/List 响应中剥离）。当设置 environmentId 时，CLAUDE_CODE_OAUTH_TOKEN 会自动从调用者的 accessToken 注入，以便容器的钩子可以调用推理（服务器仅传递调用者发送的内容；bughunter.go 会生成自己的令牌，用户会话不会自动获得）。 */
  environmentVariables?: Record<string, string>
  /** 与 environmentId 一起设置时，创建并上传本地工作树的 git bundle（createAndUploadGitBundle 处理未提交更改的 stash-create）并将其作为 seed_bundle_file_id 传递。后端从 bundle 克隆而非 GitHub — 容器获得调用者的确切本地状态。仅需要 .git/，不需要 GitHub 远程。 */
  useBundle?: boolean
  /** 当尝试 bundle 路径但失败时，使用面向用户的消息调用。包装器将其写入 stderr（在 REPL 之前）。Remote-agent 调用者捕获它以包含在它们的抛出中（在 REPL 内，由 Ink 渲染）。 */
  onBundleFail?: (message: string) => void

  onCreateFail?: (message: string) => void
  /** 为 true 时，完全禁用 git-bundle 回退。用于像 autofix 这样的流程，其中 CCR 必须推送到 GitHub — bundle 无法做到这一点。 */
  skipBundle?: boolean
  /** 设置时，重用此分支作为结果分支，而不是生成新的 claude/ 分支。在源上设置 allow_unrestricted_git_push，并在会话上下文中设置 reuse_outcome_branches，以便远程直接推送到调用者的分支。 */
  reuseOutcomeBranch?: string
  /** 要附加到会话上下文的 GitHub PR。后端使用此信息来识别与此会话关联的 PR。 */
  githubPr?: { owner: string; repo: string; number: number }
}): Promise<TeleportToRemoteResponse | null> {
  const { initialMessage, signal } = options
  try {
    // 检查身份验证
    await checkAndRefreshOAuthTokenIfNeeded()
    const accessToken = getClaudeAIOAuthTokens()?.accessToken
    if (!accessToken) {
      logError(new Error('未找到用于创建远程会话的访问令牌'))
      return null
    }

    // 获取组织 UUID
    const orgUUID = await getOrganizationUUID()
    if (!orgUUID) {
      logError(
        new Error(
          '无法获取用于创建远程会话的组织 UUID',
        ),
      )
      return null
    }

    // 显式的 environmentId 会绕过 Haiku 标题生成 + 环
    // 境选择。仍运行仓库检测，以便容器获得工作目录 — code_revie
    // w 编排器读取 --repo-dir $(pwd)，它不克隆（bughu
    // nter.go:520 也设置了 git 源；环境管理器在 Sessio
    // nStart 钩子触发之前执行检出）。
    if (options.environmentId) {
      const url = `${getOauthConfig().BASE_API_URL}/v1/sessions`
      const headers = {
        ...getOAuthHeaders(accessToken),
        'anthropic-beta': 'ccr-byoc-2025-07-29',
        'x-organization-uuid': orgUUID,
      }
      const envVars = {
        CLAUDE_CODE_OAUTH_TOKEN: accessToken,
        ...(options.environmentVariables ?? {}),
      }

      // Bundle 模式：上传本地工作树（通过 refs/seed/sta
      // sh 处理未提交的更改），容器从 bundle 克隆。无需 Git
      // Hub。否则：github.com 源 — 调用者已检查资格。
      let gitSource: GitSource | null = null
      let seedBundleFileId: string | null = null
      if (options.useBundle) {
        const bundle = await createAndUploadGitBundle(
          {
            oauthToken: accessToken,
            sessionId: getSessionId(),
            baseUrl: getOauthConfig().BASE_API_URL,
          },
          { signal },
        )
        if (!bundle.success) {
          const failBundle = bundle as { success: false; error: string; failReason?: string }
          logError(new Error(`Bundle 上传失败：${failBundle.error}`))
          return null
        }
        seedBundleFileId = bundle.fileId
        logEvent('tengu_teleport_bundle_mode', {
          size_bytes: bundle.bundleSizeBytes,
          scope:
            bundle.scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          has_wip: bundle.hasWip,
          reason:
            'explicit_env_bundle' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      } else {
        const repoInfo = await detectCurrentRepositoryWithHost()
        if (repoInfo) {
          gitSource = {
            type: 'git_repository',
            url: `https://${repoInfo.host}/${repoInfo.owner}/${repoInfo.name}`,
            revision: options.branchName,
          }
        }
      }

      const requestBody = {
        title: options.title || options.description || '远程任务',
        events: [],
        session_context: {
          sources: gitSource ? [gitSource] : [],
          ...(seedBundleFileId && { seed_bundle_file_id: seedBundleFileId }),
          outcomes: [],
          environment_variables: envVars,
        },
        environment_id: options.environmentId,
      }
      logForDebugging(
        `[teleportToRemote] 显式环境 ${options.environmentId}，${Object.keys(envVars).length} 个环境变量，${seedBundleFileId ? `bundle=${seedBundleFileId}` : `source=${gitSource?.url ?? 'none'}@${options.branchName ?? 'default'}`}`,
      )
      const response = await axios.post(url, requestBody, { headers, signal })
      if (response.status !== 200 && response.status !== 201) {
        logError(
          new Error(
            `CreateSession ${response.status}：${jsonStringify(response.data)}`,
          ),
        )
        return null
      }
      const sessionData = response.data as SessionResource
      if (!sessionData || typeof sessionData.id !== 'string') {
        logError(
          new Error(
            `响应中没有会话 ID：${jsonStringify(response.data)}`,
          ),
        )
        return null
      }
      return {
        id: sessionData.id,
        title: sessionData.title || requestBody.title,
      }
    }

    let gitSource: GitSource | null = null
    let gitOutcome: GitRepositoryOutcome | null = null
    let seedBundleFileId: string | null = null

    // 源选择阶梯：GitHub 克隆（如果 CCR 确实可以拉取）→ bu
    // ndle 回退（如果存在 .git）→ 空沙箱。
    //
    // 预检与容器的 git-proxy 克隆将命中的代码路径相同（get_g
    // ithub_client_with_user_auth → no_sync
    // _user_token_found）。50% 到达“安装 GitHub
    // App”步骤的用户从未完成；没有预检，他们每个人都会得到一个在克隆时
    // 401 的容器。有了预检，他们会静默回退到 bundle。
    //
    // CCR_FORCE_BUNDLE=1 完全跳过预检 — 适用于测试或当您知
    // 道 GitHub 身份验证已损坏时。在此处读取（而非在调用者中），以便它
    // 也适用于 remote-agent，而不仅仅是 --remote。

    const repoInfo = await detectCurrentRepositoryWithHost()

    // 为会话生成标题和分支名称。当明确提供了标题
    // 和结果分支时，跳过 Haiku 调用。
    let sessionTitle: string
    let sessionBranch: string
    if (options.title && options.reuseOutcomeBranch) {
      sessionTitle = options.title
      sessionBranch = options.reuseOutcomeBranch
    } else {
      const generated = await generateTitleAndBranch(
        options.description || initialMessage || '后台任务',
        signal,
      )
      sessionTitle = options.title || generated.title
      sessionBranch = options.reuseOutcomeBranch || generated.branchName
    }

    // 预检：CCR 是否有可以克隆此仓库的令牌？仅针对 git
    // hub.com 检查 — GHES 需要 ghe_configur
    // ation_id，我们没有，而 GHES 用户是高级用户，可能已完
    // 成设置。对于他们（以及对于 parseGitRemote 以
    // 某种方式接受的非 GitHub 主机），乐观地继续；如果后端
    // 拒绝主机，下次使用 bundle。
    let ghViable = false
    let sourceReason:
      | 'github_preflight_ok'
      | 'ghes_optimistic'
      | 'github_preflight_failed'
      | 'no_github_remote'
      | 'forced_bundle'
      | 'no_git_at_all' = 'no_git_at_all'

    // gitRoot 控制 bundle 创建和门控检查本身 — 当
    // 没有内容可打包时，等待 GrowthBook 没有意义。
    const gitRoot = findGitRoot(getCwd())
    const forceBundle =
      !options.skipBundle && isEnvTruthy(process.env.CCR_FORCE_BUNDLE)
    const bundleSeedGateOn =
      !options.skipBundle &&
      gitRoot !== null &&
      (isEnvTruthy(process.env.CCR_ENABLE_BUNDLE) ||
        (await checkGate_CACHED_OR_BLOCKING('tengu_ccr_bundle_seed_enabled')))

    if (repoInfo && !forceBundle) {
      if (repoInfo.host === 'github.com') {
        ghViable = await checkGithubAppInstalled(
          repoInfo.owner,
          repoInfo.name,
          signal,
        )
        sourceReason = ghViable
          ? 'github_preflight_ok'
          : 'github_preflight_failed'
      } else {
        ghViable = true
        sourceReason = 'ghes_optimistic'
      }
    } else if (forceBundle) {
      sourceReason = 'forced_bundle'
    } else if (gitRoot) {
      sourceReason = 'no_github_remote'
    }

    // 预检失败但 bundle 已关闭 — 像预预检行为
    // 一样乐观地继续。后端报告真实的身份验证错误。
    if (!ghViable && !bundleSeedGateOn && repoInfo) {
      ghViable = true
    }

    if (ghViable && repoInfo) {
      const { host, owner, name } = repoInfo
      // 解析基础分支：优先使用显式 branchName，回退到默认分支
      const revision =
        options.branchName ?? (await getDefaultBranch()) ?? undefined
      logForDebugging(
        `[teleportToRemote] Git 源：${host}/${owner}/${name}，修订版本：${revision ?? 'none'}`,
      )
      gitSource = {
        type: 'git_repository',
        url: `https://${host}/${owner}/${name}`,
        // 修订版本指定要作为基础分支检出的引用
        revision,
        ...(options.reuseOutcomeBranch && {
          allow_unrestricted_git_push: true,
        }),
      }
      // type: 'github' 用于所有与 GitHub 兼容的主机（github
      // .com 和 GHE）。CLI 无法在客户端区分 GHE 与非 GitHub
      // 主机（GitLab、Bitbucket）— 后端根据配置的 GHE 实例验证
      // URL，并忽略无法识别主机的 git_info。
      gitOutcome = {
        type: 'git_repository',
        git_info: {
          type: 'github',
          repo: `${owner}/${name}`,
          branches: [sessionBranch],
        },
      }
    }

    // Bundle 回退。仅当 GitHub 不可行、门控开启且存在 .git/ 可
    // 打包时才尝试 bundle。在此处到达且 ghViable=fal
    // se 且 repoInfo 非 null 意味着预检失败 — .git 肯
    // 定存在（detectCurrentRepositoryWithHost
    // 从中读取了远程）。
    if (!gitSource && bundleSeedGateOn) {
      logForDebugging(`[teleportToRemote] 正在打包（原因：${sourceReason}）`)
      const bundle = await createAndUploadGitBundle(
        {
          oauthToken: accessToken,
          sessionId: getSessionId(),
          baseUrl: getOauthConfig().BASE_API_URL,
        },
        { signal },
      )
      if (!bundle.success) {
        const failBundle = bundle as { success: false; error: string; failReason?: string }
        logError(new Error(`Bundle 上传失败：${failBundle.error}`))
        // 仅当存在要克隆的远程时才引导用户进行 GitHub 设置。
        const setup = repoInfo
          ? '。请在 https://claude.ai/code 上设置 GitHub'
          : ''
        let msg: string
        switch (failBundle.failReason) {
          case 'empty_repo':
            msg =
              '仓库没有提交 — 请运行 `git add . && git commit -m "initial"` 然后重试'
            break
          case 'too_large':
            msg = `仓库太大，无法传送${setup}`
            break
          case 'git_error':
            msg = `无法创建 git bundle (${failBundle.error})${setup}`
            break
          case undefined:
            msg = `Bundle 上传失败：${failBundle.error}${setup}`
            break
          default: {
            msg = `Bundle 上传失败：${failBundle.error}`
          }
        }
        options.onBundleFail?.(msg)
        return null
      }
      seedBundleFileId = bundle.fileId
      logEvent('tengu_teleport_bundle_mode', {
        size_bytes: bundle.bundleSizeBytes,
        scope:
          bundle.scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        has_wip: bundle.hasWip,
        reason:
          sourceReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }

    logEvent('tengu_teleport_source_decision', {
      reason:
        sourceReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      path: (gitSource
        ? 'github'
        : seedBundleFileId
          ? 'bundle'
          : 'empty') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    if (!gitSource && !seedBundleFileId) {
      logForDebugging(
        '[teleportToRemote] 未检测到仓库 — 会话将具有空沙箱',
      )
    }

    // 获取可用环境
    let environments = await fetchEnvironments()
    if (!environments || environments.length === 0) {
      logError(new Error('没有可用于创建会话的环境'))
      return null
    }

    logForDebugging(
      `可用环境：${environments.map(e => `${e.environment_id} (${e.name}, ${e.kind})`).join(', ')}`,
    )

    // 根据设置选择环境，然后优先选择 anthropic_cloud，最后选择第一个可用的环境
    // 。优先选择 anthropic_cloud 环境而非 byoc：anthropic_cl
    // oud 环境（例如“Default”）是具有完整仓库访问权限的标准计算环境，而 b
    // yoc 环境（例如“monorepo”）是用户拥有的计算环境，可能不支持当前仓库。
    const settings = getSettings_DEPRECATED()
    const defaultEnvironmentId = options.useDefaultEnvironment
      ? undefined
      : settings?.remote?.defaultEnvironmentId
    let cloudEnv = environments.find(env => env.kind === 'anthropic_cloud')
    // 当调用者选择退出其配置的默认环境时，不要回
    // 退到可能不支持当前仓库或请求权限模式的 BY
    // OC 环境。重试一次以实现最终一致性，然后
    // 大声失败。
    if (options.useDefaultEnvironment && !cloudEnv) {
      logForDebugging(
        `环境列表中没有 anthropic_cloud（${environments.length} 个环境）；正在重试 fetchEnvironments`,
      )
      const retried = await fetchEnvironments()
      cloudEnv = retried?.find(env => env.kind === 'anthropic_cloud')
      if (!cloudEnv) {
        logError(
          new Error(
            `重试后仍无 anthropic_cloud 环境可用（得到：${(retried ?? environments).map(e => `${e.name} (${e.kind})`).join(', ')}）。静默回退到 byoc 会启动到死环境 — 改为快速失败。`,
          ),
        )
        return null
      }
      if (retried) environments = retried
    }
    const selectedEnvironment =
      (defaultEnvironmentId &&
        environments.find(
          env => env.environment_id === defaultEnvironmentId,
        )) ||
      cloudEnv ||
      environments.find(env => env.kind !== 'bridge') ||
      environments[0]

    if (!selectedEnvironment) {
      logError(new Error('没有可用于创建会话的环境'))
      return null
    }

    if (defaultEnvironmentId) {
      const matchedDefault =
        selectedEnvironment.environment_id === defaultEnvironmentId
      logForDebugging(
        matchedDefault
          ? `使用配置的默认环境：${defaultEnvironmentId}`
          : `未找到配置的默认环境 ${defaultEnvironmentId}，使用第一个可用的`,
      )
    }

    const environmentId = selectedEnvironment.environment_id
    logForDebugging(
      `选定的环境：${environmentId} (${selectedEnvironment.name}, ${selectedEnvironment.kind})`,
    )

    // 为 Sessions API 准备 API 请求
    const url = `${getOauthConfig().BASE_API_URL}/v1/sessions`

    const headers = {
      ...getOAuthHeaders(accessToken),
      'anthropic-beta': 'ccr-byoc-2025-07-29',
      'x-organization-uuid': orgUUID,
    }

    const sessionContext = {
      sources: gitSource ? [gitSource] : [],
      ...(seedBundleFileId && { seed_bundle_file_id: seedBundleFileId }),
      outcomes: gitOutcome ? [gitOutcome] : [],
      model: options.model ?? getMainLoopModel(),
      ...(options.reuseOutcomeBranch && { reuse_outcome_branches: true }),
      ...(options.githubPr && { github_pr: options.githubPr }),
    }

    // CreateCCRSessionPayload 没有 permissi
    // on_mode 字段 —— 一个顶级的请求体条目会被服务端的 pro
    // to 解析器静默丢弃。应改为前置一个 set_permission_mo
    // de 控制请求事件。初始事件在容器连接前就已写入 threadstore
    // ，因此 CLI 会在第一个用户回合前应用该模式 —— 避免了就绪状态的竞争。
    const events: Array<{ type: 'event'; data: Record<string, unknown> }> = []
    if (options.permissionMode) {
      events.push({
        type: 'event',
        data: {
          type: 'control_request',
          request_id: `set-mode-${randomUUID()}`,
          request: {
            subtype: 'set_permission_mode',
            mode: options.permissionMode,
            ultraplan: options.ultraplan,
          },
        },
      })
    }
    if (initialMessage) {
      events.push({
        type: 'event',
        data: {
          uuid: randomUUID(),
          session_id: '',
          type: 'user',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: initialMessage,
          },
        },
      })
    }

    const requestBody = {
      title: options.ultraplan ? `ultraplan: ${sessionTitle}` : sessionTitle,
      events,
      session_context: sessionContext,
      environment_id: environmentId,
    }

    logForDebugging(
      `正在使用负载创建会话：${jsonStringify(requestBody, null, 2)}`,
    )

    // 执行 API 调用
    const response = await axios.post(url, requestBody, { headers, signal, validateStatus: (status) => status < 500  })
    const isSuccess = response.status === 200 || response.status === 201

    if (!isSuccess) {
      logError(
        new Error(
          `API 请求失败，状态码 ${response.status}：${response.statusText}

响应数据：${jsonStringify(response.data, null, 2)}`,
        ),
      )

      options.onCreateFail?.(`${response.status} ${response.statusText}: ${jsonStringify(response.data)}`);
      return null
    }

    // 将响应解析为 SessionResource
    const sessionData = response.data as SessionResource
    if (!sessionData || typeof sessionData.id !== 'string') {
      logError(
        new Error(
          `无法从 API 响应中确定会话 ID：${jsonStringify(response.data)}`,
        ),
      )
      return null
    }

    logForDebugging(`成功创建远程会话：${sessionData.id}`)
    return {
      id: sessionData.id,
      title: sessionData.title || requestBody.title,
    }
  } catch (error) {
    const err = toError(error)
    logError(err)
    return null
  }
}

/** 尽力而为的会话归档。POST /v1/sessions/{id}/archive 没有运行状态检查（不像 DELETE 在 RUNNING 状态时会返回 409），因此它可以在实现过程中执行。已归档的会话会拒绝新事件（send_events.go），因此远程端会在下一次写入时停止。409（已归档）被视为成功。采用“发射后不管”策略；失败会导致会话保持可见，直到回收器将其清理。 */
export async function archiveRemoteSession(sessionId: string, timeout = 10_000): Promise<void> {
  const accessToken = getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) return
  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) return
  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID,
  }
  const url = `${getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}/archive`
  try {
    const resp = await axios.post(
      url,
      {},
      { headers, timeout, validateStatus: s => s < 500 },
    )
    if (resp.status === 200 || resp.status === 409) {
      logForDebugging(`[archiveRemoteSession] 已归档 ${sessionId}`)
    } else {
      logForDebugging(
        `[archiveRemoteSession] ${sessionId} 失败 ${resp.status}：${jsonStringify(resp.data)}`,
      )
    }
  } catch (err) {
    logError(err)
  }
}
