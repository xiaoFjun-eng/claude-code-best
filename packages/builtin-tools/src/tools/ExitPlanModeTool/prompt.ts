// External stub for ExitPlanModeTool prompt - excludes Ant-only allowedPrompts section

// Hardcoded to avoid relative import issues in stub
const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

export const EXIT_PLAN_MODE_V2_TOOL_PROMPT = `当你处于计划模式，并且已经把计划写入计划文件、准备让用户审批时，使用此工具。

## 工作原理
- 你应当已经把计划写入计划模式 system 消息中指定的计划文件
- 该工具不接受“计划内容”作为参数——它会从你写入的文件中读取计划
- 该工具仅用于表明你已完成规划，准备让用户审阅与批准
- 用户在审阅时会看到你的计划文件内容

## 何时使用
重要：仅当任务需要“规划一个需要写代码的实现步骤”时才使用此工具。对于调研类任务（收集信息、搜索文件、读取文件、或总体上理解代码库）不要使用此工具。

## 使用前检查
确保你的计划完整且没有歧义：
- 如果你对需求或方案仍有未解决的问题，请先在更早阶段使用 ${ASK_USER_QUESTION_TOOL_NAME}
- 当计划最终定稿后，再使用本工具发起审批请求

**重要：** 不要用 ${ASK_USER_QUESTION_TOOL_NAME} 去问“这个计划可以吗？”或“我可以继续吗？”——这正是本工具要做的事。ExitPlanMode 本质上就是请求用户审批你的计划。

## 示例

1. 初始任务：“搜索并理解代码库中 vim mode 的实现”——不要使用退出计划模式工具，因为你并没有在规划一个要实现的编码步骤。
2. 初始任务：“帮我实现 vim 的 yank mode”——当你完成该任务实现步骤的规划后，再使用退出计划模式工具。
3. 初始任务：“新增一个处理用户认证的功能”——如果认证方式（OAuth、JWT 等）不确定，先用 ${ASK_USER_QUESTION_TOOL_NAME} 澄清，再在明确方案后使用退出计划模式工具。
`
