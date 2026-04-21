import { DEFAULT_BINDINGS } from '../../keybindings/defaultBindings.js'
import { isKeybindingCustomizationEnabled } from '../../keybindings/loadUserBindings.js'
import {
  MACOS_RESERVED,
  NON_REBINDABLE,
  TERMINAL_RESERVED,
} from '../../keybindings/reservedShortcuts.js'
import type { KeybindingsSchemaType } from '../../keybindings/schema.js'
import {
  KEYBINDING_ACTIONS,
  KEYBINDING_CONTEXT_DESCRIPTIONS,
  KEYBINDING_CONTEXTS,
} from '../../keybindings/schema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { registerBundledSkill } from '../bundledSkills.js'

/** 构建所有上下文的 Markdown 表格。 */
function generateContextsTable(): string {
  return markdownTable(
    ['Context', 'Description'],
    KEYBINDING_CONTEXTS.map(ctx => [
      `\`${ctx}\``,
      KEYBINDING_CONTEXT_DESCRIPTIONS[ctx],
    ]),
  )
}

/** 构建所有操作及其默认绑定和上下文的 Markdown 表格。 */
function generateActionsTable(): string {
  // 构建查找表：操作 -> { 按键, 上下文 }
  const actionInfo: Record<string, { keys: string[]; context: string }> = {}
  for (const block of DEFAULT_BINDINGS) {
    for (const [key, action] of Object.entries(block.bindings)) {
      if (action) {
        if (!actionInfo[action as string]) {
          actionInfo[action as string] = { keys: [], context: block.context }
        }
        actionInfo[action as string].keys.push(key)
      }
    }
  }

  return markdownTable(
    ['Action', '默认按键', 'Context'],
    KEYBINDING_ACTIONS.map(action => {
      const info = actionInfo[action]
      const keys = info ? info.keys.map(k => `\`${k}\``).join(', ') : '(none)'
      const context = info ? info.context : inferContextFromAction(action)
      return [`\`${action}\``, keys, context]
    }),
  )
}

/** 当不在 DEFAULT_BINDINGS 中时，根据操作前缀推断上下文。 */
function inferContextFromAction(action: string): string {
  const prefix = action.split(':')[0]
  const prefixToContext: Record<string, string> = {
    app: 'Global',
    history: '全局或聊天',
    chat: 'Chat',
    autocomplete: 'Autocomplete',
    confirm: 'Confirmation',
    tabs: 'Tabs',
    transcript: 'Transcript',
    historySearch: 'HistorySearch',
    task: 'Task',
    theme: 'ThemePicker',
    help: 'Help',
    attachments: 'Attachments',
    footer: 'Footer',
    messageSelector: 'MessageSelector',
    diff: 'DiffDialog',
    modelPicker: 'ModelPicker',
    select: 'Select',
    permission: 'Confirmation',
  }
  return prefixToContext[prefix ?? ''] ?? 'Unknown'
}

/** 构建保留快捷键列表。 */
function generateReservedShortcuts(): string {
  const lines: string[] = []

  lines.push('### 不可重新绑定（错误）')
  for (const s of NON_REBINDABLE) {
    lines.push(`- \`${s.key}\` — ${s.reason}`)
  }

  lines.push('')
  lines.push('### 终端保留（错误/警告）')
  for (const s of TERMINAL_RESERVED) {
    lines.push(
      `- \`${s.key}\` — ${s.reason} (${s.severity === 'error' ? '将无法工作' : '可能冲突'})`,
    )
  }

  lines.push('')
  lines.push('### macOS 保留（错误）')
  for (const s of MACOS_RESERVED) {
    lines.push(`- \`${s.key}\` — ${s.reason}`)
  }

  return lines.join('\n')
}

const FILE_FORMAT_EXAMPLE: KeybindingsSchemaType = {
  $schema: 'https://www.schemastore.org/claude-code-keybindings.json',
  $docs: 'https://code.claude.com/docs/en/keybindings',
  bindings: [
    {
      context: 'Chat',
      bindings: {
        'ctrl+e': 'chat:externalEditor',
      },
    },
  ],
}

const UNBIND_EXAMPLE: KeybindingsSchemaType['bindings'][number] = {
  context: 'Chat',
  bindings: {
    'ctrl+s': null,
  },
}

const REBIND_EXAMPLE: KeybindingsSchemaType['bindings'][number] = {
  context: 'Chat',
  bindings: {
    'ctrl+g': null,
    'ctrl+e': 'chat:externalEditor',
  },
}

const CHORD_EXAMPLE: KeybindingsSchemaType['bindings'][number] = {
  context: 'Global',
  bindings: {
    'ctrl+k ctrl+t': 'app:toggleTodos',
  },
}

const SECTION_INTRO = [
  '# 快捷键技能',
  '',
  '创建或修改 `~/.claude/keybindings.json` 以自定义键盘快捷键。',
  '',
  '## 重要：写入前必读',
  '',
  '**务必先读取 `~/.claude/keybindings.json`**（该文件可能尚不存在）。将更改与现有绑定合并——切勿替换整个文件。',
  '',
  '- 使用 **Edit** 工具修改现有文件',
  '- 仅当文件尚不存在时使用 **Write** 工具',
].join('\n')

const SECTION_FILE_FORMAT = [
  '## 文件格式',
  '',
  '```json',
  jsonStringify(FILE_FORMAT_EXAMPLE, null, 2),
  '```',
  '',
  '始终包含 `$schema` 和 `$docs` 字段。',
].join('\n')

const SECTION_KEYSTROKE_SYNTAX = [
  '## 击键语法',
  '',
  '**修饰键**（用 `+` 组合）：',
  '- `ctrl`（别名：`control`）',
  '- `alt`（别名：`opt`, `option`）——注意：在终端中 `alt` 和 `meta` 是相同的',
  '- `shift`',
  '- `meta`（别名：`cmd`, `command`）',
  '',
  '**特殊键**：`escape`/`esc`, `enter`/`return`, `tab`, `space`, `backspace`, `delete`, `up`, `down`, `left`, `right`',
  '',
  '**和弦**：用空格分隔的击键序列，例如 `ctrl+k ctrl+s`（击键间有 1 秒超时）',
  '',
  '**示例**：`ctrl+shift+p`, `alt+enter`, `ctrl+k ctrl+n`',
].join('\n')

const SECTION_UNBINDING = [
  '## 解除默认快捷键绑定',
  '',
  '将某个键设置为 `null` 以移除其默认绑定：',
  '',
  '```json',
  jsonStringify(UNBIND_EXAMPLE, null, 2),
  '```',
].join('\n')

const SECTION_INTERACTION = [
  '## 用户绑定如何与默认绑定交互',
  '',
  '- 用户绑定是**累加的**——它们会追加在默认绑定之后',
  '- 要将绑定**移动**到不同的键：解除旧键绑定（`null`）并添加新绑定',
  "- 只有当用户想要更改某个上下文中的内容时，该上下文才需要出现在用户的文件中",
].join('\n')

const SECTION_COMMON_PATTERNS = [
  '## 常见模式',
  '',
  '### 重新绑定按键',
  '要将外部编辑器快捷键从 `ctrl+g` 改为 `ctrl+e`：',
  '```json',
  jsonStringify(REBIND_EXAMPLE, null, 2),
  '```',
  '',
  '### 添加和弦绑定',
  '```json',
  jsonStringify(CHORD_EXAMPLE, null, 2),
  '```',
].join('\n')

const SECTION_BEHAVIORAL_RULES = [
  '## 行为规则',
  '',
  '1. 仅包含用户想要更改的上下文（最小化覆盖）',
  '2. 验证操作和上下文是否来自下面已知的列表',
  '3. 如果用户选择的键与保留快捷键或常见工具（如 tmux (`ctrl+b`) 和 screen (`ctrl+a`)）冲突，主动警告用户',
  '4. 为现有操作添加新绑定时，新绑定是累加的（除非显式解除绑定，否则现有默认绑定仍然有效）',
  '5. 要完全替换默认绑定，需解除旧键绑定并添加新绑定',
].join('\n')

const SECTION_DOCTOR = [
  '## 使用 /doctor 进行验证',
  '',
  '`/doctor` 命令包含一个“快捷键配置问题”部分，用于验证 `~/.claude/keybindings.json`。',
  '',
  '### 常见问题及修复',
  '',
  markdownTable(
    ['Issue', 'Cause', 'Fix'],
    [
      [
        '`keybindings.json 必须有一个 "bindings" 数组`',
        '缺少包装对象',
        '将绑定包装在 `{ "bindings": [...] }` 中',
      ],
      [
        '`"bindings" 必须是一个数组`',
        '`bindings` 不是一个数组',
        '将 `"bindings"` 设置为数组：`[{ context: ..., bindings: ... }]`',
      ],
      [
        '`未知上下文 "X"`',
        '拼写错误或无效的上下文名称',
        '使用“可用上下文”表中的确切上下文名称',
      ],
      [
        '`在 Y 绑定中重复的键 "X"`',
        '同一上下文中定义了两次相同的键',
        '移除重复项；JSON 仅使用最后一个值',
      ],
      [
        '`"X" 可能无法工作：...`',
        '按键与终端/操作系统保留快捷键冲突',
        '选择不同的键（参见“保留快捷键”部分）',
      ],
      [
        '`无法解析击键 "X"`',
        '无效的按键语法',
        '检查语法：在修饰键之间使用 `+`，使用有效的键名',
      ],
      [
        '`"X" 的操作无效`',
        '操作值不是字符串或 null',
        '操作必须是像 `"app:help"` 这样的字符串，或是用于解除绑定的 `null`',
      ],
    ],
  ),
  '',
  '### /doctor 输出示例',
  '',
  '```',
  '快捷键配置问题',
  '位置：~/.claude/keybindings.json',
  '  └ [错误] 未知上下文 "chat"',
  '    → 有效上下文：Global, Chat, Autocomplete, ...',
  '  └ [警告] "ctrl+c" 可能无法工作：终端中断 (SIGINT)',
  '```',
  '',
  '**错误**会阻止绑定工作，必须修复。**警告**表示潜在冲突，但绑定可能仍然有效。',
].join('\n')

export function registerKeybindingsSkill(): void {
  registerBundledSkill({
    name: 'keybindings-help',
    description:
      '当用户想要自定义键盘快捷键、重新绑定按键、添加和弦绑定或修改 ~/.claude/keybindings.json 时使用。例如：“重新绑定 ctrl+s”、“添加快捷键和弦”、“更改提交键”、“自定义快捷键”。',
    allowedTools: ['Read'],
    userInvocable: false,
    isEnabled: isKeybindingCustomizationEnabled,
    async getPromptForCommand(args) {
      // 从单一事实来源数组动态生成参考表格
      const contextsTable = generateContextsTable()
      const actionsTable = generateActionsTable()
      const reservedShortcuts = generateReservedShortcuts()

      const sections = [
        SECTION_INTRO,
        SECTION_FILE_FORMAT,
        SECTION_KEYSTROKE_SYNTAX,
        SECTION_UNBINDING,
        SECTION_INTERACTION,
        SECTION_COMMON_PATTERNS,
        SECTION_BEHAVIORAL_RULES,
        SECTION_DOCTOR,
        `## 保留快捷键

${reservedShortcuts}`,
        `## 可用上下文

${contextsTable}`,
        `## 可用操作

${actionsTable}`,
      ]

      if (args) {
        sections.push(`## 用户请求

${args}`)
      }

      return [{ type: 'text', text: sections.join('\n\n') }]
    },
  })
}

/** 根据表头和行数据构建一个 Markdown 表格。 */
function markdownTable(headers: string[], rows: string[][]): string {
  const separator = headers.map(() => '---')
  return [
    `| ${headers.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ].join('\n')
}
