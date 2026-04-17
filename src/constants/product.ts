export const PRODUCT_URL = 'https://claude.com/claude-code'

// Claude Code 远程会话 URL
export const CLAUDE_AI_BASE_URL = 'https://claude.ai'
export const CLAUDE_AI_STAGING_BASE_URL = 'https://claude-ai.staging.ant.dev'
export const CLAUDE_AI_LOCAL_BASE_URL = 'http://localhost:4000'

/**
 * 判断远程会话是否处于预发（staging）环境。
 * 检查会话 ID 格式与入口 URL。
 */
export function isRemoteSessionStaging(
  sessionId?: string,
  ingressUrl?: string,
): boolean {
  return (
    sessionId?.includes('_staging_') === true ||
    ingressUrl?.includes('staging') === true
  )
}

/**
 * 判断远程会话是否处于本地开发环境。
 * 检查会话 ID 格式（如 `session_local_...`）与入口 URL。
 */
export function isRemoteSessionLocal(
  sessionId?: string,
  ingressUrl?: string,
): boolean {
  return (
    sessionId?.includes('_local_') === true ||
    ingressUrl?.includes('localhost') === true
  )
}

/**
 * 按环境返回 Claude AI 的基础 URL。
 */
export function getClaudeAiBaseUrl(
  sessionId?: string,
  ingressUrl?: string,
): string {
  if (isRemoteSessionLocal(sessionId, ingressUrl)) {
    return CLAUDE_AI_LOCAL_BASE_URL
  }
  if (isRemoteSessionStaging(sessionId, ingressUrl)) {
    return CLAUDE_AI_STAGING_BASE_URL
  }
  return CLAUDE_AI_BASE_URL
}

/**
 * 获取远程会话的完整会话 URL。
 *
 * cse_→session_ 的转换是由 tengu_bridge_repl_v2_cse_shim_enabled 控制的临时垫片
 *（见 isCseShimEnabled）。Worker 端点（/v1/code/sessions/{id}/worker/*）期望 `cse_*`，
 * 而 claude.ai 前端当前按 `session_*` 路由（compat/convert.go:27 校验 TagSession）。
 * UUID 主体相同，标签前缀不同。待服务端按 environment_kind 打标且前端直接接受 `cse_*`
 * 后即可关闭该开关。已是 `session_*` 形式的 ID 不受影响。规范实现见
 * src/bridge/sessionIdCompat.ts 的 toCompatSessionId（此处懒加载 require，
 * 以保持 constants/ 在模块加载时处于 DAG 叶节点）。
 */
export function getRemoteSessionUrl(
  sessionId: string,
  ingressUrl?: string,
): string {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { toCompatSessionId } =
    require('../bridge/sessionIdCompat.js') as typeof import('../bridge/sessionIdCompat.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const compatId = toCompatSessionId(sessionId)
  const baseUrl = getClaudeAiBaseUrl(compatId, ingressUrl)
  return `${baseUrl}/code/${compatId}`
}
