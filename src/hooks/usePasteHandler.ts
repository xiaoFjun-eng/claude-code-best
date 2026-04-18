import { basename } from 'path'
import React from 'react'
import { logError } from 'src/utils/log.js'
import { useDebounceCallback } from 'usehooks-ts'
import type { InputEvent, Key } from '@anthropic/ink'
import {
  getImageFromClipboard,
  isImageFilePath,
  PASTE_THRESHOLD,
  tryReadImageFromPath,
} from '../utils/imagePaste.js'
import type { ImageDimensions } from '../utils/imageResizer.js'
import { getPlatform } from '../utils/platform.js'

const CLIPBOARD_CHECK_DEBOUNCE_MS = 50
const PASTE_COMPLETION_TIMEOUT_MS = 100

type PasteHandlerProps = {
  onPaste?: (text: string) => void
  onInput: (input: string, key: Key) => void
  onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void
}

export function usePasteHandler({
  onPaste,
  onInput,
  onImagePaste,
}: PasteHandlerProps): {
  wrappedOnInput: (input: string, key: Key, event: InputEvent) => void
  pasteState: {
    chunks: string[]
    timeoutId: ReturnType<typeof setTimeout> | null
  }
  isPasting: boolean
} {
  const [pasteState, setPasteState] = React.useState<{
    chunks: string[]
    timeoutId: ReturnType<typeof setTimeout> | null
  }>({ chunks: [], timeoutId: null })
  const [isPasting, setIsPasting] = React.useState(false)
  const isMountedRef = React.useRef(true)
  // 与 pasteState.timeoutId 镜像同步更新。当粘贴和按键输入同时到达同一个 stdin 数据块时，两个 wrappedOnInput 调用会在 React 提交前的同一批离散更新中执行——第二次调用会读取过时的 pasteState.timeoutId（null）并走 onInput 路径。如果该按键是 Enter，就会提交旧的输入，导致粘贴内容丢失。
  // 与 pasteState.timeoutId 镜像同步更新。当粘贴和按键输入同时到达同一个 stdin 数据块时，两个 wrappedOnInput 调用会在 React 提交前的同一批离散更新中执行——第二次调用会读取过时的 pasteState.timeoutId（null）并走 onInput 路径。如果该按键是 Enter，就会提交旧的输入，导致粘贴内容丢失。
  // 与 pasteState.timeoutId 镜像同步更新。当粘贴和按键输入同时到达同一个 stdin 数据块时，两个 wrappedOnInput 调用会在 React 提交前的同一批离散更新中执行——第二次调用会读取过时的 pasteState.timeoutId（null）并走 onInput 路径。如果该按键是 Enter，就会提交旧的输入，导致粘贴内容丢失。
  // 与 pasteState.timeoutId 镜像同步更新。当粘贴和按键输入同时到达同一个 stdin 数据块时，两个 wrappedOnInput 调用会在 React 提交前的同一批离散更新中执行——第二次调用会读取过时的 pasteState.timeoutId（null）并走 onInput 路径。如果该按键是 Enter，就会提交旧的输入，导致粘贴内容丢失。
  // 与 pasteState.timeoutId 镜像同步更新。当粘贴和按键输入同时到达同一个 stdin 数据块时，两个 wrappedOnInput 调用会在 React 提交前的同一批离散更新中执行——第二次调用会读取过时的 pasteState.timeoutId（null）并走 onInput 路径。如果该按键是 Enter，就会提交旧的输入，导致粘贴内容丢失。
  const pastePendingRef = React.useRef(false)

  const isMacOS = React.useMemo(() => getPlatform() === 'macos', [])

  React.useEffect(() => {
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const checkClipboardForImageImpl = React.useCallback(() => {
    if (!onImagePaste || !isMountedRef.current) return

    void getImageFromClipboard()
      .then(imageData => {
        if (imageData && isMountedRef.current) {
          onImagePaste(
            imageData.base64,
            imageData.mediaType,
            undefined, // no filename for clipboard images
            imageData.dimensions,
          )
        }
      })
      .catch(error => {
        if (isMountedRef.current) {
          logError(error as Error)
        }
      })
      .finally(() => {
        if (isMountedRef.current) {
          setIsPasting(false)
        }
      })
  }, [onImagePaste])

  const checkClipboardForImage = useDebounceCallback(
    checkClipboardForImageImpl,
    CLIPBOARD_CHECK_DEBOUNCE_MS,
  )

  const resetPasteTimeout = React.useCallback(
    (currentTimeoutId: ReturnType<typeof setTimeout> | null) => {
      if (currentTimeoutId) {
        clearTimeout(currentTimeoutId)
      }
      return setTimeout(
        (
          setPasteState,
          onImagePaste,
          onPaste,
          setIsPasting,
          checkClipboardForImage,
          isMacOS,
          pastePendingRef,
        ) => {
          pastePendingRef.current = false
          setPasteState(({ chunks }) => {
            // 合并数据块并过滤掉孤立的焦点序列
            // 粘贴时焦点事件被分割可能出现这种情况
            const pastedText = chunks
              .join('')
              .replace(/\[I$/, '')
              .replace(/\[O$/, '')

            // 检查粘贴文本是否包含图片文件路径
            // 拖拽多张图片时，它们可能以以下形式出现：
            // 1. 换行符分隔的路径（某些终端中常见）
            // 2. 空格分隔的路径（从 Finder 拖拽时常见）
            // 对于空格分隔的路径，我们按绝对路径前的空格进行分割：
            // - Unix：空格后接 `/`（例如 `/Users/...`）
            // - Windows：空格后接驱动器盘符和 `:\`（例如 `C:\Users\...`）
            // 之所以可行，是因为路径内的空格已转义（例如 `file\ name.png`）
            const lines = pastedText
              .split(/ (?=\/|[A-Za-z]:\\)/)
              .flatMap(part => part.split('\n'))
              .filter(line => line.trim())
            const imagePaths = lines.filter(line => isImageFilePath(line))

            if (onImagePaste && imagePaths.length > 0) {
              const isTempScreenshot =
                /\/TemporaryItems\/.*screencaptureui.*\/Screenshot/i.test(
                  pastedText,
                )

              // 处理所有图片路径
              void Promise.all(
                imagePaths.map(imagePath => tryReadImageFromPath(imagePath)),
              ).then(results => {
                const validImages = results.filter(
                  (r): r is NonNullable<typeof r> => r !== null,
                )

                if (validImages.length > 0) {
                  // 成功读取至少一张图片
                  for (const imageData of validImages) {
                    const filename = basename(imageData.path)
                    onImagePaste(
                      imageData.base64,
                      imageData.mediaType,
                      filename,
                      imageData.dimensions,
                      imageData.path,
                    )
                  }
                  // 如果某些路径不是图片，则作为文本粘贴
                  const nonImageLines = lines.filter(
                    line => !isImageFilePath(line),
                  )
                  if (nonImageLines.length > 0 && onPaste) {
                    onPaste(nonImageLines.join('\n'))
                  }
                  setIsPasting(false)
                } else if (isTempScreenshot && isMacOS) {
                  // 对于已不存在的临时截图文件，尝试从剪贴板读取
                  checkClipboardForImage()
                } else {
                  if (onPaste) {
                    onPaste(pastedText)
                  }
                  setIsPasting(false)
                }
              })
              return { chunks: [], timeoutId: null }
            }

            // 如果粘贴内容为空（常见于使用 Cmd+V 粘贴图片时），
            // 检查剪贴板是否有图片（仅限 macOS）
            if (isMacOS && onImagePaste && pastedText.length === 0) {
              checkClipboardForImage()
              return { chunks: [], timeoutId: null }
            }

            // 处理常规粘贴
            if (onPaste) {
              onPaste(pastedText)
            }
            // 粘贴完成后重置 isPasting 状态
            setIsPasting(false)
            return { chunks: [], timeoutId: null }
          })
        },
        PASTE_COMPLETION_TIMEOUT_MS,
        setPasteState,
        onImagePaste,
        onPaste,
        setIsPasting,
        checkClipboardForImage,
        isMacOS,
        pastePendingRef,
      )
    },
    [checkClipboardForImage, isMacOS, onImagePaste, onPaste],
  )

  // 粘贴检测现在通过 InputEvent 的 keypress.isPasted 标志实现，
  // 该标志由按键解析器在检测到括号粘贴模式时设置。
  // 这避免了在 stdin 上设置多个监听器导致的竞态条件。
  // 之前我们在此处设置了 stdin.on('data') 监听器，它与
  // App.tsx 中的 'readable' 监听器竞争，导致字符丢失。

  const wrappedOnInput = (input: string, key: Key, event: InputEvent): void => {
    // 从解析后的按键事件检测粘贴。
    // 按键解析器为括号粘贴模式内的内容设置 isPasted=true。
    const isFromPaste = event.keypress.isPasted

    // 如果这是粘贴的内容，设置 isPasting 状态以提供 UI 反馈
    if (isFromPaste) {
      setIsPasting(true)
    }

    // 处理大型粘贴（>PASTE_THRESHOLD 字符）
    // 通常我们一次会收到一两个输入字符。如果我们
    // 收到的字符数超过阈值，用户很可能执行了粘贴操作。
    // 遗憾的是，节点会分批处理长粘贴内容，因此有可能
    // 我们会先看到例如 1024 个字符，然后在下一帧中
    // 只看到属于原始粘贴内容的少量额外字符。
    // 这种分批处理的数目并不固定。

    // 处理可能的图像文件名（即使它们短于粘贴阈值）
    // 当拖拽多个图像时，它们可能以换行分隔或
    // 空格分隔的路径形式出现。在绝对路径前的空格处分割：
    // - Unix：` /` - Windows：` C:\` 等。
    const hasImageFilePath = input
      .split(/ (?=\/|[A-Za-z]:\\)/)
      .flatMap(part => part.split('\n'))
      .some(line => isImageFilePath(line.trim()))

    // 处理空粘贴（macOS 上的剪贴板图像）
    // 当用户使用 Cmd+V 粘贴图像时，终端会发送一个空的
    // 括号粘贴序列。按键解析器会将其作为 isPasted=true
    // 且输入为空的情况发出。
    if (isFromPaste && input.length === 0 && isMacOS && onImagePaste) {
      checkClipboardForImage()
      // 重置 isPasting，因为没有文本内容需要处理
      setIsPasting(false)
      return
    }

    // 检查是否应作为粘贴处理（来自括号粘贴、大量输入或连续输入）
    const shouldHandleAsPaste =
      onPaste &&
      (input.length > PASTE_THRESHOLD ||
        pastePendingRef.current ||
        hasImageFilePath ||
        isFromPaste)

    if (shouldHandleAsPaste) {
      pastePendingRef.current = true
      setPasteState(({ chunks, timeoutId }) => {
        return {
          chunks: [...chunks, input],
          timeoutId: resetPasteTimeout(timeoutId),
        }
      })
      return
    }
    onInput(input, key)
    if (input.length > 10) {
      // 确保在任何其他多字符输入时关闭 setIsPasting，
      // 因为 stdin 缓冲区可能在任意点分块，如果输入长度
      // 对于 stdin 缓冲区过长，可能会分割
      // 结束转义序列。
      setIsPasting(false)
    }
  }

  return {
    wrappedOnInput,
    pasteState,
    isPasting,
  }
}
