import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { KeyboardShortcutHint } from '@anthropic/ink'
import { Spinner } from '../../components/Spinner.js'
import TextInput from '../../components/TextInput.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { type KeyboardEvent, setClipboard, Box, Link, Text } from '@anthropic/ink'
import { OAuthService } from '../../services/oauth/index.js'
import { saveOAuthTokensIfNeeded } from '../../utils/auth.js'
import { logError } from '../../utils/log.js'

interface OAuthFlowStepProps {
  onSuccess: (token: string) => void
  onCancel: () => void
}

type OAuthStatus =
  | { state: 'starting' }
  | { state: 'waiting_for_login'; url: string }
  | { state: 'processing' }
  | { state: 'success'; token: string }
  | { state: 'error'; message: string; toRetry?: OAuthStatus }
  | { state: 'about_to_retry'; nextState: OAuthStatus }

const PASTE_HERE_MSG = '如果提示，请在此处粘贴代码 > '

export function OAuthFlowStep({
  onSuccess,
  onCancel,
}: OAuthFlowStepProps): React.ReactNode {
  const [oauthStatus, setOAuthStatus] = useState<OAuthStatus>({
    state: 'starting',
  })
  const [oauthService] = useState(() => new OAuthService())
  const [pastedCode, setPastedCode] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [showPastePrompt, setShowPastePrompt] = useState(false)
  const [urlCopied, setUrlCopied] = useState(false)
  const timersRef = useRef<Set<NodeJS.Timeout>>(new Set())
  // 使用独立的 ref，这样 startOAuth 的计时器清除操作就不会取消 urlCopied 的重置
  const urlCopiedTimerRef = useRef<NodeJS.Timeout | undefined>(undefined)

  const terminalSize = useTerminalSize()
  const textInputColumns = Math.max(
    50,
    terminalSize.columns - PASTE_HERE_MSG.length - 4,
  )

  function handleKeyDown(e: KeyboardEvent): void {
    if (oauthStatus.state !== 'error') return
    e.preventDefault()
    if (e.key === 'return' && oauthStatus.toRetry) {
      setPastedCode('')
      setCursorOffset(0)
      setOAuthStatus({
        state: 'about_to_retry',
        nextState: oauthStatus.toRetry,
      })
    } else {
      onCancel()
    }
  }

  async function handleSubmitCode(value: string, url: string) {
    try {
      // 期望从授权回调 URL 获取格式为 "authorizationCode#state" 的数据
      const [authorizationCode, state] = value.split('#')

      if (!authorizationCode || !state) {
        setOAuthStatus({
          state: 'error',
          message: '无效的代码。请确保复制了完整的代码',
          toRetry: { state: 'waiting_for_login', url },
        })
        return
      }

      // 追踪用户正在采取的路径（手动代码输入）
      logEvent('tengu_oauth_manual_entry', {})
      oauthService.handleManualAuthCodeInput({
        authorizationCode,
        state,
      })
    } catch (err: unknown) {
      logError(err)
      setOAuthStatus({
        state: 'error',
        message: (err as Error).message,
        toRetry: { state: 'waiting_for_login', url },
      })
    }
  }

  const startOAuth = useCallback(async () => {
    // 启动新的 OAuth 流程时，清除所有现有的计时器
    timersRef.current.forEach(timer => clearTimeout(timer))
    timersRef.current.clear()

    try {
      const result = await oauthService.startOAuthFlow(
        async url => {
          setOAuthStatus({ state: 'waiting_for_login', url })
          const timer = setTimeout(setShowPastePrompt, 3000, true)
          timersRef.current.add(timer)
        },
        {
          loginWithClaudeAi: true, // 订阅令牌始终使用 Claude AI
          inferenceOnly: true,
          expiresIn: 365 * 24 * 60 * 60, // 1 年
        },
      )

      // 显示处理状态
      setOAuthStatus({ state: 'processing' })

      // OAuthFlowStep 为 GitHub Actions 创建仅用于推理
      // 的令牌，并非替代登录。请直接使用 saveOAuthTokensIfN
      // eeded 以避免 performLogout 破坏用户现有的认证会话。
      saveOAuthTokensIfNeeded(result)

      // 对于 OAuth 流程，访问令牌可用作 API 密钥
      const timer1 = setTimeout(
        (setOAuthStatus, accessToken, onSuccess, timersRef) => {
          setOAuthStatus({ state: 'success', token: accessToken })
          // 短暂延迟后自动继续，以显示成功
          const timer2 = setTimeout(onSuccess, 1000, accessToken)
          timersRef.current.add(timer2 as unknown as NodeJS.Timeout)
        },
        100,
        setOAuthStatus,
        result.accessToken,
        onSuccess,
        timersRef,
      )
      timersRef.current.add(timer1)
    } catch (err) {
      const errorMessage = (err as Error).message
      setOAuthStatus({
        state: 'error',
        message: errorMessage,
        toRetry: { state: 'starting' }, // 允许通过启动全新的 OAuth 流程来重试
      })
      logError(err)
      logEvent('tengu_oauth_error', {
        error:
          errorMessage as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
  }, [oauthService, onSuccess])

  useEffect(() => {
    if (oauthStatus.state === 'starting') {
      void startOAuth()
    }
  }, [oauthStatus.state, startOAuth])

  // 重试逻辑
  useEffect(() => {
    if (oauthStatus.state === 'about_to_retry') {
      const timer = setTimeout(
        (nextState, setShowPastePrompt, setOAuthStatus) => {
          // 仅在重试到 waiting_for_login 状态时显示粘贴提示
          setShowPastePrompt(nextState.state === 'waiting_for_login')
          setOAuthStatus(nextState)
        },
        500,
        oauthStatus.nextState,
        setShowPastePrompt,
        setOAuthStatus,
      )
      timersRef.current.add(timer)
    }
  }, [oauthStatus])

  useEffect(() => {
    if (
      pastedCode === 'c' &&
      oauthStatus.state === 'waiting_for_login' &&
      showPastePrompt &&
      !urlCopied
    ) {
      void setClipboard(oauthStatus.url).then(raw => {
        if (raw) process.stdout.write(raw)
        setUrlCopied(true)
        clearTimeout(urlCopiedTimerRef.current)
        urlCopiedTimerRef.current = setTimeout(setUrlCopied, 2000, false)
      })
      setPastedCode('')
    }
  }, [pastedCode, oauthStatus, showPastePrompt, urlCopied])

  // 组件卸载时清理 OAuth 服务和计时器
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      oauthService.cleanup()
      // 清除所有计时器
      timers.forEach(timer => clearTimeout(timer))
      timers.clear()
      clearTimeout(urlCopiedTimerRef.current)
    }
  }, [oauthService])

  // 用于渲染适当状态消息的辅助函数
  function renderStatusMessage(): React.ReactNode {
    switch (oauthStatus.state) {
      case 'starting':
        return (
          <Box>
            <Spinner />
            <Text>正在启动认证…</Text>
          </Box>
        )

      case 'waiting_for_login':
        return (
          <Box flexDirection="column" gap={1}>
            {!showPastePrompt && (
              <Box>
                <Spinner />
                <Text>
                  正在打开浏览器以使用您的 Claude 账户登录…</Text>
              </Box>
            )}

            {showPastePrompt && (
              <Box>
                <Text>{PASTE_HERE_MSG}</Text>
                <TextInput
                  value={pastedCode}
                  onChange={setPastedCode}
                  onSubmit={(value: string) =>
                    handleSubmitCode(value, oauthStatus.url)
                  }
                  cursorOffset={cursorOffset}
                  onChangeCursorOffset={setCursorOffset}
                  columns={textInputColumns}
                />
              </Box>
            )}
          </Box>
        )

      case 'processing':
        return (
          <Box>
            <Spinner />
            <Text>正在处理认证…</Text>
          </Box>
        )

      case 'success':
        return (
          <Box flexDirection="column" gap={1}>
            <Text color="success">
              ✓ 认证令牌创建成功！</Text>
            <Text dimColor>正在使用令牌进行 GitHub Actions 设置…</Text>
          </Box>
        )

      case 'error':
        return (
          <Box flexDirection="column" gap={1}>
            <Text color="error">OAuth 错误：{oauthStatus.message}</Text>
            {oauthStatus.toRetry ? (
              <Text dimColor>
                按 Enter 键重试，或按任意其他键取消</Text>
            ) : (
              <Text dimColor>按任意键返回 API 密钥选择</Text>
            )}
          </Box>
        )

      case 'about_to_retry':
        return (
          <Box flexDirection="column" gap={1}>
            <Text color="permission">Retrying…</Text>
          </Box>
        )

      default:
        return null
    }
  }

  return (
    <Box
      flexDirection="column"
      gap={1}
      tabIndex={0}
      autoFocus
      onKeyDown={handleKeyDown}
    >
      {/* 仅在初始启动状态时内联显示标题 */}
      {oauthStatus.state === 'starting' && (
        <Box flexDirection="column" gap={1} paddingBottom={1}>
          <Text bold>创建认证令牌</Text>
          <Text dimColor>正在为 GitHub Actions 创建长期有效的令牌</Text>
        </Box>
      )}
      {/* 为非启动状态显示标题（以避免与内联标题重复） */}
      {oauthStatus.state !== 'success' &&
        oauthStatus.state !== 'starting' &&
        oauthStatus.state !== 'processing' && (
          <Box key="header" flexDirection="column" gap={1} paddingBottom={1}>
            <Text bold>创建身份验证令牌</Text>
            <Text dimColor>为 GitHub Actions 创建长期有效的令牌</Text>
          </Box>
        )}
      {/* 粘贴提示可见时显示 URL */}
      {oauthStatus.state === 'waiting_for_login' && showPastePrompt && (
        <Box flexDirection="column" key="urlToCopy" gap={1} paddingBottom={1}>
          <Box paddingX={1}>
            <Text dimColor>
              浏览器未打开？请使用以下 URL 登录{' '}
            </Text>
            {urlCopied ? (
              <Text color="success">(Copied!)</Text>
            ) : (
              <Text dimColor>
                <KeyboardShortcutHint shortcut="c" action="copy" parens />
              </Text>
            )}
          </Box>
          <Link url={oauthStatus.url}>
            <Text dimColor>{oauthStatus.url}</Text>
          </Link>
        </Box>
      )}
      <Box paddingLeft={1} flexDirection="column" gap={1}>
        {renderStatusMessage()}
      </Box>
    </Box>
  )
}
