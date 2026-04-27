import {
  getModelStrings as getModelStringsState,
  setModelStrings as setModelStringsState,
} from 'src/bootstrap/state.js'
import { logError } from '../log.js'
import { sequential } from '../sequential.js'
import { getInitialSettings } from '../settings/settings.js'
import { findFirstMatch, getBedrockInferenceProfiles } from './bedrock.js'
import {
  ALL_MODEL_CONFIGS,
  CANONICAL_ID_TO_KEY,
  type CanonicalModelId,
  type ModelKey,
} from './configs.js'
import { type APIProvider, getAPIProvider } from './providers.js'

/** 将每个模型版本映射到其特定提供商的模型ID字符串。
源自 ALL_MODEL_CONFIGS — 在该配置中添加模型会扩展此类型。 */
export type ModelStrings = Record<ModelKey, string>

const MODEL_KEYS = Object.keys(ALL_MODEL_CONFIGS) as ModelKey[]

function getBuiltinModelStrings(provider: APIProvider): ModelStrings {
  const out = {} as ModelStrings
  for (const key of MODEL_KEYS) {
    out[key] = ALL_MODEL_CONFIGS[key][provider]
  }
  return out
}

async function getBedrockModelStrings(): Promise<ModelStrings> {
  const fallback = getBuiltinModelStrings('bedrock')
  let profiles: string[] | undefined
  try {
    profiles = await getBedrockInferenceProfiles()
  } catch (error) {
    logError(error as Error)
    return fallback
  }
  if (!profiles?.length) {
    return fallback
  }
  // 每个配置的 firstParty ID 是我们在用户推理配置文件中搜索的规范子字符
  // 串（例如 "claude-opus-4-6" 匹配 "eu.anth
  // ropic.claude-opus-4-6-v1"）。当未找到匹配的配置文件时，
  // 回退到硬编码的 bedrock ID。
  const out = {} as ModelStrings
  for (const key of MODEL_KEYS) {
    const needle = ALL_MODEL_CONFIGS[key].firstParty
    out[key] = findFirstMatch(profiles, needle) || fallback[key]
  }
  return out
}

/** 在提供商派生的模型字符串之上叠加用户配置的 modelOverrides（来自 settings.json）。覆盖项以规范的 first-party 模型 ID 为键（例如 "claude-opus-4-6"），映射到任意提供商特定的字符串 — 通常是 Bedrock 推理配置文件的 ARN。 */
function applyModelOverrides(ms: ModelStrings): ModelStrings {
  const overrides = getInitialSettings().modelOverrides
  if (!overrides) {
    return ms
  }
  const out = { ...ms }
  for (const [canonicalId, override] of Object.entries(overrides)) {
    const key = CANONICAL_ID_TO_KEY[canonicalId as CanonicalModelId]
    if (key && override) {
      out[key] = override
    }
  }
  return out
}

/** 将覆盖的模型 ID（例如 Bedrock ARN）解析回其规范的 first-party 模型 ID。如果输入不匹配任何当前覆盖值，则原样返回。在模块初始化期间调用是安全的（如果设置尚未加载，则不执行任何操作）。 */
export function resolveOverriddenModel(modelId: string): string {
  let overrides: Record<string, string> | undefined
  try {
    overrides = getInitialSettings().modelOverrides
  } catch {
    return modelId
  }
  if (!overrides) {
    return modelId
  }
  for (const [canonicalId, override] of Object.entries(overrides)) {
    if (override === modelId) {
      return canonicalId
    }
  }
  return modelId
}

const updateBedrockModelStrings = sequential(async () => {
  if (getModelStringsState() !== null) {
    // 已初始化。在此处进行检查，结合 `sequ
    // ential`，允许测试套件在测试之间重置
    // 状态，同时仍防止在生产环境中进行多次 AP
    // I 调用。
    return
  }
  try {
    const ms = await getBedrockModelStrings()
    setModelStringsState(ms)
  } catch (error) {
    logError(error as Error)
  }
})

function initModelStrings(): void {
  const ms = getModelStringsState()
  if (ms !== null) {
    // 已初始化
    return
  }
  // 为非 Bedrock 提供商使用默认值初始化
  if (getAPIProvider() !== 'bedrock') {
    setModelStringsState(getBuiltinModelStrings(getAPIProvider()))
    return
  }
  // 在 Bedrock 上，在后台更新模型字符串而不阻塞。在这种情况下不
  // 设置状态，以便我们可以在 `updateBedrockModelSt
  // rings` 上使用 `sequential`，并在多次调用时检查现
  // 有状态。
  void updateBedrockModelStrings()
}

export function getModelStrings(): ModelStrings {
  const ms = getModelStringsState()
  if (ms === null) {
    initModelStrings()
    // 当配置文件获取在后台运行时，Bedrock 路
    // 径会落在此处 — 仍对临时默认值应用覆盖。
    return applyModelOverrides(getBuiltinModelStrings(getAPIProvider()))
  }
  return applyModelOverrides(ms)
}

/** 确保模型字符串完全初始化。
对于 Bedrock 用户，这会等待配置文件获取完成。
在生成模型选项之前调用此方法，以确保正确的区域字符串。 */
export async function ensureModelStringsInitialized(): Promise<void> {
  const ms = getModelStringsState()
  if (ms !== null) {
    return
  }

  // 对于非 Bedrock，同步初始化
  if (getAPIProvider() !== 'bedrock') {
    setModelStringsState(getBuiltinModelStrings(getAPIProvider()))
    return
  }

  // 对于 Bedrock，等待配置文件获取
  await updateBedrockModelStrings()
}
