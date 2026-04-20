import type { Command, LocalJSXCommandOnDone } from '../types/command.js'
import type { ReactNode } from 'react'

const call = async (onDone: LocalJSXCommandOnDone): Promise<ReactNode> => {
  onDone(
    'torch：保留的内部调试命令。此构建版本中未提供实现。',
    { display: 'system' },
  )
  return null
}

export default {
  type: 'local-jsx',
  name: 'torch',
  description: '[内部] 开发调试命令（保留）',
  isEnabled: () => true,
  isHidden: true,
  load: () => Promise.resolve({ call }),
} satisfies Command
