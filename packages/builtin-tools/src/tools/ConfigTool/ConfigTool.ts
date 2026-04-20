import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import {
  type GlobalConfig,
  getGlobalConfig,
  getRemoteControlAtStartup,
  saveGlobalConfig,
} from 'src/utils/config.js'
import { errorMessage } from 'src/utils/errors.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { logError } from 'src/utils/log.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from 'src/utils/settings/settings.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { CONFIG_TOOL_NAME } from './constants.js'
import { DESCRIPTION, generatePrompt } from './prompt.js'
import {
  getConfig,
  getOptionsForSetting,
  getPath,
  isSupported,
} from './supportedSettings.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    setting: z
      .string()
      .describe(
        '设置项的键名（例如 "theme"、"model"、"permissions.defaultMode"）',
      ),
    value: z
      .union([z.string(), z.boolean(), z.number()])
      .optional()
      .describe('新值。省略此参数则获取当前值。'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    operation: z.enum(['get', 'set']).optional(),
    setting: z.string().optional(),
    value: z.unknown().optional(),
    previousValue: z.unknown().optional(),
    newValue: z.unknown().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Input = z.infer<InputSchema>
export type Output = z.infer<OutputSchema>

export const ConfigTool = buildTool({
  name: CONFIG_TOOL_NAME,
  searchHint: '获取或设置 Claude Code 配置（主题、模型）',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return generatePrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Config'
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return true
  },
  isReadOnly(input: Input) {
    return input.value === undefined
  },
  toAutoClassifierInput(input) {
    return input.value === undefined
      ? input.setting
      : `${input.setting} = ${input.value}`
  },
  async checkPermissions(input: Input) {
    // 自动允许读取配置
    if (input.value === undefined) {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    return {
      behavior: 'ask' as const,
      message: `将 ${input.setting} 设置为 ${jsonStringify(input.value)}`,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  async call({ setting, value }: Input, context): Promise<{ data: Output }> {
    // 1. 检查设置项是否受支持。语
    // 音设置是在构建时注册的（feature('VOICE_MODE')
    // ），但也必须在运行时进行门控。当紧急开关开启时，将 voic
    // eEnabled 视为未知设置，以避免泄露任何语音相关的字符串。
    if (feature('VOICE_MODE') && setting === 'voiceEnabled') {
      const { isVoiceGrowthBookEnabled } = await import(
        'src/voice/voiceModeEnabled.js'
      )
      if (!isVoiceGrowthBookEnabled()) {
        return {
          data: { success: false, error: `未知设置项："${setting}"` },
        }
      }
    }
    if (!isSupported(setting)) {
      return {
        data: { success: false, error: `未知设置项："${setting}"` },
      }
    }

    const config = getConfig(setting)!
    const path = getPath(setting)

    // 2. GET 操作
    if (value === undefined) {
      const currentValue = getValue(config.source, path)
      const displayValue = config.formatOnRead
        ? config.formatOnRead(currentValue)
        : currentValue
      return {
        data: { success: true, operation: 'get', setting, value: displayValue },
      }
    }

    // 3. SET 操作

    // 处理 "default" 值 —— 取消设置该配置键
    // ，使其回退到平台感知的默认值（由桥接功能门决定）。
    if (
      setting === 'remoteControlAtStartup' &&
      typeof value === 'string' &&
      value.toLowerCase().trim() === 'default'
    ) {
      saveGlobalConfig(prev => {
        if (prev.remoteControlAtStartup === undefined) return prev
        const next = { ...prev }
        delete next.remoteControlAtStartup
        return next
      })
      const resolved = getRemoteControlAtStartup()
      // 同步到 AppState，以便 useReplBridge 能立即响应
      context.setAppState(prev => {
        if (prev.replBridgeEnabled === resolved && !prev.replBridgeOutboundOnly)
          return prev
        return {
          ...prev,
          replBridgeEnabled: resolved,
          replBridgeOutboundOnly: false,
        }
      })
      return {
        data: {
          success: true,
          operation: 'set',
          setting,
          value: resolved,
        },
      }
    }

    let finalValue: unknown = value

    // 强制转换并验证布尔值
    if (config.type === 'boolean') {
      if (typeof value === 'string') {
        const lower = value.toLowerCase().trim()
        if (lower === 'true') finalValue = true
        else if (lower === 'false') finalValue = false
      }
      if (typeof finalValue !== 'boolean') {
        return {
          data: {
            success: false,
            operation: 'set',
            setting,
            error: `${setting} 需要 true 或 false。`,
          },
        }
      }
    }

    // 检查选项
    const options = getOptionsForSetting(setting)
    if (options && !options.includes(String(finalValue))) {
      return {
        data: {
          success: false,
          operation: 'set',
          setting,
          error: `无效值 "${value}"。可选值：${options.join(', ')}`,
        },
      }
    }

    // 异步验证（例如，模型 API 检查）
    if (config.validateOnWrite) {
      const result = await config.validateOnWrite(finalValue)
      if (!result.valid) {
        return {
          data: {
            success: false,
            operation: 'set',
            setting,
            error: result.error,
          },
        }
      }
    }

    // 语音模式的预检
    if (
      feature('VOICE_MODE') &&
      setting === 'voiceEnabled' &&
      finalValue === true
    ) {
      const { isVoiceModeEnabled } = await import(
        'src/voice/voiceModeEnabled.js'
      )
      if (!isVoiceModeEnabled()) {
        const { isAnthropicAuthEnabled } = await import('src/utils/auth.js')
        return {
          data: {
            success: false,
            error: !isAnthropicAuthEnabled()
              ? '语音模式需要 Claude.ai 账户。请运行 /login 登录。'
              : '语音模式不可用。',
          },
        }
      }
      const { isVoiceStreamAvailable } = await import(
        'src/services/voiceStreamSTT.js'
      )
      const {
        checkRecordingAvailability,
        checkVoiceDependencies,
        requestMicrophonePermission,
      } = await import('src/services/voice.js')

      const recording = await checkRecordingAvailability()
      if (!recording.available) {
        return {
          data: {
            success: false,
            error:
              recording.reason ??
              '语音模式在此环境中不可用。',
          },
        }
      }
      if (!isVoiceStreamAvailable()) {
        return {
          data: {
            success: false,
            error:
              '语音模式需要 Claude.ai 账户。请运行 /login 登录。',
          },
        }
      }
      const deps = await checkVoiceDependencies()
      if (!deps.available) {
        return {
          data: {
            success: false,
            error:
              '未找到音频录制工具。' +
              (deps.installCommand ? ` Run: ${deps.installCommand}` : ''),
          },
        }
      }
      if (!(await requestMicrophonePermission())) {
        let guidance: string
        if (process.platform === 'win32') {
          guidance = '设置 → 隐私 → 麦克风'
        } else if (process.platform === 'linux') {
          guidance = "您系统的音频设置"
        } else {
          guidance =
            '系统设置 → 隐私与安全性 → 麦克风'
        }
        return {
          data: {
            success: false,
            error: `麦克风访问被拒绝。要启用它，请前往 ${guidance}，然后重试。`,
          },
        }
      }
    }

    const previousValue = getValue(config.source, path)

    // 4. 写入存储
    try {
      if (config.source === 'global') {
        const key = path[0]
        if (!key) {
          return {
            data: {
              success: false,
              operation: 'set',
              setting,
              error: '无效的设置路径',
            },
          }
        }
        saveGlobalConfig(prev => {
          if (prev[key as keyof GlobalConfig] === finalValue) return prev
          return { ...prev, [key]: finalValue }
        })
      } else {
        const update = buildNestedObject(path, finalValue)
        const result = updateSettingsForSource('userSettings', update)
        if (result.error) {
          return {
            data: {
              success: false,
              operation: 'set',
              setting,
              error: result.error.message,
            },
          }
        }
      }

      // 5a. 语音模式需要 notifyChange，以便 applySettingsChange
      // 重新同步 AppState.settings（useVoiceEnabled 会读取 setti
      // ngs.voiceEnabled），并且设置缓存会为下一次 /voice 读取而重置。
      if (feature('VOICE_MODE') && setting === 'voiceEnabled') {
        const { settingsChangeDetector } = await import(
          'src/utils/settings/changeDetector.js'
        )
        settingsChangeDetector.notifyChange('userSettings')
      }

      // 5b. 若需立即更新界面效果，则同步至 AppState
      if (config.appStateKey) {
        const appKey = config.appStateKey
        context.setAppState(prev => {
          if (prev[appKey] === finalValue) return prev
          return { ...prev, [appKey]: finalValue }
        })
      }

      // 将 remoteControlAtStartup 同步到 AppS
      // tate，以便桥接层能立即响应（配置键名与 AppState 字段名不同
      // ，因此通用的 appStateKey 机制无法处理这种情况）。
      if (setting === 'remoteControlAtStartup') {
        const resolved = getRemoteControlAtStartup()
        context.setAppState(prev => {
          if (
            prev.replBridgeEnabled === resolved &&
            !prev.replBridgeOutboundOnly
          )
            return prev
          return {
            ...prev,
            replBridgeEnabled: resolved,
            replBridgeOutboundOnly: false,
          }
        })
      }

      logEvent('tengu_config_tool_changed', {
        setting:
          setting as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        value: String(
          finalValue,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      return {
        data: {
          success: true,
          operation: 'set',
          setting,
          previousValue,
          newValue: finalValue,
        },
      }
    } catch (error) {
      logError(error)
      return {
        data: {
          success: false,
          operation: 'set',
          setting,
          error: errorMessage(error),
        },
      }
    }
  },
  mapToolResultToToolResultBlockParam(content: Output, toolUseID: string) {
    if (content.success) {
      if (content.operation === 'get') {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result' as const,
          content: `${content.setting} = ${jsonStringify(content.value)}`,
        }
      }
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `将 ${content.setting} 设置为 ${jsonStringify(content.newValue)}`,
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: `Error: ${content.error}`,
      is_error: true,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

function getValue(source: 'global' | 'settings', path: string[]): unknown {
  if (source === 'global') {
    const config = getGlobalConfig()
    const key = path[0]
    if (!key) return undefined
    return config[key as keyof GlobalConfig]
  }
  const settings = getInitialSettings()
  let current: unknown = settings
  for (const key of path) {
    if (current && typeof current === 'object' && key in current) {
      current = (current as Record<string, unknown>)[key]
    } else {
      return undefined
    }
  }
  return current
}

function buildNestedObject(
  path: string[],
  value: unknown,
): Record<string, unknown> {
  if (path.length === 0) {
    return {}
  }
  const key = path[0]!
  if (path.length === 1) {
    return { [key]: value }
  }
  return { [key]: buildNestedObject(path.slice(1), value) }
}
