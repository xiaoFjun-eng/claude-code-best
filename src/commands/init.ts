import { feature } from 'bun:bundle'
import type { Command } from '../commands.js'
import { maybeMarkProjectOnboardingComplete } from '../projectOnboardingState.js'
import { AUTONOMY_AGENTS_PATH_POSIX } from '../utils/autonomyAuthority.js'
import { isEnvTruthy } from '../utils/envUtils.js'

const OLD_INIT_PROMPT = `请分析此代码库并创建一个 CLAUDE.md 文件，该文件将提供给未来在此仓库中运行的 Claude Code 实例。

需要添加的内容：
1. 常用命令，例如如何构建、代码检查和运行测试。包含在此代码库中进行开发所需的必要命令，例如如何运行单个测试。
2. 高级代码架构和结构，以便未来的实例能够更快地投入生产。重点放在需要阅读多个文件才能理解的“大局”架构上。

使用说明：
- 如果已经存在 CLAUDE.md，请提出改进建议。
- 当你首次创建 CLAUDE.md 时，不要重复自己，也不要包含显而易见的指令，例如“向用户提供有用的错误消息”、“为所有新工具编写单元测试”、“绝不在代码或提交中包含敏感信息（API 密钥、令牌）”。
- 避免列出所有可以轻松发现的组件或文件结构。
- 不要包含通用的开发实践。
- 如果有 Cursor 规则（位于 .cursor/rules/ 或 .cursorrules）或 Copilot 规则（位于 .github/copilot-instructions.md），请确保包含重要部分。
- 如果有 README.md，请确保包含重要部分。
- 不要编造诸如“常见开发任务”、“开发技巧”、“支持与文档”之类的信息，除非在你阅读的其他文件中明确包含这些内容。
- 请务必在文件开头加上以下文本：

\`\`\`
# CLAUDE.md

此文件为在此仓库中工作的 Claude Code (claude.ai/code) 提供指导。
\`\`\``

const NEW_INIT_PROMPT = `为此仓库设置一个最简的 CLAUDE.md（以及可选的技能和钩子）。CLAUDE.md 会被加载到每个 Claude Code 会话中，因此它必须简洁 —— 只包含没有它 Claude 就会出错的内容。

## 第 1 阶段：询问要设置什么

使用 AskUserQuestion 了解用户想要什么：

- “/init 应该设置哪些 CLAUDE.md 文件？”
  选项：“项目 CLAUDE.md” | “个人 CLAUDE.local.md” | “项目 + 个人”
  项目描述：“团队共享的指令，签入源代码控制 — 架构、编码标准、常用工作流。”
  个人描述：“你在此项目中的私有偏好（被 git 忽略，不共享）— 你的角色、沙箱 URL、偏好的测试数据、工作流中的特殊点。”

- “还要设置技能和钩子吗？”
  选项：“技能 + 钩子” | “仅技能” | “仅钩子” | “都不，只要 CLAUDE.md”
  技能描述：“你或 Claude 使用 \`/技能名\` 调用的按需能力 — 适用于可重复的工作流和参考知识。”
  钩子描述：“在工具事件上运行的决定性 shell 命令（例如每次编辑后格式化）。Claude 不能跳过它们。”

## 第 2 阶段：探索代码库

启动一个子代理来调查代码库，并要求它阅读关键文件以了解项目：清单文件（package.json、Cargo.toml、pyproject.toml、go.mod、pom.xml 等）、README、Makefile/构建配置、CI 配置、现有的 CLAUDE.md、.claude/rules/、${AUTONOMY_AGENTS_PATH_POSIX}、.cursor/rules 或 .cursorrules、.github/copilot-instructions.md、.windsurfrules、.clinerules、.mcp.json。

检测：
- 构建、测试和代码检查命令（尤其是非标准的）
- 语言、框架和包管理器
- 项目结构（带有工作区的单体仓库、多模块或单项目）
- 与语言默认值不同的代码风格规则
- 不明显的陷阱、必需的环境变量或工作流中的特殊点
- 现有的 .claude/skills/ 和 .claude/rules/ 目录
- 格式化工具配置（prettier、biome、ruff、black、gofmt、rustfmt 或统一的格式化脚本如 \`npm run format\` / \`make fmt\`）
- Git worktree 使用情况：运行 \`git worktree list\` 检查此仓库是否有多个 worktree（仅当用户想要个人 CLAUDE.local.md 时相关）

记下你无法仅从代码中确定的内容 — 这些将成为访谈问题。

## 第 3 阶段：填补空白

使用 AskUserQuestion 收集编写好的 CLAUDE.md 文件和技能所需的信息。只询问代码无法回答的问题。

如果用户选择了项目 CLAUDE.md 或两者都选：询问代码库实践 — 非明显命令、陷阱、分支/PR 约定、必需的环境设置、测试中的特殊点。跳过 README 中已存在或从清单文件显而易见的内容。不要将任何选项标记为“推荐” — 这关乎他们团队的工作方式，而非最佳实践。

如果用户选择了个人 CLAUDE.local.md 或两者都选：询问关于他们个人的问题，而不是代码库。不要将任何选项标记为“推荐” — 这关乎他们的个人偏好，而非最佳实践。问题示例：
  - 他们在团队中的角色是什么？（例如“后端工程师”、“数据科学家”、“新员工入职”）
  - 他们对此代码库及其语言/框架的熟悉程度如何？（以便 Claude 校准解释深度）
  - 他们是否有个人沙箱 URL、测试账户、API 密钥路径或 Claude 应知道的本地设置细节？
  - 仅当第 2 阶段发现多个 git worktree 时：询问他们的 worktree 是嵌套在主仓库内部（例如 \`.claude/worktrees/<name>/\`）还是作为兄弟/外部（例如 \`../myrepo-feature/\`）。如果嵌套，向上文件查找会自动找到主仓库的 CLAUDE.local.md — 无需特殊处理。如果兄弟/外部，个人内容应放在主目录文件中（例如 \`~/.claude/<项目名>-instructions.md\`），每个 worktree 获得一个单行的 CLAUDE.local.md 存根，导入它：\`@~/.claude/<项目名>-instructions.md\`。永远不要将此导入放在项目 CLAUDE.md 中 — 那会将个人引用检入团队共享的文件。
  - 任何沟通偏好？（例如“简洁”、“总是解释权衡”、“结尾不总结”）

**根据第 2 阶段的发现综合一个提案** — 例如，如果存在格式化工具则使用“编辑后格式化”钩子，如果存在测试则使用 \`/verify\` 技能，对于任何来自填补空白的答案中属于指导原则而非工作流的内容，在 CLAUDE.md 中添加一个说明。对于每一项，选择适合的工件类型，**受第 1 阶段的技能+钩子选择约束**：

  - **钩子**（更严格）— 在工具事件上运行的决定性 shell 命令；Claude 不能跳过它。适用于机械的、快速的、每次编辑的步骤：格式化、代码检查、在被更改的文件上运行快速测试。
  - **技能**（按需）— 你或 Claude 在需要时调用 \`/技能名\`。适用于不属于每次编辑的工作流：深度验证、会话报告、部署。
  - **CLAUDE.md 说明**（较宽松）— 影响 Claude 的行为但不强制执行。适用于沟通/思考偏好：“编码前先计划”、“简洁”、“解释权衡”。

  **将第 1 阶段的技能+钩子选择视为硬过滤器**：如果用户选择了“仅技能”，则将任何你建议的钩子降级为技能或 CLAUDE.md 说明。如果选择了“仅钩子”，则将技能降级为钩子（在机械上可能的地方）或说明。如果选择了“都不”，则所有内容都变成 CLAUDE.md 说明。永远不要建议用户未选择的工件类型。

**通过 AskUserQuestion 的 \`preview\` 字段展示提案，而不是作为单独的文本消息** — 对话框覆盖在你的输出之上，因此前面的文本会被隐藏。\`preview\` 字段在侧边栏中渲染 markdown（类似于计划模式）；\`question\` 字段只能是纯文本。结构如下：

  - \`question\`：简短且纯文本，例如“这个提案看起来对吗？”
  - 每个选项得到一个 \`preview\`，其中包含完整的提案 markdown。“看起来不错 — 继续”选项的预览显示所有内容；每个删除项目的选项的预览显示删除后剩余的内容。
  - **保持预览简洁 — 预览框会截断且无滚动。** 每项一行，项之间无空行，无标题。预览内容示例：

    • **编辑后格式化钩子**（自动） — 通过 PostToolUse 执行 \`ruff format <file>\`
    • **/verify 技能**（按需） — \`make lint && make typecheck && make test\`
    • **CLAUDE.md 说明**（指导原则） — “在标记完成前运行 lint/typecheck/test”

  - 选项标签保持简短（“看起来不错”、“删除钩子”、“删除技能”）— 工具会自动添加一个“其他”自由文本选项，因此不要添加你自己的全包选项。

**根据接受的提案构建偏好队列**。每个条目：{type: hook|skill|note, description, target file, 任何第 2 阶段来源的细节，如实际的测试/格式化命令}。第 4-7 阶段将消费此队列。

## 第 4 阶段：编写 CLAUDE.md（如果用户选择了项目或两者都选）

在项目根目录编写一个最简的 CLAUDE.md。每一行都必须通过这个测试：“如果删除这一行，Claude 会犯错吗？”如果不会，就删除它。

**从第 3 阶段的偏好队列中消费 \`note\` 条目，这些条目的目标是 CLAUDE.md**（团队级说明） — 将每个条目作为简洁的一行添加到最相关的部分。这些是用户希望 Claude 遵循但不需要强制执行的行为（例如“在实现前提出计划”、“重构时解释权衡”）。留出个人目标的说明用于第 5 阶段。

包括：
- Claude 无法猜测的构建/测试/代码检查命令（非标准脚本、标志或序列）
- 与语言默认值不同的代码风格规则（例如“优先使用 type 而不是 interface”）
- 测试指令和特殊点（例如“运行单个测试：pytest -k 'test_name'”）
- 仓库规范（分支命名、PR 约定、提交风格）
- 必需的环境变量或设置步骤
- 不明显的陷阱或架构决策
- 如果存在其他 AI 编码工具配置中的重要部分（${AUTONOMY_AGENTS_PATH_POSIX}、.cursor/rules、.cursorrules、.github/copilot-instructions.md、.windsurfrules、.clinerules）

排除：
- 逐文件结构或组件列表（Claude 可以通过阅读代码库发现这些）
- Claude 已知的标准语言约定
- 通用建议（“编写干净的代码”、“处理错误”）
- 详细的 API 文档或长引用 — 使用 \`@path/to/import\` 语法代替（例如 \`@docs/api-reference.md\`），按需内联内容而不使 CLAUDE.md 膨胀
- 频繁变化的信息 — 使用 \`@path/to/import\` 引用源，以便 Claude 总是读取当前版本
- 长教程或演练（移到单独文件并用 \`@path/to/import\` 引用，或放在技能中）
- 从清单文件显而易见的命令（例如标准的“npm test”、“cargo test”、“pytest”）

要具体：“在 TypeScript 中使用 2 空格缩进”比“正确格式化代码”更好。

不要重复自己，不要编造诸如“常见开发任务”或“开发技巧”的部分 — 只包含在你阅读的文件中明确发现的信息。

在文件开头加上：

\`\`\`
# CLAUDE.md

此文件为在此仓库中工作的 Claude Code (claude.ai/code) 提供指导。
\`\`\`

如果 CLAUDE.md 已存在：阅读它，提出具体的更改（作为 diff），并解释每个更改为什么能改进它。不要静默覆盖。

对于包含多个关注点的项目，建议将指令组织到 \`.claude/rules/\` 中作为单独的重点文件（例如 \`code-style.md\`、\`testing.md\`、\`security.md\`）。这些文件会与 CLAUDE.md 一起自动加载，并可以使用 \`paths\` frontmatter 限定到特定文件路径。

对于具有不同子目录的项目（单体仓库、多模块项目等）：提及可以添加子目录 CLAUDE.md 文件以获取模块特定的指令（当 Claude 在这些目录中工作时会自动加载）。如果用户想要，提供创建它们的选项。

## 第 5 阶段：编写 CLAUDE.local.md（如果用户选择了个人或两者都选）

在项目根目录编写一个最简的 CLAUDE.local.md。此文件会与 CLAUDE.md 一起自动加载。创建后，将 \`CLAUDE.local.md\` 添加到项目的 .gitignore 中，以便保持私有。

**从第 3 阶段的偏好队列中消费 \`note\` 条目，这些条目的目标是 CLAUDE.local.md**（个人级说明） — 将每个条目作为简洁的一行添加。如果用户在第 1 阶段选择了仅个人，这是说明条目的唯一消费者。

包括：
- 用户的角色和对代码库的熟悉程度（以便 Claude 校准解释）
- 个人沙箱 URL、测试账户或本地设置细节
- 个人工作流或沟通偏好

保持简短 — 只包含能让 Claude 对此用户的响应明显更好的内容。

如果第 2 阶段发现多个 git worktree，并且用户确认他们使用兄弟/外部 worktree（不嵌套在主仓库内部）：向上文件查找无法从所有 worktree 中找到单个 CLAUDE.local.md。将实际的个人内容写入 \`~/.claude/<项目名>-instructions.md\`，并使 CLAUDE.local.md 成为一个单行存根，导入它：\`@~/.claude/<项目名>-instructions.md\`。用户可以将此单行存根复制到每个兄弟 worktree。永远不要将此导入放在项目 CLAUDE.md 中。如果 worktree 嵌套在主仓库内部（例如 \`.claude/worktrees/\`），无需特殊处理 — 主仓库的 CLAUDE.local.md 会被自动找到。

如果 CLAUDE.local.md 已存在：阅读它，提出具体的添加内容，不要静默覆盖。

## 第 6 阶段：建议并创建技能（如果用户选择了“技能 + 钩子”或“仅技能”）

技能添加了 Claude 可以按需使用的能力，而不会使每个会话变得臃肿。

**首先，从第 3 阶段的偏好队列中消费 \`skill\` 条目。** 每个排队的技能偏好都变成一个 SKILL.md，根据用户描述的内容量身定制。对于每个条目：
- 根据偏好命名（例如“verify-deep”、“session-report”、“deploy-sandbox”）
- 使用用户自己在访谈中的措辞以及第 2 阶段发现的内容（测试命令、报告格式、部署目标）来编写正文。如果偏好映射到现有的捆绑技能（例如 \`/verify\`），编写一个项目技能，在其上添加用户特定的约束 — 告诉用户捆绑的技能仍然存在，他们的技能是附加的。
- 如果偏好指定不足，快速追问（例如“verify-deep 应运行哪个测试命令？”）

**然后，建议超出队列的额外技能**，当你发现：
- 针对特定任务的参考知识（约定、模式、子系统的风格指南）
- 用户想要直接触发的可重复工作流（部署、修复问题、发布流程、验证更改）

对于每个建议的技能，提供：名称、单行目的以及为什么它适合此仓库。

如果 \`.claude/skills/\` 已存在并包含技能，首先审查它们。不要覆盖现有技能 — 只建议补充现有技能的新技能。

在 \`.claude/skills/<技能名>/SKILL.md\` 中创建每个技能：

\`\`\`yaml
---
name: <技能名>
description: <技能的作用及何时使用>
---

<给 Claude 的指令>
\`\`\`

默认情况下，用户（\`/<技能名>\`）和 Claude 都可以调用技能。对于有副作用的工作流（例如 \`/deploy\`、\`/fix-issue 123\`），添加 \`disable-model-invocation: true\`，以便只有用户可以触发它，并使用 \`$ARGUMENTS\` 接受输入。

## 第 7 阶段：建议额外的优化

告诉用户，既然 CLAUDE.md 和技能（如果选择了）已经就位，你将要建议一些额外的优化。

检查环境并针对你发现的每个缺口询问用户（使用 AskUserQuestion）：

- **GitHub CLI**：运行 \`which gh\`（或在 Windows 上运行 \`where gh\`）。如果缺失并且项目使用 GitHub（检查 \`git remote -v\` 中的 github.com），询问用户是否要安装它。解释 GitHub CLI 让 Claude 直接帮助提交、拉取请求、问题和代码审查。

- **代码检查**：如果第 2 阶段没有发现代码检查配置（对于项目的语言没有 .eslintrc、ruff.toml、.golangci.yml 等），询问用户是否希望 Claude 为此代码库设置代码检查。解释代码检查可以及早发现问题，并为 Claude 提供关于其自身编辑的快速反馈。

- **提案来源的钩子**（如果用户选择了“技能 + 钩子”或“仅钩子”）：从第 3 阶段的偏好队列中消费 \`hook\` 条目。如果第 2 阶段发现了一个格式化工具并且队列中没有格式化钩子，提供“编辑后格式化”作为后备。如果用户在第 1 阶段选择了“都不”或“仅技能”，则完全跳过此项。

  对于每个钩子偏好（来自队列或格式化工具后备）：

  1. 目标文件：基于第 1 阶段 CLAUDE.md 选择的默认值 — 项目 → \`.claude/settings.json\`（团队共享，已提交）；个人 → \`.claude/settings.local.json\`。仅当用户在第 1 阶段选择了“两者”或偏好不明确时才询问。对所有钩子只问一次，而不是每个钩子问一次。

  2. 从偏好中选择事件和匹配器：
     - “每次编辑后” → 带有匹配器 \`Write|Edit\` 的 \`PostToolUse\`
     - “当 Claude 完成时” / “在我审查之前” → \`Stop\` 事件（在每个轮次结束时触发 — 包括只读轮次）
     - “在运行 bash 之前” → 带有匹配器 \`Bash\` 的 \`PreToolUse\`
     - “在提交之前”（字面上的 git-commit 门控） → **不是 hooks.json 钩子。** 匹配器无法按命令内容过滤 Bash，因此无法仅针对 \`git commit\`。将其路由到 git pre-commit 钩子（\`.git/hooks/pre-commit\`、husky、pre-commit 框架） — 提供编写一个的选项。如果用户实际上指的是“在我审查并提交 Claude 的输出之前”，那是 \`Stop\` — 探测以消除歧义。
     如果偏好不明确，进行探测。

  3. **加载钩子参考**（在每次 \`/init\` 运行中，在第一个钩子之前执行一次）：调用 Skill 工具，参数为 \`skill: 'update-config'\`，参数以 \`[hooks-only]\` 开头，后跟一个一行摘要，描述你正在构建的内容 — 例如 \`[hooks-only] 为 .claude/settings.json 构建一个使用 ruff 的 PostToolUse/Write|Edit 格式化钩子\`。这会将钩子模式和验证流程加载到上下文中。后续钩子会重用此上下文 — 不要重新调用。

  4. 遵循技能的 **“构建一个钩子”** 流程：去重检查 → 为此项目构建 → 管道测试原始 → 包装 → 写入 JSON → \`jq -e\` 验证 → 实况证明（对于可触发匹配器的 \`Pre|PostToolUse\`）→ 清理 → 交接。目标文件和事件/匹配器来自上面的步骤 1–2。

在继续之前，对每个“是”采取行动。

## 第 8 阶段：总结和后续步骤

总结设置的内容 — 写了哪些文件以及每个文件中包含的关键点。提醒用户这些文件是一个起点：他们应该审查和调整它们，并且可以随时再次运行 \`/init\` 重新扫描。

然后告诉用户，你将根据你的发现，再介绍一些优化其代码库和 Claude Code 设置的建议。将这些建议作为一个格式良好的待办事项列表呈现，每个项目都与该仓库相关。将最有影响力的项目放在最前面。

在构建列表时，逐项检查以下内容，只包括适用的项目：
- 如果检测到前端代码（React、Vue、Svelte 等）：\`/plugin install frontend-design@claude-plugins-official\` 为 Claude 提供设计原则和组件模式，以便它生成精美的 UI；\`/plugin install playwright@claude-plugins-official\` 让 Claude 启动真实的浏览器、截图它构建的内容并自行修复视觉错误。
- 如果你在第 7 阶段发现了缺口（缺少 GitHub CLI、缺少代码检查）并且用户说了“不”：在这里列出它们，并附上一行说明每个为什么有帮助。
- 如果测试缺失或很少：建议设置测试框架，以便 Claude 可以验证自己的更改。
- 为了帮助你创建技能并使用评估优化现有技能，Claude Code 有一个官方的 skill-creator 插件。使用 \`/plugin install skill-creator@claude-plugins-official\` 安装它，然后运行 \`/skill-creator <技能名>\` 来创建新技能或改进任何现有技能。（始终包含此项。）
- 使用 \`/plugin\` 浏览官方插件 — 这些插件捆绑了技能、代理、钩子和 MCP 服务器，你可能觉得有用。你也可以创建自己的自定义插件与他人共享。（始终包含此项。）`

const command = {
  type: 'prompt',
  name: 'init',
  get description() {
    return feature('NEW_INIT') &&
      (process.env.USER_TYPE === 'ant' ||
        isEnvTruthy(process.env.CLAUDE_CODE_NEW_INIT))
      ? '初始化新的 CLAUDE.md 文件以及可选的技能/钩子，并提供代码库文档'
      : '使用代码库文档初始化一个新的 CLAUDE.md 文件'
  },
  contentLength: 0, // 动态内容
  progressMessage: '正在分析你的代码库',
  source: 'builtin',
  async getPromptForCommand() {
    maybeMarkProjectOnboardingComplete()

    return [
      {
        type: 'text',
        text:
          feature('NEW_INIT') &&
          (process.env.USER_TYPE === 'ant' ||
            isEnvTruthy(process.env.CLAUDE_CODE_NEW_INIT))
            ? NEW_INIT_PROMPT
            : OLD_INIT_PROMPT,
      },
    ]
  },
} satisfies Command

export default command