import { AGENT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/AgentTool/constants.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/AskUserQuestionTool/prompt.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/EnterPlanModeTool/constants.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/ExitPlanModeTool/constants.js'
import { SKILL_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/SkillTool/constants.js'
import { getIsGit } from '../../utils/git.js'
import { registerBundledSkill } from '../bundledSkills.js'

const MIN_AGENTS = 5
const MAX_AGENTS = 30

const WORKER_INSTRUCTIONS = `完成变更实现后：
1. **简化** — 使用 \`skill: "simplify"\` 调用 \`${SKILL_TOOL_NAME}\` 工具，以审查并清理你的更改。
2. **运行单元测试** — 运行项目的测试套件（检查 package.json 脚本、Makefile 目标或常见命令如 \`npm test\`、\`bun test\`、\`pytest\`、\`go test\`）。如果测试失败，请修复它们。
3. **端到端测试** — 按照协调员提示（下方）中的端到端测试步骤进行。如果步骤说明此单元可跳过端到端测试，则跳过。
4. **提交并推送** — 使用清晰的提交信息提交所有更改，推送分支，并使用 \`gh pr create\` 创建 PR。使用描述性的标题。如果 \`gh\` 不可用或推送失败，请在最终消息中注明。
5. **报告** — 最后以单行形式结束：\`PR: <url>\`，以便协调员跟踪。如果未创建 PR，则以 \`PR: none — <原因>\` 结束。`

function buildPrompt(instruction: string): string {
  return `# 批处理：并行工作编排

你正在编排一个跨越此代码库的大型、可并行化的变更。

## 用户指令

${instruction}

## 第一阶段：研究与规划（计划模式）

现在调用 \`${ENTER_PLAN_MODE_TOOL_NAME}\` 工具进入计划模式，然后：

1. **理解范围。** 启动一个或多个子代理（在前台运行 — 你需要它们的结果）来深入研究此指令涉及的内容。找出所有需要更改的文件、模式和调用点。理解现有的约定，以便迁移保持一致。

2. **分解为独立单元。** 将工作分解为 ${MIN_AGENTS}–${MAX_AGENTS} 个自包含的单元。每个单元必须：
   - 能够在隔离的 git worktree 中独立实现（与兄弟单元无共享状态）
   - 能够独立合并，无需依赖另一个单元的 PR 先落地
   - 大小大致均匀（拆分大单元，合并琐碎单元）

   根据实际工作量调整数量：文件少 → 接近 ${MIN_AGENTS}；文件多 → 接近 ${MAX_AGENTS}。优先按目录或模块切片，而非任意的文件列表。

3. **确定端到端测试步骤。** 想出一个方法，让工作者可以验证其变更确实能端到端工作 — 不仅仅是单元测试通过。寻找：
   - \`claude-in-chrome\` 技能或浏览器自动化工具（用于 UI 变更：点击受影响的流程，截图结果）
   - \`tmux\` 或 CLI 验证器技能（用于 CLI 变更：交互式启动应用，执行更改后的行为）
   - 开发服务器 + curl 模式（用于 API 变更：启动服务器，访问受影响的端点）
   - 工作者可以运行的现有端到端/集成测试套件

   如果找不到具体的端到端路径，使用 \`${ASK_USER_QUESTION_TOOL_NAME}\` 工具询问用户如何端到端验证此变更。根据你的发现提供 2–3 个具体选项（例如，“通过 Chrome 扩展截图”、“运行 \`bun run dev\` 并 curl 端点”、“无需端到端 — 单元测试已足够”）。不要跳过此步骤 — 工作者无法自行询问用户。

   将步骤写成一个简短、具体的指令集，供工作者自主执行。包括任何设置（启动开发服务器、先构建）以及用于验证的确切命令/交互。

4. **编写计划。** 在你的计划文件中，包括：
   - 研究期间发现的总结
   - 工作单元的编号列表 — 对于每个单元：简短标题、涵盖的文件/目录列表以及变更的一行描述
   - 端到端测试步骤（如果用户选择跳过，则为“跳过端到端，因为…”）
   - 你将给每个代理的确切工作者指令（共享模板）

5. 调用 \`${EXIT_PLAN_MODE_TOOL_NAME}\` 来提交计划以供批准。

## 第二阶段：生成工作者（计划批准后）

一旦计划获得批准，使用 \`${AGENT_TOOL_NAME}\` 工具为每个工作单元生成一个后台代理。**所有代理必须使用 \`isolation: "worktree"\` 和 \`run_in_background: true\`。** 在一个消息块中启动所有代理，以便它们并行运行。

对于每个代理，提示必须完全自包含。包括：
- 总体目标（用户的指令）
- 此单元的具体任务（标题、文件列表、变更描述 — 从你的计划中逐字复制）
- 你发现的、工作者需要遵循的任何代码库约定
- 你计划中的端到端测试步骤（或“跳过端到端，因为…”）
- 下方的工作者指令，逐字复制：

\`\`\`
${WORKER_INSTRUCTIONS}
\`\`\`

除非有更具体的代理类型适用，否则使用 \`subagent_type: "general-purpose"\`。

## 第三阶段：跟踪进度

启动所有工作者后，渲染初始状态表：

| # | 单元 | 状态 | PR |
|---|------|--------|----|
| 1 | <标题> | 运行中 | — |
| 2 | <标题> | 运行中 | — |

当后台代理完成通知到达时，从每个代理的结果中解析 \`PR: <url>\` 行，并使用更新后的状态（\`完成\` / \`失败\`）和 PR 链接重新渲染表格。对于任何未生成 PR 的代理，保留简短的失败说明。

当所有代理都报告后，渲染最终表格和一行摘要（例如，“24 个单元中有 22 个已落地为 PR”）。`
}

const NOT_A_GIT_REPO_MESSAGE = `这不是一个 git 仓库。\`/batch\` 命令需要一个 git 仓库，因为它会在隔离的 git worktree 中生成代理，并从每个代理创建 PR。请先初始化一个仓库，或在现有仓库内运行此命令。`

const MISSING_INSTRUCTION_MESSAGE = `请提供一条指令，描述你想要进行的批处理变更。

示例：
  /batch 从 react 迁移到 vue
  /batch 将所有 lodash 的使用替换为原生等效项
  /batch 为所有无类型的函数参数添加类型注解`

export function registerBatchSkill(): void {
  registerBundledSkill({
    name: 'batch',
    description:
      '研究并规划一个大规模变更，然后在 5–30 个隔离的 worktree 代理中并行执行，每个代理都会打开一个 PR。',
    whenToUse:
      '当用户想要进行一个跨越许多文件的、可分解为独立并行单元的、大规模的、机械式的变更（迁移、重构、批量重命名）时使用。',
    argumentHint: '<instruction>',
    userInvocable: true,
    disableModelInvocation: true,
    async getPromptForCommand(args) {
      const instruction = args.trim()
      if (!instruction) {
        return [{ type: 'text', text: MISSING_INSTRUCTION_MESSAGE }]
      }

      const isGit = await getIsGit()
      if (!isGit) {
        return [{ type: 'text', text: NOT_A_GIT_REPO_MESSAGE }]
      }

      return [{ type: 'text', text: buildPrompt(instruction) }]
    },
  })
}
