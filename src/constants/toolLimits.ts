/**
 * 与工具结果体积限制相关的常量
 */

/**
 * 工具结果落盘前的默认最大字符数。超过后结果写入文件，
 * 模型仅收到带路径的预览而非全文。
 *
 * 各工具可声明更低的 maxResultSizeChars，但本常量作为全系统上限。
 */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000

/**
 * 工具结果的 token 上限。
 * 根据结果体积分析设定合理上界，避免过大结果占用过多上下文。
 *
 * 约合 400KB 文本（按每 token 约 4 字节估算）。
 */
export const MAX_TOOL_RESULT_TOKENS = 100_000

/**
 * 从字节数估算 token 时的「每 token 字节数」保守值，实际 token 数可能不同。
 */
export const BYTES_PER_TOKEN = 4

/**
 * 工具结果最大字节数（由 token 上限推导）。
 */
export const MAX_TOOL_RESULT_BYTES = MAX_TOOL_RESULT_TOKENS * BYTES_PER_TOKEN

/**
 * 单条用户消息内 tool_result 块合计的默认最大字符数（同一回合并行工具结果一批）。
 * 超出时将该消息中最大的若干块落盘并替换为预览，直至低于预算。
 * 各条消息独立计算 —— 上一回合 150K 与下一回合 150K 互不影响。
 *
 * 避免 N 个并行工具各自顶满单工具上限，在一回合内凑出例如 10×40K=400K。
 *
 * 运行时可由 GrowthBook 标志 tengu_hawthorn_window 覆盖，见 toolResultStorage.ts 的 getPerMessageBudgetLimit()。
 */
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000

/**
 * 紧凑视图中工具摘要字符串的最大字符长度。
 * 供 getToolUseSummary() 实现截断长输入，用于分组代理渲染。
 */
export const TOOL_SUMMARY_MAX_LENGTH = 50
