import { feature } from 'bun:bundle'
import { getRemoteControlAtStartup } from 'src/utils/config.js'
import {
  EDITOR_MODES,
  NOTIFICATION_CHANNELS,
  TEAMMATE_MODES,
} from 'src/utils/configConstants.js'
import { getModelOptions } from 'src/utils/model/modelOptions.js'
import { validateModel } from 'src/utils/model/validateModel.js'
import { THEME_NAMES, THEME_SETTINGS } from 'src/utils/theme.js'

/** 可同步以立即影响UI的AppState键 */
type SyncableAppStateKey = 'verbose' | 'mainLoopModel' | 'thinkingEnabled'

type SettingConfig = {
  source: 'global' | 'settings'
  type: 'boolean' | 'string'
  description: string
  path?: string[]
  options?: readonly string[]
  getOptions?: () => string[]
  appStateKey?: SyncableAppStateKey
  /** 写入/设置值时调用的异步验证 */
  validateOnWrite?: (v: unknown) => Promise<{ valid: boolean; error?: string }>
  /** 读取/获取值时进行格式化以便显示 */
  formatOnRead?: (v: unknown) => unknown
}

export const SUPPORTED_SETTINGS: Record<string, SettingConfig> = {
  theme: {
    source: 'global',
    type: 'string',
    description: 'UI的颜色主题',
    options: feature('AUTO_THEME') ? THEME_SETTINGS : THEME_NAMES,
  },
  editorMode: {
    source: 'global',
    type: 'string',
    description: '按键绑定模式',
    options: EDITOR_MODES,
  },
  verbose: {
    source: 'global',
    type: 'boolean',
    description: '显示详细的调试输出',
    appStateKey: 'verbose',
  },
  preferredNotifChannel: {
    source: 'global',
    type: 'string',
    description: '首选通知渠道',
    options: NOTIFICATION_CHANNELS,
  },
  autoCompactEnabled: {
    source: 'global',
    type: 'boolean',
    description: '上下文已满时自动压缩',
  },
  autoMemoryEnabled: {
    source: 'settings',
    type: 'boolean',
    description: '启用自动内存管理',
  },
  autoDreamEnabled: {
    source: 'settings',
    type: 'boolean',
    description: '启用后台内存整理',
  },
  fileCheckpointingEnabled: {
    source: 'global',
    type: 'boolean',
    description: '为代码回退启用文件检查点',
  },
  showTurnDuration: {
    source: 'global',
    type: 'boolean',
    description:
      '在响应后显示处理时长消息（例如“已处理 1分6秒”）',
  },
  terminalProgressBarEnabled: {
    source: 'global',
    type: 'boolean',
    description: '在支持的终端中显示OSC 9;4进度指示器',
  },
  todoFeatureEnabled: {
    source: 'global',
    type: 'boolean',
    description: '启用待办事项/任务跟踪',
  },
  model: {
    source: 'settings',
    type: 'string',
    description: '覆盖默认模型',
    appStateKey: 'mainLoopModel',
    getOptions: () => {
      try {
        return getModelOptions()
          .filter(o => o.value !== null)
          .map(o => o.value as string)
      } catch {
        return ['sonnet', 'opus', 'haiku']
      }
    },
    validateOnWrite: v => validateModel(String(v)),
    formatOnRead: v => (v === null ? 'default' : v),
  },
  alwaysThinkingEnabled: {
    source: 'settings',
    type: 'boolean',
    description: '启用扩展思考（设为false以禁用）',
    appStateKey: 'thinkingEnabled',
  },
  'permissions.defaultMode': {
    source: 'settings',
    type: 'string',
    description: '工具使用的默认权限模式',
    options: feature('TRANSCRIPT_CLASSIFIER')
      ? ['default', 'plan', 'acceptEdits', 'dontAsk', 'auto']
      : ['default', 'plan', 'acceptEdits', 'dontAsk'],
  },
  language: {
    source: 'settings',
    type: 'string',
    description:
      'Claude响应和语音听写的首选语言（例如“japanese”、“spanish”）',
  },
  teammateMode: {
    source: 'global',
    type: 'string',
    description:
      '如何生成队友："tmux"表示传统tmux，"in-process"表示同一进程，"auto"表示自动选择',
    options: TEAMMATE_MODES,
  },
  ...(process.env.USER_TYPE === 'ant'
    ? {
        classifierPermissionsEnabled: {
          source: 'settings' as const,
          type: 'boolean' as const,
          description:
            '为Bash(prompt:...)权限规则启用基于AI的分类',
        },
      }
    : {}),
  ...(feature('VOICE_MODE')
    ? {
        voiceEnabled: {
          source: 'settings' as const,
          type: 'boolean' as const,
          description: '启用语音听写（按住说话）',
        },
      }
    : {}),
  ...(feature('BRIDGE_MODE')
    ? {
        remoteControlAtStartup: {
          source: 'global' as const,
          type: 'boolean' as const,
          description:
            '为所有会话启用远程控制（true | false | default）',
          formatOnRead: () => getRemoteControlAtStartup(),
        },
      }
    : {}),
  ...(feature('KAIROS') || feature('KAIROS_PUSH_NOTIFICATION')
    ? {
        taskCompleteNotifEnabled: {
          source: 'global' as const,
          type: 'boolean' as const,
          description:
            'Claude完成后，在空闲时推送到您的移动设备（需要远程控制）',
        },
        inputNeededNotifEnabled: {
          source: 'global' as const,
          type: 'boolean' as const,
          description:
            '当权限提示或问题等待时，推送到您的移动设备（需要远程控制）',
        },
        agentPushNotifEnabled: {
          source: 'global' as const,
          type: 'boolean' as const,
          description:
            '允许Claude在认为适当时推送到您的移动设备（需要远程控制）',
        },
      }
    : {}),
}

export function isSupported(key: string): boolean {
  return key in SUPPORTED_SETTINGS
}

export function getConfig(key: string): SettingConfig | undefined {
  return SUPPORTED_SETTINGS[key]
}

export function getAllKeys(): string[] {
  return Object.keys(SUPPORTED_SETTINGS)
}

export function getOptionsForSetting(key: string): string[] | undefined {
  const config = SUPPORTED_SETTINGS[key]
  if (!config) return undefined
  if (config.options) return [...config.options]
  if (config.getOptions) return config.getOptions()
  return undefined
}

export function getPath(key: string): string[] {
  const config = SUPPORTED_SETTINGS[key]
  return config?.path ?? key.split('.')
}
