/**
 * 用于 `auto` 主题设置的终端深色/浅色模式检测。
 *
 * 检测基于终端的真实背景色（`systemThemeWatcher.ts` 通过 OSC 11 查询），而非操作系统外观设置——
 * 即便 OS 为浅色模式，只要终端背景是深色，也应解析为 `dark`。
 *
 * 检测结果在模块级缓存，使调用方解析 `auto` 时无需等待异步 OSC 往返。
 * 缓存先由 `$COLORFGBG`（同步；部分终端启动时会设置）进行初始种子，然后在收到 OSC 11 响应后
 * 由 watcher 更新为准确值。
 */

import type { ThemeName, ThemeSetting } from './theme.js'

export type SystemTheme = 'dark' | 'light'

let cachedSystemTheme: SystemTheme | undefined

/**
 * 获取当前终端主题。首次检测后即缓存；watcher 会在主题实时变化时更新缓存。
 */
export function getSystemThemeName(): SystemTheme {
  if (cachedSystemTheme === undefined) {
    cachedSystemTheme = detectFromColorFgBg() ?? 'dark'
  }
  return cachedSystemTheme
}

/**
 * 更新缓存的终端主题。watcher 在 OSC 11 查询返回时调用，确保非 React 调用方也能保持同步。
 */
export function setCachedSystemTheme(theme: SystemTheme): void {
  cachedSystemTheme = theme
}

/**
 * 将 ThemeSetting（可能为 `auto`）解析为具体 ThemeName。
 */
export function resolveThemeSetting(setting: ThemeSetting): ThemeName {
  if (setting === 'auto') {
    return getSystemThemeName()
  }
  return setting
}

/**
 * 将 OSC 颜色响应的数据字符串解析为主题。
 *
 * 支持 OSC 10/11 查询返回的 XParseColor 格式：
 * - `rgb:R/G/B`：每个分量为 1–4 位十六进制（各自缩放到 \([0, 16^n - 1]\)，n 为位数）。xterm、iTerm2、Terminal.app、
 *   Ghostty、kitty、Alacritty 等通常返回此格式。
 * - `#RRGGBB` / `#RRRRGGGGBBBB`：较少见，但兼容成本很低。
 *
 * 对无法识别的格式返回 undefined，便于调用方回退。
 */
export function themeFromOscColor(data: string): SystemTheme | undefined {
  const rgb = parseOscRgb(data)
  if (!rgb) return undefined
  // ITU-R BT.709 相对亮度；按中点切分：> 0.5 视为浅色。
  const luminance = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b
  return luminance > 0.5 ? 'light' : 'dark'
}

type Rgb = { r: number; g: number; b: number }

function parseOscRgb(data: string): Rgb | undefined {
  // rgb:RRRR/GGGG/BBBB —— 每个分量为 1–4 位十六进制
  // 部分终端会追加 alpha 分量（rgba:…/…/…/…）；忽略即可
  const rgbMatch =
    /^rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(data)
  if (rgbMatch) {
    return {
      r: hexComponent(rgbMatch[1]!),
      g: hexComponent(rgbMatch[2]!),
      b: hexComponent(rgbMatch[3]!),
    }
  }
  // #RRGGBB 或 #RRRRGGGGBBBB —— 拆成三段等长十六进制串
  const hashMatch = /^#([0-9a-f]+)$/i.exec(data)
  if (hashMatch && hashMatch[1]!.length % 3 === 0) {
    const hex = hashMatch[1]!
    const n = hex.length / 3
    return {
      r: hexComponent(hex.slice(0, n)),
      g: hexComponent(hex.slice(n, 2 * n)),
      b: hexComponent(hex.slice(2 * n)),
    }
  }
  return undefined
}

/** 将 1–4 位十六进制分量归一化到 [0, 1]。 */
function hexComponent(hex: string): number {
  const max = 16 ** hex.length - 1
  return parseInt(hex, 16) / max
}

/**
 * 在 OSC 11 往返完成前，读取 `$COLORFGBG` 做一次同步初始猜测。
 * 格式为 `fg;bg`（或 `fg;other;bg`），值为 ANSI 颜色索引。rxvt 约定：bg 为 0–6 或 8 视为深色；
 * bg 为 7 与 9–15 视为浅色。仅部分终端会设置（rxvt 系、Konsole、启用该选项的 iTerm2），
 * 因此只作为尽力提示。
 */
function detectFromColorFgBg(): SystemTheme | undefined {
  const colorfgbg = process.env['COLORFGBG']
  if (!colorfgbg) return undefined
  const parts = colorfgbg.split(';')
  const bg = parts[parts.length - 1]
  if (bg === undefined || bg === '') return undefined
  const bgNum = Number(bg)
  if (!Number.isInteger(bgNum) || bgNum < 0 || bgNum > 15) return undefined
  // 0–6 与 8 为深色 ANSI；7（白）与 9–15（高亮）为浅色。
  return bgNum <= 6 || bgNum === 8 ? 'dark' : 'light'
}
