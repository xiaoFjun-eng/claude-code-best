import type { Command, LocalCommandCall } from '../../types/command.js'
import { getWorkflowCommands } from '@claude-code-best/builtin-tools/tools/WorkflowTool/createWorkflowCommand.js'
import { getCwd } from '../../utils/cwd.js'

const call: LocalCommandCall = async (_args, _context) => {
  const commands = await getWorkflowCommands(getCwd())
  if (commands.length === 0) {
    return {
      type: 'text',
      value: '未找到工作流。请将工作流文件添加到 .claude/workflows/ 目录下（YAML 或 Markdown 格式）。',
    }
  }
  const list = commands.map((cmd) => `  /${cmd.name} - ${cmd.description}`).join('\n')
  return { type: 'text', value: `可用工作流：
${list}` }
}

const workflows = {
  type: 'local',
  name: 'workflows',
  description: '列出可用的工作流脚本',
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default workflows
