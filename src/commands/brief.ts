import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getKairosActive, setUserMsgOptIn } from '../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { ToolUseContext } from '../Tool.js'
import { isBriefEntitled } from '@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js'
import { BRIEF_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BriefTool/prompt.js'
import type {
  Command,
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../types/command.js'
import { lazySchema } from '../utils/lazySchema.js'

// Zod 用于防止误操作推送 GB（与 pollConfig.ts / cronS
// cheduler.ts 采用相同模式）。配置格式错误时，会完全回退到 DEFA
// ULT_BRIEF_CONFIG，而不是部分信任。
const briefConfigSchema = lazySchema(() =>
  z.object({
    enable_slash_command: z.boolean(),
  }),
)
type BriefConfig = z.infer<ReturnType<typeof briefConfigSchema>>

const DEFAULT_BRIEF_CONFIG: BriefConfig = {
  enable_slash_command: false,
}

// 无 TTL —— 此开关控制斜杠命令的*可见性*，而非紧急关闭开关。CA
// CHED_MAY_BE_STALE 仍有一次后台更新翻转（首次调用触发获
// 取；第二次调用看到新值），但之后不再有额外翻转。工具可用性开关（isBrie
// fEnabled 中的 tengu_kairos_brief）保持其 5
// 分钟 TTL，因为那才是一个紧急关闭开关。
function getBriefConfig(): BriefConfig {
  const raw = getFeatureValue_CACHED_MAY_BE_STALE<unknown>(
    'tengu_kairos_brief_config',
    DEFAULT_BRIEF_CONFIG,
  )
  const parsed = briefConfigSchema().safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_BRIEF_CONFIG
}

const brief = {
  type: 'local-jsx',
  name: 'brief',
  description: '切换仅简报模式',
  isEnabled: () => {
    if (feature('KAIROS') || feature('KAIROS_BRIEF')) {
      return getBriefConfig().enable_slash_command
    }
    return false
  },
  immediate: true,
  load: () =>
    Promise.resolve({
      async call(
        onDone: LocalJSXCommandOnDone,
        context: ToolUseContext & LocalJSXCommandContext,
      ): Promise<React.ReactNode> {
        const current = context.getAppState().isBriefOnly
        const newState = !current

        // 权限检查仅控制开启转换 —— 关闭始终允许，这
        // 样在会话中途 GB 开关翻转的用户不会被卡住。
        if (newState && !isBriefEntitled()) {
          logEvent('tengu_brief_mode_toggled', {
            enabled: false,
            gated: true,
            source:
              'slash_command' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          onDone('您的账户未启用简报工具', {
            display: 'system',
          })
          return null
        }

        // 双向关联：userMsgOptIn 跟踪 isBri
        // efOnly，确保工具仅在简报模式开启时可用。每次
        // 切换都会使提示缓存失效（工具列表变更），但过时的工具
        // 列表更糟 —— 当会话中途启用 /brief 时，模
        // 型之前没有该工具，会输出过滤器隐藏的纯文本。
        setUserMsgOptIn(newState)

        context.setAppState(prev => {
          if (prev.isBriefOnly === newState) return prev
          return { ...prev, isBriefOnly: newState }
        })

        logEvent('tengu_brief_mode_toggled', {
          enabled: newState,
          gated: false,
          source:
            'slash_command' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })

        // 仅工具列表变更在会话中途的信号不够强（模型可能因惯性继续输出纯文本
        // ，或继续调用刚消失的工具）。在下一轮上下文中注入明确的提醒，使转换
        // 清晰无误。当 Kairos 激活时跳过：isBriefEnable
        // d() 在 getKairosActive()
        // 处短路，因此工具实际上从未离开列表，且 Kairos 系统提示
        // 已强制要求 SendUserMessage。内联 <system
        // -reminder> 包装 —— 从 utils/mess
        // ages.ts 导入 wrapInSystemReminder 会
        // 通过此模块的导入链将 constants/xml.ts 拉入 br
        // idge SDK 包，从而触发 excluded-strings 检查。
        const metaMessages = getKairosActive()
          ? undefined
          : [
              `<system-reminder>
${newState
                  ? `Brief mode is now enabled. Use the ${BRIEF_TOOL_NAME} tool for all user-facing output — plain text outside it is hidden from the user's view.`
                  : `Brief mode is now disabled. The ${BRIEF_TOOL_NAME} tool is no longer available — reply with plain text.`}
</system-reminder>`,
            ]

        onDone(
          newState ? '仅简报模式已启用' : '仅简报模式已禁用',
          { display: 'system', metaMessages },
        )
        return null
      },
    }),
} satisfies Command

export default brief
