import {
  clearBetaHeaderLatches,
  clearSystemPromptSectionState,
  getSystemPromptSectionCache,
  setSystemPromptSectionCacheEntry,
} from '../bootstrap/state.js'

type ComputeFn = () => string | null | Promise<string | null>

type SystemPromptSection = {
  name: string
  compute: ComputeFn
  cacheBreak: boolean
}

/**
 * 创建带记忆化的系统提示片段。
 * 计算一次，缓存至执行 /clear 或 /compact。
 */
export function systemPromptSection(
  name: string,
  compute: ComputeFn,
): SystemPromptSection {
  return { name, compute, cacheBreak: false }
}

/**
 * 创建每回合重算的易变系统提示片段。
 * 值变化时会破坏提示缓存。
 * 须提供 _reason 说明为何必须打破缓存。
 */
export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: ComputeFn,
  _reason: string,
): SystemPromptSection {
  return { name, compute, cacheBreak: true }
}

/**
 * 解析全部系统提示片段，返回提示字符串数组。
 */
export async function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<(string | null)[]> {
  const cache = getSystemPromptSectionCache()

  return Promise.all(
    sections.map(async s => {
      if (!s.cacheBreak && cache.has(s.name)) {
        return cache.get(s.name) ?? null
      }
      const value = await s.compute()
      setSystemPromptSectionCacheEntry(s.name, value)
      return value
    }),
  )
}

/**
 * 清空系统提示片段状态。在 /clear 与 /compact 时调用。
 * 同时重置 beta 头闩锁，使新会话重新评估 AFK/快速模式/缓存编辑等头。
 */
export function clearSystemPromptSections(): void {
  clearSystemPromptSectionState()
  clearBetaHeaderLatches()
}
