import type { Command } from '../../commands.js'
import { env } from '../../utils/env.js'

// 原生支持 CSI u / Kitty 键盘协议的终端
const NATIVE_CSIU_TERMINALS: Record<string, string> = {
  ghostty: 'Ghostty',
  kitty: 'Kitty',
  'iTerm.app': 'iTerm2',
  WezTerm: 'WezTerm',
}

const terminalSetup = {
  type: 'local-jsx',
  name: 'terminal-setup',
  description:
    env.terminal === 'Apple_Terminal'
      ? '启用 Option+Enter 键绑定以输入换行符和视觉响铃'
      : '安装 Shift+Enter 键绑定以输入换行符',
  isHidden: env.terminal !== null && env.terminal in NATIVE_CSIU_TERMINALS,
  load: () => import('./terminalSetup.js'),
} satisfies Command

export default terminalSetup
