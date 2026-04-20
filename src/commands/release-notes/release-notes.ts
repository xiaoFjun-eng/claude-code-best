import type { LocalCommandResult } from '../../types/command.js'
import {
  CHANGELOG_URL,
  fetchAndStoreChangelog,
  getAllReleaseNotes,
  getStoredChangelog,
} from '../../utils/releaseNotes.js'

function formatReleaseNotes(notes: Array<[string, string[]]>): string {
  return notes
    .map(([version, notes]) => {
      const header = `版本 ${version}：`
      const bulletPoints = notes.map(note => `· ${note}`).join('\n')
      return `${header}\n${bulletPoints}`
    })
    .join('\n\n')
}

export async function call(): Promise<LocalCommandResult> {
  // 尝试以 500 毫秒超时获取最新的更新日志
  let freshNotes: Array<[string, string[]]> = []

  try {
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(rej => rej(new Error('Timeout')), 500, reject)
    })

    await Promise.race([fetchAndStoreChangelog(), timeoutPromise])
    freshNotes = getAllReleaseNotes(await getStoredChangelog())
  } catch {
    // 获取失败或超时 - 直接使用缓存的说明
  }

  // 如果快速获取到了新的说明，就使用它们
  if (freshNotes.length > 0) {
    return { type: 'text', value: formatReleaseNotes(freshNotes) }
  }

  // 否则检查缓存的说明
  const cachedNotes = getAllReleaseNotes(await getStoredChangelog())
  if (cachedNotes.length > 0) {
    return { type: 'text', value: formatReleaseNotes(cachedNotes) }
  }

  // 无可用内容，显示链接
  return {
    type: 'text',
    value: `查看完整更新日志：${CHANGELOG_URL}`,
  }
}
