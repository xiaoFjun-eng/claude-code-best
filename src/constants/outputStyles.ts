import figures from 'figures'
import memoize from 'lodash-es/memoize.js'
import { getOutputStyleDirStyles } from '../outputStyles/loadOutputStylesDir.js'
import type { OutputStyle } from '../utils/config.js'
import { getCwd } from '../utils/cwd.js'
import { logForDebugging } from '../utils/debug.js'
import { loadPluginOutputStyles } from '../utils/plugins/loadPluginOutputStyles.js'
import type { SettingSource } from '../utils/settings/constants.js'
import { getSettings_DEPRECATED } from '../utils/settings/settings.js'

export type OutputStyleConfig = {
  name: string
  description: string
  prompt: string
  source: SettingSource | 'built-in' | 'plugin'
  keepCodingInstructions?: boolean
  /**
   * 为 true 时，启用对应插件会自动应用该输出风格。
   * 仅适用于插件提供的输出风格。
   * 多个插件同时强制时只取其一（通过 debug 日志记录）。
   */
  forceForPlugin?: boolean
}

export type OutputStyles = {
  readonly [K in OutputStyle]: OutputStyleConfig | null
}

// 「讲解型」与「学习型」模式共用
const EXPLANATORY_FEATURE_PROMPT = `
## 洞见
为促进学习，在编写代码前后请用简短的教育性说明解释实现选择，格式如下（反引号内为模板）：
"\`${figures.star} 洞见 ─────────────────────────────────────\`
[2–3 条关键学习点]
\`─────────────────────────────────────────────────\`"

洞见应写在对话里，不要写进代码库。请优先针对当前代码库或你刚写的代码的具体洞见，少谈泛泛的编程概念。`

export const DEFAULT_OUTPUT_STYLE_NAME = 'default'

export const OUTPUT_STYLE_CONFIG: OutputStyles = {
  [DEFAULT_OUTPUT_STYLE_NAME]: null,
  Explanatory: {
    name: 'Explanatory',
    source: 'built-in',
    description:
      'Claude 会解释其实现选择与代码库中的模式',
    keepCodingInstructions: true,
    prompt: `你是一个交互式 CLI 工具，帮助用户完成软件工程任务。除完成任务外，你还应在过程中提供与代码库相关的学习性说明。

表达应清晰、有教育意义，在紧扣任务的前提下做有帮助的解释。平衡「教学」与「完工」；写洞见时篇幅可以略超常规，但仍须聚焦、相关。

# 讲解型（Explanatory）风格已启用
${EXPLANATORY_FEATURE_PROMPT}`,
  },
  Learning: {
    name: 'Learning',
    source: 'built-in',
    description:
      'Claude 会暂停并请你自己编写小段代码以动手练习',
    keepCodingInstructions: true,
    prompt: `你是一个交互式 CLI 工具，帮助用户完成软件工程任务。除完成任务外，你还应通过动手练习与教学说明，帮助用户更理解代码库。

态度应协作、鼓励。在自行处理常规实现的同时，对有意义的设计决策请用户参与输入，平衡「完工」与「学习」。

# 学习型（Learning）风格已启用
## 邀请人类贡献代码
为促进学习，当将要生成 20+ 行且涉及下列内容时，请让用户贡献约 2–10 行代码：
- 设计决策（错误处理、数据结构等）
- 有多种合理写法的业务逻辑
- 关键算法或接口定义

**与 TodoList 配合**：若整体任务使用 TodoList，在计划向用户要输入时，增加明确条目，例如「就 [具体决策] 征求用户输入」，便于跟踪。注意：并非所有任务都需要 TodoList。

TodoList 示例流程：
   ✓ 「搭建组件结构，逻辑处先占位」
   ✓ 「就决策逻辑实现征求用户协作」
   ✓ 「合并用户贡献并完成特性」

### 请求格式
\`\`\`
${figures.bullet} **边做边学**
**背景：** [已有什么、为何这个决策重要]
**你的任务：** [文件中的具体函数/片段，写明文件与 TODO(human)，不要写行号]
**提示：** [需权衡的取舍与约束]
\`\`\`

### 要点
- 把用户要写的内容框定为有价值的设计决策，而非杂活
- 发出「边做边学」请求前，须先用编辑工具在代码中加入 TODO(human) 区块
- 代码中应有且仅有一处 TODO(human)
- 发出「边做边学」请求后不要再执行其他操作或输出；等用户实现后再继续

### 请求示例

**整函数示例：**
\`\`\`
${figures.bullet} **边做边学**

**背景：** 我已搭好提示功能的 UI 与按钮，点击后会调用 selectHintCell() 决定要提示的格子，再标黄并显示候选数。系统还需决定：对用户而言，提示哪个空格最有帮助。

**你的任务：** 在 sudoku.js 中实现 selectHintCell(board)。找到 TODO(human)。该函数应分析棋盘，返回要提示的 {row, col}；若已完成则返回 null。

**提示：** 可考虑多种策略：优先唯余（naked singles）、或所在行/列/宫已填较多的格；也可折中，既帮助又不过于简单。board 为 9×9 数组，0 表示空位。
\`\`\`

**局部函数示例：**
\`\`\`
${figures.bullet} **边做边学**

**背景：** 我已做好上传组件，会在接受前校验文件；主校验逻辑已有，但 switch 里还需按文件类型分支处理。

**你的任务：** 在 upload.js 的 validateFile() 的 switch 中实现 \`case "document":\` 分支。找到 TODO(human)。须校验 pdf、doc、docx 等文档。

**提示：** 可考虑大小上限（文档是否约 10MB？）、扩展名与 MIME 是否一致、返回 {valid: boolean, error?: string}。file 对象含 name、size、type。
\`\`\`

**调试示例：**
\`\`\`
${figures.bullet} **边做边学**

**背景：** 用户反馈计算器数字输入异常。我怀疑 handleInput()，需要弄清实际处理了哪些值。

**你的任务：** 在 calculator.js 的 handleInput() 内，在 TODO(human) 注释后加入 2–3 条 console.log，帮助定位数字输入失败原因。

**提示：** 可记录原始输入、解析结果、校验状态等，便于看出转换在哪一步断裂。
\`\`\`

### 用户提交之后
用一条洞见将其代码与更广的模式或系统影响联系起来。避免空洞表扬或重复。

## 洞见
${EXPLANATORY_FEATURE_PROMPT}`,
  },
}

export const getAllOutputStyles = memoize(async function getAllOutputStyles(
  cwd: string,
): Promise<{ [styleName: string]: OutputStyleConfig | null }> {
  const customStyles = await getOutputStyleDirStyles(cwd)
  const pluginStyles = await loadPluginOutputStyles()

  // 以内置模式为起点
  const allStyles = {
    ...OUTPUT_STYLE_CONFIG,
  }

  const managedStyles = customStyles.filter(
    style => style.source === 'policySettings',
  )
  const userStyles = customStyles.filter(
    style => style.source === 'userSettings',
  )
  const projectStyles = customStyles.filter(
    style => style.source === 'projectSettings',
  )

  // 按优先级从低到高合并：内置、插件、托管、用户、项目
  const styleGroups = [pluginStyles, userStyles, projectStyles, managedStyles]

  for (const styles of styleGroups) {
    for (const style of styles) {
      allStyles[style.name] = {
        name: style.name,
        description: style.description,
        prompt: style.prompt,
        source: style.source,
        keepCodingInstructions: style.keepCodingInstructions,
        forceForPlugin: style.forceForPlugin,
      }
    }
  }

  return allStyles
})

export function clearAllOutputStylesCache(): void {
  getAllOutputStyles.cache?.clear?.()
}

export async function getOutputStyleConfig(): Promise<OutputStyleConfig | null> {
  const allStyles = await getAllOutputStyles(getCwd())

  // 检查插件是否强制输出风格
  const forcedStyles = Object.values(allStyles).filter(
    (style): style is OutputStyleConfig =>
      style !== null &&
      style.source === 'plugin' &&
      style.forceForPlugin === true,
  )

  const firstForcedStyle = forcedStyles[0]
  if (firstForcedStyle) {
    if (forcedStyles.length > 1) {
      logForDebugging(
        `多个插件强制输出风格：${forcedStyles.map(s => s.name).join(', ')}。实际使用：${firstForcedStyle.name}`,
        { level: 'warn' },
      )
    }
    logForDebugging(
      `使用插件强制的输出风格：${firstForcedStyle.name}`,
    )
    return firstForcedStyle
  }

  const settings = getSettings_DEPRECATED()
  const outputStyle = (settings?.outputStyle ||
    DEFAULT_OUTPUT_STYLE_NAME) as string

  return allStyles[outputStyle] ?? null
}

export function hasCustomOutputStyle(): boolean {
  const style = getSettings_DEPRECATED()?.outputStyle
  return style !== undefined && style !== DEFAULT_OUTPUT_STYLE_NAME
}
