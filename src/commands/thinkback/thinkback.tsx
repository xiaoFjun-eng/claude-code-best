import { execa } from 'execa'
import { readFile } from 'fs/promises'
import { join } from 'path'
import * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '@anthropic/ink'
import { Spinner } from '../../components/Spinner.js'
import { Box, Text, instances } from '@anthropic/ink'
import { enablePluginOp } from '../../services/plugins/pluginOperations.js'
import { logForDebugging } from '../../utils/debug.js'
import { isENOENT, toError } from '../../utils/errors.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { pathExists } from '../../utils/file.js'
import { logError } from '../../utils/log.js'
import { getPlatform } from '../../utils/platform.js'
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js'
import { isPluginInstalled } from '../../utils/plugins/installedPluginsManager.js'
import {
  addMarketplaceSource,
  clearMarketplacesCache,
  loadKnownMarketplacesConfig,
  refreshMarketplace,
} from '../../utils/plugins/marketplaceManager.js'
import { OFFICIAL_MARKETPLACE_NAME } from '../../utils/plugins/officialMarketplace.js'
import { loadAllPlugins } from '../../utils/plugins/pluginLoader.js'
import { installSelectedPlugins } from '../../utils/plugins/pluginStartupCheck.js'

// 市场与插件标识符 - 因用户类型而异
const INTERNAL_MARKETPLACE_NAME = 'claude-code-marketplace'
const INTERNAL_MARKETPLACE_REPO = 'anthropics/claude-code-marketplace'
const OFFICIAL_MARKETPLACE_REPO = 'anthropics/claude-plugins-official'

function getMarketplaceName(): string {
  return process.env.USER_TYPE === 'ant'
    ? INTERNAL_MARKETPLACE_NAME
    : OFFICIAL_MARKETPLACE_NAME
}

function getMarketplaceRepo(): string {
  return process.env.USER_TYPE === 'ant'
    ? INTERNAL_MARKETPLACE_REPO
    : OFFICIAL_MARKETPLACE_REPO
}

function getPluginId(): string {
  return `thinkback@${getMarketplaceName()}`
}

const SKILL_NAME = 'thinkback'

/** 从已安装插件的缓存路径获取 thinkback 技能目录 */
async function getThinkbackSkillDir(): Promise<string | null> {
  const { enabled } = await loadAllPlugins()
  const thinkbackPlugin = enabled.find(
    p =>
      p.name === 'thinkback' || (p.source && p.source.includes(getPluginId())),
  )

  if (!thinkbackPlugin) {
    return null
  }

  const skillDir = join(thinkbackPlugin.path, 'skills', SKILL_NAME)
  if (await pathExists(skillDir)) {
    return skillDir
  }

  return null
}

export async function playAnimation(skillDir: string): Promise<{
  success: boolean
  message: string
}> {
  const dataPath = join(skillDir, 'year_in_review.js')
  const playerPath = join(skillDir, 'player.js')

  // 这两个文件都是 node 子进程的先决条件。在此处读取它们（而非
  // 在调用点），以确保所有调用方获得一致的错误信息。子进程以 reje
  // ct: false 运行，否则缺失文件会静默返回成功。根据 CL
  // AUDE.md 使用 readFile（而非 access）。
  //
  // 非 ENOENT 错误（如 EACCES 等）会被记录并作为失败返回，而非抛出——基于旧版
  // pathExists 的代码从不抛出，且一个调用方（handleSelect）使用 `
  // void playAnimation().then(...)` 而没有 .catch()。
  try {
    await readFile(dataPath)
  } catch (e: unknown) {
    if (isENOENT(e)) {
      return {
        success: false,
        message: '未找到动画。请先运行 /think-back 以生成一个。',
      }
    }
    logError(e)
    return {
      success: false,
      message: `无法访问动画数据：${toError(e).message}`,
    }
  }

  try {
    await readFile(playerPath)
  } catch (e: unknown) {
    if (isENOENT(e)) {
      return {
        success: false,
        message:
          '播放器脚本未找到。thinkback 技能中缺少 player.js 文件。',
      }
    }
    logError(e)
    return {
      success: false,
      message: `无法访问播放器脚本：${toError(e).message}`,
    }
  }

  // 获取用于终端接管的 ink 实例
  const inkInstance = instances.get(process.stdout)
  if (!inkInstance) {
    return { success: false, message: '无法访问终端实例' }
  }

  inkInstance.enterAlternateScreen()
  try {
    await execa('node', [playerPath], {
      stdio: 'inherit',
      cwd: skillDir,
      reject: false,
    })
  } catch {
    // 动画可能已被中断（例如，按了 Ctrl+C）
  } finally {
    inkInstance.exitAlternateScreen()
  }

  // 在浏览器中打开 HTML 文件以下载视频
  const htmlPath = join(skillDir, 'year_in_review.html')
  if (await pathExists(htmlPath)) {
    const platform = getPlatform()
    const openCmd =
      platform === 'macos'
        ? 'open'
        : platform === 'windows'
          ? 'start'
          : 'xdg-open'
    void execFileNoThrow(openCmd, [htmlPath])
  }

  return { success: true, message: '年度回顾动画完成！' }
}

type InstallState =
  | { phase: 'checking' }
  | { phase: 'installing-marketplace' }
  | { phase: 'installing-plugin' }
  | { phase: 'enabling-plugin' }
  | { phase: 'ready' }
  | { phase: 'error'; message: string }

function ThinkbackInstaller({
  onReady,
  onError,
}: {
  onReady: () => void
  onError: (message: string) => void
}): React.ReactNode {
  const [state, setState] = useState<InstallState>({ phase: 'checking' })
  const [progressMessage, setProgressMessage] = useState('')

  useEffect(() => {
    async function checkAndInstall(): Promise<void> {
      try {
        // 检查市场是否已安装
        const knownMarketplaces = await loadKnownMarketplacesConfig()
        const marketplaceName = getMarketplaceName()
        const marketplaceRepo = getMarketplaceRepo()
        const pluginId = getPluginId()
        const marketplaceInstalled = marketplaceName in knownMarketplaces

        // 首先检查插件是否已安装
        const pluginAlreadyInstalled = isPluginInstalled(pluginId)

        if (!marketplaceInstalled) {
          // 安装市场
          setState({ phase: 'installing-marketplace' })
          logForDebugging(`正在安装市场 ${marketplaceRepo}`)

          await addMarketplaceSource(
            { source: 'github', repo: marketplaceRepo },
            message => {
              setProgressMessage(message)
            },
          )
          clearAllCaches()
          logForDebugging(`市场 ${marketplaceName} 已安装`)
        } else if (!pluginAlreadyInstalled) {
          // 市场已安装但插件未安装 - 刷新以获取最新插件。仅
          // 在需要时刷新，以避免潜在的破坏性 git 操作
          setState({ phase: 'installing-marketplace' })
          setProgressMessage('正在更新市场…')
          logForDebugging(`正在刷新市场 ${marketplaceName}`)

          await refreshMarketplace(marketplaceName, message => {
            setProgressMessage(message)
          })
          clearMarketplacesCache()
          clearAllCaches()
          logForDebugging(`市场 ${marketplaceName} 已刷新`)
        }

        if (!pluginAlreadyInstalled) {
          // 安装插件
          setState({ phase: 'installing-plugin' })
          logForDebugging(`正在安装插件 ${pluginId}`)

          const result = await installSelectedPlugins([pluginId])

          if (result.failed.length > 0) {
            const errorMsg = result.failed
              .map(f => `${f.name}: ${f.error}`)
              .join(', ')
            throw new Error(`安装插件失败：${errorMsg}`)
          }

          clearAllCaches()
          logForDebugging(`插件 ${pluginId} 已安装`)
        } else {
          // 插件已安装，检查是否已启用
          const { disabled } = await loadAllPlugins()
          const isDisabled = disabled.some(
            p => p.name === 'thinkback' || p.source?.includes(pluginId),
          )

          if (isDisabled) {
            // 启用插件
            setState({ phase: 'enabling-plugin' })
            logForDebugging(`正在启用插件 ${pluginId}`)

            const enableResult = await enablePluginOp(pluginId)
            if (!enableResult.success) {
              throw new Error(
                `启用插件失败：${enableResult.message}`,
              )
            }

            clearAllCaches()
            logForDebugging(`插件 ${pluginId} 已启用`)
          }
        }

        setState({ phase: 'ready' })
        onReady()
      } catch (error) {
        const err = toError(error)
        logError(err)
        setState({ phase: 'error', message: err.message })
        onError(err.message)
      }
    }

    void checkAndInstall()
  }, [onReady, onError])

  if (state.phase === 'error') {
    return (
      <Box flexDirection="column">
        <Text color="error">Error: {state.message}</Text>
      </Box>
    )
  }

  if (state.phase === 'ready') {
    return null
  }

  const statusMessage =
    state.phase === 'checking'
      ? '正在检查 thinkback 安装…'
      : state.phase === 'installing-marketplace'
        ? '正在安装 marketplace…'
        : state.phase === 'enabling-plugin'
          ? '正在启用 thinkback 插件…'
          : '正在安装 thinkback 插件…'

  return (
    <Box flexDirection="column">
      <Box>
        <Spinner />
        <Text>{progressMessage || statusMessage}</Text>
      </Box>
    </Box>
  )
}

type MenuAction = 'play' | 'edit' | 'fix' | 'regenerate'
type GenerativeAction = Exclude<MenuAction, 'play'>

function ThinkbackMenu({
  onDone,
  onAction,
  skillDir,
  hasGenerated,
}: {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay; shouldQuery?: boolean },
  ) => void
  onAction: (action: GenerativeAction) => void
  skillDir: string
  hasGenerated: boolean
}): React.ReactNode {
  const [hasSelected, setHasSelected] = useState(false)

  const options = hasGenerated
    ? [
        {
          label: '播放动画',
          value: 'play' as const,
          description: '观看你的年度回顾',
        },
        {
          label: '编辑内容',
          value: 'edit' as const,
          description: '修改动画',
        },
        {
          label: '修复错误',
          value: 'fix' as const,
          description: '修复验证或渲染问题',
        },
        {
          label: 'Regenerate',
          value: 'regenerate' as const,
          description: '从头创建新动画',
        },
      ]
    : [
        {
          label: "开始吧！",
          value: 'regenerate' as const,
          description: '生成你的个性化动画',
        },
      ]

  function handleSelect(value: MenuAction): void {
    setHasSelected(true)
    if (value === 'play') {
      // Play 运行终端接管动画，然后通过 skip 信号完成
      void playAnimation(skillDir).then(() => {
        onDone(undefined, { display: 'skip' })
      })
    } else {
      onAction(value)
    }
  }

  function handleCancel(): void {
    onDone(undefined, { display: 'skip' })
  }

  if (hasSelected) {
    return null
  }

  return (
    <Dialog
      title="与 Claude Code 一起回顾 2025"
      subtitle="生成你的 2025 Claude Code 年度回顾（运行需要几分钟）"
      onCancel={handleCancel}
      color="claude"
    >
      <Box flexDirection="column" gap={1}>
        {/* 首次用户描述 */}
        {!hasGenerated && (
          <Box flexDirection="column">
            <Text>重温你与 Claude 一起编码的一年。</Text>
            <Text dimColor>
              {
                "我们将创建一个个性化的 ASCII 动画来庆祝你的旅程。"
              }
            </Text>
          </Box>
        )}

        {/* 菜单 */}
        <Select
          options={options}
          onChange={handleSelect}
          visibleOptionCount={5}
        />
      </Box>
    </Dialog>
  )
}

const EDIT_PROMPT =
  '使用 Skill 工具调用 "thinkback" 技能，设置 mode=edit 来修改我现有的 Claude Code 年度回顾动画。询问我想要更改什么。当动画准备就绪时，告诉用户再次运行 /think-back 来播放它。'

const FIX_PROMPT =
  '使用 Skill 工具调用 "thinkback" 技能，设置 mode=fix 来修复我现有的 Claude Code 年度回顾动画中的验证或渲染错误。运行验证器，识别错误并修复它们。当动画准备就绪时，告诉用户再次运行 /think-back 来播放它。'

const REGENERATE_PROMPT =
  '使用 Skill 工具调用 "thinkback" 技能，设置 mode=regenerate 来从头创建一个全新的 Claude Code 年度回顾动画。删除现有动画并重新开始。当动画准备就绪时，告诉用户再次运行 /think-back 来播放它。'

function ThinkbackFlow({
  onDone,
}: {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay; shouldQuery?: boolean },
  ) => void
}): React.ReactNode {
  const [installComplete, setInstallComplete] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [skillDir, setSkillDir] = useState<string | null>(null)
  const [hasGenerated, setHasGenerated] = useState<boolean | null>(null)

  function handleReady(): void {
    setInstallComplete(true)
  }

  const handleError = useCallback(
    (message: string): void => {
      setInstallError(message)
      // 调用 onDone 并附带错误信息，以便模型可以继续
      onDone(
        `thinkback 错误：${message}。尝试运行 /plugin 手动安装 think-back 插件。`,
        { display: 'system' },
      )
    },
    [onDone],
  )

  useEffect(() => {
    if (installComplete && !skillDir && !installError) {
      // 安装后获取技能目录
      void getThinkbackSkillDir().then(dir => {
        if (dir) {
          logForDebugging(`Thinkback 技能目录：${dir}`)
          setSkillDir(dir)
        } else {
          handleError('找不到 thinkback 技能目录')
        }
      })
    }
  }, [installComplete, skillDir, installError, handleError])

  // 获取 skillDir 后检查生成的文件
  useEffect(() => {
    if (!skillDir) {
      return
    }

    const dataPath = join(skillDir, 'year_in_review.js')
    void pathExists(dataPath).then(exists => {
      logForDebugging(
        `正在检查 ${dataPath}: ${exists ? 'found' : 'not found'}`,
      )
      setHasGenerated(exists)
    })
  }, [skillDir])

  function handleAction(action: GenerativeAction): void {
    // 根据操作向模型发送提示
    const prompts: Record<GenerativeAction, string> = {
      edit: EDIT_PROMPT,
      fix: FIX_PROMPT,
      regenerate: REGENERATE_PROMPT,
    }
    onDone(prompts[action], { display: 'user', shouldQuery: true })
  }

  if (installError) {
    return (
      <Box flexDirection="column">
        <Text color="error">Error: {installError}</Text>
        <Text dimColor>
          尝试运行 /plugin 命令来手动安装 think-back 插件。</Text>
      </Box>
    )
  }

  if (!installComplete) {
    return <ThinkbackInstaller onReady={handleReady} onError={handleError} />
  }

  if (!skillDir || hasGenerated === null) {
    return (
      <Box>
        <Spinner />
        <Text>正在加载 thinkback 技能…</Text>
      </Box>
    )
  }

  return (
    <ThinkbackMenu
      onDone={onDone}
      onAction={handleAction}
      skillDir={skillDir}
      hasGenerated={hasGenerated}
    />
  )
}

export async function call(
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay; shouldQuery?: boolean },
  ) => void,
): Promise<React.ReactNode> {
  return <ThinkbackFlow onDone={onDone} />
}
