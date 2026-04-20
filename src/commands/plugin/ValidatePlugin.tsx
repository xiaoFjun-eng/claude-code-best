import figures from 'figures'
import * as React from 'react'
import { useEffect } from 'react'
import { Box, Text } from '@anthropic/ink'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { validateManifest } from '../../utils/plugins/validatePlugin.js'
import { plural } from '../../utils/stringUtils.js'

type Props = {
  onComplete: (result?: string) => void
  path?: string
}

export function ValidatePlugin({ onComplete, path }: Props): React.ReactNode {
  useEffect(() => {
    async function runValidation() {
      // 如果未提供路径，则显示用法
      if (!path) {
        onComplete(
          '用法：/plugin validate <路径>\n\n' +
            '验证插件或市场清单文件或目录。\n\n' +
            'Examples:\n' +
            '  /plugin validate .claude-plugin/plugin.json\n' +
            '  /plugin validate /path/to/plugin-directory\n' +
            '  /plugin validate .\n\n' +
            '当给定目录时，自动验证 .claude-plugin/marketplace.json\n' +
            '或 .claude-plugin/plugin.json（如果两者都存在，则优先使用 marketplace）。\n\n' +
            '或在命令行中：\n' +
            '  claude plugin validate <路径>',
        )
        return
      }

      try {
        const result = await validateManifest(path)

        let output = ''

        // 添加标题
        output += `正在验证 ${result.fileType} 清单：${result.filePath}

`

        // 显示错误
        if (result.errors.length > 0) {
          output += `${figures.cross} 发现 ${result.errors.length} 个 ${plural(result.errors.length, 'error')}：

`

          result.errors.forEach(error => {
            output += `  ${figures.pointer} ${error.path}: ${error.message}\n`
          })

          output += '\n'
        }

        // 显示警告
        if (result.warnings.length > 0) {
          output += `${figures.warning} 发现 ${result.warnings.length} 个 ${plural(result.warnings.length, 'warning')}：

`

          result.warnings.forEach(warning => {
            output += `  ${figures.pointer} ${warning.path}: ${warning.message}\n`
          })

          output += '\n'
        }

        // 显示成功或失败
        if (result.success) {
          if (result.warnings.length > 0) {
            output += `${figures.tick} 验证通过，但有警告
`
          } else {
            output += `${figures.tick} 验证通过
`
          }

          // 以代码 0 退出（成功）
          process.exitCode = 0
        } else {
          output += `${figures.cross} 验证失败
`

          // 以代码 1 退出（验证失败）
          process.exitCode = 1
        }

        onComplete(output)
      } catch (error) {
        // 以代码 2 退出（意外错误）
        process.exitCode = 2

        logError(error)

        onComplete(
          `${figures.cross} 验证期间发生意外错误：${errorMessage(error)}`,
        )
      }
    }

    void runValidation()
  }, [onComplete, path])

  return (
    <Box flexDirection="column">
      <Text>正在运行验证...</Text>
    </Box>
  )
}
