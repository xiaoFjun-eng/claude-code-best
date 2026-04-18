import { randomUUID } from 'crypto'
import { queryModelWithStreaming } from '../services/api/claude.js'
import { autoCompactIfNeeded } from '../services/compact/autoCompact.js'
import { microcompactMessages } from '../services/compact/microCompact.js'

// -- 依赖项

// query() 的 I/O 依赖项。将 `deps` 覆盖传递给 QueryPa
// rams 允许测试直接注入模拟对象，而无需每个模块都使用 spyOn —— 目
// 前最常见的模拟对象（callModel、autocompact）在 6-8 个
// 测试文件中都需要模块导入和 spy 的样板代码。
//
// 使用 `typeof fn` 可以自动保持签名与真实
// 实现同步。此文件导入真实函数既用于类型定义也用于生产
// 工厂 —— 为类型定义导入此文件的测试已经导入了
// query.ts（它导入了所有内容），因此不会产生
// 新的模块图开销。
//
// 范围有意保持狭窄（4 个依赖项）以验证此模式。后续的 PR 可以添加 runT
// ools、handleStopHooks、logEvent、队列操作等。
export type QueryDeps = {
  // -- 模型
  callModel: typeof queryModelWithStreaming

  // -- 压缩
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded

  // -- 平台
  uuid: () => string
}

export function productionDeps(): QueryDeps {
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}
