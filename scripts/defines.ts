/**
 * 由 dev.ts（运行时 -d 标志）和 build.ts（Bun.build define 选项）
 * 共享的 MACRO 定义映射。
 *
 * 每个值都是一个 JSON 字符串化的表达式，在转译/打包时会替换对应的
 * MACRO.* 标识符。
 */
export function getMacroDefines(): Record<string, string> {
    return {
        "MACRO.VERSION": JSON.stringify("2.1.888"),
        "MACRO.BUILD_TIME": JSON.stringify(new Date().toISOString()),
        "MACRO.FEEDBACK_CHANNEL": JSON.stringify(""),
        "MACRO.ISSUES_EXPLAINER": JSON.stringify(""),
        "MACRO.NATIVE_PACKAGE_URL": JSON.stringify(""),
        "MACRO.PACKAGE_URL": JSON.stringify(""),
        "MACRO.VERSION_CHANGELOG": JSON.stringify(""),
    };
}

/**
 * Bun.build 和 Vite 构建中默认启用的功能标志。
 * 可以通过 FEATURE_<NAME>=1 环境变量启用额外功能。
 *
 * 用于：
 *   - build.ts（Bun.build）
 *   - scripts/vite-plugin-feature-flags.ts（Vite/Rollup）
 *   - scripts/dev.ts（bun run dev）
 */
export const DEFAULT_BUILD_FEATURES = [
    'BUDDY', 'TRANSCRIPT_CLASSIFIER', 'BRIDGE_MODE',
    'AGENT_TRIGGERS_REMOTE',
    'CHICAGO_MCP',
    'VOICE_MODE',
    'SHOT_STATS',
    'PROMPT_CACHE_BREAK_DETECTION',
    'TOKEN_BUDGET',
    // P0：本地功能
    'AGENT_TRIGGERS',
    'ULTRATHINK',
    'BUILTIN_EXPLORE_PLAN_AGENTS',
    'LODESTONE',
    // P1：依赖 API 的功能
    'EXTRACT_MEMORIES',
    'VERIFICATION_AGENT',
    'KAIROS_BRIEF',
    'AWAY_SUMMARY',
    'ULTRAPLAN',
    // P2：守护进程 + 远程控制服务器
    'DAEMON',
    // ACP（Agent Client Protocol，代理客户端协议）代理模式
    'ACP',
    // 从 PR 包中恢复的功能
    'WORKFLOW_SCRIPTS',
    'HISTORY_SNIP',
    'CONTEXT_COLLAPSE',
    'MONITOR_TOOL',
    'FORK_SUBAGENT',
    // 'UDS_INBOX',
    'KAIROS',
    'COORDINATOR_MODE',
    'LAN_PIPES',
    'BG_SESSIONS',
    'TEMPLATES',
    // 'REVIEW_ARTIFACT', // API 请求无响应，需进一步排查 schema 兼容性
    // P3：穷鬼模式（禁用 extract_memories + prompt_suggestion）
    'POOR',
] as const;