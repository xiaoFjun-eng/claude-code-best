import {
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
  isKairosCronEnabled,
} from '@claude-code-best/builtin-tools/tools/ScheduleCronTool/prompt.js'
import { registerBundledSkill } from '../bundledSkills.js'

export function registerCronListSkill(): void {
  registerBundledSkill({
    name: 'cron-list',
    description: '列出此会话中所有已计划的定时任务',
    whenToUse:
      '当用户想要查看其计划/重复任务、检查活动的定时任务或查看当前正在循环执行的任务时。',
    userInvocable: true,
    isEnabled: isKairosCronEnabled,
    async getPromptForCommand() {
      return [
        {
          type: 'text',
          text: `调用 ${CRON_LIST_TOOL_NAME} 以列出所有已计划的定时任务。将结果显示在包含以下列的表格中：ID、计划时间、提示、是否重复、是否持久。如果不存在任务，则显示“没有计划任务。”`,
        },
      ]
    },
  })
}

export function registerCronDeleteSkill(): void {
  registerBundledSkill({
    name: 'cron-delete',
    description: '根据 ID 取消一个已计划的定时任务',
    whenToUse:
      '当用户想要取消、停止或移除一个计划/重复任务或定时任务时。',
    argumentHint: '<job-id>',
    userInvocable: true,
    isEnabled: isKairosCronEnabled,
    async getPromptForCommand(args) {
      const id = args.trim()
      if (!id) {
        return [
          {
            type: 'text',
            text: `用法：/cron-delete <任务ID>

提供要取消的任务 ID。使用 /cron-list 查看活动任务及其 ID。`,
          },
        ]
      }
      return [
        {
          type: 'text',
          text: `使用 id "${id}" 调用 ${CRON_DELETE_TOOL_NAME} 以取消该计划任务。向用户确认结果。`,
        },
      ]
    },
  })
}
