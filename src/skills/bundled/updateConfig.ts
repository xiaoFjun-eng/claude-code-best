import { toJSONSchema } from 'zod/v4'
import { SettingsSchema } from '../../utils/settings/types.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { registerBundledSkill } from '../bundledSkills.js'

/**
 * 根据设置 Zod 模式生成 JSON Schema。
 * 这使技能提示与实际类型保持同步。
 */
function generateSettingsSchema(): string {
  const jsonSchema = toJSONSchema(SettingsSchema(), { io: 'input' })
  return jsonStringify(jsonSchema, null, 2)
}

const SETTINGS_EXAMPLES_DOCS = `## 设置文件位置

根据作用范围选择合适的文件：

| 文件 | 作用范围 | Git 版本控制 | 用途 |
|------|---------|-------------|------|
| \`~/.claude/settings.json\` | 全局 | 不适用 | 适用于所有项目的个人偏好 |
| \`.claude/settings.json\` | 项目 | 提交 | 团队级钩子、权限、插件 |
| \`.claude/settings.local.json\` | 项目 | .gitignore 忽略 | 当前项目的个人覆盖配置 |

设置加载顺序：用户 → 项目 → 本地（后加载的会覆盖前值）。

## 设置模式参考

### 权限
\`\`\`json
{
  "permissions": {
    "allow": ["Bash(npm:*)", "Edit(.claude)", "Read"],
    "deny": ["Bash(rm -rf:*)"],
    "ask": ["Write(/etc/*)"],
    "defaultMode": "default" | "plan" | "acceptEdits" | "dontAsk",
    "additionalDirectories": ["/extra/dir"]
  }
}
\`\`\`

**权限规则语法：**
- 精确匹配：\`"Bash(npm run test)"\`
- 前缀通配：\`"Bash(git:*)"\` —— 匹配 \`git status\`、\`git commit\` 等
- 仅工具名：\`"Read"\` —— 允许所有 Read 操作

### 环境变量
\`\`\`json
{
  "env": {
    "DEBUG": "true",
    "MY_API_KEY": "value"
  }
}
\`\`\`

### 模型与代理
\`\`\`json
{
  "model": "sonnet",  // 或 "opus"、"haiku"，或完整模型 ID
  "agent": "agent-name",
  "alwaysThinkingEnabled": true
}
\`\`\`

### 归属信息（提交与 PR）
\`\`\`json
{
  "attribution": {
    "commit": "自定义提交附加说明文本",
    "pr": "自定义 PR 描述文本"
  }
}
\`\`\`
将 \`commit\` 或 \`pr\` 设为空字符串 \`""\` 可隐藏对应的归属信息。

### MCP 服务器管理
\`\`\`json
{
  "enableAllProjectMcpServers": true,
  "enabledMcpjsonServers": ["server1", "server2"],
  "disabledMcpjsonServers": ["blocked-server"]
}
\`\`\`

### 插件
\`\`\`json
{
  "enabledPlugins": {
    "formatter@anthropic-tools": true
  }
}
\`\`\`
插件语法：\`plugin-name@source\`，其中 source 可以是 \`claude-code-marketplace\`、\`claude-plugins-official\` 或 \`builtin\`。

### 其他设置
- \`language\`：首选回复语言（例如 "japanese"）
- \`cleanupPeriodDays\`：保留对话记录的天数（默认 30；设为 0 则完全禁用持久化）
- \`respectGitignore\`：是否遵守 .gitignore（默认 true）
- \`spinnerTipsEnabled\`：在加载动画中显示提示
- \`spinnerVerbs\`：自定义加载动画动词（\`{ "mode": "append" | "replace", "verbs": [...] }\`）
- \`spinnerTipsOverride\`：覆盖加载动画提示（\`{ "excludeDefault": true, "tips": ["自定义提示"] }\`）
- \`syntaxHighlightingDisabled\`：禁用差异高亮
`

// 注意：我们保留手写的常见模式示例，因为它们比自动生成的模式文档更实用。
// 生成的模式列表提供了完整性，而示例提供了清晰性。

const HOOKS_DOCS = `## 钩子配置

钩子在 Claude Code 生命周期的特定时刻运行命令。

### 钩子结构
\`\`\`json
{
  "hooks": {
    "EVENT_NAME": [
      {
        "matcher": "ToolName|OtherTool",
        "hooks": [
          {
            "type": "command",
            "command": "your-command-here",
            "timeout": 60,
            "statusMessage": "运行中..."
          }
        ]
      }
    ]
  }
}
\`\`\`

### 钩子事件

| 事件 | 匹配器 | 用途 |
|------|--------|------|
| PermissionRequest | 工具名称 | 在权限提示之前运行 |
| PreToolUse | 工具名称 | 在工具之前运行，可以阻止执行 |
| PostToolUse | 工具名称 | 工具成功运行后执行 |
| PostToolUseFailure | 工具名称 | 工具运行失败后执行 |
| Notification | 通知类型 | 收到通知时运行 |
| Stop | - | Claude 停止时运行（包括清除、恢复、压缩） |
| PreCompact | "manual"/"auto" | 在压缩之前 |
| PostCompact | "manual"/"auto" | 压缩之后（接收摘要） |
| UserPromptSubmit | - | 用户提交提示时 |
| SessionStart | - | 会话开始时 |

**常用工具匹配器：** \`Bash\`、\`Write\`、\`Edit\`、\`Read\`、\`Glob\`、\`Grep\`

### 钩子类型

**1. 命令钩子** - 运行 shell 命令：
\`\`\`json
{ "type": "command", "command": "prettier --write $FILE", "timeout": 30 }
\`\`\`

**2. 提示钩子** - 使用 LLM 评估条件：
\`\`\`json
{ "type": "prompt", "prompt": "Is this safe? $ARGUMENTS" }
\`\`\`
仅可用于工具事件：PreToolUse、PostToolUse、PermissionRequest。

**3. 代理钩子** - 运行带有工具的代理：
\`\`\`json
{ "type": "agent", "prompt": "Verify tests pass: $ARGUMENTS" }
\`\`\`
仅可用于工具事件：PreToolUse、PostToolUse、PermissionRequest。

### 钩子输入（stdin JSON）
\`\`\`json
{
  "session_id": "abc123",
  "tool_name": "Write",
  "tool_input": { "file_path": "/path/to/file.txt", "content": "..." },
  "tool_response": { "success": true }  // 仅 PostToolUse
}
\`\`\`

### 钩子 JSON 输出

钩子可以返回 JSON 以控制行为：

\`\`\`json
{
  "systemMessage": "向用户显示在 UI 中的警告",
  "continue": false,
  "stopReason": "阻止时显示的消息",
  "suppressOutput": false,
  "decision": "block",
  "reason": "决策的解释",
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "注入回模型的上下文"
  }
}
\`\`\`

**字段说明：**
- \`systemMessage\` - 向用户显示一条消息（所有钩子）
- \`continue\` - 设为 \`false\` 以阻止/停止（默认 true）
- \`stopReason\` - 当 \`continue\` 为 false 时显示的消息
- \`suppressOutput\` - 从对话记录中隐藏标准输出（默认 false）
- \`decision\` - 用于 PostToolUse/Stop/UserPromptSubmit 钩子的 "block"（PreToolUse 中已弃用，请改用 hookSpecificOutput.permissionDecision）
- \`reason\` - 决策的解释
- \`hookSpecificOutput\` - 特定事件的输出（必须包含 \`hookEventName\`）：
  - \`additionalContext\` - 注入模型上下文的文本
  - \`permissionDecision\` - "allow"、"deny" 或 "ask"（仅 PreToolUse）
  - \`permissionDecisionReason\` - 权限决策的原因（仅 PreToolUse）
  - \`updatedInput\` - 修改后的工具输入（仅 PreToolUse）

### 常见模式

**写入后自动格式化：**
\`\`\`json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "jq -r '.tool_response.filePath // .tool_input.file_path' | { read -r f; prettier --write \\"$f\\"; } 2>/dev/null || true"
      }]
    }]
  }
}
\`\`\`

**记录所有 bash 命令：**
\`\`\`json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "jq -r '.tool_input.command' >> ~/.claude/bash-log.txt"
      }]
    }]
  }
}
\`\`\`

**向用户显示消息的停止钩子：**

命令必须输出包含 \`systemMessage\` 字段的 JSON：
\`\`\`bash
# 示例命令输出：{"systemMessage": "会话完成！"}
echo '{"systemMessage": "会话完成！"}'
\`\`\`

**代码更改后运行测试：**
\`\`\`json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "jq -r '.tool_input.file_path // .tool_response.filePath' | grep -E '\\\\.(ts|js)$' && npm test || true"
      }]
    }]
  }
}
\`\`\`
`

const HOOK_VERIFICATION_FLOW = `## 构建钩子（含验证）

给定事件、匹配器、目标文件和所需行为，请遵循以下流程。每个步骤都能捕获不同的失败类型 —— 一个静默无效的钩子比没有钩子更糟糕。

1. **重复检查**。读取目标文件。如果同一事件+匹配器上已存在钩子，显示现有命令并询问：保留、替换或额外添加。

2. **为当前项目构建命令 —— 不要假设**。钩子从标准输入接收 JSON。构建一个命令：
   - 安全地提取任何需要的负载 —— 使用 \`jq -r\` 赋给带引号的变量，或使用 \`{ read -r f; ... "$f"; }\`，不要使用未加引号的 \`| xargs\`（会在空格处分割）
   - 以该项目运行底层工具的方式调用它（npx/bunx/yarn/pnpm？Makefile 目标？全局安装？）
   - 跳过工具不处理的输入（格式化工具通常有 \`--ignore-unknown\`；如果没有，按扩展名进行防护）
   - 保持原始状态 —— 暂时不要加 \`|| true\`，不要抑制标准错误。等管道测试通过后再包装。

3. **管道测试原始命令**。合成钩子将收到的 stdin 负载并直接管道传输：
   - \`Pre|PostToolUse\` 作用于 \`Write|Edit\`：\`echo '{"tool_name":"Edit","tool_input":{"file_path":"<此仓库中的真实文件>"}}' | <cmd>\`
   - \`Pre|PostToolUse\` 作用于 \`Bash\`：\`echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | <cmd>\`
   - \`Stop\`/\`UserPromptSubmit\`/\`SessionStart\`：大多数命令不读取 stdin，因此 \`echo '{}' | <cmd>\` 即可

   检查退出代码和副作用（文件是否实际格式化、测试是否实际运行）。如果失败，你会得到真实的错误 —— 修复（包管理器不对？工具未安装？jq 路径错误？）并重新测试。一旦成功，用 \`2>/dev/null || true\` 包装（除非用户想要阻塞检查）。

4. **编写 JSON**。合并到目标文件中（模式结构见上文“钩子结构”部分）。如果这是首次创建 \`.claude/settings.local.json\`，请将其添加到 .gitignore —— Write 工具不会自动忽略它。

5. **一次性验证语法 + 模式**：

   \`jq -e '.hooks.<event>[] | select(.matcher == "<matcher>") | .hooks[] | select(.type == "command") | .command' <target-file>\`

   退出码 0 且输出你的命令 = 正确。退出码 4 = 匹配器不匹配。退出码 5 = JSON 格式错误或嵌套错误。损坏的 settings.json 会静默禁用该文件的所有设置 —— 也要修复任何预先存在的格式错误。

6. **证明钩子会触发** —— 仅适用于 \`Pre|PostToolUse\` 且匹配器可以按顺序触发（\`Write|Edit\` 通过 Edit，\`Bash\` 通过 Bash）。\`Stop\`/\`UserPromptSubmit\`/\`SessionStart\` 在此轮次之外触发 —— 跳到第 7 步。

   对于 **格式化钩子** 在 \`PostToolUse\`/\`Write|Edit\` 上：通过 Edit 引入一个可检测的违规（两个连续空行、错误的缩进、缺失分号 —— 此格式化工具会修正的内容；不要用尾随空格，Edit 会在写入前将其去除），重新读取，确认钩子**修复**了它。对于**其他任何内容**：在 settings.json 中的命令前临时加上 \`echo "$(date) hook fired" >> /tmp/claude-hook-check.txt; \`，触发匹配的工具（Edit 对应 \`Write|Edit\`，无害的 \`true\` 对应 \`Bash\`），读取标记文件。

   **始终清理** —— 还原违规，去除临时前缀，无论证明通过还是失败。

   **如果证明失败但管道测试通过且 \`jq -e\` 通过**：设置监视器未监视 \`.claude/\` —— 它只监视会话启动时已存在设置文件的目录。钩子已正确写入。告诉用户打开 \`/hooks\` 一次（重新加载配置）或重启 —— 你无法自行完成；\`/hooks\` 是用户 UI 菜单，打开它会结束本轮对话。

7. **移交**。告诉用户钩子已生效（或需要按监视器注意事项执行 \`/hooks\`/重启）。指出 \`/hooks\` 供以后查看、编辑或禁用。UI 仅当钩子出错或缓慢时才会显示“运行了 N 个钩子” —— 静默成功在设计上是不可见的。
`

const UPDATE_CONFIG_PROMPT = `# 更新配置技能

通过修改 settings.json 文件来配置 Claude Code 工具。

## 何时需要钩子（而非记忆）

如果用户希望某些操作在响应**事件**时自动发生，则需要在 settings.json 中配置**钩子**。记忆/偏好设置无法触发自动化操作。

**以下情况需要钩子：**
- “压缩前，问我需要保留什么” → PreCompact 钩子
- “写入文件后，运行 prettier” → PostToolUse 钩子，匹配器为 Write|Edit
- “我运行 bash 命令时，记录下来” → PreToolUse 钩子，匹配器为 Bash
- “代码更改后始终运行测试” → PostToolUse 钩子

**钩子事件：** PreToolUse、PostToolUse、PreCompact、PostCompact、Stop、Notification、SessionStart

## 关键：先读后写

**在修改现有设置文件之前，始终先读取它。** 将新设置与现有设置合并 —— 绝不替换整个文件。

## 关键：存在歧义时使用 AskUserQuestion

当用户的请求不明确时，使用 AskUserQuestion 来澄清：
- 要修改哪个设置文件（用户/项目/本地）
- 是添加到现有数组还是替换它们
- 当有多个选项时的具体值

## 决策：使用 Config 工具还是直接编辑

**对于以下简单设置，使用 Config 工具：**
- \`theme\`、\`editorMode\`、\`verbose\`、\`model\`
- \`language\`、\`alwaysThinkingEnabled\`
- \`permissions.defaultMode\`

**对于以下情况，直接编辑 settings.json：**
- 钩子（PreToolUse、PostToolUse 等）
- 复杂的权限规则（allow/deny 数组）
- 环境变量
- MCP 服务器配置
- 插件配置

## 工作流程

1. **明确意图** - 如果请求有歧义，先询问
2. **读取现有文件** - 使用 Read 工具读取目标设置文件
3. **仔细合并** - 保留现有设置，特别是数组
4. **编辑文件** - 使用 Edit 工具（如果文件不存在，请先要求用户创建）
5. **确认** - 告诉用户更改了什么

## 合并数组（重要！）

当向权限数组或钩子数组添加内容时，**合并**到现有内容，而不是替换：

**错误**（替换现有权限）：
\`\`\`json
{ "permissions": { "allow": ["Bash(npm:*)"] } }
\`\`\`

**正确**（保留现有 + 添加新项）：
\`\`\`json
{
  "permissions": {
    "allow": [
      "Bash(git:*)",      // 已有
      "Edit(.claude)",    // 已有
      "Bash(npm:*)"       // 新增
    ]
  }
}
\`\`\`

${SETTINGS_EXAMPLES_DOCS}

${HOOKS_DOCS}

${HOOK_VERIFICATION_FLOW}

## 工作流示例

### 添加钩子

用户：“Claude 写完代码后格式化我的代码”

1. **澄清**：使用哪个格式化工具？（prettier、gofmt 等）
2. **读取**：\`.claude/settings.json\`（如果不存在则创建）
3. **合并**：添加到现有钩子中，不要替换
4. **结果**：
\`\`\`json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "jq -r '.tool_response.filePath // .tool_input.file_path' | { read -r f; prettier --write \\"$f\\"; } 2>/dev/null || true"
      }]
    }]
  }
}
\`\`\`

### 添加权限

用户：“允许 npm 命令，无需提示”

1. **读取**：现有权限
2. **合并**：将 \`Bash(npm:*)\` 添加到 allow 数组
3. **结果**：与现有允许项合并

### 环境变量

用户：“设置 DEBUG=true”

1. **决定**：用户设置（全局）还是项目设置？
2. **读取**：目标文件
3. **合并**：添加到 env 对象
\`\`\`json
{ "env": { "DEBUG": "true" } }
\`\`\`

## 常见错误避免

1. **替换而不是合并** - 始终保留现有设置
2. **错误的文件** - 如果作用范围不明确，询问用户
3. **无效的 JSON** - 更改后验证语法
4. **忘记先读取** - 始终先读后写

## 钩子故障排除

如果钩子没有运行：
1. **检查设置文件** - 读取 ~/.claude/settings.json 或 .claude/settings.json
2. **验证 JSON 语法** - 无效的 JSON 会静默失败
3. **检查匹配器** - 是否匹配工具名称？（例如 "Bash"、"Write"、"Edit"）
4. **检查钩子类型** - 是 "command"、"prompt" 还是 "agent"？
5. **测试命令** - 手动运行钩子命令，看是否有效
6. **使用 --debug** - 运行 \`claude --debug\` 查看钩子执行日志
`

export function registerUpdateConfigSkill(): void {
  registerBundledSkill({
    name: 'update-config',
    description:
      '使用此技能通过 settings.json 配置 Claude Code 工具。自动化行为（“从现在起当 X 时”、“每次 X 时”、“每当 X 时”、“在 X 之前/之后”）需要在 settings.json 中配置钩子 —— 工具执行这些钩子，而不是 Claude，因此记忆/偏好无法满足它们。也用于：权限（“允许 X”、“添加权限”、“将权限移动到”）、环境变量（“设置 X=Y”）、钩子故障排除或任何对 settings.json/settings.local.json 文件的更改。示例：“允许 npm 命令”、“向全局设置添加 bq 权限”、“将权限移动到用户设置”、“设置 DEBUG=true”、“当 claude 停止时显示 X”。对于简单的设置如 theme/model，请使用 Config 工具。',
    allowedTools: ['Read'],
    userInvocable: true,
    async getPromptForCommand(args) {
      if (args.startsWith('[hooks-only]')) {
        const req = args.slice('[hooks-only]'.length).trim()
        let prompt = HOOKS_DOCS + '\n\n' + HOOK_VERIFICATION_FLOW
        if (req) {
          prompt += `\n\n## 任务\n\n${req}`
        }
        return [{ type: 'text', text: prompt }]
      }

      // 动态生成模式以保持与类型同步
      const jsonSchema = generateSettingsSchema()

      let prompt = UPDATE_CONFIG_PROMPT
      prompt += `\n\n## 完整设置 JSON 模式\n\n\`\`\`json\n${jsonSchema}\n\`\`\``

      if (args) {
        prompt += `\n\n## 用户请求\n\n${args}`
      }

      return [{ type: 'text', text: prompt }]
    },
  })
}