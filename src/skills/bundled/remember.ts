import { isAutoMemoryEnabled } from '../../memdir/paths.js'
import { registerBundledSkill } from '../bundledSkills.js'

export function registerRememberSkill(): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  const SKILL_PROMPT = `# 内存审查

## 目标
审查用户的内存状况，并按操作类型分组，生成一份清晰的建议变更报告。请勿应用变更——仅提供建议供用户批准。

## 步骤

### 1. 收集所有内存层
从项目根目录读取 CLAUDE.md 和 CLAUDE.local.md 文件（如果存在）。你的自动记忆内容已在系统提示中——请在那里查看。注意是否存在团队记忆部分（如果有的话）。

**成功标准**：你已获取所有内存层的内容，并能进行比较。

### 2. 对每条自动记忆条目进行分类
对于自动记忆中的每条实质性条目，确定其最佳归属地：

| 归属地 | 应存放的内容 | 示例 |
|---|---|---|
| **CLAUDE.md** | 所有贡献者都应遵循的、面向 Claude 的项目约定和指令 | "使用 bun 而非 npm"、"API 路由使用 kebab-case"、"测试命令是 bun test"、"优先使用函数式风格" |
| **CLAUDE.local.md** | 仅适用于此用户的、面向 Claude 的个人指令，不适用于其他贡献者 | "我偏好简洁的回复"、"始终解释权衡利弊"、"不要自动提交"、"提交前运行测试" |
| **团队记忆** | 适用于跨仓库的组织级知识（仅在团队记忆已配置时） | "部署 PR 需经过 #deploy-queue"、"预发布环境在 staging.internal"、"平台团队负责基础设施" |
| **保留在自动记忆中** | 工作笔记、临时上下文，或明显不适合其他地方的条目 | 特定会话的观察、不确定的模式 |

**重要区别**：
- CLAUDE.md 和 CLAUDE.local.md 包含的是给 Claude 的指令，而不是用户对外部工具的个人偏好（编辑器主题、IDE 快捷键等不属于这两者）
- 工作流实践（PR 约定、合并策略、分支命名）是模糊的——询问用户这些是个人偏好还是团队通用的
- 不确定时，请询问而非猜测

**成功标准**：每条条目都有一个建议的归属地，或被标记为模糊不清。

### 3. 识别清理机会
扫描所有内存层，查找：
- **重复项**：自动记忆条目已存在于 CLAUDE.md 或 CLAUDE.local.md 中 → 建议从自动记忆中移除
- **过时项**：CLAUDE.md 或 CLAUDE.local.md 中的条目被较新的自动记忆条目所否定 → 建议更新旧的内存层
- **冲突项**：任意两个内存层之间存在矛盾 → 提出解决方案，并注明哪个更新

**成功标准**：识别出所有跨层问题。

### 4. 呈现报告
按操作类型分组输出一份结构化报告：
1. **提升项** —— 需要移动的条目，附带目标归属地和理由
2. **清理项** —— 需要解决的重复项、过时项、冲突项
3. **模糊项** —— 你需要用户就归属地提供意见的条目
4. **无需操作项** —— 简要说明应保持原状的条目

如果自动记忆为空，请说明并提供审查 CLAUDE.md 以进行清理的选项。

**成功标准**：用户可以逐条审查并批准/拒绝每个建议。

## 规则
- 在进行任何更改之前，呈现所有建议
- 未经用户明确批准，请勿修改文件
- 除非目标文件尚不存在，否则请勿创建新文件
- 询问模糊条目——不要猜测`

  registerBundledSkill({
    name: 'remember',
    description:
      '审查自动记忆条目，并建议将其提升到 CLAUDE.md、CLAUDE.local.md 或共享内存中。同时检测各内存层之间过时、冲突和重复的条目。',
    whenToUse:
      '当用户想要审查、整理或提升其自动记忆条目时使用。也适用于清理 CLAUDE.md、CLAUDE.local.md 和自动记忆之间过时或冲突的条目。',
    userInvocable: true,
    isEnabled: () => isAutoMemoryEnabled(),
    async getPromptForCommand(args) {
      let prompt = SKILL_PROMPT

      if (args) {
        prompt += `
## 来自用户的额外上下文

${args}`
      }

      return [{ type: 'text', text: prompt }]
    },
  })
}
