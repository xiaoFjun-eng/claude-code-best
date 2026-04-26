import { feature } from 'bun:bundle'
import memoize from 'lodash-es/memoize.js'
import { basename } from 'path'
import type { SettingSource } from 'src/utils/settings/constants.js'
import { z } from 'zod/v4'
import { isAutoMemoryEnabled } from 'src/memdir/paths.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  type McpServerConfig,
  McpServerConfigSchema,
} from 'src/services/mcp/types.js'
import type { ToolUseContext } from 'src/Tool.js'
import { logForDebugging } from 'src/utils/debug.js'
import {
  EFFORT_LEVELS,
  type EffortValue,
  parseEffortValue,
} from 'src/utils/effort.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'
import { parsePositiveIntFromFrontmatter } from 'src/utils/frontmatterParser.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { logError } from 'src/utils/log.js'
import {
  loadMarkdownFilesForSubdir,
  parseAgentToolsFromFrontmatter,
  parseSlashCommandToolsFromFrontmatter,
} from 'src/utils/markdownConfigLoader.js'
import {
  PERMISSION_MODES,
  type PermissionMode,
} from 'src/utils/permissions/PermissionMode.js'
import {
  clearPluginAgentCache,
  loadPluginAgents,
} from 'src/utils/plugins/loadPluginAgents.js'
import { HooksSchema, type HooksSettings } from 'src/utils/settings/types.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import {
  AGENT_COLORS,
  type AgentColorName,
  setAgentColor,
} from './agentColorManager.js'
import { type AgentMemoryScope, loadAgentMemoryPrompt } from './agentMemory.js'
import {
  checkAgentMemorySnapshot,
  initializeFromSnapshot,
} from './agentMemorySnapshot.js'
import { getBuiltInAgents } from './builtInAgents.js'

// 代理定义中 MCP 服务器规范的类型。可以
// 是按名称引用现有服务器，或以内联定义形式 { [name]: config }
export type AgentMcpServerSpec =
  | string // 按名称引用现有服务器（例如 "slack"）
  | { [name: string]: McpServerConfig } // 以内联定义形式 { name: config }

// 代理 MCP 服务器规范的 Zod 模式
const AgentMcpServerSpecSchema = lazySchema(() =>
  z.union([
    z.string(), // 按名称引用
    z.record(z.string(), McpServerConfigSchema()), // 以内联形式 { name: config }
  ]),
)

// 用于 JSON 代理验证的 Zod 模式。注意：
// HooksSchema 是惰性的，因此循环链 AppState -> loadAgentsDir -> settin
// gs/types 在模块加载时被中断
const AgentJsonSchema = lazySchema(() =>
  z.object({
    description: z.string().min(1, '描述不能为空'),
    tools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    prompt: z.string().min(1, '提示词不能为空'),
    model: z
      .string()
      .trim()
      .min(1, '模型不能为空')
      .transform(m => (m.toLowerCase() === 'inherit' ? 'inherit' : m))
      .optional(),
    effort: z.union([z.enum(EFFORT_LEVELS), z.number().int()]).optional(),
    permissionMode: z.enum(PERMISSION_MODES).optional(),
    mcpServers: z.array(AgentMcpServerSpecSchema()).optional(),
    hooks: HooksSchema().optional(),
    maxTurns: z.number().int().positive().optional(),
    skills: z.array(z.string()).optional(),
    initialPrompt: z.string().optional(),
    memory: z.enum(['user', 'project', 'local']).optional(),
    background: z.boolean().optional(),
    isolation: (process.env.USER_TYPE === 'ant'
      ? z.enum(['worktree', 'remote'])
      : z.enum(['worktree'])
    ).optional(),
  }),
)

const AgentsJsonSchema = lazySchema(() =>
  z.record(z.string(), AgentJsonSchema()),
)

// 所有代理共用的基础类型
export type BaseAgentDefinition = {
  agentType: string
  whenToUse: string
  tools?: string[]
  disallowedTools?: string[]
  skills?: string[] // 要预加载的技能名称（从逗号分隔的 frontmatter 解析）
  mcpServers?: AgentMcpServerSpec[] // 此代理专用的 MCP 服务器
  hooks?: HooksSettings // 代理启动时注册的会话作用域钩子
  color?: AgentColorName
  model?: string
  effort?: EffortValue
  permissionMode?: PermissionMode
  maxTurns?: number // 停止前的最大代理轮次数量
  filename?: string // 原始文件名（不含 .md 扩展名，适用于用户/项目/托管代理）
  baseDir?: string
  criticalSystemReminder_EXPERIMENTAL?: string // 每次用户轮次重新注入的简短消息
  requiredMcpServers?: string[] // 代理可用前必须配置的 MCP 服务器名称模式
  background?: boolean // 生成时始终作为后台任务运行
  initialPrompt?: string // 预置到第一个用户轮次（支持斜杠命令）
  memory?: AgentMemoryScope // 持久化内存作用域
  isolation?: 'worktree' | 'remote' // 在隔离的 git 工作树中运行，或远程在 CCR 中运行（仅限 ant）
  pendingSnapshotUpdate?: { snapshotTimestamp: string }
  /** 从代理的 userContext 中省略 CLAUDE.md 层级结构。只读代理（探索、规划）不需要提交/PR/代码检查指南——主代理拥有完整的 CLAUDE.md 并解释它们的输出。每周在 3400 万+ 探索生成中节省约 5-15 Gtok。紧急开关：tengu_slim_subagent_claudemd。 */
  omitClaudeMd?: boolean
}

// 内置代理 - 仅动态提示词，无静态 systemPrompt 字段
export type BuiltInAgentDefinition = BaseAgentDefinition & {
  source: 'built-in'
  baseDir: 'built-in'
  callback?: () => void
  getSystemPrompt: (params: {
    toolUseContext: Pick<ToolUseContext, 'options'>
  }) => string
}

// 来自用户/项目/策略设置的自定义代理 - 提示词通过闭包存储
export type CustomAgentDefinition = BaseAgentDefinition & {
  getSystemPrompt: () => string
  source: SettingSource
  filename?: string
  baseDir?: string
}

// 插件代理 - 类似于自定义代理但带有插件元数据，提示词通过闭包存储
export type PluginAgentDefinition = BaseAgentDefinition & {
  getSystemPrompt: () => string
  source: 'plugin'
  filename?: string
  plugin: string
}

// 所有代理类型的联合类型
export type AgentDefinition =
  | BuiltInAgentDefinition
  | CustomAgentDefinition
  | PluginAgentDefinition

// 用于运行时类型检查的类型守卫
export function isBuiltInAgent(
  agent: AgentDefinition,
): agent is BuiltInAgentDefinition {
  return agent.source === 'built-in'
}

export function isCustomAgent(
  agent: AgentDefinition,
): agent is CustomAgentDefinition {
  return agent.source !== 'built-in' && agent.source !== 'plugin'
}

export function isPluginAgent(
  agent: AgentDefinition,
): agent is PluginAgentDefinition {
  return agent.source === 'plugin'
}

export type AgentDefinitionsResult = {
  activeAgents: AgentDefinition[]
  allAgents: AgentDefinition[]
  failedFiles?: Array<{ path: string; error: string }>
  allowedAgentTypes?: string[]
}

export function getActiveAgentsFromList(
  allAgents: AgentDefinition[],
): AgentDefinition[] {
  const builtInAgents = allAgents.filter(a => a.source === 'built-in')
  const pluginAgents = allAgents.filter(a => a.source === 'plugin')
  const userAgents = allAgents.filter(a => a.source === 'userSettings')
  const projectAgents = allAgents.filter(a => a.source === 'projectSettings')
  const managedAgents = allAgents.filter(a => a.source === 'policySettings')
  const flagAgents = allAgents.filter(a => a.source === 'flagSettings')

  const agentGroups = [
    builtInAgents,
    pluginAgents,
    userAgents,
    projectAgents,
    flagAgents,
    managedAgents,
  ]

  const agentMap = new Map<string, AgentDefinition>()

  for (const agents of agentGroups) {
    for (const agent of agents) {
      agentMap.set(agent.agentType, agent)
    }
  }

  return Array.from(agentMap.values())
}

/** 检查代理所需的 MCP 服务器是否可用。若无要求或所有要求均满足则返回 true。
@param agent 要检查的代理
@param availableServers 可用 MCP 服务器名称列表（例如来自 mcp.clients） */
export function hasRequiredMcpServers(
  agent: AgentDefinition,
  availableServers: string[],
): boolean {
  if (!agent.requiredMcpServers || agent.requiredMcpServers.length === 0) {
    return true
  }
  // 每个必需模式必须至少匹配一个可用服务器（不区分大小写）
  return agent.requiredMcpServers.every(pattern =>
    availableServers.some(server =>
      server.toLowerCase().includes(pattern.toLowerCase()),
    ),
  )
}

/** 根据 MCP 服务器要求筛选智能体。
仅返回所需 MCP 服务器可用的智能体。
@param agents 待筛选的智能体列表
@param availableServers 可用的 MCP 服务器名称列表 */
export function filterAgentsByMcpRequirements(
  agents: AgentDefinition[],
  availableServers: string[],
): AgentDefinition[] {
  return agents.filter(agent => hasRequiredMcpServers(agent, availableServers))
}

/** 检查并从项目快照初始化智能体记忆。
对于启用了记忆的智能体，如果本地没有记忆，则将快照复制到本地。
对于有较新快照的智能体，记录一条调试消息（用户提示 TODO）。 */
async function initializeAgentMemorySnapshots(
  agents: CustomAgentDefinition[],
): Promise<void> {
  await Promise.all(
    agents.map(async agent => {
      if (agent.memory !== 'user') return
      const result = await checkAgentMemorySnapshot(
        agent.agentType,
        agent.memory,
      )
      switch (result.action) {
        case 'initialize':
          logForDebugging(
            `正在从项目快照初始化 ${agent.agentType} 的记忆`,
          )
          await initializeFromSnapshot(
            agent.agentType,
            agent.memory,
            result.snapshotTimestamp!,
          )
          break
        case 'prompt-update':
          agent.pendingSnapshotUpdate = {
            snapshotTimestamp: result.snapshotTimestamp!,
          }
          logForDebugging(
            `${agent.agentType} 的记忆有可用的较新快照（快照：${result.snapshotTimestamp}）`,
          )
          break
      }
    }),
  )
}

export const getAgentDefinitionsWithOverrides = memoize(
  async (cwd: string): Promise<AgentDefinitionsResult> => {
    // // 简单模式：跳过自定义代理，仅返回内置代理
    if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
      const builtInAgents = getBuiltInAgents()
      return {
        activeAgents: builtInAgents,
        allAgents: builtInAgents,
      }
    }

    try {
      const markdownFiles = await loadMarkdownFilesForSubdir('agents', cwd)

      const failedFiles: Array<{ path: string; error: string }> = []
      const customAgents = markdownFiles
        .map(({ filePath, baseDir, frontmatter, content, source }) => {
          const agent = parseAgentFromMarkdown(
            filePath,
            baseDir,
            frontmatter,
            content,
            source,
          )
          if (!agent) {
            // 静默跳过非代理的 markdown 文件（例如与代理定义放在一起的参考文档）。
            // 仅对看起来像是代理尝试的文件（frontmatter 中有 'name' 字段）报告错误。
            if (!frontmatter['name']) {
              return null
            }
            const errorMsg = getParseError(frontmatter)
            failedFiles.push({ path: filePath, error: errorMsg })
            logForDebugging(
              `从 ${filePath} 解析智能体失败：${errorMsg}`,
            )
            logEvent('tengu_agent_parse_error', {
              error:
                errorMsg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              location:
                source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            return null
          }
          return agent
        })
        .filter(agent => agent !== null)

      // 与内存快照初始化并发启动插件代理加载 —
      // loadPluginAgents 已被记忆化且不接收参数，因此它是独立的
      // 。将两者合并，这样无论哪个抛出异常，都不会变成悬空的 Promise。
      let pluginAgentsPromise = loadPluginAgents()
      if (feature('AGENT_MEMORY_SNAPSHOT') && isAutoMemoryEnabled()) {
        const [pluginAgents_] = await Promise.all([
          pluginAgentsPromise,
          initializeAgentMemorySnapshots(customAgents),
        ])
        pluginAgentsPromise = Promise.resolve(pluginAgents_)
      }
      const pluginAgents = await pluginAgentsPromise

      const builtInAgents = getBuiltInAgents()

      const allAgentsList: AgentDefinition[] = [
        ...builtInAgents,
        ...pluginAgents,
        ...customAgents,
      ]

      const activeAgents = getActiveAgentsFromList(allAgentsList)

      // 为所有活跃代理初始化颜色
      for (const agent of activeAgents) {
        if (agent.color) {
          setAgentColor(agent.agentType, agent.color)
        }
      }

      return {
        activeAgents,
        allAgents: allAgentsList,
        failedFiles: failedFiles.length > 0 ? failedFiles : undefined,
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logForDebugging(`加载智能体定义时出错：${errorMessage}`)
      logError(error)
      // 即使出错，也返回内置代理
      const builtInAgents = getBuiltInAgents()
      return {
        activeAgents: builtInAgents,
        allAgents: builtInAgents,
        failedFiles: [{ path: 'unknown', error: errorMessage }],
      }
    }
  },
)

export function clearAgentDefinitionsCache(): void {
  getAgentDefinitionsWithOverrides.cache.clear?.()
  loadMarkdownFilesForSubdir.cache?.clear?.()
  clearPluginAgentCache()
}

/** 用于确定代理文件具体解析错误的辅助函数 */
function getParseError(frontmatter: Record<string, unknown>): string {
  const agentType = frontmatter['name']
  const description = frontmatter['description']

  if (!agentType || typeof agentType !== 'string') {
    return '前置元数据中缺少必需的 "name" 字段'
  }

  if (!description || typeof description !== 'string') {
    return '前置元数据中缺少必需的 "description" 字段'
  }

  return '未知的解析错误'
}

/** 使用 HooksSchema 从 frontmatter 解析 hooks
@param frontmatter 包含潜在 hooks 的 frontmatter 对象
@param agentType 用于日志记录的代理类型
@returns 解析后的 hooks 设置，如果无效/缺失则返回 undefined */
function parseHooksFromFrontmatter(
  frontmatter: Record<string, unknown>,
  agentType: string,
): HooksSettings | undefined {
  if (!frontmatter.hooks) {
    return undefined
  }

  const result = HooksSchema().safeParse(frontmatter.hooks)
  if (!result.success) {
    logForDebugging(
      `智能体 '${agentType}' 中的钩子无效：${result.error.message}`,
    )
    return undefined
  }
  return result.data
}

/** 从 JSON 数据解析代理定义 */
export function parseAgentFromJson(
  name: string,
  definition: unknown,
  source: SettingSource = 'flagSettings',
): CustomAgentDefinition | null {
  try {
    const parsed = AgentJsonSchema().parse(definition)

    let tools = parseAgentToolsFromFrontmatter(parsed.tools)

    // 如果启用了内存，则注入用于内存访问的 Write/Edit/Read 工具
    if (isAutoMemoryEnabled() && parsed.memory && tools !== undefined) {
      const toolSet = new Set(tools)
      for (const tool of [
        FILE_WRITE_TOOL_NAME,
        FILE_EDIT_TOOL_NAME,
        FILE_READ_TOOL_NAME,
      ]) {
        if (!toolSet.has(tool)) {
          tools = [...tools, tool]
        }
      }
    }

    const disallowedTools =
      parsed.disallowedTools !== undefined
        ? parseAgentToolsFromFrontmatter(parsed.disallowedTools)
        : undefined

    const systemPrompt = parsed.prompt

    const agent: CustomAgentDefinition = {
      agentType: name,
      whenToUse: parsed.description,
      ...(tools !== undefined ? { tools } : {}),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
      getSystemPrompt: () => {
        if (isAutoMemoryEnabled() && parsed.memory) {
          return (
            systemPrompt + '\n\n' + loadAgentMemoryPrompt(name, parsed.memory)
          )
        }
        return systemPrompt
      },
      source,
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.effort !== undefined ? { effort: parsed.effort } : {}),
      ...(parsed.permissionMode
        ? { permissionMode: parsed.permissionMode }
        : {}),
      ...(parsed.mcpServers && parsed.mcpServers.length > 0
        ? { mcpServers: parsed.mcpServers }
        : {}),
      ...(parsed.hooks ? { hooks: parsed.hooks } : {}),
      ...(parsed.maxTurns !== undefined ? { maxTurns: parsed.maxTurns } : {}),
      ...(parsed.skills && parsed.skills.length > 0
        ? { skills: parsed.skills }
        : {}),
      ...(parsed.initialPrompt ? { initialPrompt: parsed.initialPrompt } : {}),
      ...(parsed.background ? { background: parsed.background } : {}),
      ...(parsed.memory ? { memory: parsed.memory } : {}),
      ...(parsed.isolation ? { isolation: parsed.isolation } : {}),
    }

    return agent
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`从 JSON 解析智能体 '${name}' 时出错：${errorMessage}`)
    logError(error)
    return null
  }
}

/** 从 JSON 对象解析多个代理 */
export function parseAgentsFromJson(
  agentsJson: unknown,
  source: SettingSource = 'flagSettings',
): AgentDefinition[] {
  try {
    const parsed = AgentsJsonSchema().parse(agentsJson)
    return Object.entries(parsed)
      .map(([name, def]) => parseAgentFromJson(name, def, source))
      .filter((agent): agent is CustomAgentDefinition => agent !== null)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`从 JSON 解析智能体时出错：${errorMessage}`)
    logError(error)
    return []
  }
}

/** 从 markdown 文件数据解析代理定义 */
export function parseAgentFromMarkdown(
  filePath: string,
  baseDir: string,
  frontmatter: Record<string, unknown>,
  content: string,
  source: SettingSource,
): CustomAgentDefinition | null {
  try {
    const agentType = frontmatter['name']
    let whenToUse = frontmatter['description'] as string

    // 验证必填字段 — 静默跳过没有任何代理 frontm
    // atter 的文件（它们很可能是放在一起的参考文档）
    if (!agentType || typeof agentType !== 'string') {
      return null
    }
    if (!whenToUse || typeof whenToUse !== 'string') {
      logForDebugging(
        `智能体文件 ${filePath} 的前置元数据中缺少必需的 'description'`,
      )
      return null
    }

    // 对 whenToUse 中为 YAML 解析而转义的换行符进行反转义
    whenToUse = whenToUse.replace(/\\n/g, '\n')

    const color = frontmatter['color'] as AgentColorName | undefined
    const modelRaw = frontmatter['model']
    let model: string | undefined
    if (typeof modelRaw === 'string' && modelRaw.trim().length > 0) {
      const trimmed = modelRaw.trim()
      model = trimmed.toLowerCase() === 'inherit' ? 'inherit' : trimmed
    }

    // 解析 background 标志
    const backgroundRaw = frontmatter['background']

    if (
      backgroundRaw !== undefined &&
      backgroundRaw !== 'true' &&
      backgroundRaw !== 'false' &&
      backgroundRaw !== true &&
      backgroundRaw !== false
    ) {
      logForDebugging(
        `智能体文件 ${filePath} 的 background 值 '${backgroundRaw}' 无效。必须是 'true'、'false' 或省略。`,
      )
    }

    const background =
      backgroundRaw === 'true' || backgroundRaw === true ? true : undefined

    // 解析 memory 作用域
    const VALID_MEMORY_SCOPES: AgentMemoryScope[] = ['user', 'project', 'local']
    const memoryRaw = frontmatter['memory'] as string | undefined
    let memory: AgentMemoryScope | undefined
    if (memoryRaw !== undefined) {
      if (VALID_MEMORY_SCOPES.includes(memoryRaw as AgentMemoryScope)) {
        memory = memoryRaw as AgentMemoryScope
      } else {
        logForDebugging(
          `智能体文件 ${filePath} 的 memory 值 '${memoryRaw}' 无效。有效选项：${VALID_MEMORY_SCOPES.join(', ')}`,
        )
      }
    }

    // 解析隔离模式。'remote' 仅限 ant；外部构建会在解析时拒绝它。
    type IsolationMode = 'worktree' | 'remote'
    const VALID_ISOLATION_MODES: readonly IsolationMode[] =
      process.env.USER_TYPE === 'ant' ? ['worktree', 'remote'] : ['worktree']
    const isolationRaw = frontmatter['isolation'] as string | undefined
    let isolation: IsolationMode | undefined
    if (isolationRaw !== undefined) {
      if (VALID_ISOLATION_MODES.includes(isolationRaw as IsolationMode)) {
        isolation = isolationRaw as IsolationMode
      } else {
        logForDebugging(
          `智能体文件 ${filePath} 的 isolation 值 '${isolationRaw}' 无效。有效选项：${VALID_ISOLATION_MODES.join(', ')}`,
        )
      }
    }

    // 从 frontmatter 解析 effort（支持字符串级别和整数）
    const effortRaw = frontmatter['effort']
    const parsedEffort =
      effortRaw !== undefined ? parseEffortValue(effortRaw) : undefined

    if (effortRaw !== undefined && parsedEffort === undefined) {
      logForDebugging(
        `智能体文件 ${filePath} 的 effort 值 '${effortRaw}' 无效。有效选项：${EFFORT_LEVELS.join(', ')} 或一个整数`,
      )
    }

    // 从 frontmatter 解析 permissionMode
    const permissionModeRaw = frontmatter['permissionMode'] as
      | string
      | undefined
    const isValidPermissionMode =
      permissionModeRaw &&
      (PERMISSION_MODES as readonly string[]).includes(permissionModeRaw)

    if (permissionModeRaw && !isValidPermissionMode) {
      const errorMsg = `智能体文件 ${filePath} 的 permissionMode 值 '${permissionModeRaw}' 无效。有效选项：${PERMISSION_MODES.join(', ')}`
      logForDebugging(errorMsg)
    }

    // 从 frontmatter 解析 maxTurns
    const maxTurnsRaw = frontmatter['maxTurns']
    const maxTurns = parsePositiveIntFromFrontmatter(maxTurnsRaw)
    if (maxTurnsRaw !== undefined && maxTurns === undefined) {
      logForDebugging(
        `智能体文件 ${filePath} 的 maxTurns 值 '${maxTurnsRaw}' 无效。必须是一个正整数。`,
      )
    }

    // 提取不带扩展名的文件名
    const filename = basename(filePath, '.md')

    // 从 frontmatter 解析工具
    let tools = parseAgentToolsFromFrontmatter(frontmatter['tools'])

    // 如果启用了内存，则注入用于内存访问的 Write/Edit/Read 工具
    if (isAutoMemoryEnabled() && memory && tools !== undefined) {
      const toolSet = new Set(tools)
      for (const tool of [
        FILE_WRITE_TOOL_NAME,
        FILE_EDIT_TOOL_NAME,
        FILE_READ_TOOL_NAME,
      ]) {
        if (!toolSet.has(tool)) {
          tools = [...tools, tool]
        }
      }
    }

    // 从 frontmatter 解析 disallowedTools
    const disallowedToolsRaw = frontmatter['disallowedTools']
    const disallowedTools =
      disallowedToolsRaw !== undefined
        ? parseAgentToolsFromFrontmatter(disallowedToolsRaw)
        : undefined

    // 从 frontmatter 解析 skills
    const skills = parseSlashCommandToolsFromFrontmatter(frontmatter['skills'])

    const initialPromptRaw = frontmatter['initialPrompt']
    const initialPrompt =
      typeof initialPromptRaw === 'string' && initialPromptRaw.trim()
        ? initialPromptRaw
        : undefined

    // 使用与 JSON 智能体相同的 Zod 验证从前置元数据中解析 mcpServers
    const mcpServersRaw = frontmatter['mcpServers']
    let mcpServers: AgentMcpServerSpec[] | undefined
    if (Array.isArray(mcpServersRaw)) {
      mcpServers = mcpServersRaw
        .map(item => {
          const result = AgentMcpServerSpecSchema().safeParse(item)
          if (result.success) {
            return result.data
          }
          logForDebugging(
            `智能体文件 ${filePath} 的 mcpServers 项无效：${jsonStringify(item)}。错误：${result.error.message}`,
          )
          return null
        })
        .filter((item): item is AgentMcpServerSpec => item !== null)
    }

    // 从前置元数据中解析 hooks
    const hooks = parseHooksFromFrontmatter(frontmatter, agentType)

    const systemPrompt = content.trim()
    const agentDef: CustomAgentDefinition = {
      baseDir,
      agentType: agentType,
      whenToUse: whenToUse,
      ...(tools !== undefined ? { tools } : {}),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
      ...(skills !== undefined ? { skills } : {}),
      ...(initialPrompt !== undefined ? { initialPrompt } : {}),
      ...(mcpServers !== undefined && mcpServers.length > 0
        ? { mcpServers }
        : {}),
      ...(hooks !== undefined ? { hooks } : {}),
      getSystemPrompt: () => {
        if (isAutoMemoryEnabled() && memory) {
          const memoryPrompt = loadAgentMemoryPrompt(agentType, memory)
          return systemPrompt + '\n\n' + memoryPrompt
        }
        return systemPrompt
      },
      source,
      filename,
      ...(color && typeof color === 'string' && AGENT_COLORS.includes(color)
        ? { color }
        : {}),
      ...(model !== undefined ? { model } : {}),
      ...(parsedEffort !== undefined ? { effort: parsedEffort } : {}),
      ...(isValidPermissionMode
        ? { permissionMode: permissionModeRaw as PermissionMode }
        : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(background ? { background } : {}),
      ...(memory ? { memory } : {}),
      ...(isolation ? { isolation } : {}),
    }
    return agentDef
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`从 ${filePath} 解析智能体时出错：${errorMessage}`)
    logError(error)
    return null
  }
}
