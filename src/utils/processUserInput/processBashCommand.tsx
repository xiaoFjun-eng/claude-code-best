import type { ContentBlockParam } from '@anthropic-ai/sdk/resources'
import { randomUUID } from 'crypto'
import * as React from 'react'
import { BashModeProgress } from 'src/components/BashModeProgress.js'
import type { SetToolJSXFn } from 'src/Tool.js'
import { BashTool } from '@claude-code-best/builtin-tools/tools/BashTool/BashTool.js'
import type {
  AttachmentMessage,
  SystemMessage,
  UserMessage,
} from 'src/types/message.js'
import type { ShellProgress } from 'src/types/tools.js'
import { logEvent } from '../../services/analytics/index.js'
import { errorMessage, ShellError } from '../errors.js'
import {
  createSyntheticUserCaveatMessage,
  createUserInterruptionMessage,
  createUserMessage,
  prepareUserContent,
} from '../messages.js'
import { resolveDefaultShell } from '../shell/resolveDefaultShell.js'
import { isPowerShellToolEnabled } from '../shell/shellToolUtils.js'
import { processToolResultBlock } from '../toolResultStorage.js'
import { escapeXml } from '../xml.js'
import type { ProcessUserInputContext } from './processUserInput.js'

export async function processBashCommand(
  inputString: string,
  precedingInputBlocks: ContentBlockParam[],
  attachmentMessages: AttachmentMessage[],
  context: ProcessUserInputContext,
  setToolJSX: SetToolJSXFn,
): Promise<{
  messages: (UserMessage | AttachmentMessage | SystemMessage)[]
  shouldQuery: boolean
}> {
  // Shell 路由（docs/design/ps-shell-selecti
  // on.md §5.2）：查询 defaultShell，回退到 bash。isPo
  // werShellToolEnabled() 应用与 tools.ts 相同的平台
  // + 环境变量门控，以确保输入框路由与工具列表可见性匹配。预先计算，以便遥测记
  // 录实际使用的 shell，而非原始设置。
  const usePowerShell =
    isPowerShellToolEnabled() && resolveDefaultShell() === 'powershell'

  logEvent('tengu_input_bash', { powershell: usePowerShell })

  const userMessage = createUserMessage({
    content: prepareUserContent({
      inputString: `<bash-input>${inputString}</bash-input>`,
      precedingInputBlocks,
    }),
  })

  // ctrl+b 后台运行指示器
  let jsx: React.ReactNode

  // 仅显示初始 UI
  setToolJSX({
    jsx: (
      <BashModeProgress
        input={inputString}
        progress={null}
        verbose={context.options.verbose}
      />
    ),
    shouldHidePromptInput: false,
  })

  try {
    const bashModeContext: ProcessUserInputContext = {
      ...context,
      // TODO: 清理此临时方案
      setToolJSX: _ => {
        jsx = _?.jsx
      },
    }

    // 进度 UI — 两个 shell 后端共享（两者均发出 ShellProgress）
    const onProgress = (progress: { data: ShellProgress }) => {
      setToolJSX({
        jsx: (
          <>
            <BashModeProgress
              input={inputString!}
              progress={progress.data}
              verbose={context.options.verbose}
            />
            {jsx}
          </>
        ),
        shouldHidePromptInput: false,
        showSpinner: false,
      })
    }

    // 用户发起的 `!` 命令在沙箱外运行。两个 shell 工具均遵循 dangerouslyDi
    // sableSandbox（在 shouldUseSandbox.ts 中通过 areUnsandb
    // oxedCommandsAllowed() 检查）。PS 沙箱仅限 Linux/macOS/WS
    // L2 — 在原生 Windows 上，无论设置如何，shouldUseSandbox() 均返回 f
    // alse（平台不支持）。延迟加载 PowerShellTool，使其约 300KB 的代
    // 码块仅在用户实际选择 powershell 作为默认 shell 时加载。
    type PSMod = typeof import('@claude-code-best/builtin-tools/tools/PowerShellTool/PowerShellTool.js')
    let PowerShellTool: PSMod['PowerShellTool'] | null = null
    if (usePowerShell) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      PowerShellTool = (
        require('@claude-code-best/builtin-tools/tools/PowerShellTool/PowerShellTool.js') as PSMod
      ).PowerShellTool
      /* eslint-enable @typescript-eslint/no-require-imports */
    }
    const shellTool = PowerShellTool ?? BashTool

    const response = PowerShellTool
      ? await PowerShellTool.call(
          { command: inputString, dangerouslyDisableSandbox: true },
          bashModeContext,
          undefined,
          undefined,
          onProgress,
        )
      : await BashTool.call(
          {
            command: inputString,
            dangerouslyDisableSandbox: true,
          },
          bashModeContext,
          undefined,
          undefined,
          onProgress,
        )
    const data = response.data

    if (!data) {
      throw new Error('未收到 shell 命令结果')
    }

    const stderr = data.stderr
    // 复用与内联 !`cmd` bash（promptShellExecution）和模型发起的 Bash 相
    // 同的格式化流水线。当 BashTool.call() 将大量输出持久化到磁盘时，会设置 data.p
    // ersistedOutputPath，格式化器将其包装在 <persisted-output> 中。传
    // 递 stderr:'' 以保持其独立，用于 <bash-stderr> UI 标签。
    const mapped = await processToolResultBlock(
      shellTool,
      { ...data, stderr: '' },
      randomUUID(),
    )
    // mapped.content 可能包含我们自己的 <persisted-output> 包装
    // 器（来自 buildLargeToolResultMessage 的可信 XML）。转义它会将
    // 结构标签变为 &lt;persisted-output&gt;，破坏模型的解析和 Us
    // erBashOutputMessage 的 extractTag。仅转义原始回退内容。
    const stdout =
      typeof mapped.content === 'string'
        ? mapped.content
        : escapeXml(data.stdout)
    return {
      messages: [
        createSyntheticUserCaveatMessage(),
        userMessage,
        ...attachmentMessages,
        createUserMessage({
          content: `<bash-stdout>${stdout}</bash-stdout><bash-stderr>${escapeXml(stderr)}</bash-stderr>`,
        }),
      ],
      shouldQuery: false,
    }
  } catch (e) {
    if (e instanceof ShellError) {
      if (e.interrupted) {
        return {
          messages: [
            createSyntheticUserCaveatMessage(),
            userMessage,
            createUserInterruptionMessage({ toolUse: false }),
            ...attachmentMessages,
          ],
          shouldQuery: false,
        }
      }
      return {
        messages: [
          createSyntheticUserCaveatMessage(),
          userMessage,
          ...attachmentMessages,
          createUserMessage({
            content: `<bash-stdout>${escapeXml(e.stdout)}</bash-stdout><bash-stderr>${escapeXml(e.stderr)}</bash-stderr>`,
          }),
        ],
        shouldQuery: false,
      }
    }
    return {
      messages: [
        createSyntheticUserCaveatMessage(),
        userMessage,
        ...attachmentMessages,
        createUserMessage({
          content: `<bash-stderr>命令失败：${escapeXml(errorMessage(e))}</bash-stderr>`,
        }),
      ],
      shouldQuery: false,
    }
  } finally {
    setToolJSX(null)
  }
}
