/**
 * Anthropic API 限制
 *
 * 以下常量为 Anthropic API 在服务端强制执行的限制。
 * 本文件保持无外部依赖，以避免循环引用。
 *
 * 最近核对：2025-12-22
 * 来源：api/api/schemas/messages/blocks/ 与 api/api/config.py
 *
 * 后续：见 issue #13240，计划从服务端动态拉取限制。
 */

// =============================================================================
// 图片限制
// =============================================================================

/**
 * Base64 编码图片的最大长度（API 强制）。
 * 超过此 base64 字符串长度会被 API 拒绝。
 * 注意：此为 base64 长度，非原始字节；Base64 体积约增加 ~33%。
 */
export const API_IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024 // 5 MB

/**
 * 编码后仍低于 base64 上限的目标原始图片大小。
 * Base64 将大小放大为 4/3，故最大原始大小为：
 * raw_size * 4/3 = base64_size → raw_size = base64_size * 3/4
 */
export const IMAGE_TARGET_RAW_SIZE = (API_IMAGE_MAX_BASE64_SIZE * 3) / 4 // 3.75 MB

/**
 * 客户端缩放图片时的最大宽高。
 *
 * 说明：API 内部会将大于 1568px 的图片缩放（见 encoding/full_encoding.py），
 * 在服务端处理且不会报错。客户端 2000px 略大，以便在合适时保留画质。
 *
 * API_IMAGE_MAX_BASE64_SIZE（5MB）才是超限时真正触发 API 错误的硬限制。
 */
export const IMAGE_MAX_WIDTH = 2000
export const IMAGE_MAX_HEIGHT = 2000

// =============================================================================
// PDF 限制
// =============================================================================

/**
 * 编码后仍能落在 API 单次请求限制内的 PDF 原始最大体积。
 * API 总请求体上限 32MB；Base64 约放大 4/3，故 20MB 原始约 27MB base64，为对话上下文留余量。
 */
export const PDF_TARGET_RAW_SIZE = 20 * 1024 * 1024 // 20 MB

/**
 * API 接受的 PDF 最大页数。
 */
export const API_PDF_MAX_PAGES = 100

/**
 * 超过此大小时，PDF 会按页抽成图片发送，而不再作为 base64 文档块。
 * 仅适用于一方 API；非一方始终走抽取路径。
 */
export const PDF_EXTRACT_SIZE_THRESHOLD = 3 * 1024 * 1024 // 3 MB

/**
 * 按页抽取路径允许的最大 PDF 体积；更大则拒绝，避免处理超大文件。
 */
export const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024 // 100 MB

/**
 * Read 工具在单次调用中使用 pages 参数时最多抽取的页数。
 */
export const PDF_MAX_PAGES_PER_READ = 20

/**
 * 页数超过此值的 PDF 在 @ 提及时按引用处理，不再内联进上下文。
 */
export const PDF_AT_MENTION_INLINE_THRESHOLD = 10

// =============================================================================
// 媒体（综合）限制
// =============================================================================

/**
 * 单次 API 请求允许的媒体项（图片 + PDF）数量上限。
 * 超出时 API 会返回费解错误；客户端预先校验以给出明确提示。
 */
export const API_MAX_MEDIA_PER_REQUEST = 100
