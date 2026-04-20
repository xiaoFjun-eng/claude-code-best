/** `claude mcp xaa` — 管理 XAA (SEP-990) IdP 连接。

IdP 连接是用户级别的：配置一次，所有启用 XAA 的 MCP 服务器都会复用。它存储在 settings.xaaIdp（非机密）和一个由颁发者标识的钥匙串槽位（机密）中。信任域与每个服务器的 AS 密钥是分开的。 */
import type { Command } from '@commander-js/extra-typings'
import { cliError, cliOk } from '../../cli/exit.js'
import {
  acquireIdpIdToken,
  clearIdpClientSecret,
  clearIdpIdToken,
  getCachedIdpIdToken,
  getIdpClientSecret,
  getXaaIdpSettings,
  issuerKey,
  saveIdpClientSecret,
  saveIdpIdTokenFromJwt,
} from '../../services/mcp/xaaIdpLogin.js'
import { errorMessage } from '../../utils/errors.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

export function registerMcpXaaIdpCommand(mcp: Command): void {
  const xaaIdp = mcp
    .command('xaa')
    .description('管理 XAA (SEP-990) IdP 连接')

  xaaIdp
    .command('setup')
    .description(
      '配置 IdP 连接（一次性设置，适用于所有启用 XAA 的服务器）',
    )
    .requiredOption('--issuer <url>', 'IdP 颁发者 URL (OIDC 发现)')
    .requiredOption('--client-id <id>', "Claude Code 在 IdP 处的 client_id")
    .option(
      '--client-secret',
      '从 MCP_XAA_IDP_CLIENT_SECRET 环境变量读取 IdP 客户端密钥',
    )
    .option(
      '--callback-port <port>',
      '固定的环回回调端口（仅在 IdP 不遵循 RFC 8252 端口任意匹配规则时使用）',
    )
    .action(options => {
      // 在任何写入操作之前验证所有内容。写入过程中 exit(1) 会导致 setti
      // ngs 已配置但钥匙串缺失——状态混乱。updateSettingsF
      // orSource 在写入时不进行模式检查；一个非 URL 的颁发者会被写入磁
      // 盘，然后在下次启动时污染整个 userSettings 源（SettingsSc
      // hema .url() 失败 → parseSettingsFile 返回
      // { settings: null }，丢弃所有内容，而不仅仅是 xaaIdp）。
      let issuerUrl: URL
      try {
        issuerUrl = new URL(options.issuer)
      } catch {
        return cliError(
          `错误：--issuer 必须是有效的 URL（收到 "${options.issuer}"）`,
        )
      }
      // OIDC 发现和令牌交换针对此主机运行。仅允许对环回地址使用
      // http://（用于一致性测试套件的模拟 IdP）；其他任
      // 何情况都会导致客户端密钥和授权码以明文形式泄露。
      if (
        issuerUrl.protocol !== 'https:' &&
        !(
          issuerUrl.protocol === 'http:' &&
          (issuerUrl.hostname === 'localhost' ||
            issuerUrl.hostname === '127.0.0.1' ||
            issuerUrl.hostname === '[::1]')
        )
      ) {
        return cliError(
          `错误：--issuer 必须使用 https://（收到 "${issuerUrl.protocol}//${issuerUrl.host}"）`,
        )
      }
      const callbackPort = options.callbackPort
        ? parseInt(options.callbackPort, 10)
        : undefined
      // callbackPort <= 0 会导致下次启动时 Zod 的 .positiv
      // e() 验证失败——与上述颁发者检查相同的 settings 污染故障模式。
      if (
        callbackPort !== undefined &&
        (!Number.isInteger(callbackPort) || callbackPort <= 0)
      ) {
        return cliError('错误：--callback-port 必须是一个正整数')
      }
      const secret = options.clientSecret
        ? process.env.MCP_XAA_IDP_CLIENT_SECRET
        : undefined
      if (options.clientSecret && !secret) {
        return cliError(
          '错误：--client-secret 需要 MCP_XAA_IDP_CLIENT_SECRET 环境变量',
        )
      }

      // 现在读取旧配置（在覆盖 settings 之前），以便在成功写入后可
      // 以清除过时的钥匙串槽位。`clear` 无法事后执行此操作——它读
      // 取的是 *当前* 的 settings.xaaIdp，而那时已经是
      // 新配置了。
      const old = getXaaIdpSettings()
      const oldIssuer = old?.issuer
      const oldClientId = old?.clientId

      // callbackPort 必须存在（即使是 undefined）——merge
      // With 进行深度合并，并且仅在显式 `undefined` 时删除键，而不是在
      // 键缺失时。条件展开会将之前固定的端口泄露到新 IdP 的配置中。
      const { error } = updateSettingsForSource('userSettings', {
        xaaIdp: {
          issuer: options.issuer,
          clientId: options.clientId,
          callbackPort,
        },
      })
      if (error) {
        return cliError(`写入 settings 时出错：${error.message}`)
      }

      // 仅在 settings 写入成功后清除过时的钥匙串槽位——
      // 否则写入失败会导致 settings 仍指向 oldIssue
      // r，但其密钥已被删除。通过 issuerKey() 进行比较：
      // 尾部斜杠或主机名大小写差异会标准化为同一个钥匙串槽位。
      if (oldIssuer) {
        if (issuerKey(oldIssuer) !== issuerKey(options.issuer)) {
          clearIdpIdToken(oldIssuer)
          clearIdpClientSecret(oldIssuer)
        } else if (oldClientId !== options.clientId) {
          // 相同的颁发者槽位但不同的 OAuth 客户端注册——缓存的 id_t
          // oken 的 aud 声明和存储的密钥都是针对旧客户端的。`xaa lo
          // gin` 会发送 {新 clientId, 旧密钥} 并因不透明的 `i
          // nvalid_client` 而失败；下游 SEP-990 交换也会
          // 因 aud 验证失败而失败。当 clientId 未更改时保留两者：不
          // 带 --client-secret 重新设置意味着“调整端口，保留密钥”。
          clearIdpIdToken(oldIssuer)
          clearIdpClientSecret(oldIssuer)
        }
      }

      if (secret) {
        const { success, warning } = saveIdpClientSecret(options.issuer, secret)
        if (!success) {
          return cliError(
            `错误：settings 已写入但钥匙串保存失败${warning ? ` — ${warning}` : ''}。` +
              `钥匙串可用后，请使用 --client-secret 重新运行。`,
          )
        }
      }

      cliOk(`已为 ${options.issuer} 配置 XAA IdP 连接`)
    })

  xaaIdp
    .command('login')
    .description(
      '缓存一个 IdP id_token，以便启用 XAA 的 MCP 服务器可以静默认证。' +
        '默认：运行 OIDC 浏览器登录。使用 --id-token：' +
        '直接写入一个预先获取的 JWT（用于一致性/端到端测试，' +
        '其中模拟 IdP 不提供 /authorize 端点）。',
    )
    .option(
      '--force',
      '忽略任何缓存的 id_token 并重新登录（在 IdP 端撤销后很有用）',
    )
    // TODO(paulc)：从标准输入而非命令行参数读取 JWT，以避免其出现在 shell 历
    // 史记录中。对于一致性测试来说没问题（docker exec 直接使用 argv，不经过 s
    // hell 解析器），但真实用户会希望使用 `echo $TOKEN | ... --stdin`。
    .option(
      '--id-token <jwt>',
      '将此预先获取的 id_token 直接写入缓存，跳过 OIDC 浏览器登录',
    )
    .action(async options => {
      const idp = getXaaIdpSettings()
      if (!idp) {
        return cliError(
          "错误：未配置 XAA IdP 连接。请先运行 'claude mcp xaa setup'。",
        )
      }

      // 直接注入路径：跳过缓存检查，跳过 OIDC。写入操作
      // 本身就是目的。颁发者来自设置（单一事实来源），而非单独
      // 的标志——减少一个可能不同步的环节。
      if (options.idToken) {
        const expiresAt = saveIdpIdTokenFromJwt(idp.issuer, options.idToken)
        return cliOk(
          `id_token 已为 ${idp.issuer} 缓存（将于 ${new Date(expiresAt).toISOString()} 过期）`,
        )
      }

      if (options.force) {
        clearIdpIdToken(idp.issuer)
      }

      const wasCached = getCachedIdpIdToken(idp.issuer) !== undefined
      if (wasCached) {
        return cliOk(
          `已登录到 ${idp.issuer}（缓存的 id_token 仍然有效）。使用 --force 重新登录。`,
        )
      }

      process.stdout.write(`正在打开浏览器进行 IdP 登录，地址：${idp.issuer}…
`)
      try {
        await acquireIdpIdToken({
          idpIssuer: idp.issuer,
          idpClientId: idp.clientId,
          idpClientSecret: getIdpClientSecret(idp.issuer),
          callbackPort: idp.callbackPort,
          onAuthorizationUrl: url => {
            process.stdout.write(
              `如果浏览器未自动打开，请访问：
  ${url}
`,
            )
          },
        })
        cliOk(
          `登录成功。使用 --xaa 的 MCP 服务器现在将进行静默认证。`,
        )
      } catch (e) {
        cliError(`IdP 登录失败：${errorMessage(e)}`)
      }
    })

  xaaIdp
    .command('show')
    .description('显示当前的 IdP 连接配置')
    .action(() => {
      const idp = getXaaIdpSettings()
      if (!idp) {
        return cliOk('未配置 XAA IdP 连接。')
      }
      const hasSecret = getIdpClientSecret(idp.issuer) !== undefined
      const hasIdToken = getCachedIdpIdToken(idp.issuer) !== undefined
      process.stdout.write(`Issuer:        ${idp.issuer}\n`)
      process.stdout.write(`客户端 ID：     ${idp.clientId}
`)
      if (idp.callbackPort !== undefined) {
        process.stdout.write(`回调端口： ${idp.callbackPort}
`)
      }
      process.stdout.write(
        `客户端密钥： ${hasSecret ? '(stored in keychain)' : '(not set — PKCE-only)'}
`,
      )
      process.stdout.write(
        `已登录：     ${hasIdToken ? 'yes (id_token cached)' : "no — run 'claude mcp xaa login'"}
`,
      )
      cliOk()
    })

  xaaIdp
    .command('clear')
    .description('清除 IdP 连接配置和缓存的 id_token')
    .action(() => {
      // 首先读取颁发者，以便我们可以清除正确的钥匙串槽位。
      const idp = getXaaIdpSettings()
      // updateSettingsForSource 使用 mergeWith：设置为 undefined（
      // 而非删除）以发出移除密钥的信号。
      const { error } = updateSettingsForSource('userSettings', {
        xaaIdp: undefined,
      })
      if (error) {
        return cliError(`写入设置时出错：${error.message}`)
      }
      // 仅在设置写入成功后清除钥匙串——否则，写入失败
      // 会导致设置仍指向 IdP，但其密钥已被删除（与
      // `setup` 中旧颁发者清理的模式相同）。
      if (idp) {
        clearIdpIdToken(idp.issuer)
        clearIdpClientSecret(idp.issuer)
      }
      cliOk('XAA IdP 连接已清除')
    })
}
