import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import type { ToolUseContext } from '../../Tool.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/AskUserQuestionTool/prompt.js'
import { REMOTE_TRIGGER_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/RemoteTriggerTool/prompt.js'
import { getClaudeAIOAuthTokens } from '../../utils/auth.js'
import { checkRepoForRemoteAccess } from '../../utils/background/remote/preconditions.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  detectCurrentRepositoryWithHost,
  parseGitRemote,
} from '../../utils/detectRepository.js'
import { getRemoteUrl } from '../../utils/git.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  createDefaultCloudEnvironment,
  type EnvironmentResource,
  fetchEnvironments,
} from '../../utils/teleport/environments.js'
import { registerBundledSkill } from '../bundledSkills.js'

// 标记 ID 系统使用的 Base58 字母表（比特币风格）
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** 将 mcpsrv_ 标记的 ID 解码为 UUID 字符串。
标记 ID 的格式为：mcpsrv_01{base58(uuid.int)}
其中 01 是版本前缀。

TODO(public-ship)：在公开发布之前，/v1/mcp_servers 端点
应直接返回原始 UUID，这样我们就不需要在客户端进行解码。
标记 ID 格式是内部实现细节，可能会更改。 */
function taggedIdToUUID(taggedId: string): string | null {
  const prefix = 'mcpsrv_'
  if (!taggedId.startsWith(prefix)) {
    return null
  }
  const rest = taggedId.slice(prefix.length)
  // 跳过版本前缀（2 个字符，始终为 "01"）
  const base58Data = rest.slice(2)

  // 将 base58 解码为 bigint
  let n = 0n
  for (const c of base58Data) {
    const idx = BASE58.indexOf(c)
    if (idx === -1) {
      return null
    }
    n = n * 58n + BigInt(idx)
  }

  // 转换为 UUID 十六进制字符串
  const hex = n.toString(16).padStart(32, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

type ConnectorInfo = {
  uuid: string
  name: string
  url: string
}

function getConnectedClaudeAIConnectors(
  mcpClients: MCPServerConnection[],
): ConnectorInfo[] {
  const connectors: ConnectorInfo[] = []
  for (const client of mcpClients) {
    if (client.type !== 'connected') {
      continue
    }
    if (client.config.type !== 'claudeai-proxy') {
      continue
    }
    const uuid = taggedIdToUUID(client.config.id)
    if (!uuid) {
      continue
    }
    connectors.push({
      uuid,
      name: client.name,
      url: client.config.url,
    })
  }
  return connectors
}

function sanitizeConnectorName(name: string): string {
  return name
    .replace(/^claude[.\s-]ai[.\s-]/i, '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function formatConnectorsInfo(connectors: ConnectorInfo[]): string {
  if (connectors.length === 0) {
    return '未找到已连接的 MCP 连接器。用户可能需要访问 https://claude.ai/settings/connectors 连接服务器'
  }
  const lines = ['已连接的连接器（可用于触发器）：']
  for (const c of connectors) {
    const safeName = sanitizeConnectorName(c.name)
    lines.push(
      `- ${c.name} (connector_uuid: ${c.uuid}, name: ${safeName}, url: ${c.url})`,
    )
  }
  return lines.join('\n')
}

const BASE_QUESTION = '您希望对计划的远程代理执行什么操作？'

/** 将设置说明格式化为带项目符号的“注意”块。在初始 AskUserQuestion 对话框文本（无参数路径）和提示正文部分（有参数路径）之间共享，以确保说明永远不会被静默丢弃。 */
function formatSetupNotes(notes: string[]): string {
  const items = notes.map(n => `- ${n}`).join('\n')
  return `⚠ 注意：
${items}`
}

async function getCurrentRepoHttpsUrl(): Promise<string | null> {
  const remoteUrl = await getRemoteUrl()
  if (!remoteUrl) {
    return null
  }
  const parsed = parseGitRemote(remoteUrl)
  if (!parsed) {
    return null
  }
  return `https://${parsed.host}/${parsed.owner}/${parsed.name}`
}

function buildPrompt(opts: {
  userTimezone: string
  connectorsInfo: string
  gitRepoUrl: string | null
  environmentsInfo: string
  createdEnvironment: EnvironmentResource | null
  setupNotes: string[]
  needsGitHubAccessReminder: boolean
  userArgs: string
}): string {
  const {
    userTimezone,
    connectorsInfo,
    gitRepoUrl,
    environmentsInfo,
    createdEnvironment,
    setupNotes,
    needsGitHubAccessReminder,
    userArgs,
  } = opts
  // 当用户传递参数时，会跳过初始的 AskUserQuesti
  // on 对话框。设置说明必须在提示正文中显示，否则它们会被
  // 计算并静默丢弃（相对于旧的硬性阻止，这是一种回归）。
  const setupNotesSection =
    userArgs && setupNotes.length > 0
      ? `
## 设置说明

${formatSetupNotes(setupNotes)}
`
      : ''
  const initialQuestion =
    setupNotes.length > 0
      ? `${formatSetupNotes(setupNotes)}\n\n${BASE_QUESTION}`
      : BASE_QUESTION
  const firstStep = userArgs
    ? `用户已经告诉您他们想要什么（请参阅底部的“用户请求”）。跳过初始问题，直接进入匹配的工作流程。`
    : `您的 FIRST 操作必须是单个 ${ASK_USER_QUESTION_TOOL_NAME} 工具调用（无需前言）。使用此 EXACT 字符串作为 \`question\` 字段 — 不要转述或缩短它：

${jsonStringify(initialQuestion)}

设置 \`header: "操作"\` 并提供四个操作（创建/列出/更新/运行）作为选项。用户选择后，请遵循下面的匹配工作流程。`

  return `# 计划远程代理

您正在帮助用户计划、更新、列出或运行**远程** Claude Code 代理。这些不是本地 cron 作业 — 每个触发器都会按照 cron 计划在 Anthropic 的云基础设施中启动一个完全隔离的远程会话（CCR）。代理在沙盒环境中运行，拥有自己的 git 检出、工具和可选的 MCP 连接。

## 第一步

${firstStep}
${setupNotesSection}

## 您可以做什么

使用 \`${REMOTE_TRIGGER_TOOL_NAME}\` 工具（首先使用 \`ToolSearch select:${REMOTE_TRIGGER_TOOL_NAME}\` 加载它；身份验证在进程内处理 — 不要使用 curl）：

- \`{action: "list"}\` — 列出所有触发器
- \`{action: "get", trigger_id: "..."}\` — 获取一个触发器
- \`{action: "create", body: {...}}\` — 创建触发器
- \`{action: "update", trigger_id: "...", body: {...}}\` — 部分更新
- \`{action: "run", trigger_id: "..."}\` — 立即运行触发器

您 CANNOT 删除触发器。如果用户要求删除，请引导他们访问：https://claude.ai/code/scheduled

## 创建请求体结构

\`\`\`json
{
  "name": "AGENT_NAME",
  "cron_expression": "CRON_EXPR",
  "enabled": true,
  "job_config": {
    "ccr": {
      "environment_id": "ENVIRONMENT_ID",
      "session_context": {
        "model": "claude-sonnet-4-6",
        "sources": [
          {"git_repository": {"url": "${gitRepoUrl || 'https://github.com/ORG/REPO'}"}}
        ],
        "allowed_tools": ["Bash", "Read", "Write", "Edit", "Glob", "Grep"]
      },
      "events": [
        {"data": {
          "uuid": "<lowercase v4 uuid>",
          "session_id": "",
          "type": "user",
          "parent_tool_use_id": null,
          "message": {"content": "PROMPT_HERE", "role": "user"}
        }}
      ]
    }
  }
}
\`\`\`

请自行为 \`events[].data.uuid\` 生成一个新的小写 UUID。

## 可用的 MCP 连接器

这些是用户当前连接的 claude.ai MCP 连接器：

${connectorsInfo}

将连接器附加到触发器时，请使用上面显示的 \`connector_uuid\` 和 \`name\`（该名称已清理，仅包含字母、数字、连字符和下划线），以及连接器的 URL。\`mcp_connections\` 中的 \`name\` 字段只能包含 \`[a-zA-Z0-9_-]\` — 不允许使用点和空格。

**重要提示：** 根据用户的描述推断代理需要哪些服务。例如，如果他们说“检查 Datadog 并通过 Slack 通知我错误”，则代理需要 Datadog 和 Slack 连接器。请对照上面的列表进行交叉引用，如果缺少任何必需的服务，请发出警告。如果缺少所需的连接器，请引导用户访问 https://claude.ai/settings/connectors 先进行连接。

## 环境

每个触发器都需要在作业配置中指定一个 \`environment_id\`。这决定了远程代理在哪里运行。询问用户要使用哪个环境。

${environmentsInfo}

将 \`id\` 值用作 \`job_config.ccr.environment_id\` 中的 \`environment_id\`。
${createdEnvironment ? `\n**Note:** A new environment \`${createdEnvironment.name}\` (id: \`${createdEnvironment.environment_id}\`) was just created for the user because they had none. Use this id for \`job_config.ccr.environment_id\` and mention the creation when you confirm the trigger config.\n` : ''}

## API 字段参考

### 创建触发器 — 必填字段
- \`name\` (string) — 描述性名称
- \`cron_expression\` (string) — 5 字段 cron 表达式。**最小间隔为 1 小时。**
- \`job_config\` (object) — 会话配置（参见上面的结构）

### 创建触发器 — 可选字段
- \`enabled\` (boolean, default: true)
- \`mcp_connections\` (array) — 要附加的 MCP 服务器：
  \`\`\`json
  [{"connector_uuid": "uuid", "name": "server-name", "url": "https://..."}]
  \`\`\`

### 更新触发器 — 可选字段
所有字段都是可选的（部分更新）：
- \`name\`, \`cron_expression\`, \`enabled\`, \`job_config\`
- \`mcp_connections\` — 替换 MCP 连接
- \`clear_mcp_connections\` (boolean) — 移除所有 MCP 连接

### Cron 表达式示例

用户的本地时区是 **${userTimezone}**。Cron 表达式始终使用 UTC。当用户说本地时间时，将其转换为 UTC 以生成 cron 表达式，但请与他们确认：“${userTimezone} 时间上午 9 点 = UTC 时间 X 点，因此 cron 表达式为 \`0 X * * 1-5\`。”

- \`0 9 * * 1-5\` — 每个工作日上午 9 点 **UTC**
- \`0 */2 * * *\` — 每 2 小时
- \`0 0 * * *\` — 每天午夜 **UTC**
- \`30 14 * * 1\` — 每周一下午 2:30 **UTC**
- \`0 8 1 * *\` — 每月 1 日上午 8 点 **UTC**

最小间隔为 1 小时。\`*/30 * * * *\` 将被拒绝。

## 工作流程

### 创建新触发器：

1.  **理解目标** — 询问他们希望远程代理做什么。使用哪个仓库？什么任务？提醒他们代理是远程运行的 — 它无法访问他们的本地机器、本地文件或本地环境变量。
2.  **设计提示** — 帮助他们编写有效的代理提示。好的提示应具备以下特点：
    - 明确要做什么以及成功标准是什么
    - 清楚要关注哪些文件/区域
    - 明确要采取哪些操作（打开 PR、提交、仅分析等）
3.  **设置计划** — 询问何时以及多久运行一次。用户的时区是 ${userTimezone}。当他们说一个时间（例如，“每天早上 9 点”）时，假设他们指的是本地时间，并将其转换为 UTC 以生成 cron 表达式。始终确认转换：“${userTimezone} 时间上午 9 点 = UTC 时间 X 点。”
4.  **选择模型** — 默认为 \`claude-sonnet-4-6\`。告诉用户您默认使用的模型，并询问他们是否想要不同的模型。
5.  **验证连接** — 根据用户的描述推断代理需要哪些服务。例如，如果他们说“检查 Datadog 并通过 Slack 通知我错误”，则代理需要 Datadog 和 Slack MCP 连接器。与上面的连接器列表进行交叉引用。如果缺少任何连接器，请警告用户并引导他们访问 https://claude.ai/settings/connectors 先进行连接。${gitRepoUrl ? ` The default git repo is already set to \`${gitRepoUrl}\`. Ask the user if this is the right repo or if they need a different one.` : ' Ask which git repos the remote agent needs cloned into its environment.'}
6.  **审查并确认** — 在创建之前显示完整配置。让他们进行调整。
7.  **创建** — 使用 \`action: "create"\` 调用 \`${REMOTE_TRIGGER_TOOL_NAME}\` 并显示结果。响应中包含触发器 ID。最后始终输出一个链接：\`https://claude.ai/code/scheduled/{TRIGGER_ID}\`

### 更新触发器：

1. 首先列出触发器，以便用户选择
2. 询问他们想要更改什么
3. 显示当前值与建议值
4. 确认并更新

### 列出触发器：

1. 获取并以可读格式显示
2. 显示：名称、计划（人类可读）、启用/禁用状态、下次运行时间、仓库

### 立即运行：

1. 如果用户未指定，则列出触发器
2. 确认要运行哪个触发器
3. 执行并确认

## 重要说明

- 这些是 REMOTE 代理 — 它们在 Anthropic 的云中运行，而不是在用户的机器上。它们无法访问本地文件、本地服务或本地环境变量。
- 显示时始终将 cron 表达式转换为人类可读的格式
- 除非用户另有说明，否则默认为 \`enabled: true\`
- 接受任何格式的 GitHub URL（https://github.com/org/repo, org/repo 等）并将其规范化为完整的 HTTPS URL（不带 .git 后缀）
- 提示是最重要的部分 — 花时间把它做好。远程代理从零上下文开始，因此提示必须是自包含的。
- 要删除触发器，请引导用户访问 https://claude.ai/code/scheduled
${needsGitHubAccessReminder ? `- If the user's request seems to require GitHub repo access (e.g. cloning a repo, opening PRs, reading code), remind them that ${getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_lantern', false) ? "they should run /web-setup to connect their GitHub account (or install the Claude GitHub App on the repo as an alternative) — otherwise the remote agent won't be able to access it" : "they need the Claude GitHub App installed on the repo — otherwise the remote agent won't be able to access it"}.` : ''}
${userArgs ? `\n## User Request\n\nThe user said: "${userArgs}"\n\nStart by understanding their intent and working through the appropriate workflow above.` : ''}`
}

export function registerScheduleRemoteAgentsSkill(): void {
  registerBundledSkill({
    name: 'schedule',
    description:
      '创建、更新、列出或运行按 cron 计划执行的计划远程代理（触发器）。',
    whenToUse:
      '当用户想要计划一个重复运行的远程代理、设置自动化任务、为 Claude Code 创建 cron 作业或管理其计划的代理/触发器时使用。',
    userInvocable: true,
    isEnabled: () =>
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_surreal_dali', false) &&
      isPolicyAllowed('allow_remote_sessions'),
    allowedTools: [REMOTE_TRIGGER_TOOL_NAME, ASK_USER_QUESTION_TOOL_NAME],
    async getPromptForCommand(args: string, context: ToolUseContext) {
      if (!getClaudeAIOAuthTokens()?.accessToken) {
        return [
          {
            type: 'text',
            text: '您需要先使用 claude.ai 帐户进行身份验证。不支持 API 帐户。请运行 /login，然后重试 /schedule。',
          },
        ]
      }

      let environments: EnvironmentResource[]
      try {
        environments = await fetchEnvironments()
      } catch (err) {
        logForDebugging(`[schedule] 获取环境失败：${err}`, {
          level: 'warn',
        })
        return [
          {
            type: 'text',
            text: "我们无法连接您的远程 claude.ai 帐户来设置计划任务。请几分钟后重试 /schedule。",
          },
        ]
      }

      let createdEnvironment: EnvironmentResource | null = null
      if (environments.length === 0) {
        try {
          createdEnvironment = await createDefaultCloudEnvironment(
            'claude-code-default',
          )
          environments = [createdEnvironment]
        } catch (err) {
          logForDebugging(`[schedule] 创建环境失败：${err}`, {
            level: 'warn',
          })
          return [
            {
              type: 'text',
              text: '未找到远程环境，且我们无法自动创建一个。请访问 https://claude.ai/code 设置一个，然后重试 /schedule。',
            },
          ]
        }
      }

      // 软性设置检查 — 作为前期说明收集并嵌入到初始的 AskUse
      // rQuestion 对话框中。从不阻止 — 触发器不需要
      // git 源（例如，仅限 Slack 的轮询），并且触发器的源
      // 可能指向与当前工作目录不同的仓库。
      const setupNotes: string[] = []
      let needsGitHubAccessReminder = false

      const repo = await detectCurrentRepositoryWithHost()
      if (repo === null) {
        setupNotes.push(
          `不在 git 仓库中 — 您需要手动指定一个仓库 URL（或者完全跳过仓库）。`,
        )
      } else if (repo.host === 'github.com') {
        const { hasAccess } = await checkRepoForRemoteAccess(
          repo.owner,
          repo.name,
        )
        if (!hasAccess) {
          needsGitHubAccessReminder = true
          const webSetupEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
            'tengu_cobalt_lantern',
            false,
          )
          const msg = webSetupEnabled
            ? `GitHub 未连接到 ${repo.owner}/${repo.name} — 请运行 /web-setup 同步您的 GitHub 凭据，或在 https://claude.ai/code/onboarding?magic=github-app-setup 安装 Claude GitHub App。`
            : `Claude GitHub App 未安装在 ${repo.owner}/${repo.name} 上 — 如果您的触发器需要此仓库，请在 https://claude.ai/code/onboarding?magic=github-app-setup 安装。`
          setupNotes.push(msg)
        }
      }
      // 非 github.com 主机（GHE/GitLab 等）：静默跳过。GitHub
      // App 检查是特定于 github.com 的，并且“不在 git 仓库中”的说明
      // 在事实上是错误的 — 下面的 getCurrentRepoHttpsUrl()
      // 仍将使用 GHE URL 填充 gitRepoUrl。

      const connectors = getConnectedClaudeAIConnectors(
        context.options.mcpClients,
      )
      if (connectors.length === 0) {
        setupNotes.push(
          `没有 MCP 连接器 — 如果需要，请在 https://claude.ai/settings/connectors 连接。`,
        )
      }

      const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const connectorsInfo = formatConnectorsInfo(connectors)
      const gitRepoUrl = await getCurrentRepoHttpsUrl()
      const lines = ['可用环境：']
      for (const env of environments) {
        lines.push(
          `- ${env.name} (id: ${env.environment_id}, kind: ${env.kind})`,
        )
      }
      const environmentsInfo = lines.join('\n')
      const prompt = buildPrompt({
        userTimezone,
        connectorsInfo,
        gitRepoUrl,
        environmentsInfo,
        createdEnvironment,
        setupNotes,
        needsGitHubAccessReminder,
        userArgs: args,
      })
      return [{ type: 'text', text: prompt }]
    },
  })
}
