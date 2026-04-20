import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import React from 'react'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import {
  checkOverageGate,
  confirmOverage,
  launchRemoteReview,
} from './reviewRemote.js'
import { UltrareviewOverageDialog } from './UltrareviewOverageDialog.js'

function contentBlocksToString(blocks: ContentBlockParam[]): string {
  return blocks
    .map(b => (b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
}

async function launchAndDone(
  args: string,
  context: Parameters<LocalJSXCommandCall>[1],
  onDone: LocalJSXCommandOnDone,
  billingNote: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await launchRemoteReview(args, context, billingNote)
  // 用户在约 5 秒的启动过程中按下了 Escape 键——对话框已显
  // 示“已取消”并已卸载，因此跳过 onDone（否则会写入一个无效的
  // 转录记录槽），让调用方跳过 confirmOverage。
  if (signal?.aborted) return
  if (result) {
    onDone(contentBlocksToString(result), { shouldQuery: true })
  } else {
    // 前置条件失败现在会返回上面特定的 ContentBlockParam[
    // ]。null 仅在此处出现于传送失败（PR 模式）或非 GitHub
    // 仓库的情况——两者均为 CCR/仓库连接问题。
    onDone(
      'Ultrareview 未能启动远程会话。请确认这是一个 GitHub 仓库，然后重试。',
      { display: 'system' },
    )
  }
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const gate = await checkOverageGate()

  if (gate.kind === 'not-enabled') {
    onDone(
      '免费 Ultrareview 次数已用完。请在 https://claude.ai/settings/billing 启用“额外用量”以继续。',
      { display: 'system' },
    )
    return null
  }

  if (gate.kind === 'low-balance') {
    onDone(
      `余额过低，无法启动 Ultrareview（当前可用 \$${gate.available.toFixed(2)}，最低需 $10）。请在 https://claude.ai/settings/billing 充值`,
      { display: 'system' },
    )
    return null
  }

  if (gate.kind === 'needs-confirm') {
    return (
      <UltrareviewOverageDialog
        onProceed={async signal => {
          await launchAndDone(
            args,
            context,
            onDone,
            '本次评审将按“额外用量”计费。',
            signal,
          )
          // 仅在未中止的启动后持久化确认标志——否则启动过
          // 程中按 Escape 键会导致标志被设置，并
          // 在下次尝试时跳过此对话框。
          if (!signal.aborted) confirmOverage()
        }}
        onCancel={() => onDone('Ultrareview 已取消。', { display: 'system' })}
      />
    )
  }

  // gate.kind === 'proceed'
  await launchAndDone(args, context, onDone, gate.billingNote)
  return null
}
