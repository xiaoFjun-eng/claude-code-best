import type { ContentBlockParam } from '@anthropic-ai/sdk/resources'
import { randomUUID } from 'crypto'
import { setPromptId } from 'src/bootstrap/state.js'
import type {
  AttachmentMessage,
  SystemMessage,
  UserMessage,
} from 'src/types/message.js'
import { logEvent } from '../../services/analytics/index.js'
import type { PermissionMode } from '../../types/permissions.js'
import { createUserMessage } from '../messages.js'
import { logOTelEvent, redactIfDisabled } from '../telemetry/events.js'
import { startInteractionSpan } from '../telemetry/sessionTracing.js'
import {
  matchesKeepGoingKeyword,
  matchesNegativeKeyword,
} from '../userPromptKeywords.js'

export function processTextPrompt(
  input: string | Array<ContentBlockParam>,
  imageContentBlocks: ContentBlockParam[],
  imagePasteIds: number[],
  attachmentMessages: AttachmentMessage[],
  uuid?: string,
  permissionMode?: PermissionMode,
  isMeta?: boolean,
): {
  messages: (UserMessage | AttachmentMessage | SystemMessage)[]
  shouldQuery: boolean
} {
  const promptId = randomUUID()
  setPromptId(promptId)

  const userPromptText =
    typeof input === 'string'
      ? input
      : input.find(block => block.type === 'text')?.text || ''
  startInteractionSpan(userPromptText)

  // 为字符串（CLI）和数组（SDK/VS Code）两种输入格式均发出 user_prompt
  // OTEL 事件。之前仅在 `typeof input === 'string'` 条件下触
  // 发，因此 VS Code 会话从未发出过 user_prompt 事件（anthro
  // pics/claude-code#33301）。对于数组输入，使用最后一个文本块：cre
  // ateUserContent 将用户消息推送到最后（在所有 <ide_selection>/附
  // 件上下文块之后），因此 .findLast 获取的是实际提示。userPromptText（
  // 第一个块）保持不变，供 startInteractionSpan 使用，以保留现有的跨度属性。
  const otelPromptText =
    typeof input === 'string'
      ? input
      : input.findLast(block => block.type === 'text')?.text || ''
  if (otelPromptText) {
    void logOTelEvent('user_prompt', {
      prompt_length: String(otelPromptText.length),
      prompt: redactIfDisabled(otelPromptText),
      'prompt.id': promptId,
    })
  }

  const isNegative = matchesNegativeKeyword(userPromptText)
  const isKeepGoing = matchesKeepGoingKeyword(userPromptText)
  logEvent('tengu_input_prompt', {
    is_negative: isNegative,
    is_keep_going: isKeepGoing,
  })

  // 如果我们已粘贴图像，则创建一条包含图像内容的消息
  if (imageContentBlocks.length > 0) {
    // 构建内容：先文本，后图像
    const textContent =
      typeof input === 'string'
        ? input.trim()
          ? [{ type: 'text' as const, text: input }]
          : []
        : input
    const userMessage = createUserMessage({
      content: [...textContent, ...imageContentBlocks],
      uuid: uuid,
      imagePasteIds: imagePasteIds.length > 0 ? imagePasteIds : undefined,
      permissionMode,
      isMeta: isMeta || undefined,
    })

    return {
      messages: [userMessage, ...attachmentMessages],
      shouldQuery: true,
    }
  }

  const userMessage = createUserMessage({
    content: input,
    uuid,
    permissionMode,
    isMeta: isMeta || undefined,
  })

  return {
    messages: [userMessage, ...attachmentMessages],
    shouldQuery: true,
  }
}
