import { z } from 'zod/v4'
import { getSessionId, setOriginalCwd } from 'src/bootstrap/state.js'
import { clearSystemPromptSections } from 'src/constants/systemPromptSections.js'
import { logEvent } from 'src/services/analytics/index.js'
import type { Tool } from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { clearMemoryFileCaches } from 'src/utils/claudemd.js'
import { getCwd } from 'src/utils/cwd.js'
import { findCanonicalGitRoot } from 'src/utils/git.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { getPlanSlug, getPlansDirectory } from 'src/utils/plans.js'
import { setCwd } from 'src/utils/Shell.js'
import { saveWorktreeState } from 'src/utils/sessionStorage.js'
import {
  createWorktreeForSession,
  getCurrentWorktreeSession,
  validateWorktreeSlug,
} from 'src/utils/worktree.js'
import { ENTER_WORKTREE_TOOL_NAME } from './constants.js'
import { getEnterWorktreeToolPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    name: z
      .string()
      .superRefine((s, ctx) => {
        try {
          validateWorktreeSlug(s)
        } catch (e) {
          ctx.addIssue({ code: 'custom', message: (e as Error).message })
        }
      })
      .optional()
      .describe(
        '工作树的可选名称。每个以“/”分隔的段只能包含字母、数字、点、下划线和短横线；总长度最多 64 个字符。如果未提供，将生成一个随机名称。',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    worktreePath: z.string(),
    worktreeBranch: z.string().optional(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const EnterWorktreeTool: Tool<InputSchema, Output> = buildTool({
  name: ENTER_WORKTREE_TOOL_NAME,
  searchHint: '创建一个隔离的 git 工作树并切换到其中',
  maxResultSizeChars: 100_000,
  async description() {
    return '创建一个隔离的工作树（通过 git 或配置的钩子）并将会话切换到其中'
  },
  async prompt() {
    return getEnterWorktreeToolPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return '正在创建工作树'
  },
  shouldDefer: true,
  toAutoClassifierInput(input) {
    return input.name ?? ''
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(input) {
    // 验证当前未处于由本会话创建的工作树中
    if (getCurrentWorktreeSession()) {
      throw new Error('已处于工作树会话中')
    }

    // 解析到主仓库根目录，以便可以从工作树内部创建工作树
    const mainRepoRoot = findCanonicalGitRoot(getCwd())
    if (mainRepoRoot && mainRepoRoot !== getCwd()) {
      process.chdir(mainRepoRoot)
      setCwd(mainRepoRoot)
    }

    const slug = input.name ?? getPlanSlug()

    const worktreeSession = await createWorktreeForSession(getSessionId(), slug)

    process.chdir(worktreeSession.worktreePath)
    setCwd(worktreeSession.worktreePath)
    setOriginalCwd(getCwd())
    saveWorktreeState(worktreeSession)
    // 清除缓存的系统提示部分，以便 env_info_simple 在工作树上下文中重新计算
    clearSystemPromptSections()
    // 清除依赖于当前工作目录的已记忆缓存
    clearMemoryFileCaches()
    getPlansDirectory.cache.clear?.()

    logEvent('tengu_worktree_created', {
      mid_session: true,
    })

    const branchInfo = worktreeSession.worktreeBranch
      ? ` 在分支 ${worktreeSession.worktreeBranch} 上`
      : ''

    return {
      data: {
        worktreePath: worktreeSession.worktreePath,
        worktreeBranch: worktreeSession.worktreeBranch,
        message: `已在 ${worktreeSession.worktreePath}${branchInfo} 处创建工作树。会话现在正在该工作树中工作。使用 ExitWorktree 可在会话中途离开，或退出会话以获取提示。`,
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
