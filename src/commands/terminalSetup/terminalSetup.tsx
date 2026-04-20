import chalk from 'chalk'
import { randomBytes } from 'crypto'
import { copyFile, mkdir, readFile, writeFile } from 'fs/promises'
import { homedir, platform } from 'os'
import { dirname, join } from 'path'
import type { ThemeName } from 'src/utils/theme.js'
import { pathToFileURL } from 'url'
import { supportsHyperlinks } from '@anthropic/ink'
import { color } from '@anthropic/ink'
import { maybeMarkProjectOnboardingComplete } from '../../projectOnboardingState.js'
import type { ToolUseContext } from '../../Tool.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import {
  backupTerminalPreferences,
  checkAndRestoreTerminalBackup,
  getTerminalPlistPath,
  markTerminalSetupComplete,
} from '../../utils/appleTerminalBackup.js'
import { setupShellCompletion } from '../../utils/completionCache.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { env } from '../../utils/env.js'
import { isFsInaccessible } from '../../utils/errors.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { addItemToJSONCArray, safeParseJSONC } from '../../utils/json.js'
import { logError } from '../../utils/log.js'
import { getPlatform } from '../../utils/platform.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'

const EOL = '\n'

// 原生支持 CSI u / Kitty 键盘协议的终端
const NATIVE_CSIU_TERMINALS: Record<string, string> = {
  ghostty: 'Ghostty',
  kitty: 'Kitty',
  'iTerm.app': 'iTerm2',
  WezTerm: 'WezTerm',
  WarpTerminal: 'Warp',
}

/** 检测是否在 VSCode Remote SSH 会话中运行。
在这种情况下，快捷键需要安装在本地机器上，
而不是 Claude 运行的远程服务器上。 */
function isVSCodeRemoteSSH(): boolean {
  const askpassMain = process.env.VSCODE_GIT_ASKPASS_MAIN ?? ''
  const path = process.env.PATH ?? ''

  // 检查两个环境变量 - VSCODE_GIT_ASKPASS_MAIN 在 git 扩
  // 展激活时更可靠，PATH 是备用方案。省略路径分隔符以确保 Windows 兼容性。
  return (
    askpassMain.includes('.vscode-server') ||
    askpassMain.includes('.cursor-server') ||
    askpassMain.includes('.windsurf-server') ||
    path.includes('.vscode-server') ||
    path.includes('.cursor-server') ||
    path.includes('.windsurf-server')
  )
}

export function getNativeCSIuTerminalDisplayName(): string | null {
  if (!env.terminal || !(env.terminal in NATIVE_CSIU_TERMINALS)) {
    return null
  }
  return NATIVE_CSIU_TERMINALS[env.terminal] ?? null
}

/** 将文件路径格式化为可点击的超链接。

包含空格的路径（例如 "Application Support"）在大多数终端中不可点击 - 它们会在空格处被分割。OSC 8 超链接通过嵌入一个 file:// URL 来解决此问题，终端可以点击打开，同时向用户显示干净的路径。

与 createHyperlink() 不同，此方法不应用任何颜色样式，因此路径会继承父级的样式（例如 chalk.dim）。 */
function formatPathLink(filePath: string): string {
  if (!supportsHyperlinks()) {
    return filePath
  }
  const fileUrl = pathToFileURL(filePath).href
  // OSC 8 超链接：\e]8;;URL\a TEXT \e]8;;\a
  return `\x1b]8;;${fileUrl}\x07${filePath}\x1b]8;;\x07`
}

export function shouldOfferTerminalSetup(): boolean {
  // iTerm2、WezTerm、Ghostty、Kitty 和 Warp 原生支持
  // CSI u / Kitty 键盘协议，Claude Code 已能解析。这些终
  // 端无需额外设置。
  return (
    (platform() === 'darwin' && env.terminal === 'Apple_Terminal') ||
    env.terminal === 'vscode' ||
    env.terminal === 'cursor' ||
    env.terminal === 'windsurf' ||
    env.terminal === 'alacritty' ||
    env.terminal === 'zed'
  )
}

export async function setupTerminal(theme: ThemeName): Promise<string> {
  let result = ''

  switch (env.terminal) {
    case 'Apple_Terminal':
      result = await enableOptionAsMetaForTerminal(theme)
      break
    case 'vscode':
      result = await installBindingsForVSCodeTerminal('VSCode', theme)
      break
    case 'cursor':
      result = await installBindingsForVSCodeTerminal('Cursor', theme)
      break
    case 'windsurf':
      result = await installBindingsForVSCodeTerminal('Windsurf', theme)
      break
    case 'alacritty':
      result = await installBindingsForAlacritty(theme)
      break
    case 'zed':
      result = await installBindingsForZed(theme)
      break
    case null:
      break
  }

  saveGlobalConfig(current => {
    if (
      ['vscode', 'cursor', 'windsurf', 'alacritty', 'zed'].includes(
        env.terminal ?? '',
      )
    ) {
      if (current.shiftEnterKeyBindingInstalled === true) return current
      return { ...current, shiftEnterKeyBindingInstalled: true }
    } else if (env.terminal === 'Apple_Terminal') {
      if (current.optionAsMetaKeyInstalled === true) return current
      return { ...current, optionAsMetaKeyInstalled: true }
    }
    return current
  })

  maybeMarkProjectOnboardingComplete()

  // 安装 shell 补全（仅限 ant，因为补全命令仅限 ant）
  if (process.env.USER_TYPE === 'ant') {
    result += await setupShellCompletion(theme)
  }

  return result
}

export function isShiftEnterKeyBindingInstalled(): boolean {
  return getGlobalConfig().shiftEnterKeyBindingInstalled === true
}

export function hasUsedBackslashReturn(): boolean {
  return getGlobalConfig().hasUsedBackslashReturn === true
}

export function markBackslashReturnUsed(): void {
  const config = getGlobalConfig()
  if (!config.hasUsedBackslashReturn) {
    saveGlobalConfig(current => ({
      ...current,
      hasUsedBackslashReturn: true,
    }))
  }
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  _args: string,
): Promise<null> {
  if (env.terminal && env.terminal in NATIVE_CSIU_TERMINALS) {
    const message = `Shift+Enter 在 ${NATIVE_CSIU_TERMINALS[env.terminal]} 中原生支持。

无需配置。直接使用 Shift+Enter 添加换行。`
    onDone(message)
    return null
  }

  // 检查终端是否受支持
  if (!shouldOfferTerminalSetup()) {
    const terminalName = env.terminal || '您当前的终端'
    const currentPlatform = getPlatform()

    // 构建平台特定的终端建议
    let platformTerminals = ''
    if (currentPlatform === 'macos') {
      platformTerminals = '   • macOS: Apple Terminal\n'
    } else if (currentPlatform === 'windows') {
      platformTerminals = '   • Windows: Windows Terminal\n'
    }
    // 对于 Linux 和其他平台，我们不显示原生终端
    // 选项，因为它们目前不受支持

    const message = `无法从 ${terminalName} 运行终端设置。

此命令为多行提示配置便捷的 Shift+Enter 快捷键。
${chalk.dim('Note: You can already use backslash (\\\\) + return to add newlines.')}

要设置快捷键（可选）：
1. 暂时退出 tmux/screen
2. 直接在以下任一终端中运行 /terminal-setup：
${platformTerminals}   • IDE: VSCode, Cursor, Windsurf, Zed
   • 其他: Alacritty
3. 返回 tmux/screen - 设置将持久保存

${chalk.dim('Note: iTerm2, WezTerm, Ghostty, Kitty, and Warp support Shift+Enter natively.')}`
    onDone(message)
    return null
  }

  const result = await setupTerminal(context.options.theme)
  onDone(result)
  return null
}

type VSCodeKeybinding = {
  key: string
  command: string
  args: { text: string }
  when: string
}

async function installBindingsForVSCodeTerminal(
  editor: 'VSCode' | 'Cursor' | 'Windsurf' = 'VSCode',
  theme: ThemeName,
): Promise<string> {
  // 检查是否在 VSCode Remote SS
  // H 会话中运行 在这种情况下，快捷键需要安装在本地机器上
  if (isVSCodeRemoteSSH()) {
    return `${color(
      'warning',
      theme,
    )(
      `Cannot install keybindings from a remote ${editor} session.`,
    )}${EOL}${EOL}${editor} 快捷键必须安装在您的本地机器上，而不是远程服务器上。${EOL}${EOL}要安装 Shift+Enter 快捷键：${EOL}1. 在您的本地机器上打开 ${editor}（未连接到远程）${EOL}2. 打开命令面板 (Cmd/Ctrl+Shift+P) → "Preferences: Open Keyboard Shortcuts (JSON)"${EOL}3. 添加此快捷键（文件必须是 JSON 数组）：${EOL}${EOL}${chalk.dim(`[
  {
    "key": "shift+enter",
    "command": "workbench.action.terminal.sendSequence",
    "args": { "text": "\\u001b\\r" },
    "when": "terminalFocus"
  }
]`)}${EOL}`
  }

  const editorDir = editor === 'VSCode' ? 'Code' : editor
  const userDirPath = join(
    homedir(),
    platform() === 'win32'
      ? join('AppData', 'Roaming', editorDir, 'User')
      : platform() === 'darwin'
        ? join('Library', 'Application Support', editorDir, 'User')
        : join('.config', editorDir, 'User'),
  )
  const keybindingsPath = join(userDirPath, 'keybindings.json')

  try {
    // 确保用户目录存在（幂等且递归）
    await mkdir(userDirPath, { recursive: true })

    // 读取现有的快捷键文件，如果不存在则默认为空数组
    let content = '[]'
    let keybindings: VSCodeKeybinding[] = []
    let fileExists = false
    try {
      content = await readFile(keybindingsPath, { encoding: 'utf-8' })
      fileExists = true
      keybindings = (safeParseJSONC(content) as VSCodeKeybinding[]) ?? []
    } catch (e: unknown) {
      if (!isFsInaccessible(e)) throw e
    }

    // 在修改前备份现有文件
    if (fileExists) {
      const randomSha = randomBytes(4).toString('hex')
      const backupPath = `${keybindingsPath}.${randomSha}.bak`
      try {
        await copyFile(keybindingsPath, backupPath)
      } catch {
        return `${color(
          'warning',
          theme,
        )(
          `备份现有 ${editor} 终端快捷键时出错。中止操作。`,
        )}${EOL}${chalk.dim(`See ${formatPathLink(keybindingsPath)}`)}${EOL}${chalk.dim(`备份路径：${formatPathLink(backupPath)}`)}${EOL}`
      }
    }

    // 检查快捷键是否已存在
    const existingBinding = keybindings.find(
      binding =>
        binding.key === 'shift+enter' &&
        binding.command === 'workbench.action.terminal.sendSequence' &&
        binding.when === 'terminalFocus',
    )
    if (existingBinding) {
      return `${color(
        'warning',
        theme,
      )(
        `发现现有的 ${editor} 终端 Shift+Enter 快捷键。请移除它以继续。`,
      )}${EOL}${chalk.dim(`See ${formatPathLink(keybindingsPath)}`)}${EOL}`
    }

    // 创建新的快捷键
    const newKeybinding: VSCodeKeybinding = {
      key: 'shift+enter',
      command: 'workbench.action.terminal.sendSequence',
      args: { text: '\u001b\r' },
      when: 'terminalFocus',
    }

    // 通过添加新快捷键来修改内容，同时保留注释和格式
    const updatedContent = addItemToJSONCArray(content, newKeybinding)

    // 将更新后的内容写回文件
    await writeFile(keybindingsPath, updatedContent, { encoding: 'utf-8' })

    return `${color(
      'success',
      theme,
    )(
      `已安装 ${editor} 终端 Shift+Enter 快捷键`,
    )}${EOL}${chalk.dim(`See ${formatPathLink(keybindingsPath)}`)}${EOL}`
  } catch (error) {
    logError(error)
    throw new Error(
      `安装 ${editor} 终端 Shift+Enter 键绑定失败`,
    )
  }
}

async function enableOptionAsMetaForProfile(
  profileName: string,
): Promise<boolean> {
  // 首先尝试添加属性（以防它不存在） 引用配置文件名以
  // 处理带空格的文件名（例如 "Man Page"、"Red Sands"）
  const { code: addCode } = await execFileNoThrow('/usr/libexec/PlistBuddy', [
    '-c',
    `添加 :'Window Settings':'${profileName}':useOptionAsMetaKey bool true`,
    getTerminalPlistPath(),
  ])

  // 如果添加失败（很可能是因为它已存在），请尝试设置它
  if (addCode !== 0) {
    const { code: setCode } = await execFileNoThrow('/usr/libexec/PlistBuddy', [
      '-c',
      `设置 :'Window Settings':'${profileName}':useOptionAsMetaKey true`,
      getTerminalPlistPath(),
    ])

    if (setCode !== 0) {
      logError(
        new Error(
          `为 Terminal.app 配置文件启用 Option 作为 Meta 键失败：${profileName}`,
        ),
      )
      return false
    }
  }

  return true
}

async function disableAudioBellForProfile(
  profileName: string,
): Promise<boolean> {
  // 首先尝试添加属性（以防它不存在） 引用配置文件名以
  // 处理带空格的文件名（例如 "Man Page"、"Red Sands"）
  const { code: addCode } = await execFileNoThrow('/usr/libexec/PlistBuddy', [
    '-c',
    `添加 :'Window Settings':'${profileName}':Bell bool false`,
    getTerminalPlistPath(),
  ])

  // 如果添加失败（很可能是因为它已存在），请尝试设置它
  if (addCode !== 0) {
    const { code: setCode } = await execFileNoThrow('/usr/libexec/PlistBuddy', [
      '-c',
      `设置 :'Window Settings':'${profileName}':Bell false`,
      getTerminalPlistPath(),
    ])

    if (setCode !== 0) {
      logError(
        new Error(
          `为 Terminal.app 配置文件禁用音频提示音失败：${profileName}`,
        ),
      )
      return false
    }
  }

  return true
}

// 为 Terminal.app 启用 Option 作为 Meta 键
async function enableOptionAsMetaForTerminal(
  theme: ThemeName,
): Promise<string> {
  try {
    // 创建当前 plist 文件的备份
    const backupPath = await backupTerminalPreferences()
    if (!backupPath) {
      throw new Error(
        '创建 Terminal.app 首选项备份失败，正在退出',
      )
    }

    // 从 plist 中读取当前的默认配置文件
    const { stdout: defaultProfile, code: readCode } = await execFileNoThrow(
      'defaults',
      ['read', 'com.apple.Terminal', '默认窗口设置'],
    )

    if (readCode !== 0 || !defaultProfile.trim()) {
      throw new Error('读取默认 Terminal.app 配置文件失败')
    }

    const { stdout: startupProfile, code: startupCode } = await execFileNoThrow(
      'defaults',
      ['read', 'com.apple.Terminal', '启动窗口设置'],
    )
    if (startupCode !== 0 || !startupProfile.trim()) {
      throw new Error('读取启动 Terminal.app 配置文件失败')
    }

    let wasAnyProfileUpdated = false

    const defaultProfileName = defaultProfile.trim()
    const optionAsMetaEnabled =
      await enableOptionAsMetaForProfile(defaultProfileName)
    const audioBellDisabled =
      await disableAudioBellForProfile(defaultProfileName)

    if (optionAsMetaEnabled || audioBellDisabled) {
      wasAnyProfileUpdated = true
    }

    const startupProfileName = startupProfile.trim()

    // 仅当启动配置文件与默认配置文件不同时才继续
    if (startupProfileName !== defaultProfileName) {
      const startupOptionAsMetaEnabled =
        await enableOptionAsMetaForProfile(startupProfileName)
      const startupAudioBellDisabled =
        await disableAudioBellForProfile(startupProfileName)

      if (startupOptionAsMetaEnabled || startupAudioBellDisabled) {
        wasAnyProfileUpdated = true
      }
    }

    if (!wasAnyProfileUpdated) {
      throw new Error(
        '未能为任何 Terminal.app 配置文件启用 Option 作为 Meta 键或禁用音频提示音',
      )
    }

    // 刷新首选项缓存
    await execFileNoThrow('killall', ['cfprefsd'])

    markTerminalSetupComplete()

    return `${color(
      'success',
      theme,
    )(
      `已配置的 Terminal.app 设置：`,
    )}${EOL}${color('success', theme)('- 已启用 "使用 Option 作为 Meta 键"')}${EOL}${color('success', theme)('- 已切换到视觉提示音')}${EOL}${chalk.dim('Option+Enter 现在将输入换行符。')}${EOL}${chalk.dim('您必须重启 Terminal.app 才能使更改生效。', theme)}${EOL}`
  } catch (error) {
    logError(error)

    // 尝试从备份恢复
    const restoreResult = await checkAndRestoreTerminalBackup()

    const errorMessage = '为 Terminal.app 启用 Option 作为 Meta 键失败。'
    if (restoreResult.status === 'restored') {
      throw new Error(
        `${errorMessage} 您的设置已从备份中恢复。`,
      )
    } else if (restoreResult.status === 'failed') {
      throw new Error(
        `${errorMessage} 从备份恢复失败，请尝试手动执行：defaults import com.apple.Terminal ${restoreResult.backupPath}`,
      )
    } else {
      throw new Error(
        `${errorMessage} 没有可用的备份用于恢复。`,
      )
    }
  }
}

async function installBindingsForAlacritty(theme: ThemeName): Promise<string> {
  const ALACRITTY_KEYBINDING = `[[keyboard.bindings]]
key = "Return"
mods = "Shift"
chars = "\\u001B\\r"`

  // 按优先级顺序获取 Alacritty 配置文件路径
  const configPaths: string[] = []

  // XDG 配置路径（Linux 和 macOS）
  const xdgConfigHome = process.env.XDG_CONFIG_HOME
  if (xdgConfigHome) {
    configPaths.push(join(xdgConfigHome, 'alacritty', 'alacritty.toml'))
  } else {
    configPaths.push(join(homedir(), '.config', 'alacritty', 'alacritty.toml'))
  }

  // Windows 特定路径
  if (platform() === 'win32') {
    const appData = process.env.APPDATA
    if (appData) {
      configPaths.push(join(appData, 'alacritty', 'alacritty.toml'))
    }
  }

  // 通过尝试读取来查找现有配置文件，或使用首选路径中的第一个
  let configPath: string | null = null
  let configContent = ''
  let configExists = false

  for (const path of configPaths) {
    try {
      configContent = await readFile(path, { encoding: 'utf-8' })
      configPath = path
      configExists = true
      break
    } catch (e: unknown) {
      if (!isFsInaccessible(e)) throw e
      // 文件缺失或无法访问 — 尝试下一个配置路径
    }
  }

  // 如果不存在配置文件，则使用第一个路径（XDG/默认位置）
  if (!configPath) {
    configPath = configPaths[0] ?? null
  }

  if (!configPath) {
    throw new Error('未找到 Alacritty 的有效配置路径')
  }

  try {
    if (configExists) {
      // 检查按键绑定是否已存在（查找 Shift+Return 绑定）
      if (
        configContent.includes('mods = "Shift"') &&
        configContent.includes('key = "Return"')
      ) {
        return `${color(
          'warning',
          theme,
        )(
          '发现已存在的 Alacritty Shift+Enter 按键绑定。请移除它以继续。',
        )}${EOL}${chalk.dim(`See ${formatPathLink(configPath)}`)}${EOL}`
      }

      // 创建备份
      const randomSha = randomBytes(4).toString('hex')
      const backupPath = `${configPath}.${randomSha}.bak`
      try {
        await copyFile(configPath, backupPath)
      } catch {
        return `${color(
          'warning',
          theme,
        )(
          '备份现有 Alacritty 配置时出错。操作中止。',
        )}${EOL}${chalk.dim(`See ${formatPathLink(configPath)}`)}${EOL}${chalk.dim(`备份路径：${formatPathLink(backupPath)}`)}${EOL}`
      }
    } else {
      // 确保配置目录存在（幂等且递归）
      await mkdir(dirname(configPath), { recursive: true })
    }

    // 将按键绑定添加到配置中
    let updatedContent = configContent
    if (configContent && !configContent.endsWith('\n')) {
      updatedContent += '\n'
    }
    updatedContent += '\n' + ALACRITTY_KEYBINDING + '\n'

    // 写入更新后的配置
    await writeFile(configPath, updatedContent, { encoding: 'utf-8' })

    return `${color(
      'success',
      theme,
    )('已安装 Alacritty Shift+Enter 按键绑定')}${EOL}${color(
      'success',
      theme,
    )(
      '您可能需要重启 Alacritty 以使更改生效',
    )}${EOL}${chalk.dim(`See ${formatPathLink(configPath)}`)}${EOL}`
  } catch (error) {
    logError(error)
    throw new Error('安装 Alacritty Shift+Enter 按键绑定失败')
  }
}

async function installBindingsForZed(theme: ThemeName): Promise<string> {
  // Zed 使用类似于 VSCode 的 JSON 按键绑定
  const zedDir = join(homedir(), '.config', 'zed')
  const keymapPath = join(zedDir, 'keymap.json')

  try {
    // 确保 zed 目录存在（幂等且递归）
    await mkdir(zedDir, { recursive: true })

    // 读取现有的按键映射文件，如果不存在则默认为空数组
    let keymapContent = '[]'
    let fileExists = false
    try {
      keymapContent = await readFile(keymapPath, { encoding: 'utf-8' })
      fileExists = true
    } catch (e: unknown) {
      if (!isFsInaccessible(e)) throw e
    }

    if (fileExists) {
      // 检查按键绑定是否已存在
      if (keymapContent.includes('shift-enter')) {
        return `${color(
          'warning',
          theme,
        )(
          '发现已存在的 Zed Shift+Enter 按键绑定。请移除它以继续。',
        )}${EOL}${chalk.dim(`See ${formatPathLink(keymapPath)}`)}${EOL}`
      }

      // 创建备份
      const randomSha = randomBytes(4).toString('hex')
      const backupPath = `${keymapPath}.${randomSha}.bak`
      try {
        await copyFile(keymapPath, backupPath)
      } catch {
        return `${color(
          'warning',
          theme,
        )(
          '备份现有 Zed 键位映射时出错。正在退出。',
        )}${EOL}${chalk.dim(`See ${formatPathLink(keymapPath)}`)}${EOL}${chalk.dim(`备份路径：${formatPathLink(backupPath)}`)}${EOL}`
      }
    }

    // 解析并修改键位映射
    let keymap: Array<{
      context?: string
      bindings: Record<string, string | string[]>
    }>
    try {
      keymap = jsonParse(keymapContent)
      if (!Array.isArray(keymap)) {
        keymap = []
      }
    } catch {
      keymap = []
    }

    // 为终端上下文添加新的按键绑定
    keymap.push({
      context: 'Terminal',
      bindings: {
        'shift-enter': ['terminal::SendText', '\u001b\r'],
      },
    })

    // 写入更新后的键位映射
    await writeFile(keymapPath, jsonStringify(keymap, null, 2) + '\n', {
      encoding: 'utf-8',
    })

    return `${color(
      'success',
      theme,
    )(
      '已安装 Zed Shift+Enter 按键绑定',
    )}${EOL}${chalk.dim(`See ${formatPathLink(keymapPath)}`)}${EOL}`
  } catch (error) {
    logError(error)
    throw new Error('安装 Zed Shift+Enter 按键绑定失败')
  }
}
