import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { StructuredPatchHunk } from 'diff'
import { isAbsolute, relative, resolve } from 'path'
import * as React from 'react'
import { Suspense, use, useState } from 'react'
import { MessageResponse } from 'src/components/MessageResponse.js'
import { extractTag } from 'src/utils/messages.js'
import { CtrlOToExpand } from 'src/components/CtrlOToExpand.js'
import { FallbackToolUseErrorMessage } from 'src/components/FallbackToolUseErrorMessage.js'
import { FileEditToolUpdatedMessage } from 'src/components/FileEditToolUpdatedMessage.js'
import { FileEditToolUseRejectedMessage } from 'src/components/FileEditToolUseRejectedMessage.js'

import { HighlightedCode } from 'src/components/HighlightedCode.js'
import { useTerminalSize } from 'src/hooks/useTerminalSize.js'
import { Box, Text } from '@anthropic/ink'
import { FilePathLink } from 'src/components/FilePathLink.js'
import type { ToolProgressData } from 'src/Tool.js'
import type { ProgressMessage } from 'src/types/message.js'
import { getCwd } from 'src/utils/cwd.js'
import { getPatchForDisplay } from 'src/utils/diff.js'
import { getDisplayPath } from 'src/utils/file.js'
import { logError } from 'src/utils/log.js'
import { getPlansDirectory } from 'src/utils/plans.js'
import { openForScan, readCapped } from 'src/utils/readEditContext.js'
import type { Output } from './FileWriteTool.js'

const MAX_LINES_TO_RENDER = 10
// 模型输出始终使用 \n 作为换行符，与平台无关，因此请始终按 \n 进行分割。
// 在 Windows 上，os.EOL 是 \r\n，这会导致所有文件的 numLines 都等于 1。
const EOL = '\n'

/** * 统计文件内容中的可见行数。尾随换行符被视为行终止符（而非新的空行），以匹配编辑器中的行号计数方式。 */
export function countLines(content: string): number {
  const parts = content.split(EOL)
  return content.endsWith(EOL) ? parts.length - 1 : parts.length
}

function FileWriteToolCreatedMessage({
  filePath,
  content,
  verbose,
}: {
  filePath: string
  content: string
  verbose: boolean
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const contentWithFallback = content || '(No content)'
  const numLines = countLines(content)
  const plusLines = numLines - MAX_LINES_TO_RENDER

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text>
          Wrote <Text bold>{numLines}</Text> lines to{' '}
          <Text bold>{verbose ? filePath : relative(getCwd(), filePath)}</Text>
        </Text>
        <Box flexDirection="column">
          <HighlightedCode
            code={
              verbose
                ? contentWithFallback
                : contentWithFallback
                    .split('\n')
                    .slice(0, MAX_LINES_TO_RENDER)
                    .join('\n')
            }
            filePath={filePath}
            width={columns - 12}
          />
        </Box>
        {!verbose && plusLines > 0 && (
          <Text dimColor>
            … +{plusLines} {plusLines === 1 ? 'line' : 'lines'}{' '}
            {numLines > 0 && <CtrlOToExpand />}
          </Text>
        )}
      </Box>
    </MessageResponse>
  )
}

export function userFacingName(
  input: Partial<{ file_path: string; content: string }> | undefined,
): string {
  if (input?.file_path?.startsWith(getPlansDirectory())) {
    return '更新后的计划'
  }
  return 'Write'
}

/** 控制全屏点击展开。只有 `create` 会进行截断（至 MAX_LINES_TO_RENDER）；`update` 无论 verbose 参数如何，都会渲染完整的差异。
 *  在悬停/滚动时对每条可见消息调用，因此在找到第 (MAX+1) 行后提前退出，而不是分割整个（可能非常庞大的）内容。 */
export function isResultTruncated({ type, content }: Output): boolean {
  if (type !== 'create') return false
  let pos = 0
  for (let i = 0; i < MAX_LINES_TO_RENDER; i++) {
    pos = content.indexOf(EOL, pos)
    if (pos === -1) return false
    pos++
  }
  // countLines 将尾随的 EOL 视为终止符，而非新行
  return pos < content.length
}

export function getToolUseSummary(
  input: Partial<{ file_path: string; content: string }> | undefined,
): string | null {
  if (!input?.file_path) {
    return null
  }
  return getDisplayPath(input.file_path)
}

export function renderToolUseMessage(
  input: Partial<{ file_path: string; content: string }>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!input.file_path) {
    return null
  }
  // 对于计划文件，路径已包含在 userFacingName 中
  if (input.file_path.startsWith(getPlansDirectory())) {
    return ''
  }
  return (
    <FilePathLink filePath={input.file_path}>
      {verbose ? input.file_path : getDisplayPath(input.file_path)}
    </FilePathLink>
  )
}

export function renderToolUseRejectedMessage(
  { file_path, content }: { file_path: string; content: string },
  { style, verbose }: { style?: 'condensed'; verbose: boolean },
): React.ReactNode {
  return (
    <WriteRejectionDiff
      filePath={file_path}
      content={content}
      style={style}
      verbose={verbose}
    />
  )
}

type RejectionDiffData =
  | { type: 'create' }
  | { type: 'update'; patch: StructuredPatchHunk[]; oldContent: string }
  | { type: 'error' }

function WriteRejectionDiff({
  filePath,
  content,
  style,
  verbose,
}: {
  filePath: string
  content: string
  style?: 'condensed'
  verbose: boolean
}): React.ReactNode {
  const [dataPromise] = useState(() => loadRejectionDiff(filePath, content))
  const firstLine = content.split('\n')[0] ?? null
  const createFallback = (
    <FileEditToolUseRejectedMessage
      file_path={filePath}
      operation="write"
      content={content}
      firstLine={firstLine}
      verbose={verbose}
    />
  )
  return (
    <Suspense fallback={createFallback}>
      <WriteRejectionBody
        promise={dataPromise}
        filePath={filePath}
        firstLine={firstLine}
        createFallback={createFallback}
        style={style}
        verbose={verbose}
      />
    </Suspense>
  )
}

function WriteRejectionBody({
  promise,
  filePath,
  firstLine,
  createFallback,
  style,
  verbose,
}: {
  promise: Promise<RejectionDiffData>
  filePath: string
  firstLine: string | null
  createFallback: React.ReactNode
  style?: 'condensed'
  verbose: boolean
}): React.ReactNode {
  const data = use(promise)
  if (data.type === 'create') return createFallback
  if (data.type === 'error') {
    return (
      <MessageResponse>
        <Text>(No changes)</Text>
      </MessageResponse>
    )
  }
  return (
    <FileEditToolUseRejectedMessage
      file_path={filePath}
      operation="update"
      patch={data.patch}
      firstLine={firstLine}
      fileContent={data.oldContent}
      style={style}
      verbose={verbose}
    />
  )
}

async function loadRejectionDiff(
  filePath: string,
  content: string,
): Promise<RejectionDiffData> {
  try {
    const fullFilePath = isAbsolute(filePath)
      ? filePath
      : resolve(getCwd(), filePath)
    const handle = await openForScan(fullFilePath)
    if (handle === null) return { type: 'create' }
    let oldContent: string | null
    try {
      oldContent = await readCapped(handle)
    } finally {
      await handle.close()
    }
    // 文件大小超过 MAX_SCAN_BYTES — 回退到创建视图，而不是
    // 在对比一个数 GB 大小的文件时导致内存溢出。
    if (oldContent === null) return { type: 'create' }
    const patch = getPatchForDisplay({
      filePath,
      fileContents: oldContent,
      edits: [
        { old_string: oldContent, new_string: content, replace_all: false },
      ],
    })
    return { type: 'update', patch, oldContent }
  } catch (e) {
    // 用户可能在显示差异时已手动应用了更改。
    logError(e as Error)
    return { type: 'error' }
  }
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (
    !verbose &&
    typeof result === 'string' &&
    extractTag(result, 'tool_use_error')
  ) {
    return (
      <MessageResponse>
        <Text color="error">Error writing file</Text>
      </MessageResponse>
    )
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}

export function renderToolResultMessage(
  { filePath, content, structuredPatch, type, originalFile }: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  { style, verbose }: { style?: 'condensed'; verbose: boolean },
): React.ReactNode {
  switch (type) {
    case 'create': {
      const isPlanFile = filePath.startsWith(getPlansDirectory())

      // 计划文件：反转精简模式的行为
      // - 常规模式：仅显示提示（用户可以输入 /plan 查看完整内容）
      // - 精简模式（子代理视图）：显示完整内容
      if (isPlanFile && !verbose) {
        if (style !== 'condensed') {
          return (
            <MessageResponse>
              <Text dimColor>/plan to preview</Text>
            </MessageResponse>
          )
        }
      } else if (style === 'condensed' && !verbose) {
        const numLines = countLines(content)
        return (
          <Text>
            Wrote <Text bold>{numLines}</Text> lines to{' '}
            <Text bold>{relative(getCwd(), filePath)}</Text>
          </Text>
        )
      }

      return (
        <FileWriteToolCreatedMessage
          filePath={filePath}
          content={content}
          verbose={verbose}
        />
      )
    }
    case 'update': {
      const isPlanFile = filePath.startsWith(getPlansDirectory())
      return (
        <FileEditToolUpdatedMessage
          filePath={filePath}
          structuredPatch={structuredPatch}
          firstLine={content.split('\n')[0] ?? null}
          fileContent={originalFile ?? undefined}
          style={style}
          verbose={verbose}
          previewHint={isPlanFile ? '/plan to preview' : undefined}
        />
      )
    }
  }
}
