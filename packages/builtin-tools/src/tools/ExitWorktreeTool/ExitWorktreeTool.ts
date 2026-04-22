import { z } from 'zod/v4'
import {
  getOriginalCwd,
  getProjectRoot,
  setOriginalCwd,
  setProjectRoot,
} from 'src/bootstrap/state.js'
import { clearSystemPromptSections } from 'src/constants/systemPromptSections.js'
import { logEvent } from 'src/services/analytics/index.js'
import type { Tool } from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { count } from 'src/utils/array.js'
import { clearMemoryFileCaches } from 'src/utils/claudemd.js'
import { execFileNoThrow } from 'src/utils/execFileNoThrow.js'
import { updateHooksConfigSnapshot } from 'src/utils/hooks/hooksConfigSnapshot.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { getPlansDirectory } from 'src/utils/plans.js'
import { setCwd } from 'src/utils/Shell.js'
import { saveWorktreeState } from 'src/utils/sessionStorage.js'
import {
  cleanupWorktree,
  getCurrentWorktreeSession,
  keepWorktree,
  killTmuxSession,
} from 'src/utils/worktree.js'
import { EXIT_WORKTREE_TOOL_NAME } from './constants.js'
import { getExitWorktreeToolPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['keep', 'remove'])
      .describe(
        '"keep" 保留磁盘上的工作树和分支；"remove" 删除两者。',
      ),
    discard_changes: z
      .boolean()
      .optional()
      .describe(
        '当 action 为 "remove" 且工作树有未提交文件或未合并提交时必须为 true。否则工具将拒绝并列出它们。',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    action: z.enum(['keep', 'remove']),
    originalCwd: z.string(),
    worktreePath: z.string(),
    worktreeBranch: z.string().optional(),
    tmuxSessionName: z.string().optional(),
    discardedFiles: z.number().optional(),
    discardedCommits: z.number().optional(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

type ChangeSummary = {
  changedFiles: number
  commits: number
}

/**
 * 当状态无法可靠确定时返回 null —— 使用此函数作为安全门禁的调用方必须将 null 视为“未知，假定不安全”（故障关闭）。
 * 静默的 0/0 会让 cleanupWorktree 破坏真正的工作。
 *
 * 在以下情况下返回 null：
 * - git status 或 rev-list 退出码非零（锁文件、损坏的索引、错误的引用）
 * - originalHeadCommit 为 undefined 但 git status 成功 —— 这是基于钩子的工作树包装 git 的情况（worktree.ts:525-532 未设置 originalHeadCommit）。
 *   我们可以看到工作树是 git 仓库，但没有基线无法计算提交数，因此无法证明分支是干净的。
 */
async function countWorktreeChanges(
  worktreePath: string,
  originalHeadCommit: string | undefined,
): Promise<ChangeSummary | null> {
  const status = await execFileNoThrow('git', [
    '-C',
    worktreePath,
    'status',
    '--porcelain',
  ])
  if (status.code !== 0) {
    return null
  }
  const changedFiles = count(status.stdout.split('\n'), l => l.trim() !== '')

  if (!originalHeadCommit) {
    // git status 成功 → 这是一个 git 仓库，但没有基线提交，无法计算提交数。故障关闭，而不是声称 0。
    return null
  }

  const revList = await execFileNoThrow('git', [
    '-C',
    worktreePath,
    'rev-list',
    '--count',
    `${originalHeadCommit}..HEAD`,
  ])
  if (revList.code !== 0) {
    return null
  }
  const commits = parseInt(revList.stdout.trim(), 10) || 0

  return { changedFiles, commits }
}

/**
 * 恢复会话状态以反映原始目录。
 * 这是 EnterWorktreeTool.call() 中会话级变更的逆向操作。
 *
 * keepWorktree()/cleanupWorktree() 处理 process.chdir 和 currentWorktreeSession；
 * 此函数处理工作树工具层以上的所有内容。
 */
function restoreSessionToOriginalCwd(
  originalCwd: string,
  projectRootIsWorktree: boolean,
): void {
  setCwd(originalCwd)
  // EnterWorktree 将 originalCwd 设置为 *工作树* 路径（有意为之 —— 参见 state.ts 中 getProjectRoot 的注释）。重置为真正的原始值。
  setOriginalCwd(originalCwd)
  // --worktree 启动时将 projectRoot 设置为工作树；会话中途的 EnterWorktreeTool 不会设置。仅在真正更改时恢复 ——
  // 否则我们会将 projectRoot 移动到用户进入工作树之前 cd 到的任何位置（session.originalCwd），破坏“稳定项目标识”的约定。
  if (projectRootIsWorktree) {
    setProjectRoot(originalCwd)
    // setup.ts 的 --worktree 块调用了 updateHooksConfigSnapshot() 以从工作树重新读取钩子。对称地恢复。
    // （会话中途的 EnterWorktreeTool 从未触及快照，因此此处无操作。）
    updateHooksConfigSnapshot()
  }
  saveWorktreeState(null)
  clearSystemPromptSections()
  clearMemoryFileCaches()
  getPlansDirectory.cache.clear?.()
}

export const ExitWorktreeTool: Tool<InputSchema, Output> = buildTool({
  name: EXIT_WORKTREE_TOOL_NAME,
  searchHint: '退出工作树会话并返回到原始目录',
  maxResultSizeChars: 100_000,
  async description() {
    return '退出由 EnterWorktree 创建的工作树会话并恢复原始工作目录'
  },
  async prompt() {
    return getExitWorktreeToolPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return '退出工作树'
  },
  shouldDefer: true,
  isDestructive(input) {
    return input.action === 'remove'
  },
  toAutoClassifierInput(input) {
    return input.action
  },
  async validateInput(input) {
    // 作用域门禁：除非 EnterWorktree（具体来说是 createWorktreeForSession）在 *本次* 会话中运行，否则 getCurrentWorktreeSession() 为 null。
    // 由 `git worktree add` 创建的工作树，或由先前会话中的 EnterWorktree 创建的工作树，不会填充它。这是唯一的入口门禁 ——
    // 此后的所有操作都在 EnterWorktree 创建的路径上进行。
    const session = getCurrentWorktreeSession()
    if (!session) {
      return {
        result: false,
        message:
          '无操作：没有活动的 EnterWorktree 会话可退出。此工具仅操作由 EnterWorktree 在当前会话中创建的工作树 —— 不会触碰手动创建或先前会话中创建的工作树。未对文件系统进行任何更改。',
        errorCode: 1,
      }
    }

    if (input.action === 'remove' && !input.discard_changes) {
      const summary = await countWorktreeChanges(
        session.worktreePath,
        session.originalHeadCommit,
      )
      if (summary === null) {
        return {
          result: false,
          message: `无法验证 ${session.worktreePath} 的工作树状态。拒绝在没有明确确认的情况下删除。请使用 discard_changes: true 重新调用以继续 — 或使用 action: "keep" 保留工作树。`,
          errorCode: 3,
        }
      }
      const { changedFiles, commits } = summary
      if (changedFiles > 0 || commits > 0) {
        const parts: string[] = []
        if (changedFiles > 0) {
          parts.push(
            `${changedFiles} 个未提交的${changedFiles === 1 ? '文件' : '文件'}`,
          )
        }
        if (commits > 0) {
          parts.push(
            `${commits} 个${commits === 1 ? '提交' : '提交'} ${session.worktreeBranch ? `在工作树分支 ${session.worktreeBranch} 上` : '在工作树分支上'}`,
          )
        }
        return {
          result: false,
          message: `工作树有 ${parts.join(' 和 ')}。删除将永久丢弃这些工作。请与用户确认，然后使用 discard_changes: true 重新调用 — 或使用 action: "keep" 保留工作树。`,
          errorCode: 2,
        }
      }
    }

    return { result: true }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(input) {
    const session = getCurrentWorktreeSession()
    if (!session) {
      // validateInput 会守卫这一点，但会话是模块级的可变状态 —— 防止验证和执行之间的竞争条件。
      throw new Error('不在工作树会话中')
    }

    // 在 keepWorktree/cleanupWorktree 将 currentWorktreeSession 置为 null 之前捕获。
    const {
      originalCwd,
      worktreePath,
      worktreeBranch,
      tmuxSessionName,
      originalHeadCommit,
    } = session

    // --worktree 启动在 setCwd(worktreePath) 之后立即连续调用 setOriginalCwd(getCwd()) 和 setProjectRoot(getCwd())
    // （setup.ts:235/239），因此两者都持有相同的 realpath 值，BashTool cd 从不触及它们。会话中途的 EnterWorktreeTool 设置 originalCwd 但不设置 projectRoot。
    // （不能使用 getCwd() — BashTool 在每次 cd 时都会修改它。不能使用 session.worktreePath — 它是 join() 的结果，不是 realpath。）
    const projectRootIsWorktree = getProjectRoot() === getOriginalCwd()

    // 在执行时重新计数以获得准确的分析和输出 —— validateInput 时的工作树状态可能已经改变。null（git 失败）回退到 0/0；
    // 安全门禁已在 validateInput 中完成，因此这只影响分析和消息。
    const { changedFiles, commits } = (await countWorktreeChanges(
      worktreePath,
      originalHeadCommit,
    )) ?? { changedFiles: 0, commits: 0 }

    if (input.action === 'keep') {
      await keepWorktree()
      restoreSessionToOriginalCwd(originalCwd, projectRootIsWorktree)

      logEvent('tengu_worktree_kept', {
        mid_session: true,
        commits,
        changed_files: changedFiles,
      })

      const tmuxNote = tmuxSessionName
        ? ` Tmux 会话 ${tmuxSessionName} 仍在运行；重新附加请使用：tmux attach -t ${tmuxSessionName}`
        : ''
      return {
        data: {
          action: 'keep' as const,
          originalCwd,
          worktreePath,
          worktreeBranch,
          tmuxSessionName,
          message: `已退出工作树。您的工作已保留在 ${worktreePath}${worktreeBranch ? ` 分支 ${worktreeBranch} 上` : ''}。会话现在回到 ${originalCwd}。${tmuxNote}`,
        },
      }
    }

    // action === 'remove'
    if (tmuxSessionName) {
      await killTmuxSession(tmuxSessionName)
    }
    await cleanupWorktree()
    restoreSessionToOriginalCwd(originalCwd, projectRootIsWorktree)

    logEvent('tengu_worktree_removed', {
      mid_session: true,
      commits,
      changed_files: changedFiles,
    })

    const discardParts: string[] = []
    if (commits > 0) {
      discardParts.push(`${commits} 个${commits === 1 ? '提交' : '提交'}`)
    }
    if (changedFiles > 0) {
      discardParts.push(
        `${changedFiles} 个未提交的${changedFiles === 1 ? '文件' : '文件'}`,
      )
    }
    const discardNote =
      discardParts.length > 0 ? ` 已丢弃 ${discardParts.join(' 和 ')}。` : ''
    return {
      data: {
        action: 'remove' as const,
        originalCwd,
        worktreePath,
        worktreeBranch,
        discardedFiles: changedFiles,
        discardedCommits: commits,
        message: `已退出并删除工作树 ${worktreePath}。${discardNote}会话现在回到 ${originalCwd}。`,
      },
    }
  },
  mapToolResultToToolResultBlockParam({ message }, toolUseID) {
    return {
      type: 'tool_result',
      content: message,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)