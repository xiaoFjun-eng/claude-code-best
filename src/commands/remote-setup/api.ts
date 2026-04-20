import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { logForDebugging } from '../../utils/debug.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'
import { fetchEnvironments } from '../../utils/teleport/environments.js'

const CCR_BYOC_BETA_HEADER = 'ccr-byoc-2025-07-29'

/** 包装一个原始的 GitHub 令牌，使其字符串表示形式被隐去。
`String(token)`、模板字面量、`JSON.stringify(token)` 以及任何附加的错误信息都将显示 `[REDACTED:gh-token]` 而非令牌值。仅在将原始值放入 HTTP 请求体的唯一位置调用 `.reveal()`。 */
export class RedactedGithubToken {
  readonly #value: string
  constructor(raw: string) {
    this.#value = raw
  }
  reveal(): string {
    return this.#value
  }
  toString(): string {
    return '[REDACTED:gh-token]'
  }
  toJSON(): string {
    return '[REDACTED:gh-token]'
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[REDACTED:gh-token]'
  }
}

export type ImportTokenResult = {
  github_username: string
}

export type ImportTokenError =
  | { kind: 'not_signed_in' }
  | { kind: 'invalid_token' }
  | { kind: 'server'; status: number }
  | { kind: 'network' }

/** 向 CCR 后端 POST 一个 GitHub 令牌，后端会通过 GitHub 的 /user 端点验证该令牌，并将其以 Fernet 加密方式存储在 sync_user_tokens 中。
存储的令牌满足与 OAuth 令牌相同的读取路径，因此在此操作成功后，claude.ai/code 中的克隆/推送功能可立即使用。 */
export async function importGithubToken(
  token: RedactedGithubToken,
): Promise<
  | { ok: true; result: ImportTokenResult }
  | { ok: false; error: ImportTokenError }
> {
  let accessToken: string, orgUUID: string
  try {
    ;({ accessToken, orgUUID } = await prepareApiRequest())
  } catch {
    return { ok: false, error: { kind: 'not_signed_in' } }
  }

  const url = `${getOauthConfig().BASE_API_URL}/v1/code/github/import-token`
  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': CCR_BYOC_BETA_HEADER,
    'x-organization-uuid': orgUUID,
  }

  try {
    const response = await axios.post<ImportTokenResult>(
      url,
      { token: token.reveal() },
      { headers, timeout: 15000, validateStatus: () => true },
    )
    if (response.status === 200) {
      return { ok: true, result: response.data }
    }
    if (response.status === 400) {
      return { ok: false, error: { kind: 'invalid_token' } }
    }
    if (response.status === 401) {
      return { ok: false, error: { kind: 'not_signed_in' } }
    }
    logForDebugging(`import-token 返回了 ${response.status}`, {
      level: 'error',
    })
    return { ok: false, error: { kind: 'server', status: response.status } }
  } catch (err) {
    if (axios.isAxiosError(err)) {
      // err.config.data 将包含带有原始令牌的 POS
      // T 请求体。请勿将其包含在任何日志中。仅错误代码就足够了。
      logForDebugging(`import-token 网络错误：${err.code ?? 'unknown'}`, {
        level: 'error',
      })
    }
    return { ok: false, error: { kind: 'network' } }
  }
}

async function hasExistingEnvironment(): Promise<boolean> {
  try {
    const envs = await fetchEnvironments()
    return envs.length > 0
  } catch {
    return false
  }
}

/** 尽力创建默认环境。镜像 Web 引导流程中的 DEFAULT_CLOUD_ENVIRONMENT_REQUEST，以便首次用户直接进入编辑器而非环境设置页面。首先检查是否存在现有环境，以避免重复运行 /web-setup 时产生重复项。失败不影响关键流程——令牌导入已成功，Web 状态机将在下次加载时回退到环境设置。 */
export async function createDefaultEnvironment(): Promise<boolean> {
  let accessToken: string, orgUUID: string
  try {
    ;({ accessToken, orgUUID } = await prepareApiRequest())
  } catch {
    return false
  }

  if (await hasExistingEnvironment()) {
    return true
  }

  // /private/organizations/{org}/ 路径会拒绝 CLI OAuth 令牌（错误
  // 的认证依赖）。公共路径使用 build_flexible_auth —— 与 fetchEn
  // vironments() 使用的路径相同。组织通过 x-organization-uuid 请求头传递。
  const url = `${getOauthConfig().BASE_API_URL}/v1/environment_providers/cloud/create`
  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  try {
    const response = await axios.post(
      url,
      {
        name: 'Default',
        kind: 'anthropic_cloud',
        description: '默认 - 受信任的网络访问',
        config: {
          environment_type: 'anthropic',
          cwd: '/home/user',
          init_script: null,
          environment: {},
          languages: [
            { name: 'python', version: '3.11' },
            { name: 'node', version: '20' },
          ],
          network_config: {
            allowed_hosts: [],
            allow_default_hosts: true,
          },
        },
      },
      { headers, timeout: 15000, validateStatus: () => true },
    )
    return response.status >= 200 && response.status < 300
  } catch {
    return false
  }
}

/** 当用户拥有有效的 Claude OAuth 凭据时返回 true。 */
export async function isSignedIn(): Promise<boolean> {
  try {
    await prepareApiRequest()
    return true
  } catch {
    return false
  }
}

export function getCodeWebUrl(): string {
  return `${getOauthConfig().CLAUDE_AI_ORIGIN}/code`
}
