import { feature } from 'bun:bundle'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { getDefaultSonnetModel } from '../utils/model/model.js'
import { sideQuery } from '../utils/sideQuery.js'
import type { LangfuseSpan } from '../services/langfuse/index.js'
import { jsonParse } from '../utils/slowOperations.js'
import {
  formatMemoryManifest,
  type MemoryHeader,
  scanMemoryFiles,
} from './memoryScan.js'

export type RelevantMemory = {
  path: string
  mtimeMs: number
}

const SELECT_MEMORIES_SYSTEM_PROMPT = `你正在选择对 Claude Code 处理用户查询时有用的记忆。你将获得用户的查询以及一份可用记忆文件的列表，其中包含文件名和描述。'
+'\n\n返回一份对 Claude Code 处理用户查询时明显有用的记忆文件名列表（最多 5 个）。仅包含你根据文件名和描述确定会有帮助的记忆。'
+'\n- 如果你不确定某个记忆在处理用户查询时是否有用，则不要将其包含在列表中。请有选择性和辨别力。'
+'\n- 如果列表中没有任何明显有用的记忆，可以返回空列表。'
+'\n- 如果提供了最近使用的工具列表，请不要选择这些工具的使用参考或 API 文档记忆（Claude Code 已经在使用它们）。'
+'但仍需选择包含这些工具的警告、陷阱或已知问题的记忆——正是活跃使用时这些信息才重要。\n`

/** 通过扫描记忆文件头部并让 Sonnet[模型名称] 选择最相关的文件，查找与查询相关的记忆文件。

返回最相关记忆的绝对文件路径 + 修改时间（最多 5 个）。排除 MEMORY.md（已在系统提示中加载）。
修改时间会被传递，以便调用者无需第二次 stat 即可向主模型展示新鲜度。

`alreadySurfaced` 在调用 Sonnet 之前过滤先前轮次中已展示的路径，这样选择器就能将其 5 个槽位预算花在新鲜候选项上，而不是重新选择调用者将要丢弃的文件。 */
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  signal: AbortSignal,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
  parentSpan?: LangfuseSpan | null,
): Promise<RelevantMemory[]> {
  const memories = (await scanMemoryFiles(memoryDir, signal)).filter(
    m => !alreadySurfaced.has(m.filePath),
  )
  if (memories.length === 0) {
    return []
  }

  const selectedFilenames = await selectRelevantMemories(
    query,
    memories,
    signal,
    recentTools,
    parentSpan,
  )
  const byFilename = new Map(memories.map(m => [m.filename, m]))
  const selected = selectedFilenames
    .map(filename => byFilename.get(filename))
    .filter((m): m is MemoryHeader => m !== undefined)

  // 即使选择为空也会触发：选择率需要分母，而 -1 的时效性
  // 可以区分“已运行但未选中任何内容”和“从未运行”。
  if (feature('MEMORY_SHAPE_TELEMETRY')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { logMemoryRecallShape } =
      require('./memoryShapeTelemetry.js') as typeof import('./memoryShapeTelemetry.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    logMemoryRecallShape(memories, selected)
  }

  return selected.map(m => ({ path: m.filePath, mtimeMs: m.mtimeMs }))
}

async function selectRelevantMemories(
  query: string,
  memories: MemoryHeader[],
  signal: AbortSignal,
  recentTools: readonly string[],
  parentSpan?: LangfuseSpan | null,
): Promise<string[]> {
  const validFilenames = new Set(memories.map(m => m.filename))

  const manifest = formatMemoryManifest(memories)

  // 当 Claude Code 正在活跃使用某个工具（例如
  // mcp__X__spawn）时，展示该工具的参考文档是噪
  // 音——对话中已经包含了使用方式。否则，选择器会基于关键词
  // 重叠进行匹配（查询中的“spawn”+ 记忆描述中的
  // “spawn”→ 误报）。
  const toolsSection =
    recentTools.length > 0
      ? `\n\n最近使用的工具：${recentTools.join(', ')}`
      : ''

  try {
    const result = await sideQuery({
      model: getDefaultSonnetModel(),
      system: SELECT_MEMORIES_SYSTEM_PROMPT,
      skipSystemPromptPrefix: true,
      messages: [
        {
          role: 'user',
          content: `查询：${query}\n\n可用记忆：\n${manifest}${toolsSection}`,
        },
      ],
      max_tokens: 256,
      output_format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            selected_memories: { type: 'array', items: { type: 'string' } },
          },
          required: ['selected_memories'],
          additionalProperties: false,
        },
      },
      signal,
      querySource: 'memdir_relevance',
      optional: true,
      parentSpan,
    })

    const textBlock = result.content.find(block => block.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      return []
    }

    const parsed: { selected_memories: string[] } = jsonParse(textBlock.text)
    return parsed.selected_memories.filter(f => validFilenames.has(f))
  } catch (e) {
    if (signal.aborted) {
      return []
    }
    logForDebugging(
      `[memdir] selectRelevantMemories 失败：${errorMessage(e)}`,
      { level: 'warn' },
    )
    return []
  }
}
