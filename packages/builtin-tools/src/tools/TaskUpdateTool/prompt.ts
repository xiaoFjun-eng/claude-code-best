export const DESCRIPTION = '更新任务列表中的任务'

export const PROMPT = `使用此工具更新任务列表中的任务。

## 何时使用此工具

**将任务标记为已解决：**
- 当你完成了任务中描述的工作
- 当任务不再需要或已被其他任务取代
- 重要：完成后务必把你负责的任务标记为已解决
- 解决后，调用 TaskList 查找下一个任务

- 只有在你**完全完成**任务时，才将其标记为 completed
- 如果遇到错误、阻塞或无法完成，保持任务为 in_progress
- 如果被阻塞，创建一个新任务来描述需要先解决什么
- 绝不要在以下情况下把任务标记为 completed：
  - 测试仍在失败
  - 实现不完整
  - 仍有未解决的错误
  - 找不到必要文件或依赖

**删除任务：**
- 当任务不再相关或误创建时
- 将 status 设为 \`deleted\` 会永久移除该任务

**更新任务详情：**
- 当需求发生变化或变得更清晰时
- 当需要建立任务依赖关系时

## 可更新字段

- **status**：任务状态（见下方“状态流转”）
- **subject**：修改任务标题（祈使句，例如："Run tests"）
- **description**：修改任务描述
- **activeForm**：当 in_progress 时 spinner 显示的进行时文案（例如："Running tests"）
- **owner**：修改任务负责人（agent 名称）
- **metadata**：将 metadata 的键合并到任务中（把某个 key 设为 null 可删除它）
- **addBlocks**：标记哪些任务必须等该任务完成后才能开始
- **addBlockedBy**：标记该任务开始前必须先完成哪些任务

## 状态流转

状态流转：\`pending\` → \`in_progress\` → \`completed\`

使用 \`deleted\` 可永久移除任务。

## 时效性

在更新任务前，务必先用 \`TaskGet\` 读取其最新状态。

## 示例

开始工作时将任务标记为进行中：
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

完成工作后将任务标记为已完成：
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

删除任务：
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\`

通过设置 owner 领取任务：
\`\`\`json
{"taskId": "1", "owner": "my-name"}
\`\`\`

设置任务依赖关系：
\`\`\`json
{"taskId": "2", "addBlockedBy": ["1"]}
\`\`\`
`
