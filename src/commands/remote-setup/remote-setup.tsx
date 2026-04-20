import { execa } from 'execa'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { Select } from '../../components/CustomSelect/index.js'
import { Box, Dialog, LoadingState, Text } from '@anthropic/ink'
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS as SafeString,
} from '../../services/analytics/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { openBrowser } from '../../utils/browser.js'
import { getGhAuthStatus } from '../../utils/github/ghAuthStatus.js'
import {
  createDefaultEnvironment,
  getCodeWebUrl,
  type ImportTokenError,
  importGithubToken,
  isSignedIn,
  RedactedGithubToken,
} from './api.js'

type CheckResult =
  | { status: 'not_signed_in' }
  | { status: 'has_gh_token'; token: RedactedGithubToken }
  | { status: 'gh_not_installed' }
  | { status: 'gh_not_authenticated' }

async function checkLoginState(): Promise<CheckResult> {
  if (!(await isSignedIn())) {
    return { status: 'not_signed_in' }
  }

  const ghStatus = await getGhAuthStatus()
  if (ghStatus === 'not_installed') {
    return { status: 'gh_not_installed' }
  }
  if (ghStatus === 'not_authenticated') {
    return { status: 'gh_not_authenticated' }
  }

  // ghStatus === 'authenticated'。getGhAuthStatus 以 std
  // out:'ignore' 启动（遥测安全）；再次以 stdout:'pipe' 启动以读取令牌。
  const { stdout } = await execa('gh', ['auth', 'token'], {
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: 5000,
    reject: false,
  })
  const trimmed = stdout.trim()
  if (!trimmed) {
    return { status: 'gh_not_authenticated' }
  }
  return { status: 'has_gh_token', token: new RedactedGithubToken(trimmed) }
}

function errorMessage(err: ImportTokenError, codeUrl: string): string {
  switch (err.kind) {
    case 'not_signed_in':
      return `登录失败。请访问 ${codeUrl} 并使用 GitHub App 登录`
    case 'invalid_token':
      return 'GitHub 拒绝了该令牌。请运行 `gh auth login` 并重试。'
    case 'server':
      return `服务器错误 (${err.status})。请稍后重试。`
    case 'network':
      return "无法连接到服务器。请检查您的网络连接。"
  }
}

type Step =
  | { name: 'checking' }
  | { name: 'confirm'; token: RedactedGithubToken }
  | { name: 'uploading' }

function Web({ onDone }: { onDone: LocalJSXCommandOnDone }) {
  const [step, setStep] = useState<Step>({ name: 'checking' })

  useEffect(() => {
    logEvent('tengu_remote_setup_started', {})
    void checkLoginState().then(async result => {
      switch (result.status) {
        case 'not_signed_in':
          logEvent('tengu_remote_setup_result', {
            result: 'not_signed_in' as SafeString,
          })
          onDone('未登录 Claude。请先运行 /login。')
          return
        case 'gh_not_installed':
        case 'gh_not_authenticated': {
          const url = `${getCodeWebUrl()}/onboarding?step=alt-auth`
          await openBrowser(url)
          logEvent('tengu_remote_setup_result', {
            result: result.status as SafeString,
          })
          onDone(
            result.status === 'gh_not_installed'
              ? `未找到 GitHub CLI。请通过 https://cli.github.com/ 安装，然后运行 \`gh auth login\`，或在网页端连接 GitHub：${url}`
              : `GitHub CLI 未认证。请运行 \`gh auth login\` 并重试，或在网页端连接 GitHub：${url}`,
          )
          return
        }
        case 'has_gh_token':
          setStep({ name: 'confirm', token: result.token })
      }
    })
    // onDone 在渲染间保持稳定；特意不放入依赖项。eslint-disable-n
    // ext-line react-hooks/exhaustive-deps
  }, [])

  const handleCancel = () => {
    logEvent('tengu_remote_setup_result', {
      result: 'cancelled' as SafeString,
    })
    onDone()
  }

  const handleConfirm = async (token: RedactedGithubToken) => {
    setStep({ name: 'uploading' })

    const result = await importGithubToken(token)
    if (!result.ok) {
      const err = (result as { ok: false; error: ImportTokenError }).error
      logEvent('tengu_remote_setup_result', {
        result: 'import_failed' as SafeString,
        error_kind: err.kind as SafeString,
      })
      onDone(errorMessage(err, getCodeWebUrl()))
      return
    }

    // 令牌导入成功。环境创建是尽力而为的——如果失败，网
    // 页状态机将在着陆时路由到 env-setup，这会多
    // 一次点击，但仍比 OAuth 流程要好。
    await createDefaultEnvironment()

    const url = getCodeWebUrl()
    await openBrowser(url)

    logEvent('tengu_remote_setup_result', {
      result: 'success' as SafeString,
    })
    onDone(`已连接为 ${result.result.github_username}。已打开 ${url}`)
  }

  if (step.name === 'checking') {
    return <LoadingState message="正在检查登录状态…" />
  }

  if (step.name === 'uploading') {
    return <LoadingState message="正在将 Claude 连接到 GitHub…" />
  }

  const token = step.token
  return (
    <Dialog
      title="是否在网页上将 Claude 连接到您的 GitHub 账户？"
      onCancel={handleCancel}
      hideInputGuide
    >
      <Box flexDirection="column">
        <Text>
          网页版 Claude 需要连接到您的 GitHub 账户，以便代表您克隆和推送代码。</Text>
        <Text dimColor>
          您的本地凭据将用于向 GitHub 进行身份验证</Text>
      </Box>
      <Select
        options={[
          { label: 'Continue', value: 'send' },
          { label: 'Cancel', value: 'cancel' },
        ]}
        onChange={value => {
          if (value === 'send') {
            void handleConfirm(token)
          } else {
            handleCancel()
          }
        }}
        onCancel={handleCancel}
      />
    </Dialog>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
): Promise<React.ReactNode> {
  return <Web onDone={onDone} />
}
