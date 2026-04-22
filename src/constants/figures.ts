import { env } from '../utils/env.js'

// 前者纵向对齐更好，但在 Windows/Linux 上常无法显示
export const BLACK_CIRCLE = env.platform === 'darwin' ? '⏺' : '●'
export const BULLET_OPERATOR = '∙'
export const TEARDROP_ASTERISK = '✻'
export const UP_ARROW = '\u2191' // ↑ — Opus 1M 合并提示
export const DOWN_ARROW = '\u2193' // ↓ — 滚动提示
export const LIGHTNING_BOLT = '↯' // \u21af — 快速模式指示
export const EFFORT_LOW = '○' // \u25cb — 努力程度：低
export const EFFORT_MEDIUM = '◐' // \u25d0 — 努力程度：中
export const EFFORT_HIGH = '●' // \u25cf — 努力程度：高
export const EFFORT_XHIGH = '⦿' // \u29bf - effort level: xhigh (Opus 4.7 only)
export const EFFORT_MAX = '◉'// \u25c9 — 努力程度：最高（仅 Opus 4.6）

// 媒体/触发器状态指示
export const PLAY_ICON = '\u25b6' // ▶
export const PAUSE_ICON = '\u23f8' // ⏸

// MCP 订阅状态指示
export const REFRESH_ARROW = '\u21bb' // ↻ — 资源更新指示
export const CHANNEL_ARROW = '\u2190' // ← — 频道入站消息
export const INJECTED_ARROW = '\u2192' // → — 跨会话注入消息
export const FORK_GLYPH = '\u2442' // ⑂ — fork 指令指示

// 审查状态（ultrareview 菱形状态）
export const DIAMOND_OPEN = '\u25c7' // ◇ — 运行中
export const DIAMOND_FILLED = '\u25c6' // ◆ — 已完成/失败
export const REFERENCE_MARK = '\u203b' // ※ — 米字标，离开摘要回顾标记

// Issue 旗标指示
export const FLAG_ICON = '\u2691' // ⚑ — issue 旗标横幅

// 引用块竖条
export const BLOCKQUOTE_BAR = '\u258e' // ▎ — 左四分之一块，作引用行前缀
export const HEAVY_HORIZONTAL = '\u2501' // ━ — 粗横线制表

// Bridge 状态指示
export const BRIDGE_SPINNER_FRAMES = [
  '\u00b7|\u00b7',
  '\u00b7/\u00b7',
  '\u00b7\u2014\u00b7',
  '\u00b7\\\u00b7',
]
export const BRIDGE_READY_INDICATOR = '\u00b7\u2714\ufe0e\u00b7'
export const BRIDGE_FAILED_INDICATOR = '\u00d7'
