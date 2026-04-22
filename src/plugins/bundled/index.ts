/**
 * 内置插件初始化
 *
 * 初始化随 CLI 一同发布的内置插件，这些插件会出现在 /plugin UI 中，
 * 供用户启用/禁用。
 *
 * 并非所有打包功能都应作为内置插件 —— 仅当功能需要用户显式启用/禁用时才使用此方式。
 * 对于设置复杂或具有自动启用逻辑的功能（例如 claude-in-chrome），应使用 src/skills/bundled/。
 *
 * 要添加新的内置插件：
 * 1. 从 '../builtinPlugins.js' 导入 registerBuiltinPlugin
 * 2. 在此处调用 registerBuiltinPlugin() 并传入插件定义
 */

import { registerWeixinBuiltinPlugin } from './weixin.js'

/**
 * 初始化内置插件。在 CLI 启动时调用。
 */
export function initBuiltinPlugins(): void {
  registerWeixinBuiltinPlugin()
}