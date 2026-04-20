import { mkdir, writeFile } from 'fs/promises'
import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { Dialog } from '@anthropic/ink'
import { MemoryFileSelector } from '../../components/memory/MemoryFileSelector.js'
import { getRelativeMemoryPath } from '../../components/memory/MemoryUpdateNotification.js'
import { Box, Link, Text } from '@anthropic/ink'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { clearMemoryFileCaches, getMemoryFiles } from '../../utils/claudemd.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getErrnoCode } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { editFileInEditor } from '../../utils/promptEditor.js'

function MemoryCommand({
  onDone,
}: {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}): React.ReactNode {
  const handleSelectMemoryFile = async (memoryPath: string) => {
    try {
      // 如果 claude 目录不存在则创建（幂等操作，支持递归创建）
      if (memoryPath.includes(getClaudeConfigHomeDir())) {
        await mkdir(getClaudeConfigHomeDir(), { recursive: true })
      }

      // 如果文件不存在则创建（wx 标志会在文件已存在时失
      // 败，我们捕获此错误以保留现有内容）
      try {
        await writeFile(memoryPath, '', { encoding: 'utf8', flag: 'wx' })
      } catch (e: unknown) {
        if (getErrnoCode(e) !== 'EEXIST') {
          throw e
        }
      }

      await editFileInEditor(memoryPath)

      // 确定哪个环境变量控制编辑器
      let editorSource = 'default'
      let editorValue = ''
      if (process.env.VISUAL) {
        editorSource = '$VISUAL'
        editorValue = process.env.VISUAL
      } else if (process.env.EDITOR) {
        editorSource = '$EDITOR'
        editorValue = process.env.EDITOR
      }

      const editorInfo =
        editorSource !== 'default'
          ? `正在使用 ${editorSource}="${editorValue}"。`
          : ''

      const editorHint = editorInfo
        ? `> ${editorInfo} 要更改编辑器，请设置 $EDITOR 或 $VISUAL 环境变量。`
        : `> 要使用其他编辑器，请设置 $EDITOR 或 $VISUAL 环境变量。`

      onDone(
        `已在 ${getRelativeMemoryPath(memoryPath)} 打开内存文件

${editorHint}`,
        { display: 'system' },
      )
    } catch (error) {
      logError(error)
      onDone(`打开内存文件时出错：${error}`)
    }
  }

  const handleCancel = () => {
    onDone('已取消内存编辑', { display: 'system' })
  }

  return (
    <Dialog title="Memory" onCancel={handleCancel} color="remember">
      <Box flexDirection="column">
        <React.Suspense fallback={null}>
          <MemoryFileSelector
            onSelect={handleSelectMemoryFile}
            onCancel={handleCancel}
          />
        </React.Suspense>

        <Box marginTop={1}>
          <Text dimColor>
            了解更多：<Link url="https://code.claude.com/docs/en/memory" />
          </Text>
        </Box>
      </Box>
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async onDone => {
  // 渲染前清空并预加载 —— Suspense 会处理未预加载
  // 的情况，但在此处等待可避免初始打开时的回退闪烁。
  clearMemoryFileCaches()
  await getMemoryFiles()
  return <MemoryCommand onDone={onDone} />
}
