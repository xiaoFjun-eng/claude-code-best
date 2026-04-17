import { isPlanModeInterviewPhaseEnabled } from 'src/utils/planModeV2.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../AskUserQuestionTool/prompt.js'

const WHAT_HAPPENS_SECTION = `## 计划模式会发生什么

在计划模式中，你会：
1. 使用 Glob、Grep、Read 工具充分探索代码库
2. 理解现有模式与架构
3. 设计实现方案
4. 将计划呈现给用户审批
5. 如需澄清方案，使用 ${ASK_USER_QUESTION_TOOL_NAME}
6. 准备开始实现时，通过 ExitPlanMode 退出计划模式

`

function getEnterPlanModeToolPromptExternal(): string {
  // When interview phase is enabled, omit the "What Happens" section —
  // detailed workflow instructions arrive via the plan_mode attachment (messages.ts).
  const whatHappens = isPlanModeInterviewPhaseEnabled()
    ? ''
    : WHAT_HAPPENS_SECTION

  return `当你即将开始一个不简单的实现任务时，主动使用此工具。先让用户对方案确认再写代码，可以避免返工并确保方向一致。该工具会将你切换到计划模式，在其中你可以探索代码库并设计可供用户审批的实现方案。

## 何时使用此工具

除非实现任务非常简单，否则**优先使用 EnterPlanMode**。当满足以下任一条件时使用：

1. **新功能实现**：添加有意义的新能力
   - 例："Add a logout button"——放在哪里？点击后发生什么？
   - 例："Add form validation"——规则是什么？错误提示是什么？

2. **存在多种可行方案**：任务可以用多种方式解决
   - 例："Add caching to the API"——可用 Redis、内存、文件等
   - 例："Improve performance"——可能有多种优化策略

3. **修改现有代码**：会影响既有行为或结构的更改
   - 例："Update the login flow"——具体要改什么？
   - 例："Refactor this component"——目标架构是什么？

4. **需要架构决策**：需要在模式/技术之间做取舍
   - 例："Add real-time updates"——WebSockets vs SSE vs 轮询
   - 例："Implement state management"——Redux vs Context vs 自研方案

5. **多文件变更**：很可能会涉及 2-3 个以上文件
   - 例："Refactor the authentication system"
   - 例："Add a new API endpoint with tests"

6. **需求不清晰**：需要先探索才能理解完整范围
   - 例："Make the app faster"——需要 profile 并定位瓶颈
   - 例："Fix the bug in checkout"——需要调查根因

7. **用户偏好很关键**：实现可以合理地走多个方向
   - 如果你本来会用 ${ASK_USER_QUESTION_TOOL_NAME} 来澄清方案，那更应该用 EnterPlanMode
   - 计划模式允许你先探索，再带着上下文给出选项

## 何时不要使用此工具

仅在简单任务时跳过 EnterPlanMode：
- 单行/少量行修改（拼写、明显 bug、小调整）
- 需求明确、只需新增一个函数
- 用户给了非常具体、详细的指令
- 纯调研/探索任务（改用 Agent 的 explore 类型）

${whatHappens}## 示例

### 推荐 —— 使用 EnterPlanMode：
User: "Add user authentication to the app"
- Requires architectural decisions (session vs JWT, where to store tokens, middleware structure)

User: "Optimize the database queries"
- Multiple approaches possible, need to profile first, significant impact

User: "Implement dark mode"
- Architectural decision on theme system, affects many components

User: "Add a delete button to the user profile"
- Seems simple but involves: where to place it, confirmation dialog, API call, error handling, state updates

User: "Update the error handling in the API"
- Affects multiple files, user should approve the approach

### 不推荐 —— 不要使用 EnterPlanMode：
User: "Fix the typo in the README"
- Straightforward, no planning needed

User: "Add a console.log to debug this function"
- Simple, obvious implementation

User: "What files handle routing?"
- Research task, not implementation planning

## 重要说明

- 该工具需要用户批准——用户必须同意进入计划模式
- 不确定是否要用时，倾向于先规划——先对齐方向比返工更好
- 在对代码库做较大改动前征求用户意见通常会更受欢迎
`
}

function getEnterPlanModeToolPromptAnt(): string {
  // When interview phase is enabled, omit the "What Happens" section —
  // detailed workflow instructions arrive via the plan_mode attachment (messages.ts).
  const whatHappens = isPlanModeInterviewPhaseEnabled()
    ? ''
    : WHAT_HAPPENS_SECTION

  return `当任务在“正确做法”上存在真实歧义，并且在编码前获取用户输入可以避免大量返工时，使用此工具。它会将你切换到计划模式，在其中你可以探索代码库并设计可供用户审批的实现方案。

## 何时使用此工具

当实现方案确实不清晰时，计划模式很有价值。满足以下情况时使用：

1. **显著的架构歧义**：存在多种合理方案，且选择会实质影响代码库
   - 例："Add caching to the API"——Redis vs 内存 vs 文件
   - 例："Add real-time updates"——WebSockets vs SSE vs 轮询

2. **需求不清晰**：需要先探索与澄清才能推进
   - 例："Make the app faster"——需要 profile 并定位瓶颈
   - 例："Refactor this module"——需要理解目标架构应是什么

3. **高影响重构**：任务会显著重塑既有代码，先取得认可可降低风险
   - 例："Redesign the authentication system"
   - 例："Migrate from one state management approach to another"

## 何时不要使用此工具

当你可以合理推断正确方案时，跳过计划模式：
- The task is straightforward even if it touches multiple files
- The user's request is specific enough that the implementation path is clear
- You're adding a feature with an obvious implementation pattern (e.g., adding a button, a new endpoint following existing conventions)
- Bug fixes where the fix is clear once you understand the bug
- Research/exploration tasks (use the Agent tool instead)
- The user says something like "can we work on X" or "let's do X" — just get started

拿不准时，更推荐直接开始动手，并用 ${ASK_USER_QUESTION_TOOL_NAME} 询问具体问题，而不是进入完整规划阶段。

${whatHappens}## 示例

### 推荐 —— 使用 EnterPlanMode：
User: "Add user authentication to the app"
- Genuinely ambiguous: session vs JWT, where to store tokens, middleware structure

User: "Redesign the data pipeline"
- Major restructuring where the wrong approach wastes significant effort

### 不推荐 —— 不要使用 EnterPlanMode：
User: "Add a delete button to the user profile"
- Implementation path is clear; just do it

User: "Can we work on the search feature?"
- User wants to get started, not plan

User: "Update the error handling in the API"
- Start working; ask specific questions if needed

User: "Fix the typo in the README"
- Straightforward, no planning needed

## 重要说明

- 该工具需要用户批准——用户必须同意进入计划模式
`
}

export function getEnterPlanModeToolPrompt(): string {
  return process.env.USER_TYPE === 'ant'
    ? getEnterPlanModeToolPromptAnt()
    : getEnterPlanModeToolPromptExternal()
}
