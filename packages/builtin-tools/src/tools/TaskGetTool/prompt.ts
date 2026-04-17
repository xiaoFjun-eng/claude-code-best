export const DESCRIPTION = '根据 ID 从任务列表中获取任务'

export const PROMPT = `使用此工具通过任务 ID 从任务列表中获取任务。

## 何时使用

- 在开始某个任务前，需要查看完整描述与上下文时
- 需要理解任务依赖关系（它阻塞什么、被什么阻塞）时
- 当你被分配了任务，需要获取完整需求时

## 输出

返回任务完整详情：
- **subject**：任务标题
- **description**：详细需求与上下文
- **status**：'pending'、'in_progress' 或 'completed'
- **blocks**：等待该任务完成后才能开始的任务
- **blockedBy**：该任务开始前必须先完成的任务

## 提示

- 获取任务后，开始工作前先确认它的 blockedBy 列表为空。
- 使用 TaskList 以摘要形式查看所有任务。
`
