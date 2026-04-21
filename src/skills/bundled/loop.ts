import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  DEFAULT_MAX_AGE_DAYS,
  isKairosCronEnabled,
} from '@claude-code-best/builtin-tools/tools/ScheduleCronTool/prompt.js'
import { registerBundledSkill } from '../bundledSkills.js'

const DEFAULT_INTERVAL = '10m'

const USAGE_MESSAGE = `用法：/loop [interval] <prompt>

以固定时间间隔重复运行一个提示词或斜杠命令。

时间间隔：Ns、Nm、Nh、Nd（例如 5m、30m、2h、1d）。最小粒度为 1 分钟。
如果未指定间隔，则默认为 ${DEFAULT_INTERVAL}。

示例：
  /loop 5m /babysit-prs
  /loop 30m check the deploy
  /loop 1h /standup 1
  /loop check the deploy          (默认为 ${DEFAULT_INTERVAL})
  /loop check the deploy every 20m`

function buildPrompt(args: string): string {
  return `# /loop — 安排一个重复执行的提示词

将下面的输入解析为 \`[interval] <prompt…>\` 格式，并使用 ${CRON_CREATE_TOOL_NAME} 安排它。

## 解析规则（按优先级顺序）

1.  **前导标记**：如果第一个由空白分隔的标记匹配 \`^\\d+[smhd]$\`（例如 \`5m\`、\`2h\`），则该标记为时间间隔；其余部分为提示词。
2.  **尾随 "every" 子句**：否则，如果输入以 \`every <N><unit>\` 或 \`every <N> <unit-word>\` 结尾（例如 \`every 20m\`、\`every 5 minutes\`、\`every 2 hours\`），则将其提取为时间间隔并从提示词中移除。仅当 "every" 后面是时间表达式时才匹配 —— \`check every PR\` 没有时间间隔。
3.  **默认**：否则，时间间隔为 \`${DEFAULT_INTERVAL}\`，整个输入即为提示词。

如果解析出的提示词为空，则显示用法 \`/loop [interval] <prompt>\` 并停止 —— 不要调用 ${CRON_CREATE_TOOL_NAME}。

示例：
- \`5m /babysit-prs\` → 间隔 \`5m\`，提示词 \`/babysit-prs\`（规则 1）
- \`check the deploy every 20m\` → 间隔 \`20m\`，提示词 \`check the deploy\`（规则 2）
- \`run tests every 5 minutes\` → 间隔 \`5m\`，提示词 \`run tests\`（规则 2）
- \`check the deploy\` → 间隔 \`${DEFAULT_INTERVAL}\`，提示词 \`check the deploy\`（规则 3）
- \`check every PR\` → 间隔 \`${DEFAULT_INTERVAL}\`，提示词 \`check every PR\`（规则 3 — "every" 后面不是时间）
- \`5m\` → 提示词为空 → 显示用法

## 时间间隔 → cron 表达式

支持的后缀：\`s\`（秒，向上取整到最近的分钟，最小 1 分钟）、\`m\`（分钟）、\`h\`（小时）、\`d\`（天）。转换规则：

| 间隔模式             | Cron 表达式         | 备注                                     |
|-----------------------|---------------------|------------------------------------------|
| \`Nm\` 且 N ≤ 59     | \`*/N * * * *\`     | 每 N 分钟                                |
| \`Nm\` 且 N ≥ 60     | \`0 */H * * *\`     | 舍入到小时（H = N/60，必须能整除 24）    |
| \`Nh\` 且 N ≤ 23     | \`0 */N * * *\`     | 每 N 小时                                |
| \`Nd\`                | \`0 0 */N * *\`     | 每 N 天在当地午夜执行                    |
| \`Ns\`                | 视为 \`ceil(N/60)m\` | cron 的最小粒度为 1 分钟                 |

**如果间隔不能整除其单位**（例如 \`7m\` → \`*/7 * * * *\` 会在 :56→:00 产生不均匀的间隔；\`90m\` → 1.5 小时，cron 无法表达），则选择最接近的规整间隔，并在安排前告知用户你舍入到了什么值。

## 操作步骤

1.  调用 ${CRON_CREATE_TOOL_NAME}，参数如下：
    - \`cron\`：上表中的 cron 表达式
    - \`prompt\`：上面解析出的提示词，原样传递（斜杠命令保持不变）
    - \`recurring\`：\`true\`
2.  简要确认：安排了什么、cron 表达式、人类可读的执行频率、重复任务将在 ${DEFAULT_MAX_AGE_DAYS} 天后自动过期，以及用户可以通过 ${CRON_DELETE_TOOL_NAME} 提前取消（包含任务 ID）。
3.  **然后立即执行解析出的提示词** —— 不要等待第一次 cron 触发。如果是斜杠命令，则通过 Skill 工具调用；否则直接执行。

## 输入

${args}`
}

export function registerLoopSkill(): void {
  registerBundledSkill({
    name: 'loop',
    description:
      '以固定时间间隔重复运行一个提示词或斜杠命令（例如 /loop 5m /foo，默认为 10m）',
    whenToUse:
      '当用户想要设置重复任务、轮询状态或在固定间隔重复运行某些操作时（例如 "check the deploy every 5 minutes"、"keep running /babysit-prs"）。不要为一次性任务调用。',
    argumentHint: '[interval] <prompt>',
    userInvocable: true,
    isEnabled: isKairosCronEnabled,
    async getPromptForCommand(args) {
      const trimmed = args.trim()
      if (!trimmed) {
        return [{ type: 'text', text: USAGE_MESSAGE }]
      }
      return [{ type: 'text', text: buildPrompt(trimmed) }]
    },
  })
}
