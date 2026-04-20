export const AGENT_TOOL_NAME = 'Agent'
// 用于向后兼容的旧版连线名称（权限规则、钩子、恢复的会话）
export const LEGACY_AGENT_TOOL_NAME = 'Task'
export const VERIFICATION_AGENT_TYPE = 'verification'

// 内置代理，运行一次并返回报告——父进程从不通过 SendMessages 回
// 传以继续它们。对于这些代理，跳过 agentId/SendMessage/us
// age 尾部以节省令牌（约 135 字符 × 每周 3400 万次探索运行）。
export const ONE_SHOT_BUILTIN_AGENT_TYPES: ReadonlySet<string> = new Set([
  'Explore',
  'Plan',
])
