import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from '@anthropic-ai/sdk'
import type {
  BetaMessage,
  BetaStopReason,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { AFK_MODE_BETA_HEADER } from 'src/constants/betas.js'
import type { SDKAssistantMessageError } from 'src/entrypoints/agentSdkTypes.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from 'src/types/message.js'
import {
  getAnthropicApiKeyWithSource,
  getClaudeAIOAuthTokens,
  getOauthAccountInfo,
  isClaudeAISubscriber,
} from 'src/utils/auth.js'
import {
  createAssistantAPIErrorMessage,
  NO_RESPONSE_REQUESTED,
} from 'src/utils/messages.js'
import {
  getDefaultMainLoopModelSetting,
  isNonCustomOpusModel,
} from 'src/utils/model/model.js'
import { getModelStrings } from 'src/utils/model/modelStrings.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import {
  API_PDF_MAX_PAGES,
  PDF_TARGET_RAW_SIZE,
} from '../../constants/apiLimits.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { formatFileSize } from '../../utils/format.js'
import { ImageResizeError } from '../../utils/imageResizer.js'
import { ImageSizeError } from '../../utils/imageValidation.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  type ClaudeAILimits,
  getRateLimitErrorMessage,
  type OverageDisabledReason,
} from '../claudeAiLimits.js'
import { shouldProcessRateLimits } from '../rateLimitMocking.js' // Used for /mock-limits command
import { extractConnectionErrorDetails, formatAPIError } from './errorUtils.js'

export const API_ERROR_MESSAGE_PREFIX = 'API 错误'

export function startsWithApiErrorPrefix(text: string): boolean {
  return (
    text.startsWith(API_ERROR_MESSAGE_PREFIX) ||
    text.startsWith(`请运行 /login · ${API_ERROR_MESSAGE_PREFIX}`)
  )
}
export const PROMPT_TOO_LONG_ERROR_MESSAGE = '提示过长'

export function isPromptTooLongMessage(msg: AssistantMessage): boolean {
  if (!msg.isApiErrorMessage) {
    return false
  }
  const content = msg.message!.content
  if (!Array.isArray(content)) {
    return false
  }
  return content.some(
    block =>
      block.type === 'text' &&
      block.text.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE),
  )
}

/** * 从类似“提示过长：137500 个标记 > 135000 最大值”的原始提示过长 API 错误消息中解析实际/限制标记数。
 * 原始字符串可能被 SDK 前缀或 JSON 信封包装，或具有不同的大小写（Vertex），因此这里特意保持宽松。
 */
export function parsePromptTooLongTokenCounts(rawMessage: string): {
  actualTokens: number | undefined
  limitTokens: number | undefined
} {
  const match = rawMessage.match(
    /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i,
  )
  return {
    actualTokens: match ? parseInt(match[1]!, 10) : undefined,
    limitTokens: match ? parseInt(match[2]!, 10) : undefined,
  }
}

/** * 返回提示过长错误报告超出限制的标记数，如果消息不是 PTL 或其错误详情无法解析，则返回 undefined。
 * 响应式压缩使用此差距在一次重试中跳过多个组，而不是一次剥离一个。
 */
export function getPromptTooLongTokenGap(
  msg: AssistantMessage,
): number | undefined {
  if (!isPromptTooLongMessage(msg) || !msg.errorDetails) {
    return undefined
  }
  const { actualTokens, limitTokens } = parsePromptTooLongTokenCounts(
    msg.errorDetails as string,
  )
  if (actualTokens === undefined || limitTokens === undefined) {
    return undefined
  }
  const gap = actualTokens - limitTokens
  return gap > 0 ? gap : undefined
}

/** * 此原始 API 错误文本是否是 stripImagesFromMessages 可以修复的媒体大小拒绝？响应式压缩的摘要重试使用此信息来决定是剥离并重试（媒体错误）还是放弃（其他任何情况）。
 * 模式必须与填充 errorDetails 的 getAssistantMessageFromError 分支（~L523 PDF、~L560 图像、~L573 多图像）和 classifyAPIError 分支（~L929-946）保持同步。闭环：errorDetails 仅在这些分支已经匹配相同子字符串后设置，因此对于该路径，isMediaSizeError(errorDetails) 在逻辑上为真。API 措辞漂移会导致优雅降级（errorDetails 保持未定义，调用者短路），而不是假阴性。
 */
export function isMediaSizeError(raw: string): boolean {
  return (
    (raw.includes('图像超出') && raw.includes('maximum')) ||
    (raw.includes('图像尺寸超出') && raw.includes('many-image')) ||
    /maximum of \d+ PDF pages/.test(raw)
  )
}

/** * 消息级谓词：此助手消息是否是媒体大小拒绝？
 * 与 isPromptTooLongMessage 并行。检查 errorDetails（由 ~L523/560/573 处的 getAssistantMessageFromError 分支填充的原始 API 错误字符串）而不是内容文本，因为媒体错误具有每个变体的内容字符串。
 */
export function isMediaSizeErrorMessage(msg: AssistantMessage): boolean {
  return (
    msg.isApiErrorMessage === true &&
    msg.errorDetails !== undefined &&
    isMediaSizeError(msg.errorDetails as string)
  )
}
export const CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE = '积分余额过低'
export const INVALID_API_KEY_ERROR_MESSAGE = '未登录 · 请运行 /login'
export const INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL = 'API 密钥无效 · 请修复外部 API 密钥'
export const ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH = '您的 ANTHROPIC_API_KEY 属于已禁用的组织 · 请取消设置该环境变量，以改用您的订阅'
export const ORG_DISABLED_ERROR_MESSAGE_ENV_KEY = '您的 ANTHROPIC_API_KEY 属于已禁用的组织 · 请更新或取消设置该环境变量'
export const TOKEN_REVOKED_ERROR_MESSAGE = 'OAuth 令牌已吊销 · 请运行 /login'
export const CCR_AUTH_ERROR_MESSAGE = '身份验证错误 · 这可能是临时网络问题，请重试'
export const REPEATED_529_ERROR_MESSAGE = '重复出现 529 服务过载错误'
export const CUSTOM_OFF_SWITCH_MESSAGE = 'Opus 当前负载过高，请使用 /model 切换到 Sonnet'
export const API_TIMEOUT_ERROR_MESSAGE = '请求超时'
export function getPdfTooLargeErrorMessage(): string {
  const limits = `最多 ${API_PDF_MAX_PAGES} 页，${formatFileSize(PDF_TARGET_RAW_SIZE)}`
  return getIsNonInteractiveSession()
    ? `PDF 文件过大（${limits}）。请尝试以其他方式读取文件（例如，使用 pdftotext 提取文本）。`
    : `PDF 文件过大（${limits}）。请双击 esc 返回并重试，或先使用 pdftotext 转换为文本。`
}
export function getPdfPasswordProtectedErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? 'PDF 受密码保护。请尝试使用 CLI 工具提取或转换 PDF。'
    : 'PDF 受密码保护。请双击 esc 编辑消息并重试。'
}
export function getPdfInvalidErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? 'The PDF file was not valid. Try converting it to text first (e.g., pdftotext).'
    : 'PDF 文件无效。请双击 esc 返回并使用其他文件重试。'
}
export function getImageTooLargeErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? '图像过大。请尝试调整图像大小或使用其他方法。'
    : '图像过大。请双击 esc 返回并使用较小的图像重试。'
}
export function getRequestTooLargeErrorMessage(): string {
  const limits = `最多 ${formatFileSize(PDF_TARGET_RAW_SIZE)}`
  return getIsNonInteractiveSession()
    ? `请求过大（${limits}）。请尝试使用较小的文件。`
    : `请求过大（${limits}）。请双击 esc 返回并使用较小的文件重试。`
}
export const OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE =
  'Your account does not have access to Claude Code. Please run /login.'

export function getTokenRevokedErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? '您的账户无权访问 Claude。请重新登录或联系管理员。'
    : TOKEN_REVOKED_ERROR_MESSAGE
}

export function getOauthOrgNotAllowedErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? '您的组织无权访问 Claude。请重新登录或联系管理员。'
    : OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE
}

/** * 检查我们是否处于 CCR（Claude Code Remote）模式。
 * 在 CCR 模式下，身份验证通过基础设施提供的 JWT 处理，而不是通过 /login。临时身份验证错误应建议重试，而不是登录。
 */
function isCCRMode(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)
}

// 记录 tool_use/tool_result 不匹配错误的临时辅助函数
function logToolUseToolResultMismatch(
  toolUseId: string,
  messages: Message[],
  messagesForAPI: (UserMessage | AssistantMessage)[],
): void {
  try {
    // 在规范化消息中查找 tool_use
    let normalizedIndex = -1
    for (let i = 0; i < messagesForAPI.length; i++) {
      const msg = messagesForAPI[i]
      if (!msg) continue
      const content = msg.message!.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block.type === 'tool_use' &&
            'id' in block &&
            block.id === toolUseId
          ) {
            normalizedIndex = i
            break
          }
        }
      }
      if (normalizedIndex !== -1) break
    }

    // 在原始消息中查找 tool_use
    let originalIndex = -1
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (!msg) continue
      if (msg.type === 'assistant' && 'message' in msg) {
        const content = msg.message!.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block.type === 'tool_use' &&
              'id' in block &&
              block.id === toolUseId
            ) {
              originalIndex = i
              break
            }
          }
        }
      }
      if (originalIndex !== -1) break
    }

    // 构建规范化序列
    const normalizedSeq: string[] = []
    for (let i = normalizedIndex + 1; i < messagesForAPI.length; i++) {
      const msg = messagesForAPI[i]
      if (!msg) continue
      const content = msg.message!.content
      if (Array.isArray(content)) {
        for (const block of content) {
          const role = msg.message!.role
          if (block.type === 'tool_use' && 'id' in block) {
            normalizedSeq.push(`${role}:tool_use:${block.id}`)
          } else if (block.type === 'tool_result' && 'tool_use_id' in block) {
            normalizedSeq.push(`${role}:tool_result:${block.tool_use_id}`)
          } else if (block.type === 'text') {
            normalizedSeq.push(`${role}:text`)
          } else if (block.type === 'thinking') {
            normalizedSeq.push(`${role}:thinking`)
          } else if (block.type === 'image') {
            normalizedSeq.push(`${role}:image`)
          } else {
            normalizedSeq.push(`${role}:${block.type}`)
          }
        }
      } else if (typeof content === 'string') {
        normalizedSeq.push(`${msg.message.role}:string_content`)
      }
    }

    // 构建预规范化序列
    const preNormalizedSeq: string[] = []
    for (let i = originalIndex + 1; i < messages.length; i++) {
      const msg = messages[i]
      if (!msg) continue

      switch (msg.type) {
        case 'user':
        case 'assistant': {
          if ('message' in msg) {
            const content = msg.message!.content
            if (Array.isArray(content)) {
              for (const block of content) {
                const role = msg.message!.role
                if (block.type === 'tool_use' && 'id' in block) {
                  preNormalizedSeq.push(`${role}:tool_use:${block.id}`)
                } else if (
                  block.type === 'tool_result' &&
                  'tool_use_id' in block
                ) {
                  preNormalizedSeq.push(
                    `${role}:tool_result:${block.tool_use_id}`,
                  )
                } else if (block.type === 'text') {
                  preNormalizedSeq.push(`${role}:text`)
                } else if (block.type === 'thinking') {
                  preNormalizedSeq.push(`${role}:thinking`)
                } else if (block.type === 'image') {
                  preNormalizedSeq.push(`${role}:image`)
                } else {
                  preNormalizedSeq.push(`${role}:${block.type}`)
                }
              }
            } else if (typeof content === 'string') {
              preNormalizedSeq.push(`${msg.message!.role}:string_content`)
            }
          }
          break
        }
        case 'attachment':
          if ('attachment' in msg) {
            preNormalizedSeq.push(`attachment:${msg.attachment!.type}`)
          }
          break
        case 'system':
          if ('subtype' in msg) {
            preNormalizedSeq.push(`system:${msg.subtype}`)
          }
          break
        case 'progress':
          if (
            'progress' in msg &&
            msg.progress &&
            typeof msg.progress === 'object' &&
            'type' in msg.progress
          ) {
            preNormalizedSeq.push(`progress:${msg.progress.type ?? 'unknown'}`)
          } else {
            preNormalizedSeq.push('progress:unknown')
          }
          break
      }
    }

    // 记录到 Statsig
    logEvent('tengu_tool_use_tool_result_mismatch_error', {
      toolUseId:
        toolUseId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      normalizedSequence: normalizedSeq.join(
        ', ',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      preNormalizedSequence: preNormalizedSeq.join(
        ', ',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      normalizedMessageCount: messagesForAPI.length,
      originalMessageCount: messages.length,
      normalizedToolUseIndex: normalizedIndex,
      originalToolUseIndex: originalIndex,
    })
  } catch (_) {
    // 忽略调试日志中的错误
  }
}

/** * 类型守卫，用于检查一个值是否为来自 API 的有效消息响应 */
export function isValidAPIMessage(value: unknown): value is BetaMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    'model' in value &&
    'usage' in value &&
    Array.isArray((value as BetaMessage).content) &&
    typeof (value as BetaMessage).model === 'string' &&
    typeof (value as BetaMessage).usage === 'object'
  )
}

/** AWS 可能返回的低层级错误。 */
type AmazonError = {
  Output?: {
    __type?: string
  }
  Version?: string
}

/** * 给定一个看起来不太正确的响应，检查它是否包含任何我们可以提取的已知错误类型。 */
export function extractUnknownErrorFormat(value: unknown): string | undefined {
  // 首先检查值是否为有效对象
  if (!value || typeof value !== 'object') {
    return undefined
  }

  // Amazon Bedrock 路由错误
  if ((value as AmazonError).Output?.__type) {
    return (value as AmazonError).Output!.__type
  }

  return undefined
}

export function getAssistantMessageFromError(
  error: unknown,
  model: string,
  options?: {
    messages?: Message[]
    messagesForAPI?: (UserMessage | AssistantMessage)[]
  },
): AssistantMessage {
  // 检查 SDK 超时错误
  if (
    error instanceof APIConnectionTimeoutError ||
    (error instanceof APIConnectionError &&
      error.message.toLowerCase().includes('timeout'))
  ) {
    return createAssistantAPIErrorMessage({
      content: API_TIMEOUT_ERROR_MESSAGE,
      error: 'unknown',
    })
  }

  // 检查图像大小/调整大小错误（在验证期间、API 调用之前抛出）
  // 使用 getImageTooLargeErrorMessage() 为 CLI 用户显示 "esc esc" 提示
  // 但对 SDK 用户（非交互模式）显示通用消息
  if (error instanceof ImageSizeError || error instanceof ImageResizeError) {
    return createAssistantAPIErrorMessage({
      content: getImageTooLargeErrorMessage(),
    })
  }

  // 检查 Opus PAYG 用户的紧急容量关闭开关
  if (
    error instanceof Error &&
    error.message.includes(CUSTOM_OFF_SWITCH_MESSAGE)
  ) {
    return createAssistantAPIErrorMessage({
      content: CUSTOM_OFF_SWITCH_MESSAGE,
      error: 'rate_limit',
    })
  }

  if (
    error instanceof APIError &&
    error.status === 429 &&
    shouldProcessRateLimits(isClaudeAISubscriber())
  ) {
    // 检查这是否是具有多个速率限制标头的新 API
    const rateLimitType = error.headers?.get?.(
      'anthropic-ratelimit-unified-representative-claim',
    ) as 'five_hour' | 'seven_day' | 'seven_day_opus' | null

    const overageStatus = error.headers?.get?.(
      'anthropic-ratelimit-unified-overage-status',
    ) as 'allowed' | 'allowed_warning' | 'rejected' | null

    // 如果我们有新的标头，则使用新的消息生成方式
    if (rateLimitType || overageStatus) {
      // 从错误标头构建限制对象以确定适当的消息
      const limits: ClaudeAILimits = {
        status: 'rejected',
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
      }

      // 从标头中提取速率限制信息
      const resetHeader = error.headers?.get?.(
        'anthropic-ratelimit-unified-reset',
      )
      if (resetHeader) {
        limits.resetsAt = Number(resetHeader)
      }

      if (rateLimitType) {
        limits.rateLimitType = rateLimitType
      }

      if (overageStatus) {
        limits.overageStatus = overageStatus
      }

      const overageResetHeader = error.headers?.get?.(
        'anthropic-ratelimit-unified-overage-reset',
      )
      if (overageResetHeader) {
        limits.overageResetsAt = Number(overageResetHeader)
      }

      const overageDisabledReason = error.headers?.get?.(
        'anthropic-ratelimit-unified-overage-disabled-reason',
      ) as OverageDisabledReason | null
      if (overageDisabledReason) {
        limits.overageDisabledReason = overageDisabledReason
      }

      // 对所有新 API 速率限制使用新的消息格式
      const specificErrorMessage = getRateLimitErrorMessage(limits, model)
      if (specificErrorMessage) {
        return createAssistantAPIErrorMessage({
          content: specificErrorMessage,
          error: 'rate_limit',
        })
      }

      // 如果 getRateLimitErrorMessage 返回 null，则意味着回退机制
      // 将静默处理此情况（例如，对符合条件的用户从 Opus 回退到 Sonnet）。
      // 返回 NO_RESPONSE_REQUESTED，这样不会向用户显示错误，但
      // 消息仍会记录在对话历史中供 Claude 查看。
      return createAssistantAPIErrorMessage({
        content: NO_RESPONSE_REQUESTED,
        error: 'rate_limit',
      })
    }

    // 没有配额标头 — 这不是配额限制。展示 API 实际
    // 返回的内容，而不是通用的“达到速率限制”。授权拒绝
    // （例如，没有额外使用量的 1M 上下文）和基础设施容量 429 错误会落在此处。
    if (error.message.includes('长上下文需要额外使用量')) {
      const hint = getIsNonInteractiveSession()
        ? 'enable extra usage at claude.ai/settings/usage, or use --model to switch to standard context'
        : 'run /extra-usage to enable, or /model to switch to standard context'
      return createAssistantAPIErrorMessage({
        content: `${API_ERROR_MESSAGE_PREFIX}: 1M 上下文需要额外使用量 · ${hint}`,
        error: 'rate_limit',
      })
    }
    // SDK 的 APIError.makeMessage 会在没有顶层 .message 时，前置 "429 " 并将正文 JSON 字符串化
    // — 提取内部 error.message。
    const stripped = error.message.replace(/^429\s+/, '')
    const innerMessage = stripped.match(/"message"\s*:\s*"([^"]*)"/)?.[1]
    const detail = innerMessage || stripped
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: 请求被拒绝 (429) · ${detail || 'this may be a temporary capacity issue — check status.anthropic.com'}`,
      error: 'rate_limit',
    })
  }

  // 处理提示过长错误（Vertex 返回 413，直接 API 返回 400）
  // 使用不区分大小写的检查，因为 Vertex 返回的是 "Prompt is too long"（首字母大写）
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('提示词过长')
  ) {
    // 内容保持通用（UI 进行精确字符串匹配）。原始错误信息包含
    // token 计数，会进入 errorDetails —— reactive compact 的重试循环
    // 通过 getPromptTooLongTokenGap 从那里解析出差距。
    return createAssistantAPIErrorMessage({
      content: PROMPT_TOO_LONG_ERROR_MESSAGE,
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  // 检查 PDF 页数限制错误
  if (
    error instanceof Error &&
    /maximum of \d+ PDF pages/.test(error.message)
  ) {
    return createAssistantAPIErrorMessage({
      content: getPdfTooLargeErrorMessage(),
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  // 检查受密码保护的 PDF 错误
  if (
    error instanceof Error &&
    error.message.includes('指定的 PDF 受密码保护')
  ) {
    return createAssistantAPIErrorMessage({
      content: getPdfPasswordProtectedErrorMessage(),
      error: 'invalid_request',
    })
  }

  // 检查无效的 PDF 错误（例如，将 HTML 文件重命名为 .pdf）
  // 如果没有这个处理程序，无效的 PDF 文档块会持续存在于对话
  // 上下文中，并导致后续每个 API 调用都以 400 状态码失败。
  if (
    error instanceof Error &&
    error.message.includes('指定的 PDF 无效')
  ) {
    return createAssistantAPIErrorMessage({
      content: getPdfInvalidErrorMessage(),
      error: 'invalid_request',
    })
  }

  // 检查图像大小错误（例如，"图像超过 5 MB 上限：5316852 字节 > 5242880 字节"）
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('图像超过') &&
    error.message.includes('maximum')
  ) {
    return createAssistantAPIErrorMessage({
      content: getImageTooLargeErrorMessage(),
      errorDetails: error.message,
    })
  }

  // 检查多图像尺寸错误（API 对多图像请求强制执行更严格的 2000 像素限制）
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('图像尺寸超过') &&
    error.message.includes('many-image')
  ) {
    return createAssistantAPIErrorMessage({
      content: getIsNonInteractiveSession()
        ? 'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.'
        : 'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Run /compact to remove old images from context, or start a new session.',
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  // 服务器拒绝了 afk-mode beta 请求头（套餐不包含自动
  // 模式）。在非 TRANSCRIPT_CLASSIFIER 构建中，AFK_MODE_BETA_HEADER 是 ''，
  // 因此真值守卫使其在那里保持惰性。
  if (
    AFK_MODE_BETA_HEADER &&
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes(AFK_MODE_BETA_HEADER) &&
    error.message.includes('anthropic-beta')
  ) {
    return createAssistantAPIErrorMessage({
      content: '您的套餐不包含自动模式',
      error: 'invalid_request',
    })
  }

  // 检查请求过大错误（413 状态码）
  // 这通常发生在大型 PDF 文件加上对话上下文超过 32MB API 限制时
  if (error instanceof APIError && error.status === 413) {
    return createAssistantAPIErrorMessage({
      content: getRequestTooLargeErrorMessage(),
      error: 'invalid_request',
    })
  }

  // 检查 tool_use/tool_result 并发错误
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes(
      '`tool_use` ids were found without `tool_result` blocks immediately after',
    )
  ) {
    // 如果我们有消息上下文，则记录到 Statsig
    if (options?.messages && options?.messagesForAPI) {
      const toolUseIdMatch = error.message.match(/toolu_[a-zA-Z0-9]+/)
      const toolUseId = toolUseIdMatch ? toolUseIdMatch[0] : null
      if (toolUseId) {
        logToolUseToolResultMismatch(
          toolUseId,
          options.messages,
          options.messagesForAPI,
        )
      }
    }

    if (process.env.USER_TYPE === 'ant') {
      const baseMessage = `API 错误：400 ${error.message}

运行 /share 并将 JSON 文件发布到 ${MACRO.FEEDBACK_CHANNEL}。`
      const rewindInstruction = getIsNonInteractiveSession()
        ? ''
        : ' Then, use /rewind to recover the conversation.'
      return createAssistantAPIErrorMessage({
        content: baseMessage + rewindInstruction,
        error: 'invalid_request',
      })
    } else {
      const baseMessage = 'API Error: 400 due to tool use concurrency issues.'
      const rewindInstruction = getIsNonInteractiveSession()
        ? ''
        : ' Run /rewind to recover the conversation.'
      return createAssistantAPIErrorMessage({
        content: baseMessage + rewindInstruction,
        error: 'invalid_request',
      })
    }
  }

  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('unexpected `tool_use_id` found in `tool_result`')
  ) {
    logEvent('tengu_unexpected_tool_result', {})
  }

  // 重复的 tool_use ID (CC-1212)。ensureToolResultPairing 会在发送前
  // 剥离这些 ID，所以遇到此错误意味着新的损坏路径溜了进来。
  // 记录日志以进行根因分析，并为用户提供恢复路径而非死锁。
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('`tool_use` ids must be unique')
  ) {
    logEvent('tengu_duplicate_tool_use_id', {})
    const rewindInstruction = getIsNonInteractiveSession()
      ? ''
      : ' Run /rewind to recover the conversation.'
    return createAssistantAPIErrorMessage({
      content: `API 错误：400 对话历史中存在重复的 tool_use ID。${rewindInstruction}`,
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  // 检查订阅用户尝试使用 Opus 时的无效模型名称错误
  if (
    isClaudeAISubscriber() &&
    error instanceof APIError &&
    error.status === 400 &&
    error.message.toLowerCase().includes('无效的模型名称') &&
    (isNonCustomOpusModel(model) || model === 'opus')
  ) {
    return createAssistantAPIErrorMessage({
      content:
        'Claude Opus is not available with the Claude Pro plan. If you have updated your subscription plan recently, run /logout and /login for the plan to take effect.',
      error: 'invalid_request',
    })
  }

  // 为 Ant 用户检查无效模型名称错误。Claude Code 可能
  // 默认为 Ant 使用一个自定义的内部模型，并且可能存在
  // Ant 用户使用了新的或未知的组织 ID，这些 ID 尚未被纳入权限控制。
  if (
    process.env.USER_TYPE === 'ant' &&
    !process.env.ANTHROPIC_MODEL &&
    error instanceof Error &&
    error.message.toLowerCase().includes('无效的模型名称')
  ) {
    // 从配置中获取组织 ID - 仅在主动使用 OAuth 时使用 OAuth 账户数据
    const orgId = getOauthAccountInfo()?.organizationUuid
    const baseMsg = `[仅限 ANT] 您的组织无权访问 \`${model}\` 模型。请使用 \`ANTHROPIC_MODEL=${getDefaultMainLoopModelSetting()}\` 运行 \`claude\` 命令`
    const msg = orgId
      ? `${baseMsg} 或在 ${MACRO.FEEDBACK_CHANNEL} 中分享您的 orgId (${orgId}) 以寻求获取访问权限的帮助。`
      : `${baseMsg} 或在 ${MACRO.FEEDBACK_CHANNEL} 中寻求帮助以获取访问权限。`

    return createAssistantAPIErrorMessage({
      content: msg,
      error: 'invalid_request',
    })
  }

  if (
    error instanceof Error &&
    error.message.includes('您的信用余额过低')
  ) {
    return createAssistantAPIErrorMessage({
      content: CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
      error: 'billing_error',
    })
  }
  // "组织已被禁用" — 通常是来自前雇主/项目的过时 ANTHROPIC_API_KEY
  // 覆盖了订阅认证。仅处理环境变量的情况；apiKeyHelper 和 /login-managed 密钥意味着当前
  // 认证的组织确实已被禁用，没有可回退的休眠备用方案。
  // 组织已被禁用
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.toLowerCase().includes('getAnthropicApiKeyWithSource 将环境变量与 FD 传递的密钥混为一谈')
  ) {
    const { source } = getAnthropicApiKeyWithSource()
    // 归为同一来源值，并且在 CCR 模式下，尽管存在环境变量，OAuth 仍保持活动状态。
    // 这三重防护确保我们仅在环境变量确实被设置且确实在通信中使用时才归咎于它。
    // 不是 'authentication_failed' — 那会触发 VS Code 的 showLogin()，但
    // 登录无法解决此问题（已批准的环境变量会持续覆盖 OAuth）。修复方法是
    if (
      source === 'ANTHROPIC_API_KEY' &&
      process.env.ANTHROPIC_API_KEY &&
      !isClaudeAISubscriber()
    ) {
      const hasStoredOAuth = getClaudeAIOAuthTokens()?.accessToken != null
      // 基于配置的（取消设置该变量），因此 invalid_request 是正确的。
      // 在 CCR 模式下，认证通过 JWT 进行 - 这很可能是一个临时性的网络问题
      // 检查 API 密钥是否来自外部来源
      return createAssistantAPIErrorMessage({
        error: 'invalid_request',
        content: hasStoredOAuth
          ? ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH
          : ORG_DISABLED_ERROR_MESSAGE_ENV_KEY,
      })
    }
  }

  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('x-api-key')
  ) {
    // 检查 OAuth 令牌吊销错误
    if (isCCRMode()) {
      return createAssistantAPIErrorMessage({
        error: 'authentication_failed',
        content: CCR_AUTH_ERROR_MESSAGE,
      })
    }

    // OAuth 令牌已被吊销
    const { source } = getAnthropicApiKeyWithSource()
    const isExternalSource =
      source === 'ANTHROPIC_API_KEY' || source === 'apiKeyHelper'

    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content: isExternalSource
        ? INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL
        : INVALID_API_KEY_ERROR_MESSAGE,
    })
  }

  // 检查 OAuth 组织不被允许的错误
  if (
    error instanceof APIError &&
    error.status === 403 &&
    error.message.includes('当前不允许此组织使用 OAuth 认证')
  ) {
    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content: getTokenRevokedErrorMessage(),
    })
  }

  // 其他 401/403 认证错误的通用处理程序
  if (
    error instanceof APIError &&
    (error.status === 401 || error.status === 403) &&
    error.message.includes(
      '在 CCR 模式下，认证通过 JWT 进行 - 这很可能是一个临时性的网络问题',
    )
  ) {
    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content: getOauthOrgNotAllowedErrorMessage(),
    })
  }

  // 其他 401/403 认证错误的通用处理程序
  if (
    error instanceof APIError &&
    (error.status === 401 || error.status === 403)
  ) {
    // 在 CCR 模式下，认证通过 JWT 进行 - 这很可能是一个临时网络问题
    if (isCCRMode()) {
      return createAssistantAPIErrorMessage({
        error: 'authentication_failed',
        content: CCR_AUTH_ERROR_MESSAGE,
      })
    }

    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content: getIsNonInteractiveSession()
        ? `身份验证失败。${API_ERROR_MESSAGE_PREFIX}: ${error.message}`
        : `请运行 /login · ${API_ERROR_MESSAGE_PREFIX}: ${error.message}`,
    })
  }

  // Bedrock 错误，例如 "403 您无权访问具有指定模型 ID 的模型。"
  // 不包含实际的模型 ID
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) &&
    error instanceof Error &&
    error.message.toLowerCase().includes('模型 ID')
  ) {
    const switchCmd = getIsNonInteractiveSession() ? '--model' : '/model'
    const fallbackSuggestion = get3PModelFallbackSuggestion(model)
    return createAssistantAPIErrorMessage({
      content: fallbackSuggestion
        ? `${API_ERROR_MESSAGE_PREFIX} (${model}): ${error.message}。尝试 ${switchCmd} 以切换到 ${fallbackSuggestion}。`
        : `${API_ERROR_MESSAGE_PREFIX} (${model}): ${error.message}。运行 ${switchCmd} 以选择其他模型。`,
      error: 'invalid_request',
    })
  }

  // 404 未找到 — 通常意味着所选模型不存在或不可用。
  // 引导用户前往 /model，以便他们可以选择一个有效的模型。
  // 对于第三方用户，建议一个他们可以尝试的特定备用模型。
  if (error instanceof APIError && error.status === 404) {
    const switchCmd = getIsNonInteractiveSession() ? '--model' : '/model'
    const fallbackSuggestion = get3PModelFallbackSuggestion(model)
    return createAssistantAPIErrorMessage({
      content: fallbackSuggestion
        ? `模型 ${model} 在您的 ${getAPIProvider()} 部署中不可用。尝试 ${switchCmd} 以切换到 ${fallbackSuggestion}，或请您的管理员启用此模型。`
        : `所选模型 (${model}) 存在问题。它可能不存在，或者您可能无权访问它。运行 ${switchCmd} 以选择其他模型。`,
      error: 'invalid_request',
    })
  }

  // 连接错误（非超时） — 使用 formatAPIError 获取详细消息
  if (error instanceof APIConnectionError) {
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: ${formatAPIError(error)}`,
      error: 'unknown',
    })
  }

  if (error instanceof Error) {
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: ${error.message}`,
      error: 'unknown',
    })
  }
  return createAssistantAPIErrorMessage({
    content: API_ERROR_MESSAGE_PREFIX,
    error: 'unknown',
  })
}

/** * 对于第三方用户，当所选模型不可用时，建议一个备用模型。
 * 返回一个模型名称建议，如果不适用则返回 undefined。 */
function get3PModelFallbackSuggestion(model: string): string | undefined {
  if (getAPIProvider() === 'firstParty') {
    return undefined
  }
  // @[模型发布]: 为新模型添加备用建议链 → 第三方用户的先前版本
  const m = model.toLowerCase()
  // If the failing model looks like an Opus 4.6 variant, suggest the default Opus (4.1 for 3P)
  if (m.includes('opus-4-7') || m.includes('opus_4_7')) {
    return getModelStrings().opus46
  }
  if (m.includes('opus-4-6') || m.includes('opus_4_6')) {
    return getModelStrings().opus41
  }
  // 如果失败的模型看起来像 Sonnet 4.6 变体，建议 Sonnet 4.5
  if (m.includes('sonnet-4-6') || m.includes('sonnet_4_6')) {
    return getModelStrings().sonnet45
  }
  // 如果失败的模型看起来像 Sonnet 4.5 变体，建议 Sonnet 4
  if (m.includes('sonnet-4-5') || m.includes('sonnet_4_5')) {
    return getModelStrings().sonnet40
  }
  return undefined
}

/** * 将 API 错误分类为特定错误类型，用于分析跟踪。
 * 返回一个适合 Datadog 标记的标准化错误类型字符串。 */
export function classifyAPIError(error: unknown): string {
  // 已中止的请求
  if (error instanceof Error && error.message === '请求已中止。') {
    return 'aborted'
  }

  // 超时错误
  if (
    error instanceof APIConnectionTimeoutError ||
    (error instanceof APIConnectionError &&
      error.message.toLowerCase().includes('timeout'))
  ) {
    return 'api_timeout'
  }

  // 检查重复的 529 错误
  if (
    error instanceof Error &&
    error.message.includes(REPEATED_529_ERROR_MESSAGE)
  ) {
    return 'repeated_529'
  }

  // 检查紧急容量关闭开关
  if (
    error instanceof Error &&
    error.message.includes(CUSTOM_OFF_SWITCH_MESSAGE)
  ) {
    return 'capacity_off_switch'
  }

  // 速率限制
  if (error instanceof APIError && error.status === 429) {
    return 'rate_limit'
  }

  // 服务器过载 (529)
  if (
    error instanceof APIError &&
    (error.status === 529 ||
      error.message?.includes('"type":"overloaded_error"'))
  ) {
    return 'server_overload'
  }

  // 提示/内容大小错误
  if (
    error instanceof Error &&
    error.message
      .toLowerCase()
      .includes(PROMPT_TOO_LONG_ERROR_MESSAGE.toLowerCase())
  ) {
    return 'prompt_too_long'
  }

  // PDF 错误
  if (
    error instanceof Error &&
    /maximum of \d+ PDF pages/.test(error.message)
  ) {
    return 'pdf_too_large'
  }

  if (
    error instanceof Error &&
    error.message.includes('指定的 PDF 受密码保护')
  ) {
    return 'pdf_password_protected'
  }

  // 图像大小错误
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('图像超出限制') &&
    error.message.includes('maximum')
  ) {
    return 'image_too_large'
  }

  // 多图像尺寸错误
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('图像尺寸超出限制') &&
    error.message.includes('many-image')
  ) {
    return 'image_too_large'
  }

  // 工具使用错误 (400)
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes(
      '`tool_use` ids were found without `tool_result` blocks immediately after',
    )
  ) {
    return 'tool_use_mismatch'
  }

  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('unexpected `tool_use_id` found in `tool_result`')
  ) {
    return 'unexpected_tool_result'
  }

  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('`tool_use` ids must be unique')
  ) {
    return 'duplicate_tool_use_id'
  }

  // 无效模型错误 (400)
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.toLowerCase().includes('无效模型名称')
  ) {
    return 'invalid_model'
  }

  // 信用/计费错误
  if (
    error instanceof Error &&
    error.message
      .toLowerCase()
      .includes(CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE.toLowerCase())
  ) {
    return 'credit_balance_low'
  }

  // 认证错误
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('x-api-key')
  ) {
    return 'invalid_api_key'
  }

  if (
    error instanceof APIError &&
    error.status === 403 &&
    error.message.includes('OAuth 令牌已被撤销')
  ) {
    return 'token_revoked'
  }

  if (
    error instanceof APIError &&
    (error.status === 401 || error.status === 403) &&
    error.message.includes(
      '当前不允许此组织使用 OAuth 认证',
    )
  ) {
    return 'oauth_org_not_allowed'
  }

  // 通用认证错误
  if (
    error instanceof APIError &&
    (error.status === 401 || error.status === 403)
  ) {
    return 'auth_error'
  }

  // Bedrock 特定错误
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) &&
    error instanceof Error &&
    error.message.toLowerCase().includes('模型 ID')
  ) {
    return 'bedrock_model_access'
  }

  // 基于状态码的回退
  if (error instanceof APIError) {
    const status = error.status
    if (status >= 500) return 'server_error'
    if (status >= 400) return 'client_error'
  }

  // 连接错误 - 请先检查 SSL/TLS 问题
  if (error instanceof APIConnectionError) {
    const connectionDetails = extractConnectionErrorDetails(error)
    if (connectionDetails?.isSSLError) {
      return 'ssl_cert_error'
    }
    return 'connection_error'
  }

  return 'unknown'
}

export function categorizeRetryableAPIError(
  error: APIError,
): SDKAssistantMessageError {
  if (
    error.status === 529 ||
    error.message?.includes('"type":"overloaded_error"')
  ) {
    return 'rate_limit'
  }
  if (error.status === 429) {
    return 'rate_limit'
  }
  if (error.status === 401 || error.status === 403) {
    return 'authentication_failed'
  }
  if (error.status !== undefined && error.status >= 408) {
    return 'server_error'
  }
  return 'unknown'
}

export function getErrorMessageIfRefusal(
  stopReason: BetaStopReason | null,
  model: string,
): AssistantMessage | undefined {
  if (stopReason !== 'refusal') {
    return
  }

  logEvent('tengu_refusal_api_response', {})

  const baseMessage = getIsNonInteractiveSession()
    ? `${API_ERROR_MESSAGE_PREFIX}: Claude Code 无法响应此请求，该请求似乎违反了我们的使用政策 (https://www.anthropic.com/legal/aup)。请尝试重新表述请求或采用不同的方法。`
    : `${API_ERROR_MESSAGE_PREFIX}: Claude Code 无法响应此请求，该请求似乎违反了我们的使用政策 (https://www.anthropic.com/legal/aup)。请双击 esc 键编辑上一条消息，或开始新会话以便 Claude Code 协助处理其他任务。`

  const modelSuggestion =
    model !== 'claude-sonnet-4-20250514'
      ? ' If you are seeing this refusal repeatedly, try running /model claude-sonnet-4-20250514 to switch models.'
      : ''

  return createAssistantAPIErrorMessage({
    content: baseMessage + modelSuggestion,
    error: 'invalid_request',
  })
}
