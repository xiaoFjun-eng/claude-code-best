import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getKairosActive, getUserMsgOptIn } from 'src/bootstrap/state.js'
import { getFeatureValue_CACHED_WITH_REFRESH } from 'src/services/analytics/growthbook.js'
import { logEvent } from 'src/services/analytics/index.js'
import type { ValidationResult } from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { plural } from 'src/utils/stringUtils.js'
import { resolveAttachments, validateAttachmentPaths } from './attachments.js'
import {
  BRIEF_TOOL_NAME,
  BRIEF_TOOL_PROMPT,
  DESCRIPTION,
  LEGACY_BRIEF_TOOL_NAME,
} from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    message: z
      .string()
      .describe('给用户的消息。支持 Markdown 格式。'),
    attachments: z
      .array(z.string())
      .optional()
      .describe(
        '可选的要附加的文件路径（绝对路径或相对于当前工作目录）。用于附加照片、截图、差异文件、日志或任何用户应随消息一同查看的文件。',
      ),
    status: z
      .enum(['normal', 'proactive'])
      .describe(
        "当您主动呈现用户未要求但需要立即查看的内容时（例如用户离开时的任务完成情况、您遇到的阻碍、未经请求的状态更新），请使用 'proactive'。当回复用户刚刚提到的内容时，请使用 'normal'。",
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 附件必须保持可选 — 恢复的会话会逐字重放附加附件之前的
// 输出，如果设为必填字段，会在恢复时导致 UI 渲染器崩溃。
const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('消息'),
    attachments: z
      .array(
        z.object({
          path: z.string(),
          size: z.number(),
          isImage: z.boolean(),
          file_uuid: z.string().optional(),
        }),
      )
      .optional()
      .describe('已解析的附件元数据'),
    sentAt: z
      .string()
      .optional()
      .describe(
        '在发送进程执行工具时捕获的 ISO 时间戳。可选 — 恢复的会话会逐字重放发送前（pre-sentAt）的输出。',
      ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

const KAIROS_BRIEF_REFRESH_MS = 5 * 60 * 1000

/** 权限检查 — 用户是否被允许使用 Brief？结合了构建时标志、运行时 GB 门控以及助手模式直通。此处不检查用户是否选择启用 — 这决定是否应尊重用户的启用选择，而不是用户是否已选择启用。

构建时通过 KAIROS || KAIROS_BRIEF 进行 OR 门控（与 PROACTIVE || KAIROS 模式相同）：助手模式依赖于 Brief，因此仅 KAIROS 也必须捆绑它。KAIROS_BRIEF 允许 Brief 独立发布。

使用此函数来决定是否应尊重 `--brief` / `defaultView: 'chat'` / `--tools` 列表。使用 `isBriefEnabled()` 来决定工具在当前会话中是否实际处于活动状态。

CLAUDE_CODE_BRIEF 环境变量强制授予开发/测试权限 — 绕过 GB 门控，以便您可以在未注册的情况下进行测试。仍然需要用户执行启用操作（--brief、defaultView 等）来激活，但仅设置该环境变量也会通过 maybeActivateBrief() 设置 userMsgOptIn。 */
export function isBriefEntitled(): boolean {
  // 正向三元表达式 — 参见 docs/feature-gating.
  // md。负向提前返回不会从外部构建中消除 GB 门控字符串。
  return feature('KAIROS') || feature('KAIROS_BRIEF')
    ? getKairosActive() ||
        isEnvTruthy(process.env.CLAUDE_CODE_BRIEF) ||
        getFeatureValue_CACHED_WITH_REFRESH(
          'tengu_kairos_brief',
          false,
          KAIROS_BRIEF_REFRESH_MS,
        )
    : false
}

/** Brief 工具的统一激活门控。作为一个单元来管理面向模型的行为：工具可用性、系统提示部分（getBriefSection）、工具延迟绕过（isDeferredTool）以及待办事项提醒抑制。

激活需要明确的用户选择启用（userMsgOptIn），由以下方式之一设置：
  - `--brief` CLI 标志（main.tsx 中的 maybeActivateBrief）
  - 设置中的 `defaultView: 'chat'`（main.tsx 初始化）
  - `/brief` 斜杠命令（brief.ts）
  - `/config` defaultView 选择器（Config.tsx）
  - `--tools` / SDK `tools` 选项中的 SendUserMessage（main.tsx）
  - CLAUDE_CODE_BRIEF 环境变量（maybeActivateBrief — 开发/测试绕过）
助手模式（kairosActive）绕过选择启用，因为其系统提示硬编码了“你必须使用 SendUserMessage”（systemPrompt.md:14）。

此处重新检查 GB 门控，既作为紧急停止开关，也 — 在会话中途关闭 tengu_kairos_brief 会在下一次 5 分钟刷新时禁用该工具，即使对于已选择启用的会话也是如此。未选择启用 → 无论 GB 状态如何，始终为 false（这是修复“已注册蚂蚁默认启用 brief”问题的方案）。

从 Tool.isEnabled()（惰性，初始化后）调用，绝不在模块作用域调用。getKairosActive() 和 getUserMsgOptIn() 在任何调用者到达此处之前已在 main.tsx 中设置。 */
export function isBriefEnabled(): boolean {
  // 顶层的 feature() 守卫对于 DCE（死代码消除）至关重要：B
  // un 可以在外部构建中将三元表达式常量折叠为 `false`，然后消除
  // BriefTool 对象的死代码。仅组合 isBriefEntitl
  // ed()（它有自己的守卫）在语义上是等效的，但会破坏跨边界的常量折叠。
  return feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (getKairosActive() || getUserMsgOptIn()) && isBriefEntitled()
    : false
}

export const BriefTool = buildTool({
  name: BRIEF_TOOL_NAME,
  aliases: [LEGACY_BRIEF_TOOL_NAME],
  searchHint:
    '向用户发送消息 — 您主要的可见输出通道',
  maxResultSizeChars: 100_000,
  userFacingName() {
    return ''
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isBriefEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.message
  },
  async validateInput({ attachments }, _context): Promise<ValidationResult> {
    if (!attachments || attachments.length === 0) {
      return { result: true }
    }
    return validateAttachmentPaths(attachments)
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return BRIEF_TOOL_PROMPT
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const n = output.attachments?.length ?? 0
    const suffix = n === 0 ? '' : `（包含 ${n} ${plural(n, 'attachment')}）`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `消息已送达用户。${suffix}`,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call({ message, attachments, status }, context) {
    const sentAt = new Date().toISOString()
    logEvent('tengu_brief_send', {
      proactive: status === 'proactive',
      attachment_count: attachments?.length ?? 0,
    })
    if (!attachments || attachments.length === 0) {
      return { data: { message, sentAt } }
    }
    const appState = context.getAppState()
    const resolved = await resolveAttachments(attachments, {
      replBridgeEnabled: appState.replBridgeEnabled,
      signal: context.abortController.signal,
    })
    return {
      data: { message, attachments: resolved, sentAt },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
