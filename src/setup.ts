/* eslint-disable custom-rules/no-process-exit */

import { feature } from 'bun:bundle'
import chalk from 'chalk'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getCwd } from 'src/utils/cwd.js'
import { checkForReleaseNotes } from 'src/utils/releaseNotes.js'
import { setCwd } from 'src/utils/Shell.js'
import { initSinks } from 'src/utils/sinks.js'
import {
  getIsNonInteractiveSession,
  getProjectRoot,
  getSessionId,
  setOriginalCwd,
  setProjectRoot,
  switchSession,
} from './bootstrap/state.js'
import { getCommands } from './commands.js'
import { initSessionMemory } from './services/SessionMemory/sessionMemory.js'
import { initSkillLearning } from './services/skillLearning/runtimeObserver.js'
import { asSessionId } from './types/ids.js'
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js'
import { checkAndRestoreTerminalBackup } from './utils/appleTerminalBackup.js'
import { prefetchApiKeyFromApiKeyHelperIfSafe } from './utils/auth.js'
import { clearMemoryFileCaches } from './utils/claudemd.js'
import { getCurrentProjectConfig, getGlobalConfig } from './utils/config.js'
import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
import { env } from './utils/env.js'
import { envDynamic } from './utils/envDynamic.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { errorMessage } from './utils/errors.js'
import { findCanonicalGitRoot, findGitRoot, getIsGit } from './utils/git.js'
import { initializeFileChangedWatcher } from './utils/hooks/fileChangedWatcher.js'
import {
  captureHooksConfigSnapshot,
  updateHooksConfigSnapshot,
} from './utils/hooks/hooksConfigSnapshot.js'
import { hasWorktreeCreateHook } from './utils/hooks.js'
import { checkAndRestoreITerm2Backup } from './utils/iTermBackup.js'
import { logError } from './utils/log.js'
import { getRecentActivity } from './utils/logoV2Utils.js'
import { lockCurrentVersion } from './utils/nativeInstaller/index.js'
import type { PermissionMode } from './utils/permissions/PermissionMode.js'
import { getPlanSlug } from './utils/plans.js'
import { saveWorktreeState } from './utils/sessionStorage.js'
import { profileCheckpoint } from './utils/startupProfiler.js'
import {
  createTmuxSessionForWorktree,
  createWorktreeForSession,
  generateTmuxSessionName,
  worktreeBranchName,
} from './utils/worktree.js'

export async function setup(
  cwd: string,
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
  worktreeEnabled: boolean,
  worktreeName: string | undefined,
  tmuxEnabled: boolean,
  customSessionId?: string | null,
  worktreePRNumber?: number,
  messagingSocketPath?: string,
): Promise<void> {
  logForDiagnosticsNoPII('info', 'setup_started')

  // 检查 Node.js 版本是否低于 18
  const nodeVersion = process.version.match(/^v(\d+)\./)?.[1]
  if (!nodeVersion || parseInt(nodeVersion, 10) < 18) {
    console.error(
      chalk.bold.red(
        '错误：Claude Code 需要 Node.js 版本 18 或更高。',
      ),
    )
    process.exit(1)
  }

  // 如果提供了自定义会话 ID，则进行设置
  if (customSessionId) {
    switchSession(asSessionId(customSessionId))
  }

  // --bare / SIMPLE：跳过 UDS 消息服务器和队友快
  // 照。脚本化调用不会接收注入的消息，也不使用集群队友。显式的 --messag
  // ing-socket-path 是逃生舱口（遵循 #23222 门控模式）。
  if (!isBareMode() || messagingSocketPath !== undefined) {
    // 启动 UDS 消息服务器（仅限 Mac/Linux）。默认对
    // ants 启用 —— 如果未传递 --messaging-socket-path，
    // 则在 tmpdir 中创建一个 socket。使用 await 确保服务器已绑定，并且在
    // 任何钩子（特别是 SessionStart）可能生成并快照 process.env
    // 之前，$CLAUDE_CODE_MESSAGING_SOCKET 环境变量已导出。
    if (feature('UDS_INBOX')) {
      const m = await import('./utils/udsMessaging.js')
      await m.startUdsMessaging(
        messagingSocketPath ?? m.getDefaultUdsSocketPath(),
        { isExplicit: messagingSocketPath !== undefined },
      )
    }
  }

  // 队友快照 —— 仅限 SIMPLE 模式的门控（无逃生舱口，bare 模式下不使用集群）
  if (!isBareMode() && isAgentSwarmsEnabled()) {
    const { captureTeammateModeSnapshot } = await import(
      './utils/swarm/backends/teammateModeSnapshot.js'
    )
    captureTeammateModeSnapshot()
  }

  // 终端备份恢复 —— 仅限交互模式。打印模
  // 式不与终端设置交互；下一个交互式会话将检
  // 测并恢复任何中断的设置。
  if (!getIsNonInteractiveSession()) {
    // 仅当启用集群时检查 iTerm2 备份
    if (isAgentSwarmsEnabled()) {
      const restoredIterm2Backup = await checkAndRestoreITerm2Backup()
      if (restoredIterm2Backup.status === 'restored') {
        console.log(
          chalk.yellow(
            '检测到中断的 iTerm2 设置。您的原始设置已恢复。您可能需要重启 iTerm2 以使更改生效。',
          ),
        )
      } else if (restoredIterm2Backup.status === 'failed') {
        console.error(
          chalk.red(
            `恢复 iTerm2 设置失败。请使用以下命令手动恢复您的原始设置：defaults import com.googlecode.iterm2 ${restoredIterm2Backup.backupPath}。`,
          ),
        )
      }
    }

    // 如果设置被中断，检查并恢复 Terminal.app 备份
    try {
      const restoredTerminalBackup = await checkAndRestoreTerminalBackup()
      if (restoredTerminalBackup.status === 'restored') {
        console.log(
          chalk.yellow(
            '检测到中断的 Terminal.app 设置。您的原始设置已恢复。您可能需要重启 Terminal.app 以使更改生效。',
          ),
        )
      } else if (restoredTerminalBackup.status === 'failed') {
        console.error(
          chalk.red(
            `恢复 Terminal.app 设置失败。请使用以下命令手动恢复您的原始设置：defaults import com.apple.Terminal ${restoredTerminalBackup.backupPath}。`,
          ),
        )
      }
    } catch (error) {
      // 如果 Terminal.app 备份恢复失败，记录日志但不使程序崩溃
      logError(error)
    }
  }

  // 重要：必须在任何依赖当前工作目录的其他代码之前调用 setCwd()
  setCwd(cwd)

  // 捕获钩子配置快照，以避免隐藏的钩子修改。重要：必
  // 须在 setCwd() 之后调用，以便从正确的目录加载钩子
  const hooksStart = Date.now()
  captureHooksConfigSnapshot()
  logForDiagnosticsNoPII('info', 'setup_hooks_captured', {
    duration_ms: Date.now() - hooksStart,
  })

  // 初始化 FileChanged 钩子监视器 —— 同步操作，读取钩子配置快照
  initializeFileChangedWatcher(cwd)

  // 如果请求，处理工作树创建。重要：
  // 必须在 getCommands() 之前调用，否则 /eject 将不可用。
  if (worktreeEnabled) {
    // 与 bridgeMain.ts 保持一致：配置了钩子的会话可以在没有 git 的情况下进行，因此 c
    // reateWorktreeForSession() 可以委托给钩子（非 git 版本控制系统）。
    const hasHook = hasWorktreeCreateHook()
    const inGit = await getIsGit()
    if (!hasHook && !inGit) {
      process.stderr.write(
        chalk.red(
          `错误：只能在 git 仓库中使用 --worktree，但 ${chalk.bold(cwd)} 不是 git 仓库。` +
            `在 settings.json 中配置 WorktreeCreate 钩子，以便在其他 VCS 系统中使用 --worktree。
`,
        ),
      )
      process.exit(1)
    }

    const slug = worktreePRNumber
      ? `pr-${worktreePRNumber}`
      : (worktreeName ?? getPlanSlug())

    // 只要我们在 git 仓库中，Git 前导代码就会运行 —— 即使配置了钩子
    // —— 这样 --tmux 对于同时拥有 WorktreeCreate 钩
    // 子的 git 用户仍然有效。只有纯钩子（非 git）模式会跳过它。
    let tmuxSessionName: string | undefined
    if (inGit) {
      // 解析到主仓库根目录（处理从工作树内部调用的情况）。findCanonical
      // GitRoot 是同步的、仅文件系统操作且已缓存的；底层的 findGi
      // tRoot 缓存已由上面的 getIsGit() 预热，所以这几乎是零成本的。
      const mainRepoRoot = findCanonicalGitRoot(getCwd())
      if (!mainRepoRoot) {
        process.stderr.write(
          chalk.red(
            `错误：无法确定主 git 仓库根目录。
`,
          ),
        )
        process.exit(1)
      }

      // 如果当前位于工作树内，则切换到主仓库以创建工作树
      if (mainRepoRoot !== (findGitRoot(getCwd()) ?? getCwd())) {
        logForDiagnosticsNoPII('info', 'worktree_resolved_to_main_repo')
        process.chdir(mainRepoRoot)
        setCwd(mainRepoRoot)
      }

      tmuxSessionName = tmuxEnabled
        ? generateTmuxSessionName(mainRepoRoot, worktreeBranchName(slug))
        : undefined
    } else {
      // 非 Git 钩子模式：没有规范根目录可解析，因此基于当前工作目录命名 tmux 会话 —
      // — generateTmuxSessionName 仅对路径进行 basename 处理。
      tmuxSessionName = tmuxEnabled
        ? generateTmuxSessionName(getCwd(), worktreeBranchName(slug))
        : undefined
    }

    let worktreeSession: Awaited<ReturnType<typeof createWorktreeForSession>>
    try {
      worktreeSession = await createWorktreeForSession(
        getSessionId(),
        slug,
        tmuxSessionName,
        worktreePRNumber ? { prNumber: worktreePRNumber } : undefined,
      )
    } catch (error) {
      process.stderr.write(
        chalk.red(`创建工作树时出错：${errorMessage(error)}
`),
      )
      process.exit(1)
    }

    logEvent('tengu_worktree_created', { tmux_enabled: tmuxEnabled })

    // 如果启用，则为工作树创建 tmux 会话
    if (tmuxEnabled && tmuxSessionName) {
      const tmuxResult = await createTmuxSessionForWorktree(
        tmuxSessionName,
        worktreeSession.worktreePath,
      )
      if (tmuxResult.created) {
        console.log(
          chalk.green(
            `已创建 tmux 会话：${chalk.bold(tmuxSessionName)}
要附加会话：${chalk.bold(`tmux attach -t ${tmuxSessionName}`)}`,
          ),
        )
      } else {
        console.error(
          chalk.yellow(
            `警告：创建 tmux 会话失败：${tmuxResult.error}`,
          ),
        )
      }
    }

    process.chdir(worktreeSession.worktreePath)
    setCwd(worktreeSession.worktreePath)
    setOriginalCwd(getCwd())
    // --worktree 意味着工作树本身就是会话的项目，因此技能/钩子/cr
    // on/等应在此处解析。（会话中的 EnterWorktreeTool 不
    // 会触及 projectRoot —— 那是一个临时工作树，项目保持稳定。）
    setProjectRoot(getCwd())
    saveWorktreeState(worktreeSession)
    // 清除内存文件缓存，因为 originalCwd 已更改
    clearMemoryFileCaches()
    // 设置缓存已在 init() 中（通过 applySafeConfigEnvironmentVaria
    // bles）以及上方的 captureHooksConfigSnapshot() 处填充，两者都来自
    // 原始目录的 .claude/settings.json。从工作树重新读取并重新捕获钩子。
    updateHooksConfigSnapshot()
  }

  // 后台作业 —— 仅注册必须在首次查询前完成的关键任务
  logForDiagnosticsNoPII('info', 'setup_background_jobs_starting')
  // 捆绑的技能/插件在 main.tsx 中并行 getCommands() 启动前注
  // 册 —— 参见那里的注释。从 setup() 移出是因为上方的 await 点（
  // startUdsMessaging，约 20ms）导致 getCommands()
  // 提前执行并缓存了一个空的 bundledSkills 列表。
  if (!isBareMode()) {
    initSessionMemory() // Synchronous - registers hook, gate check happens lazily
    initSkillLearning() // Synchronous - registers hook, gate check happens lazily
    if (feature('CONTEXT_COLLAPSE')) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      ;(
        require('./services/contextCollapse/index.js') as typeof import('./services/contextCollapse/index.js')
      ).initContextCollapse()
      /* eslint-enable @typescript-eslint/no-require-imports */
    }
  }
  void lockCurrentVersion() // 锁定当前版本以防止被其他进程删除
  logForDiagnosticsNoPII('info', 'setup_background_jobs_launched')

  profileCheckpoint('setup_before_prefetch')
  // 预取 Promise —— 仅包含渲染前需要的项目
  logForDiagnosticsNoPII('info', 'setup_prefetch_starting')
  // 当设置 CLAUDE_CODE_SYNC_PLUGIN_INSTALL 时，跳过所
  // 有插件预取。print.ts 中的同步安装路径会在安装后调用 refresh
  // PluginState()，这会重新加载命令、钩子和代理。在此处预取会与安装过程（
  // 对相同目录并发执行 copyPluginToVersionedCache / cach
  // ePlugin）产生竞争，并且热重载处理器会在安装中途收到 policySettings
  // 时触发 clearPluginCache()。
  const skipPluginPrefetch =
    (getIsNonInteractiveSession() &&
      isEnvTruthy(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL)) ||
    // --bare：loadPluginHooks → loadAllPlugins 是文件系统操作
    // ，在 --bare 模式下 executeHooks 会提前返回，这些操作会被浪费。
    isBareMode()
  if (!skipPluginPrefetch) {
    void getCommands(getProjectRoot())
  }
  void import('./utils/plugins/loadPluginHooks.js').then(m => {
    if (!skipPluginPrefetch) {
      void m.loadPluginHooks() // 预加载插件钩子（在渲染前由 processSessionStartHooks 使用）
      m.setupPluginHookHotReload() // 设置插件钩子在设置变更时的热重载
    }
  })
  // --bare：跳过归属钩子安装 + 仓库分类 + 会话
  // 文件访问分析 + 团队记忆监视器。这些是用于提交归属和用量指标的
  // 后台簿记 —— 脚本调用不提交代码，而 49 毫秒的归属钩子状态
  // 检查（已测量）是纯开销。这不是提前返回：下方的 --danger
  // ously-skip-permissions 安全门、tengu
  // _started 信标和 apiKeyHelper 预取仍必须运行。
  if (!isBareMode()) {
    if (process.env.USER_TYPE === 'ant') {
      // 为自动隐身模式预热仓库分类缓存。默认情况下隐身
      // 模式开启，直到确认为内部仓库；如果解析为内部仓库，
      // 则清除提示缓存，以便下一轮获取关闭状态。
      void import('./utils/commitAttribution.js').then(async m => {
        if (await m.isInternalModelRepo()) {
          const { clearSystemPromptSections } = await import(
            './constants/systemPromptSections.js'
          )
          clearSystemPromptSections()
        }
      })
    }
    if (feature('COMMIT_ATTRIBUTION')) {
      // 使用动态导入以启用死代码消除（模块包含排除的字符串）。延迟到下一个 t
      // ick 执行，以便 git 子进程的生成在首次渲染之后运行，
      // 而不是在 setup() 微任务窗口期间。
      setImmediate(() => {
        void import('./utils/attributionHooks.js').then(
          ({ registerAttributionHooks }) => {
            registerAttributionHooks() // 注册归属跟踪钩子（仅限 ant 功能）
          },
        )
      })
    }
    void import('./utils/sessionFileAccessHooks.js').then(m =>
      m.registerSessionFileAccessHooks(),
    ) // 注册会话文件访问分析钩子
    if (feature('TEAMMEM')) {
      void import('./services/teamMemorySync/watcher.js').then(m =>
        m.startTeamMemoryWatcher(),
      ) // 启动团队记忆同步监视器
    }
  }
  initSinks() // 附加错误日志和分析接收器，并清空排队的事件

  // 会话成功率分母。在分析接收器附加后立即发出 —— 在任何可
  // 能抛出异常的解析、获取或 I/O 之前。inc-3694（P
  // 0 CHANGELOG 崩溃）在下面的 checkForRe
  // leaseNotes 处抛出；此后的每个事件都无效。此信
  // 标是发布健康监控最早可靠的“进程已启动”信号。
  logEvent('tengu_started', {})

  void prefetchApiKeyFromApiKeyHelperIfSafe(getIsNonInteractiveSession()) // 安全预取 - 仅在信任已确认时执行
  profileCheckpoint('setup_after_prefetch')

  // 为 Logo v2 预取数据 - 等待以确保在 Logo 渲染前准备就绪。--bare
  // / SIMPLE: 跳过 — 发布说明是交互式 UI 显示数据，而 getRece
  // ntActivity() 会读取最多 10 个会话 JSONL 文件。
  if (!isBareMode()) {
    const { hasReleaseNotes } = await checkForReleaseNotes(
      getGlobalConfig().lastReleaseNotesSeen,
    )
    if (hasReleaseNotes) {
      await getRecentActivity()
    }
  }

  // 如果权限模式设置为 bypass，请验证我们处于安全环境中
  if (
    permissionMode === 'bypassPermissions' ||
    allowDangerouslySkipPermissions
  ) {
    // 检查是否在类 Unix 系统上以 root/sudo 身份运行。
    // 如果在沙盒中（例如需要 root 的 TPU devspaces），则允许 root
    if (
      process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      process.getuid() === 0 &&
      process.env.IS_SANDBOX !== '1' &&
      !isEnvTruthy(process.env.CLAUDE_CODE_BUBBLEWRAP)
    ) {
      console.error(
        `出于安全原因，--dangerously-skip-permissions 不能与 root/sudo 权限一起使用`,
      )
      process.exit(1)
    }

    if (
      process.env.USER_TYPE === 'ant' &&
      // 跳过 Desktop 的本地代理模式 — 信任模型与 CCR/BYOC 相同（受信任
      // 的 Anthropic 管理的启动器有意预先批准所有内容）。先例：permissionSetup
      // .ts:861, applySettingsChange.ts:55 (PR #19116)
      process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent' &&
      // CCD（Desktop 中的 Claude Code）同理 — apps#
      // 29127 无条件传递标志以解锁会话中期的 bypass 切换
      process.env.CLAUDE_CODE_ENTRYPOINT !== 'claude-desktop'
    ) {
      // 仅在权限模式设置为 bypass 时等待
      const [isDocker, hasInternet] = await Promise.all([
        envDynamic.getIsDocker(),
        env.hasInternetAccess(),
      ])
      const isBubblewrap = envDynamic.getIsBubblewrapSandbox()
      const isSandbox = process.env.IS_SANDBOX === '1'
      const isSandboxed = isDocker || isBubblewrap || isSandbox
      if (!isSandboxed || hasInternet) {
        console.error(
          `--dangerously-skip-permissions 只能在无法访问互联网的 Docker/沙盒容器中使用，但得到 Docker: ${isDocker}, Bubblewrap: ${isBubblewrap}, IS_SANDBOX: ${isSandbox}, hasInternet: ${hasInternet}`,
        )
        process.exit(1)
      }
    }
  }

  if (process.env.NODE_ENV === 'test') {
    return
  }

  // 记录来自上一个会话的 tengu_exit 事件？
  const projectConfig = getCurrentProjectConfig()
  if (
    projectConfig.lastCost !== undefined &&
    projectConfig.lastDuration !== undefined
  ) {
    logEvent('tengu_exit', {
      last_session_cost: projectConfig.lastCost,
      last_session_api_duration: projectConfig.lastAPIDuration,
      last_session_tool_duration: projectConfig.lastToolDuration,
      last_session_duration: projectConfig.lastDuration,
      last_session_lines_added: projectConfig.lastLinesAdded,
      last_session_lines_removed: projectConfig.lastLinesRemoved,
      last_session_total_input_tokens: projectConfig.lastTotalInputTokens,
      last_session_total_output_tokens: projectConfig.lastTotalOutputTokens,
      last_session_total_cache_creation_input_tokens:
        projectConfig.lastTotalCacheCreationInputTokens,
      last_session_total_cache_read_input_tokens:
        projectConfig.lastTotalCacheReadInputTokens,
      last_session_fps_average: projectConfig.lastFpsAverage,
      last_session_fps_low_1_pct: projectConfig.lastFpsLow1Pct,
      last_session_id:
        projectConfig.lastSessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...projectConfig.lastSessionMetrics,
    })
    // 注意：我们有意在记录后不清除这些值。恢
    // 复会话时，它们对于成本恢复是必需的。
    // 当下一个会话退出时，这些值将被覆盖。
  }
}
