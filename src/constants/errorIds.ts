/**
 * 生产环境用于追踪错误来源的错误 ID。
 * 为混淆后的标识符，便于定位是哪一处 logError() 产生错误。
 *
 * 以独立 const 导出，便于死代码消除（外部构建仅保留数字字面量）。
 *
 * 新增错误类型步骤：
 * 1. 按 Next ID 新增 const。
 * 2. 将 Next ID 加一。
 * Next ID: 346
 */

export const E_TOOL_USE_SUMMARY_GENERATION_FAILED = 344
