import type { SettingSource } from './constants.js'
import type { SettingsJson } from './types.js'
import type { SettingsWithErrors, ValidationError } from './validation.js'

let sessionSettingsCache: SettingsWithErrors | null = null

export function getSessionSettingsCache(): SettingsWithErrors | null {
  return sessionSettingsCache
}

export function setSessionSettingsCache(value: SettingsWithErrors): void {
  sessionSettingsCache = value
}

/** getSettingsForSource 的按源缓存。与合并的 sessionSettingsCache 一同失效——相同的 resetSettingsCache() 触发条件（设置写入、--add-dir、插件初始化、钩子刷新）。 */
const perSourceCache = new Map<SettingSource, SettingsJson | null>()

export function getCachedSettingsForSource(
  source: SettingSource,
): SettingsJson | null | undefined {
  // undefined = 缓存未命中；null = 已缓存“此源无设置”
  return perSourceCache.has(source) ? perSourceCache.get(source) : undefined
}

export function setCachedSettingsForSource(
  source: SettingSource,
  value: SettingsJson | null,
): void {
  perSourceCache.set(source, value)
}

/** parseSettingsFile 的路径键控缓存。getSettingsForSource 和 loadSettingsFromDisk 在启动期间对相同路径调用 parseSettingsFile——此缓存用于去重磁盘读取和 zod 解析。 */
type ParsedSettings = {
  settings: SettingsJson | null
  errors: ValidationError[]
}
const parseFileCache = new Map<string, ParsedSettings>()

export function getCachedParsedFile(path: string): ParsedSettings | undefined {
  return parseFileCache.get(path)
}

export function setCachedParsedFile(path: string, value: ParsedSettings): void {
  parseFileCache.set(path, value)
}

export function resetSettingsCache(): void {
  sessionSettingsCache = null
  perSourceCache.clear()
  parseFileCache.clear()
}

/** 设置级联中的插件设置基础层。pluginLoader 在加载插件后写入此处；loadSettingsFromDisk 将其作为最低优先级的基础层读取。 */
let pluginSettingsBase: Record<string, unknown> | undefined

export function getPluginSettingsBase(): Record<string, unknown> | undefined {
  return pluginSettingsBase
}

export function setPluginSettingsBase(
  settings: Record<string, unknown> | undefined,
): void {
  pluginSettingsBase = settings
}

export function clearPluginSettingsBase(): void {
  pluginSettingsBase = undefined
}
