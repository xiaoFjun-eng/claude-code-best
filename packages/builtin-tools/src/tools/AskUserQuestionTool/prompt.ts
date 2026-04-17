import { EXIT_PLAN_MODE_TOOL_NAME } from '../ExitPlanModeTool/constants.js'

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

export const ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 12

export const DESCRIPTION =
  '向用户提出多选/单选问题，用于收集信息、澄清歧义、了解偏好、协助决策或向其提供选项。'

export const PREVIEW_FEATURE_PROMPT = {
  markdown: `
预览功能：
当你需要向用户展示可视化对比的具体内容时，可以在选项上使用可选字段 \`preview\`：
- ASCII mockups of UI layouts or components
- UI 布局或组件的 ASCII 文本草图
- 展示不同实现方式的代码片段
- 不同版本的图示/示意图
- 配置示例

预览内容会以等宽字体框的形式按 markdown 渲染，支持包含换行的多行文本。只要任意选项包含 preview，UI 就会切换为左右并排布局：左侧为竖向选项列表，右侧为预览内容。对于仅凭标签与描述就足够的简单偏好问题，不要使用预览。注意：预览仅支持单选问题（不支持 multiSelect）。
`,
  html: `
预览功能：
当你需要向用户展示可视化对比的具体内容时，可以在选项上使用可选字段 \`preview\`：
- HTML mockups of UI layouts or components
- UI 布局或组件的 HTML 片段示例
- 展示不同实现方式的格式化代码片段
- 可视化对比或图示

预览内容必须是自包含的 HTML 片段（不要包含 <html>/<body> 包裹，也不要使用 <script> 或 <style> 标签——请改用内联 style 属性）。对于仅凭标签与描述就足够的简单偏好问题，不要使用预览。注意：预览仅支持单选问题（不支持 multiSelect）。
`,
} as const

export const ASK_USER_QUESTION_TOOL_PROMPT = `当你在执行过程中需要向用户提问时，使用此工具。它可以帮助你：
1. 收集用户偏好或需求
2. 澄清含糊不清的指令
3. 在实现过程中获取关键选择的决策
4. 向用户提供方向性选择

使用说明：
- 用户始终可以选择 “Other” 来输入自定义文本
- 使用 \`multiSelect: true\` 允许一个问题选择多个答案
- 如果你推荐某个选项，把它放在列表的第一项，并在标签末尾加上 “(Recommended)”

计划模式提示：在计划模式中，应在最终确定计划之前使用此工具来澄清需求或在方案之间做选择。不要用它来问“我的计划准备好了吗？”或“我可以继续吗？”——计划审批请使用 ${EXIT_PLAN_MODE_TOOL_NAME}。重要：在你的问题中不要提到“计划”（例如“你对计划有什么反馈？”“计划看起来如何？”），因为在你调用 ${EXIT_PLAN_MODE_TOOL_NAME} 之前，用户在 UI 中看不到计划内容。如果你需要计划审批，请改用 ${EXIT_PLAN_MODE_TOOL_NAME}。
`
