/** 内存目录扫描原语。从 findRelevantMemories.ts 中拆分出来，
以便 extractMemories 可以导入扫描功能，而无需引入 sideQuery 和
API 客户端链（该链通过 memdir.ts 形成了一个循环 — #25372）。 */

import { readdir } from 'fs/promises'
import { basename, join } from 'path'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { readFileInRange } from '../utils/readFileInRange.js'
import { type MemoryType, parseMemoryType } from './memoryTypes.js'

export type MemoryHeader = {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
}

const MAX_MEMORY_FILES = 200
const FRONTMATTER_MAX_LINES = 30

/** 扫描内存目录中的 .md 文件，读取其 frontmatter，并返回
按最新优先排序的标题列表（上限为 MAX_MEMORY_FILES）。由
findRelevantMemories（查询时召回）和 extractMemories（预注入
列表，使提取代理无需花费一个回合执行 `ls`）共享。

单次遍历：readFileInRange 内部进行 stat 并返回 mtimeMs，因此我们
采用先读取后排序的方式，而非 stat-排序-读取。对于常见情况（N ≤ 200），
这比单独的 stat 轮询减少了一半的系统调用；对于较大的 N，我们会多读取
少量小文件，但仍避免了在最终保留的 200 个文件上进行双重 stat。 */
export async function scanMemoryFiles(
  memoryDir: string,
  signal: AbortSignal,
): Promise<MemoryHeader[]> {
  try {
    const entries = await readdir(memoryDir, { recursive: true })
    const mdFiles = entries.filter(
      f => f.endsWith('.md') && basename(f) !== 'MEMORY.md',
    )

    const headerResults = await Promise.allSettled(
      mdFiles.map(async (relativePath): Promise<MemoryHeader> => {
        const filePath = join(memoryDir, relativePath)
        const { content, mtimeMs } = await readFileInRange(
          filePath,
          0,
          FRONTMATTER_MAX_LINES,
          undefined,
          signal,
        )
        const { frontmatter } = parseFrontmatter(content, filePath)
        return {
          filename: relativePath,
          filePath,
          mtimeMs,
          description: frontmatter.description || null,
          type: parseMemoryType(frontmatter.type),
        }
      }),
    )

    return headerResults
      .filter(
        (r): r is PromiseFulfilledResult<MemoryHeader> =>
          r.status === 'fulfilled',
      )
      .map(r => r.value)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_MEMORY_FILES)
  } catch {
    return []
  }
}

/** 将内存标题格式化为文本清单：每个文件一行，格式为
[类型] 文件名 (时间戳): 描述。由召回选择器提示和
提取代理提示共同使用。 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map(m => {
      const tag = m.type ? `[${m.type}] ` : ''
      const ts = new Date(m.mtimeMs).toISOString()
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`
    })
    .join('\n')
}
