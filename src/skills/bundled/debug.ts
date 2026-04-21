import { open, stat } from 'fs/promises'
import { CLAUDE_CODE_GUIDE_AGENT_TYPE } from '@claude-code-best/builtin-tools/tools/AgentTool/built-in/claudeCodeGuideAgent.js'
import { getSettingsFilePathForSource } from 'src/utils/settings/settings.js'
import { enableDebugLogging, getDebugLogPath } from '../../utils/debug.js'
import { errorMessage, isENOENT } from '../../utils/errors.js'
import { formatFileSize } from '../../utils/format.js'
import { registerBundledSkill } from '../bundledSkills.js'

const DEFAULT_DEBUG_LINES_READ = 20
const TAIL_READ_BYTES = 64 * 1024

export function registerDebugSkill(): void {
  registerBundledSkill({
    name: 'debug',
    description:
      process.env.USER_TYPE === 'ant'
        ? '通过读取会话调试日志来调试你当前的 Claude Code 会话。包含所有事件日志记录。'
        : '为此会话启用调试日志记录，以帮助诊断问题。',
    allowedTools: ['Read', 'Grep', 'Glob'],
    argumentHint: '[问题描述]',
    // 禁用模型调用（disableModelInvocation），以
    // 便用户在交互模式下必须显式请求它，并且描述不会占用上下文。
    disableModelInvocation: true,
    userInvocable: true,
    async getPromptForCommand(args) {
      // 默认情况下，非蚂蚁（Non-ants）不写入调试日志——现在
      // 开启日志记录，以便捕获此会话中的后续活动。
      const wasAlreadyLogging = enableDebugLogging()
      const debugLogPath = getDebugLogPath()

      let logInfo: string
      try {
        // 跟踪日志尾部而无需读取整个文件——调试日志在长时间
        // 会话中会无限增长，完整读取它们会导致 RSS 飙升。
        const stats = await stat(debugLogPath)
        const readSize = Math.min(stats.size, TAIL_READ_BYTES)
        const startOffset = stats.size - readSize
        const fd = await open(debugLogPath, 'r')
        try {
          const { buffer, bytesRead } = await fd.read({
            buffer: Buffer.alloc(readSize),
            position: startOffset,
          })
          const tail = buffer
            .toString('utf-8', 0, bytesRead)
            .split('\n')
            .slice(-DEFAULT_DEBUG_LINES_READ)
            .join('\n')
          logInfo = `日志大小：${formatFileSize(stats.size)}

### 最后 ${DEFAULT_DEBUG_LINES_READ} 行

\`\`\`
${tail}
\`\`\``
        } finally {
          await fd.close()
        }
      } catch (e) {
        logInfo = isENOENT(e)
          ? '调试日志尚不存在——日志记录功能刚刚启用。'
          : `读取调试日志最后 ${DEFAULT_DEBUG_LINES_READ} 行失败：${errorMessage(e)}`
      }

      const justEnabledSection = wasAlreadyLogging
        ? ''
        : `
## 调试日志记录刚刚启用

在此之前，此会话的调试日志记录处于关闭状态。本次 /debug 调用之前的所有内容均未被捕获。

告知用户调试日志记录现已在 \`${debugLogPath}\` 处激活，请他们复现问题，然后重新读取日志。如果他们无法复现，也可以使用 \`claude --debug\` 重启以从启动时捕获日志。
`

      const prompt = `# 调试技能

帮助用户调试他们在当前 Claude Code 会话中遇到的问题。
${justEnabledSection}
## 会话调试日志

当前会话的调试日志位于：\`${debugLogPath}\`

${logInfo}

如需更多上下文，请在整个文件中 grep 查找 [ERROR] 和 [WARN] 行。

## 问题描述

${args || 'The user did not describe a specific issue. Read the debug log and summarize any errors, warnings, or notable issues.'}

## 设置

请记住，设置位于：
* 用户 - ${getSettingsFilePathForSource('userSettings')}
* 项目 - ${getSettingsFilePathForSource('projectSettings')}
* 本地 - ${getSettingsFilePathForSource('localSettings')}

## 说明

1. 查看用户的问题描述
2. 最后 ${DEFAULT_DEBUG_LINES_READ} 行展示了调试文件的格式。在整个文件中查找 [ERROR] 和 [WARN] 条目、堆栈跟踪和失败模式
3. 考虑启动 ${CLAUDE_CODE_GUIDE_AGENT_TYPE} 子代理以了解相关的 Claude Code 功能
4. 用通俗易懂的语言解释你的发现
5. 建议具体的修复方法或后续步骤
`
      return [{ type: 'text', text: prompt }]
    },
  })
}
