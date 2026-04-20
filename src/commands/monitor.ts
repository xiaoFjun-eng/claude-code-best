/** /monitor <命令> — 启动一个后台监控任务。

MonitorTool 的快捷方式。将一个长时间运行的 shell 命令作为后台任务启动，可在页脚药丸中查看（按 Shift+Down 查看）。

用法：
  /monitor tail -f /var/log/syslog
  /monitor watch -n 5 git status
  /monitor "while true; do curl -s http://localhost:3000/health; sleep 10; done" */
import { feature } from 'bun:bundle'
import type {
  Command,
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../types/command.js'
import type { ToolUseContext } from '../Tool.js'

const monitor = {
  type: 'local-jsx',
  name: 'monitor',
  description: '启动一个后台 shell 监控器（按 Shift+Down 查看）',
  isEnabled: () => {
    if (feature('MONITOR_TOOL')) {
      return true
    }
    return false
  },
  immediate: false,
  userFacingName: () => 'monitor',
  load: () =>
    Promise.resolve({
      async call(
        onDone: LocalJSXCommandOnDone,
        context: ToolUseContext & LocalJSXCommandContext,
        args: string,
      ): Promise<React.ReactNode> {
        let command = args.trim()
        if (!command) {
          onDone(
            process.platform === 'win32'
              ? '用法：/monitor <命令>\n示例：/monitor powershell -c "while(1){git status; Start-Sleep 5}"'
              : '用法：/monitor <命令>\n示例：/monitor watch -n 5 git status',
            { display: 'system' },
          )
          return null
        }

        // Windows 兼容性：将 `watch -n <秒> <命令>` 转换为 PowerShell 循环
        if (process.platform === 'win32') {
          const watchMatch = command.match(/^watch\s+-n\s+(\d+)\s+(.+)$/)
          if (watchMatch) {
            const interval = watchMatch[1]
            const innerCmd = watchMatch[2]
            command = `powershell -c "while(1){${innerCmd}; Start-Sleep ${interval}}"`
          }
        }

        // 动态 require 以保持在功能门控之后
        const { spawnShellTask } =
          require('../tasks/LocalShellTask/LocalShellTask.js') as typeof import('../tasks/LocalShellTask/LocalShellTask.js')
        const { exec } =
          require('../utils/Shell.js') as typeof import('../utils/Shell.js')
        const { getTaskOutputPath } =
          require('../utils/task/diskOutput.js') as typeof import('../utils/task/diskOutput.js')

        try {
          const shellCommand = await exec(
            command,
            context.abortController.signal,
            'bash',
          )

          const handle = await spawnShellTask(
            {
              command,
              description: command,
              shellCommand,
              toolUseId: context.toolUseId ?? `monitor-${Date.now()}`,
              agentId: undefined,
              kind: 'monitor',
            },
            {
              abortController: context.abortController,
              getAppState: context.getAppState,
              setAppState: context.setAppState,
            },
          )

          const outputFile = getTaskOutputPath(handle.taskId)
          onDone(
            `监控已启动 (${handle.taskId})。按 Shift+Down 查看。
输出：${outputFile}`,
            { display: 'system' },
          )
        } catch (err) {
          onDone(
            `监控失败：${err instanceof Error ? err.message : String(err)}`,
            { display: 'system' },
          )
        }

        return null
      },
    }),
} satisfies Command

export default monitor
