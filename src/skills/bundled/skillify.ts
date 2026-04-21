import { getSessionMemoryContent } from '../../services/SessionMemory/sessionMemoryUtils.js'
import type { Message } from '../../types/message.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import { registerBundledSkill } from '../bundledSkills.js'

function extractUserMessages(messages: Message[]): string[] {
  return messages
    .filter(m => m.type === 'user')
    .map(m => {
      const content = m.message?.content
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      return content
        .filter(
          (b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text',
        )
        .map(b => b.text)
        .join('\n')
    })
    .filter(text => text.trim().length > 0)
}

const SKILLIFY_PROMPT = `# Skillify {{userDescriptionBlock}}

你正在将本次会话的可重复过程捕获为一个可复用的技能。

## 你的会话上下文

以下是会话记忆摘要：
<session_memory>
{{sessionMemory}}
</session_memory>

以下是本次会话期间用户的消息。注意他们是如何引导流程的，以帮助在技能中捕获他们的详细偏好：
<user_messages>
{{userMessages}}
</user_messages>

## 你的任务

### 步骤 1：分析会话

在提出任何问题之前，先分析会话以识别：
- 执行了哪些可重复过程
- 输入/参数是什么
- 具体的步骤（按顺序）
- 每个步骤的成功产出/标准（例如，不仅仅是“编写代码”，而是“一个 CI 完全通过的开放 PR”）
- 用户在何处纠正或引导了你
- 需要哪些工具和权限
- 使用了哪些代理
- 目标和成功产出是什么

### 步骤 2：访谈用户

你将使用 AskUserQuestion 来理解用户想要自动化什么。重要说明：
- 所有问题都使用 AskUserQuestion！切勿通过纯文本提问。
- 对于每一轮，根据需要尽可能多地迭代，直到用户满意为止。
- 用户总是有一个自由格式的“其他”选项来输入编辑或反馈——不要添加你自己的“需要调整”或“我将提供编辑”选项。只提供实质性的选择。

**第 1 轮：高层级确认**
- 根据你的分析，建议一个技能名称和描述。请用户确认或重命名。
- 建议技能的高层级目标和具体成功标准。

**第 2 轮：更多细节**
- 将你识别出的高层级步骤呈现为一个编号列表。告诉用户你将在下一轮深入细节。
- 如果你认为技能需要参数，请根据你的观察建议参数。确保你理解用户需要提供什么。
- 如果不清楚，询问这个技能应该以内联方式（在当前对话中）运行还是分叉运行（作为拥有自己上下文的子代理）。分叉更适合不需要过程中用户输入的自包含任务；内联更适合用户希望在过程中进行引导的情况。
- 询问技能应该保存在哪里。根据上下文建议一个默认值（特定于仓库的工作流 → 仓库，跨仓库的个人工作流 → 用户）。选项：
  - **此仓库** (\`.claude/skills/<name>/SKILL.md\`) — 用于此项目特定的工作流
  - **个人** (\`~/.claude/skills/<name>/SKILL.md\`) — 在所有仓库中跟随你

**第 3 轮：分解每个步骤**
对于每个主要步骤，如果不是显而易见，请询问：
- 此步骤产生什么后续步骤需要的东西？（数据、产出物、ID）
- 什么证明此步骤成功，并且我们可以继续前进？
- 在继续之前是否应该询问用户确认？（特别是对于不可逆的操作，如合并、发送消息或破坏性操作）
- 是否有任何步骤是独立的并且可以并行运行？（例如，同时发布到 Slack 和监控 CI）
- 应该如何执行技能？（例如，始终使用 Task 代理进行代码审查，或调用代理团队执行一组并发步骤）
- 有哪些硬性约束或硬性偏好？必须发生或绝对不能发生的事情？

你可以在这里进行多轮 AskUserQuestion，每轮针对一个步骤，特别是如果有超过 3 个步骤或许多澄清问题时。根据需要尽可能多地迭代。

重要：特别注意用户在会话过程中纠正你的地方，以帮助指导你的设计。

**第 4 轮：最终问题**
- 确认何时应该调用此技能，并建议/确认触发短语。（例如，对于 cherry-pick 工作流，你可以说：当用户想要将 PR cherry-pick 到发布分支时使用。示例：'cherry-pick 到 release'、'CP 这个 PR'、'hotfix.'）
- 如果仍然不清楚，你也可以询问任何其他需要注意的陷阱或事项。

一旦你获得足够的信息就停止访谈。重要：不要对简单的过程过度提问！

### 步骤 3：编写 SKILL.md

在用户在第 2 轮中选择的位置创建技能目录和文件。

使用此格式：

\`\`\`markdown
---
name: {{skill-name}}
description: {{one-line description}}
allowed-tools:
  {{list of tool permission patterns observed during session}}
when_to_use: {{detailed description of when Claude should automatically invoke this skill, including trigger phrases and example user messages}}
argument-hint: "{{hint showing argument placeholders}}"
arguments:
  {{list of argument names}}
context: {{inline or fork -- omit for inline}}
---

# {{Skill Title}}
技能描述

## 输入
- \`$arg_name\`: 此输入的描述

## 目标
此工作流的明确目标。最好有明确定义的产出物或完成标准。

## 步骤

### 1. 步骤名称
在此步骤中要做什么。要具体且可操作。适当时包含命令。

**成功标准**：始终包含此项！这表明步骤已完成，我们可以继续前进。可以是列表。

重要：请参阅下面的下一节，了解每个步骤可以可选包含的每步骤注解。

...
\`\`\`

**每步骤注解**：
- **成功标准** 是每个步骤必需的。这有助于模型理解用户对其工作流的期望，以及何时应该有信心继续前进。
- **执行方式**：\`Direct\`（默认）、\`Task agent\`（直接的子代理）、\`Teammate\`（具有真正并行性和代理间通信的代理）或 \`[human]\`（用户执行）。仅在非 Direct 时需要指定。
- **产出物**：此步骤产生的后续步骤需要的数据（例如，PR 编号、提交 SHA）。仅当后续步骤依赖它时才包含。
- **人工检查点**：何时暂停并在继续之前询问用户。对于不可逆操作（合并、发送消息）、错误判断（合并冲突）或输出审查时包含。
- **规则**：工作流的硬性规则。参考会话期间的用户纠正尤其有用。

**步骤结构提示**：
- 可以并发运行的步骤使用子编号：3a、3b
- 需要用户操作的步骤在标题中使用 \`[human]\`
- 保持简单技能的简洁性——一个 2 步技能不需要每个步骤都有注解

**Frontmatter 规则**：
- \`allowed-tools\`：所需的最低权限（使用模式如 \`Bash(gh:*)\` 而不是 \`Bash\`）
- \`context\`：仅对不需要过程中用户输入的自包含技能设置 \`context: fork\`。
- \`when_to_use\` 至关重要——告诉模型何时自动调用。以“当...时使用”开头，并包含触发短语。示例：“当用户想要将 PR cherry-pick 到发布分支时使用。示例：'cherry-pick 到 release'、'CP 这个 PR'、'hotfix'。”
- \`arguments\` 和 \`argument-hint\`：仅当技能接受参数时包含。在正文中使用 \`$name\` 进行替换。

### 步骤 4：确认并保存

在写入文件之前，将完整的 SKILL.md 内容作为 yaml 代码块输出到你的响应中，以便用户可以使用正确的语法高亮进行审查。然后使用 AskUserQuestion 请求确认，提出一个简单的问题，如“这个 SKILL.md 看起来可以保存吗？”——不要使用 body 字段，保持问题简洁。

写入后，告诉用户：
- 技能保存在何处
- 如何调用它：\`/{{skill-name}} [arguments]\`
- 他们可以直接编辑 SKILL.md 来完善它`

export function registerSkillifySkill(): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  registerBundledSkill({
    name: 'skillify',
    description:
      "将此会话的可重复过程捕获为技能。在你想要捕获的过程结束时调用，可附带一个可选的描述。",
    allowedTools: [
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'AskUserQuestion',
      'Bash(mkdir:*)',
    ],
    userInvocable: true,
    disableModelInvocation: true,
    argumentHint: '[你想要捕获的过程的描述]',
    async getPromptForCommand(args, context) {
      const sessionMemory =
        (await getSessionMemoryContent()) ?? '无可用会话记忆。'
      const userMessages = extractUserMessages(
        getMessagesAfterCompactBoundary(context.messages),
      )

      const userDescriptionBlock = args
        ? `用户将此过程描述为：“${args}”`
        : ''

      const prompt = SKILLIFY_PROMPT.replace('{{sessionMemory}}', sessionMemory)
        .replace('{{userMessages}}', userMessages.join('\n\n---\n\n'))
        .replace('{{userDescriptionBlock}}', userDescriptionBlock)

      return [{ type: 'text', text: prompt }]
    },
  })
}
