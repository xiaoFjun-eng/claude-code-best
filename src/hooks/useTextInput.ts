import { isInputModeCharacter } from 'src/components/PromptInput/inputModes.js'
import { useNotifications } from 'src/context/notifications.js'
import stripAnsi from 'strip-ansi'
import { markBackslashReturnUsed } from '../commands/terminalSetup/terminalSetup.js'
import { addToHistory } from '../history.js'
import type { Key } from '@anthropic/ink'
import type {
  InlineGhostText,
  TextInputState,
} from '../types/textInputTypes.js'
import {
  Cursor,
  getLastKill,
  pushToKillRing,
  recordYank,
  resetKillAccumulation,
  resetYankState,
  updateYankLength,
  yankPop,
} from '../utils/Cursor.js'
import { env } from '../utils/env.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import type { ImageDimensions } from '../utils/imageResizer.js'
import { isModifierPressed, prewarmModifiers } from '../utils/modifiers.js'
import { useDoublePress } from './useDoublePress.js'

// biome-ignore lint/suspicious/noConfusingVoidType: void is the correct return type for cursor handlers that return nothing
type MaybeCursor = void | Cursor
type InputHandler = (input: string) => MaybeCursor
type InputMapper = (input: string) => MaybeCursor
const NOOP_HANDLER: InputHandler = () => {}
function mapInput(input_map: Array<[string, InputHandler]>): InputMapper {
  const map = new Map(input_map)
  return function (input: string): MaybeCursor {
    return (map.get(input) ?? NOOP_HANDLER)(input)
  }
}

export type UseTextInputProps = {
  value: string
  onChange: (value: string) => void
  onSubmit?: (value: string) => void
  onExit?: () => void
  onExitMessage?: (show: boolean, key?: string) => void
  onHistoryUp?: () => void
  onHistoryDown?: () => void
  onHistoryReset?: () => void
  onClearInput?: () => void
  focus?: boolean
  mask?: string
  multiline?: boolean
  cursorChar: string
  highlightPastedText?: boolean
  invert: (text: string) => string
  themeText: (text: string) => string
  columns: number
  onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void
  disableCursorMovementForUpDownKeys?: boolean
  disableEscapeDoublePress?: boolean
  maxVisibleLines?: number
  externalOffset: number
  onOffsetChange: (offset: number) => void
  inputFilter?: (input: string, key: Key) => string
  inlineGhostText?: InlineGhostText
  dim?: (text: string) => string
}

export function useTextInput({
  value: originalValue,
  onChange,
  onSubmit,
  onExit,
  onExitMessage,
  onHistoryUp,
  onHistoryDown,
  onHistoryReset,
  onClearInput,
  mask = '',
  multiline = false,
  cursorChar,
  invert,
  columns,
  onImagePaste: _onImagePaste,
  disableCursorMovementForUpDownKeys = false,
  disableEscapeDoublePress = false,
  maxVisibleLines,
  externalOffset,
  onOffsetChange,
  inputFilter,
  inlineGhostText,
  dim,
}: UseTextInputProps): TextInputState {
  // 为 Apple Terminal 预加载修饰键模块（内部有防护机制，可安全多次调用）
  if (env.terminal === 'Apple_Terminal') {
    prewarmModifiers()
  }

  const offset = externalOffset
  const setOffset = onOffsetChange
  const cursor = Cursor.fromText(originalValue, columns, offset)
  const { addNotification, removeNotification } = useNotifications()

  const handleCtrlC = useDoublePress(
    show => {
      onExitMessage?.(show, 'Ctrl-C')
    },
    () => onExit?.(),
    () => {
      if (originalValue) {
        onChange('')
        setOffset(0)
        onHistoryReset?.()
      }
    },
  )

  // 注意（键位绑定）：此转义处理程序特意未迁移到键位绑定系统。
  // 这是用于清除输入的文本级双击 Esc 功能，而非操作级键位绑定。
  // 双击 Esc 清除输入并保存至历史记录——这是文本编辑行为，
  // 而非对话框关闭操作，且需要双击安全机制。
  const handleEscape = useDoublePress(
    (show: boolean) => {
      if (!originalValue || !show) {
        return
      }
      addNotification({
        key: 'escape-again-to-clear',
        text: '再次按 Esc 清除',
        priority: 'immediate',
        timeoutMs: 1000,
      })
    },
    () => {
      // 立即移除“再次按 Esc 清除”通知
      removeNotification('escape-again-to-clear')
      onClearInput?.()
      if (originalValue) {
        // 追踪双击 Esc 使用情况以进行功能发现
        // 清除前保存至历史记录
        if (originalValue.trim() !== '') {
          addToHistory(originalValue)
        }
        onChange('')
        setOffset(0)
        onHistoryReset?.()
      }
    },
  )

  const handleEmptyCtrlD = useDoublePress(
    show => {
      if (originalValue !== '') {
        return
      }
      onExitMessage?.(show, 'Ctrl-D')
    },
    () => {
      if (originalValue !== '') {
        return
      }
      onExit?.()
    },
  )

  function handleCtrlD(): MaybeCursor {
    if (cursor.text === '') {
      // 当输入为空时，处理双击操作
      handleEmptyCtrlD()
      return cursor
    }
    // 当输入非空时，像 iPython 一样向前删除
    return cursor.del()
  }

  function killToLineEnd(): Cursor {
    const { cursor: newCursor, killed } = cursor.deleteToLineEnd()
    pushToKillRing(killed, 'append')
    return newCursor
  }

  function killToLineStart(): Cursor {
    const { cursor: newCursor, killed } = cursor.deleteToLineStart()
    pushToKillRing(killed, 'prepend')
    return newCursor
  }

  function killWordBefore(): Cursor {
    const { cursor: newCursor, killed } = cursor.deleteWordBefore()
    pushToKillRing(killed, 'prepend')
    return newCursor
  }

  function yank(): Cursor {
    const text = getLastKill()
    if (text.length > 0) {
      const startOffset = cursor.offset
      const newCursor = cursor.insert(text)
      recordYank(startOffset, text.length)
      return newCursor
    }
    return cursor
  }

  function handleYankPop(): Cursor {
    const popResult = yankPop()
    if (!popResult) {
      return cursor
    }
    const { text, start, length } = popResult
    // 用新文本替换先前拉取的文本
    const before = cursor.text.slice(0, start)
    const after = cursor.text.slice(start + length)
    const newText = before + text + after
    const newOffset = start + text.length
    updateYankLength(text.length)
    return Cursor.fromText(newText, columns, newOffset)
  }

  const handleCtrl = mapInput([
    ['a', () => cursor.startOfLine()],
    ['b', () => cursor.left()],
    ['c', handleCtrlC],
    ['d', handleCtrlD],
    ['e', () => cursor.endOfLine()],
    ['f', () => cursor.right()],
    ['h', () => cursor.deleteTokenBefore() ?? cursor.backspace()],
    ['k', killToLineEnd],
    ['n', () => downOrHistoryDown()],
    ['p', () => upOrHistoryUp()],
    ['u', killToLineStart],
    ['w', killWordBefore],
    ['y', yank],
  ])

  const handleMeta = mapInput([
    ['b', () => cursor.prevWord()],
    ['f', () => cursor.nextWord()],
    ['d', () => cursor.deleteWordAfter()],
    ['y', handleYankPop],
  ])

  function handleEnter(key: Key) {
    if (
      multiline &&
      cursor.offset > 0 &&
      cursor.text[cursor.offset - 1] === '\\'
    ) {
      // 追踪用户是否使用了反斜杠+回车
      markBackslashReturnUsed()
      return cursor.backspace().insert('\n')
    }
    // Meta+Enter 或 Shift+Enter 插入换行符
    if (key.meta || key.shift) {
      return cursor.insert('\n')
    }
    // Apple Terminal 不支持自定义 Shift+Enter 键位绑定，
    // 因此我们使用原生 macOS 修饰键检测来检查是否按住 Shift
    if (env.terminal === 'Apple_Terminal' && isModifierPressed('shift')) {
      return cursor.insert('\n')
    }
    onSubmit?.(originalValue)
  }

  function upOrHistoryUp() {
    if (disableCursorMovementForUpDownKeys) {
      onHistoryUp?.()
      return cursor
    }
    // 首先尝试按换行行移动
    const cursorUp = cursor.up()
    if (!cursorUp.equals(cursor)) {
      return cursorUp
    }

    // 若无法按换行行移动且为多行输入，
    // 则尝试按逻辑行移动（以处理段落边界）
    if (multiline) {
      const cursorUpLogical = cursor.upLogicalLine()
      if (!cursorUpLogical.equals(cursor)) {
        return cursorUpLogical
      }
    }

    // 完全无法向上移动——触发历史记录导航
    onHistoryUp?.()
    return cursor
  }
  function downOrHistoryDown() {
    if (disableCursorMovementForUpDownKeys) {
      onHistoryDown?.()
      return cursor
    }
    // 首先尝试按换行行移动
    const cursorDown = cursor.down()
    if (!cursorDown.equals(cursor)) {
      return cursorDown
    }

    // 若无法按换行行移动且为多行输入，
    // 则尝试按逻辑行移动（以处理段落边界）
    if (multiline) {
      const cursorDownLogical = cursor.downLogicalLine()
      if (!cursorDownLogical.equals(cursor)) {
        return cursorDownLogical
      }
    }

    // 完全无法向下移动——触发历史记录导航
    onHistoryDown?.()
    return cursor
  }

  function mapKey(key: Key): InputMapper {
    switch (true) {
      case key.escape:
        return () => {
          // 当键位绑定上下文（如自动补全）拥有转义控制权时跳过。
          // useKeybindings 无法通过 stopImmediatePropagation 保护我们——
          // BaseTextInput 的 useInput 优先注册（子级效果先于父级效果触发），
          // 因此当键位绑定的处理程序停止传播时，此处理程序已执行完毕。
          // 返回当前光标位置不变——handleEscape 内部管理状态
          if (disableEscapeDoublePress) return cursor
          handleEscape()
          // 原样返回当前光标 - handleEscape 在内部管理状态
          return cursor
        }
      case key.leftArrow && (key.ctrl || key.meta || key.fn):
        return () => cursor.prevWord()
      case key.rightArrow && (key.ctrl || key.meta || key.fn):
        return () => cursor.nextWord()
      case key.backspace:
        return key.meta || key.ctrl
          ? killWordBefore
          : () => cursor.deleteTokenBefore() ?? cursor.backspace()
      case key.delete:
        return key.meta ? killToLineEnd : () => cursor.del()
      case key.ctrl:
        return handleCtrl
      case key.home:
        return () => cursor.startOfLine()
      case key.end:
        return () => cursor.endOfLine()
      case key.pageDown:
        // 在全屏模式下，PgUp/PgDn 滚动消息视口，而不是移动光标——此处无操作，由 ScrollKeybindingHandler 处理。
        // 仅当启用全屏鼠标跟踪时，才存在鼠标滚轮事件。
        if (isFullscreenEnvEnabled()) {
          return NOOP_HANDLER
        }
        return () => cursor.endOfLine()
      case key.pageUp:
        if (isFullscreenEnvEnabled()) {
          return NOOP_HANDLER
        }
        return () => cursor.startOfLine()
      case key.wheelUp:
      case key.wheelDown:
        // ScrollKeybindingHandler 处理它们；此处无操作，以避免将原始 SGR 序列作为文本插入。
        // 必须在 key.meta 之前，以便 Option+Return 插入换行符
        // End 键
        return NOOP_HANDLER
      case key.return:
        // 文本后的尾随 \r 是 SSH 合并的 Enter（"o\r"）——
        return () => handleEnter(key)
      case key.meta:
        return handleMeta
      case key.tab:
        return () => cursor
      case key.upArrow && !key.shift:
        return upOrHistoryUp
      case key.downArrow && !key.shift:
        return downOrHistoryDown
      case key.leftArrow:
        return () => cursor.left()
      case key.rightArrow:
        return () => cursor.right()
      default: {
        return function (input: string) {
          switch (true) {
            // Home key
            case input === '\x1b[H' || input === '\x1b[1~':
              return cursor.startOfLine()
            // 移除它，以免将 Enter 作为内容插入。单独的 \r
            case input === '\x1b[F' || input === '\x1b[4~':
              return cursor.endOfLine()
            default: {
              // 此处是 Alt+Enter 泄漏（META_KEY_CODE_RE 不匹配 \x1b\r）——留给下面的 \r→\n 处理。嵌入的 \r
              // 是来自未启用括号粘贴的终端的多行粘贴——转换为 \n。反斜杠+\r 是过时的 VS Code
              // Shift+Enter 绑定（在 #8991 /terminal-setup 之前，args.text 被写入 keybindings.json 为 "\\\r\n"）；保留 \r，以便
              // 它在下面变为 \n（anthropics/claude-code#31316）。
              // 检查是否为 kill 命令（Ctrl+K、Ctrl+U、Ctrl+W 或 Meta+Backspace/Delete）
              // 检查是否为 yank 命令（Ctrl+Y 或 Alt+Y）
              // 注意：图像粘贴快捷键（chat:imagePaste）通过 PromptInput 中的 useKeybindings 处理
              // 如果提供了过滤器，则应用过滤器
              // 如果输入被过滤掉，则不执行任何操作
              const text = stripAnsi(input)
                // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .replace(re, str) on 1-2 char keystrokes: no-match returns same string (Object.is), regex never runs
                .replace(/(?<=[^\\\r\n])\r$/, '')
                .replace(/\r/g, '\n')
              if (cursor.isAtStart() && isInputModeCharacter(input)) {
                return cursor.insert(text).left()
              }
              return cursor.insert(text)
            }
          }
        }
      }
    }
  }

  // 修复 Issue #1853：过滤在 SSH/tmux 中干扰退格键的 DEL 字符
  function isKillKey(key: Key, input: string): boolean {
    if (key.ctrl && (input === 'k' || input === 'u' || input === 'w')) {
      return true
    }
    if (key.meta && (key.backspace || key.delete)) {
      return true
    }
    return false
  }

  // 在 SSH/tmux 环境中，退格键会同时生成按键事件和原始 DEL 字符
  function isYankKey(key: Key, input: string): boolean {
    return (key.ctrl || key.meta) && input === 'y'
  }

  function onInput(input: string, key: Key): void {
    // 将所有 DEL 字符作为退格操作同步应用

    // 首先尝试删除 token，回退到字符退格
    const filteredInput = inputFilter ? inputFilter(input, key) : input

    // 使用最终结果一次性更新状态
    if (filteredInput === '' && input !== '') {
      return
    }

    // 为非 kill 键重置 kill 累积
    // 为非 yank 键重置 yank 状态（中断 yank-pop 链）
    if (!key.backspace && !key.delete && input.includes('\x7f')) {
      const delCount = (input.match(/\x7f/g) || []).length

      // SSH 合并的 Enter：在慢速链路上，"o" + Enter 可能作为一个块 "o\r" 到达。
      // parseKeypress 仅匹配 s === '\r'，因此它命中了
      let currentCursor = cursor
      for (let i = 0; i < delCount; i++) {
        currentCursor =
          currentCursor.deleteTokenBefore() ?? currentCursor.backspace()
      }

      // 使用最终结果一次性更新状态
      if (!cursor.equals(currentCursor)) {
        if (cursor.text !== currentCursor.text) {
          onChange(currentCursor.text)
        }
        setOffset(currentCursor.offset)
      }
      resetKillAccumulation()
      resetYankState()
      return
    }

    // 为非 kill 键重置 kill 累积
    if (!isKillKey(key, filteredInput)) {
      resetKillAccumulation()
    }

    // 为非 yank 键重置 yank 状态（中断 yank-pop 链）
    if (!isYankKey(key, filteredInput)) {
      resetYankState()
    }

    const nextCursor = mapKey(key)(filteredInput)
    if (nextCursor) {
      if (!cursor.equals(nextCursor)) {
        if (cursor.text !== nextCursor.text) {
          onChange(nextCursor.text)
        }
        setOffset(nextCursor.offset)
      }
      // SSH 合并的 Enter 键：在慢速链路上，“o” + Enter 可能作为一个整体到达
      // 块 "o\r"。parseKeypress 仅匹配 s === '\r'，因此它触发了
      // 默认处理程序（已去除末尾的 \r）。文本末尾
      // 恰好有一个 \r 时合并为 Enter 键；单独的 \r 是 Alt+Enter
      // （换行）；嵌入的 \r 表示多行粘贴。
      if (
        filteredInput.length > 1 &&
        filteredInput.endsWith('\r') &&
        !filteredInput.slice(0, -1).includes('\r') &&
        // Backslash+CR is a stale VS Code Shift+Enter binding, not
        // coalesced Enter. See default handler above.
        filteredInput[filteredInput.length - 2] !== '\\'
      ) {
        onSubmit?.(nextCursor.text)
      }
    }
  }

  // 准备渲染幽灵文本 - 验证插入位置是否匹配当前
  // 光标偏移，防止来自先前按键的陈旧幽灵文本导致
  // 单帧抖动（幽灵文本状态在渲染后通过 useEffect 更新）
  const ghostTextForRender =
    inlineGhostText && dim && inlineGhostText.insertPosition === offset
      ? { text: inlineGhostText.text, dim }
      : undefined

  const cursorPos = cursor.getPosition()

  return {
    onInput,
    renderedValue: cursor.render(
      cursorChar,
      mask,
      invert,
      ghostTextForRender,
      maxVisibleLines,
    ),
    offset,
    setOffset,
    cursorLine: cursorPos.line - cursor.getViewportStartLine(maxVisibleLines),
    cursorColumn: cursorPos.column,
    viewportCharOffset: cursor.getViewportCharOffset(maxVisibleLines),
    viewportCharEnd: cursor.getViewportCharEnd(maxVisibleLines),
  }
}
