import type { LocalCommandCall } from '../../types/command.js'
import { isPoorModeActive, setPoorMode } from './poorMode.js'

export const call: LocalCommandCall = async (_, context) => {
  const currentlyActive = isPoorModeActive()
  const newState = !currentlyActive
  setPoorMode(newState)

  if (newState) {
    // 在 AppState 中禁用提示建议
    context.setAppState(prev => ({
      ...prev,
      promptSuggestionEnabled: false,
    }))
  } else {
    // 重新启用提示建议
    context.setAppState(prev => ({
      ...prev,
      promptSuggestionEnabled: true,
    }))
  }

  const status = newState ? 'ON' : 'OFF'
  const details = newState
    ? 'extract_memories 和 prompt_suggestion 已禁用'
    : 'extract_memories 和 prompt_suggestion 已恢复'
  return { type: 'text', value: `差劲的模式 ${status} — ${details}` }
}
