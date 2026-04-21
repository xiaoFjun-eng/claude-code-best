import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { join } from 'path'

// 已记忆化：150+ 调用方，多位于热路径。以 CLAUDE_CONFIG_DIR 为键，
// 以便更改环境变量的测试无需显式清除缓存即可获得新值。
export const getClaudeConfigHomeDir = memoize(
  (): string => {
    return (
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    ).normalize('NFC')
  },
  () => process.env.CLAUDE_CONFIG_DIR,
)

export function getTeamsDir(): string {
  return join(getClaudeConfigHomeDir(), 'teams')
}

/**
 * 检查 NODE_OPTIONS 是否包含指定的标志。
 * 按空白字符分割并检查精确匹配，以避免误判。
 */
export function hasNodeOption(flag: string): boolean {
  const nodeOptions = process.env.NODE_OPTIONS
  if (!nodeOptions) {
    return false
  }
  return nodeOptions.split(/\s+/).includes(flag)
}

export function isEnvTruthy(envVar: string | boolean | undefined): boolean {
  if (!envVar) return false
  if (typeof envVar === 'boolean') return envVar
  const normalizedValue = envVar.toLowerCase().trim()
  return ['1', 'true', 'yes', 'on'].includes(normalizedValue)
}

export function isEnvDefinedFalsy(
  envVar: string | boolean | undefined,
): boolean {
  if (envVar === undefined) return false
  if (typeof envVar === 'boolean') return !envVar
  if (!envVar) return false
  const normalizedValue = envVar.toLowerCase().trim()
  return ['0', 'false', 'no', 'off'].includes(normalizedValue)
}

/**
 * --bare / CLAUDE_CODE_SIMPLE — 跳过钩子、LSP、插件同步、技能目录遍历、
 * 归属信息、后台预取以及所有钥匙串/凭证读取。
 * 认证严格使用 ANTHROPIC_API_KEY 环境变量或通过 --settings 指定的 apiKeyHelper。
 * 显式的 CLI 标志（--plugin-dir、--add-dir、--mcp-config）仍然生效。
 * 代码库中约有 30 处门控检查。
 *
 * 直接检查 argv（除了环境变量），因为部分门控在 main.tsx 的 action 处理器
 * 通过 --bare 设置 CLAUDE_CODE_SIMPLE=1 之前就会运行
 * —— 尤其是 main.tsx 顶层中的 startKeychainPrefetch()。
 */
export function isBareMode(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE) ||
    process.argv.includes('--bare')
  )
}

/**
 * 将环境变量字符串数组解析为键值对象
 * @param envVars 格式为 KEY=VALUE 的字符串数组
 * @returns 包含键值对的对象
 */
export function parseEnvVars(
  rawEnvArgs: string[] | undefined,
): Record<string, string> {
  const parsedEnv: Record<string, string> = {}

  // 解析各个环境变量
  if (rawEnvArgs) {
    for (const envStr of rawEnvArgs) {
      const [key, ...valueParts] = envStr.split('=')
      if (!key || valueParts.length === 0) {
        throw new Error(
          `无效的环境变量格式: ${envStr}，环境变量应按照如下格式添加：-e KEY1=value1 -e KEY2=value2`,
        )
      }
      parsedEnv[key] = valueParts.join('=')
    }
  }
  return parsedEnv
}

/**
 * 获取 AWS 区域，带回退到默认值
 * 匹配 Anthropic Bedrock SDK 的区域行为
 */
export function getAWSRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
}

/**
 * 获取默认的 Vertex AI 区域
 */
export function getDefaultVertexRegion(): string {
  return process.env.CLOUD_ML_REGION || 'us-east5'
}

/**
 * 检查 bash 命令是否应维持项目工作目录（每条命令后重置为原始目录）
 * @returns 如果 CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR 设置为真值，则返回 true
 */
export function shouldMaintainProjectWorkingDir(): boolean {
  return isEnvTruthy(process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR)
}

/**
 * 检查是否在 Homespace（ant 内部云环境）上运行
 */
export function isRunningOnHomespace(): boolean {
  return (
    process.env.USER_TYPE === 'ant' &&
    isEnvTruthy(process.env.COO_RUNNING_ON_HOMESPACE)
  )
}

/**
 * 保守检查 Claude Code 是否运行在受保护的
 * （特权或 ASL3+）COO 命名空间或集群中。
 *
 * 保守意味着：当信号不明确时，假设为受保护。我们宁愿多报告受保护的使用情况，
 * 也不愿遗漏。不受保护的环境包括 homespace、开放白名单上的命名空间，
 * 以及没有任何 k8s/COO 信号的环境（笔记本电脑/本地开发）。
 *
 * 用于遥测，以测量敏感环境中自动模式的使用情况。
 */
export function isInProtectedNamespace(): boolean {
  // USER_TYPE 是构建时的 --define；在外部构建中，此代码块会被 DCE 移除，
  // 因此 require() 和命名空间白名单永远不会出现在打包产物中。
  if (process.env.USER_TYPE === 'ant') {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return (
      require('./protectedNamespace.js') as typeof import('./protectedNamespace.js')
    ).checkProtectedNamespace()
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
  return false
}

// @[MODEL LAUNCH]: 为新模型添加 Vertex 区域覆盖的环境变量。
/**
 * 模型前缀 → 用于 Vertex 区域覆盖的环境变量。
 * 顺序重要：更具体的前缀必须放在较不具体的前缀之前
 * （例如 'claude-opus-4-1' 在 'claude-opus-4' 之前）。
 */
const VERTEX_REGION_OVERRIDES: ReadonlyArray<[string, string]> = [
  ['claude-haiku-4-5', 'VERTEX_REGION_CLAUDE_HAIKU_4_5'],
  ['claude-3-5-haiku', 'VERTEX_REGION_CLAUDE_3_5_HAIKU'],
  ['claude-3-5-sonnet', 'VERTEX_REGION_CLAUDE_3_5_SONNET'],
  ['claude-3-7-sonnet', 'VERTEX_REGION_CLAUDE_3_7_SONNET'],
  ['claude-opus-4-1', 'VERTEX_REGION_CLAUDE_4_1_OPUS'],
  ['claude-opus-4', 'VERTEX_REGION_CLAUDE_4_0_OPUS'],
  ['claude-sonnet-4-6', 'VERTEX_REGION_CLAUDE_4_6_SONNET'],
  ['claude-sonnet-4-5', 'VERTEX_REGION_CLAUDE_4_5_SONNET'],
  ['claude-sonnet-4', 'VERTEX_REGION_CLAUDE_4_0_SONNET'],
]

/**
 * 获取特定模型的 Vertex AI 区域。
 * 不同的模型可能在不同的区域可用。
 */
export function getVertexRegionForModel(
  model: string | undefined,
): string | undefined {
  if (model) {
    const match = VERTEX_REGION_OVERRIDES.find(([prefix]) =>
      model.startsWith(prefix),
    )
    if (match) {
      return process.env[match[1]] || getDefaultVertexRegion()
    }
  }
  return getDefaultVertexRegion()
}