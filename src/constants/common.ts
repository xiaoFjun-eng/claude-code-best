import memoize from 'lodash-es/memoize.js'

// 确保得到本地时区下的 ISO 格式日期
export function getLocalISODate(): string {
  // 仅 ant 构建可用的日期覆盖
  if (process.env.CLAUDE_CODE_OVERRIDE_DATE) {
    return process.env.CLAUDE_CODE_OVERRIDE_DATE
  }

  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// 为稳定提示缓存而记忆化 —— 在会话开始时固定日期一次。
// 主交互路径通过 context.ts 中的 memoize(getUserContext) 获得相同效果；
// 简易模式（--bare）按请求调用 getSystemPrompt，需显式记忆化日期，
// 以免午夜时缓存前缀失效。跨日时 getDateChangeAttachments 在尾部追加新日期
//（简易模式关闭附件时，权衡为：午夜后日期略旧 vs. 整段会话缓存失效 —— 取前者）。
export const getSessionStartDate = memoize(getLocalISODate)

// 返回用户本地时区的「月份 年份」（如「2026年2月」）。
// 按月变化而非按日 —— 用于工具提示词以减少缓存失效。
export function getLocalMonthYear(): string {
  const date = process.env.CLAUDE_CODE_OVERRIDE_DATE
    ? new Date(process.env.CLAUDE_CODE_OVERRIDE_DATE)
    : new Date()
  return date.toLocaleString('zh-CN', { month: 'long', year: 'numeric' })
}
