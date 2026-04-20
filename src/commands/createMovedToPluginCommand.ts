import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../commands.js'
import type { ToolUseContext } from '../Tool.js'

type Options = {
  name: string
  description: string
  progressMessage: string
  pluginName: string
  pluginCommand: string
  /** 当市场处于私有状态时使用的提示信息。
外部用户将看到此提示。一旦市场公开，
此参数及备用逻辑即可移除。 */
  getPromptWhileMarketplaceIsPrivate: (
    args: string,
    context: ToolUseContext,
  ) => Promise<ContentBlockParam[]>
}

export function createMovedToPluginCommand({
  name,
  description,
  progressMessage,
  pluginName,
  pluginCommand,
  getPromptWhileMarketplaceIsPrivate,
}: Options): Command {
  return {
    type: 'prompt',
    name,
    description,
    progressMessage,
    contentLength: 0, // 动态内容
    userFacingName() {
      return name
    },
    source: 'builtin',
    async getPromptForCommand(
      args: string,
      context: ToolUseContext,
    ): Promise<ContentBlockParam[]> {
      if (process.env.USER_TYPE === 'ant') {
        return [
          {
            type: 'text',
            text: `此命令已移至插件。请告知用户：

1. 要安装插件，请运行：
   claude plugin install ${pluginName}@claude-code-marketplace

2. 安装后，使用 /${pluginName}:${pluginCommand} 来运行此命令

3. 更多信息，请参阅：https://github.com/anthropics/claude-code-marketplace/blob/main/${pluginName}/README.md

请勿尝试运行该命令。只需告知用户有关插件安装的信息。`,
          },
        ]
      }

      return getPromptWhileMarketplaceIsPrivate(args, context)
    },
  }
}
