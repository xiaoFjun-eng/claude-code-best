// 系统提示的品牌化类
// 型。无依赖设计，可从任何位置导入，避免循环依赖问题。

export type SystemPrompt = readonly string[] & {
  readonly __brand: 'SystemPrompt'
}

export function asSystemPrompt(value: readonly string[]): SystemPrompt {
  return value as SystemPrompt
}
