import { feature } from 'bun:bundle'
import { spawnSync } from 'child_process'
import sample from 'lodash-es/sample.js'
import * as React from 'react'
import { ExitFlow } from '../../components/ExitFlow.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { isBgSession } from '../../utils/concurrentSessions.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { getCurrentWorktreeSession } from '../../utils/worktree.js'

const GOODBYE_MESSAGES = ['Goodbye!', '再见！', 'Bye!', '回头见！']

function getRandomGoodbyeMessage(): string {
  return sample(GOODBYE_MESSAGES) ?? 'Goodbye!'
}

export async function call(
  onDone: LocalJSXCommandOnDone,
): Promise<React.ReactNode> {
  // 在 `claude --bg` tmux 会话中：分离而非终止。REPL 会持续运行；`c
  // laude attach` 可以重新连接。涵盖 /exit、/quit、ctrl+c、
  // ctrl+d —— 所有这些都通过 REPL 的 handleExit 汇集于此。
  if (feature('BG_SESSIONS') && isBgSession()) {
    onDone()
    spawnSync('tmux', ['detach-client'], { stdio: 'ignore' })
    return null
  }

  const showWorktree = getCurrentWorktreeSession() !== null

  if (showWorktree) {
    return (
      <ExitFlow
        showWorktree={showWorktree}
        onDone={onDone}
        onCancel={() => onDone()}
      />
    )
  }

  onDone(getRandomGoodbyeMessage())
  await gracefulShutdown(0, 'prompt_input_exit')
  return null
}
