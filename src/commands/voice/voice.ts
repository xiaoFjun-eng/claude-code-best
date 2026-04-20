import { normalizeLanguageForSTT } from '../../hooks/useVoice.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { logEvent } from '../../services/analytics/index.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isAnthropicAuthEnabled } from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { isVoiceModeEnabled } from '../../voice/voiceModeEnabled.js'

const LANG_HINT_MAX_SHOWS = 2

export const call: LocalCommandCall = async () => {
  // 在允许语音模式前，检查身份验证和紧急停止开关
  if (!isVoiceModeEnabled()) {
    // 区分处理：无 OAuth 用户会收到身份验证提示，
    // 其他用户则无提示（当紧急停止开关开启时，不应能访问此命令）。
    if (!isAnthropicAuthEnabled()) {
      return {
        type: 'text' as const,
        value:
          '语音模式需要 Claude.ai 账户。请运行 /login 登录。',
      }
    }
    return {
      type: 'text' as const,
      value: '语音模式不可用。',
    }
  }

  const currentSettings = getInitialSettings()
  const isCurrentlyEnabled = currentSettings.voiceEnabled === true

  // 切换为 OFF — 无需检查
  if (isCurrentlyEnabled) {
    const result = updateSettingsForSource('userSettings', {
      voiceEnabled: false,
    })
    if (result.error) {
      return {
        type: 'text' as const,
        value:
          '更新设置失败。请检查设置文件中的语法错误。',
      }
    }
    settingsChangeDetector.notifyChange('userSettings')
    logEvent('tengu_voice_toggled', { enabled: false })
    return {
      type: 'text' as const,
      value: '语音模式已禁用。',
    }
  }

  // 切换为 ON — 首先运行预检
  const { isVoiceStreamAvailable } = await import(
    '../../services/voiceStreamSTT.js'
  )
  const { checkRecordingAvailability } = await import('../../services/voice.js')

  // 检查录音可用性（麦克风访问权限）
  const recording = await checkRecordingAvailability()
  if (!recording.available) {
    return {
      type: 'text' as const,
      value:
        recording.reason ?? '在此环境中语音模式不可用。',
    }
  }

  // 检查 API 密钥
  if (!isVoiceStreamAvailable()) {
    return {
      type: 'text' as const,
      value:
        '语音模式需要 Claude.ai 账户。请运行 /login 登录。',
    }
  }

  // 检查录音工具
  const { checkVoiceDependencies, requestMicrophonePermission } = await import(
    '../../services/voice.js'
  )
  const deps = await checkVoiceDependencies()
  if (!deps.available) {
    const hint = deps.installCommand
      ? `
是否安装音频录制工具？运行：${deps.installCommand}`
      : '\n请手动安装 SoX 以进行音频录制。'
    return {
      type: 'text' as const,
      value: `未找到音频录制工具。${hint}`,
    }
  }

  // 探测麦克风访问权限，以便操作系统权限对话框现在弹出
  // ，而不是在用户首次按住说话时触发。
  if (!(await requestMicrophonePermission())) {
    let guidance: string
    if (process.platform === 'win32') {
      guidance = '设置 → 隐私 → 麦克风'
    } else if (process.platform === 'linux') {
      guidance = "您系统的音频设置"
    } else {
      guidance = '系统设置 → 隐私与安全 → 麦克风'
    }
    return {
      type: 'text' as const,
      value: `麦克风访问被拒绝。要启用它，请前往 ${guidance}，然后再次运行 /voice。`,
    }
  }

  // 所有检查通过 — 启用语音
  const result = updateSettingsForSource('userSettings', { voiceEnabled: true })
  if (result.error) {
    return {
      type: 'text' as const,
      value:
        '更新设置失败。请检查设置文件中的语法错误。',
    }
  }
  settingsChangeDetector.notifyChange('userSettings')
  logEvent('tengu_voice_toggled', { enabled: true })
  const key = getShortcutDisplay('voice:pushToTalk', 'Chat', 'Space')
  const stt = normalizeLanguageForSTT(currentSettings.language)
  const cfg = getGlobalConfig()
  // 每当解析出的 STT 语言发生变化时（包括首次启用时，此
  // 时 lastLanguage 未定义），重置提示计数器。
  const langChanged = cfg.voiceLangHintLastLanguage !== stt.code
  const priorCount = langChanged ? 0 : (cfg.voiceLangHintShownCount ?? 0)
  const showHint = !stt.fellBackFrom && priorCount < LANG_HINT_MAX_SHOWS
  let langNote = ''
  if (stt.fellBackFrom) {
    langNote = ` 注意："${stt.fellBackFrom}" 不是支持的听写语言；将使用英语。可通过 /config 更改。`
  } else if (showHint) {
    langNote = ` 听写语言：${stt.code}（可通过 /config 更改）。`
  }
  if (langChanged || showHint) {
    saveGlobalConfig(prev => ({
      ...prev,
      voiceLangHintShownCount: priorCount + (showHint ? 1 : 0),
      voiceLangHintLastLanguage: stt.code,
    }))
  }
  return {
    type: 'text' as const,
    value: `语音模式已启用。按住 ${key} 进行录音。${langNote}`,
  }
}
