import * as React from 'react';
import { useEffect, useState } from 'react';
import { resolve } from 'path';
import { Box, Text } from '@anthropic/ink';
import { Dialog } from '../../components/design-system/Dialog.js';
import { ListItem } from '../../components/design-system/ListItem.js';
import { useRegisterOverlay } from '../../context/overlayContext.js';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import { findGitRoot } from '../../utils/git.js';
import { buildCliLaunch, spawnCli } from '../../utils/cliLaunch.js';
import { getKairosActive, setKairosActive } from '../../bootstrap/state.js';
import type { LocalJSXCommandContext } from '../../commands.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import type { AppState } from '../../state/AppState.js';

/** * 计算助手守护进程安装的默认目录。
 * 优先使用当前工作目录的 git 根目录；否则回退到当前工作目录本身。 */
export async function computeDefaultInstallDir(): Promise<string> {
  const cwd = process.cwd();
  const gitRoot = findGitRoot(cwd);
  return gitRoot || resolve(cwd);
}

interface WizardProps {
  defaultDir: string;
  onInstalled: (dir: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}

/** * 助手模式的安装向导。当 `claude assistant` 发现零个 CCR 会话时显示。
 * 引导用户启动一个守护进程，该进程会注册一个桥接 → CCR 云会话。
 *
 * 安装完成后，main.tsx 会提示用户在几秒钟后再次运行 `claude assistant`
 *（守护进程需要时间来注册桥接会话）。 */
export function NewInstallWizard({ defaultDir, onInstalled, onCancel, onError }: WizardProps): React.ReactNode {
  useRegisterOverlay('assistant-install-wizard');
  const [focusIndex, setFocusIndex] = useState(0);
  const [starting, setStarting] = useState(false);

  useKeybindings(
    {
      'select:next': () => setFocusIndex(i => (i + 1) % 2),
      'select:previous': () => setFocusIndex(i => (i - 1 + 2) % 2),
      'select:accept': () => {
        if (focusIndex === 0) {
          startDaemon();
        } else {
          onCancel();
        }
      },
    },
    { context: 'Select' },
  );

  function startDaemon(): void {
    if (starting) return;
    setStarting(true);

    const dir = defaultDir || resolve('.');

    try {
      const launch = buildCliLaunch(['daemon', 'start', `--dir=${dir}`]);

      const child = spawnCli(launch, {
        cwd: dir,
        stdio: 'ignore',
        detached: true,
      });

      child.unref();

      child.on('error', err => {
        onError(`启动守护进程失败: ${err.message}`);
      });

      // 给守护进程一点时间初始化，然后报告成功。
      // 守护进程还需要几秒钟来注册桥接
      // 并创建一个 CCR 会话 — main.tsx 将提示用户重新连接。
      setTimeout(() => {
        onInstalled(dir);
      }, 1500);
    } catch (err) {
      onError(`启动守护进程失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (starting) {
    return (
      <Dialog title="助手设置" onCancel={onCancel} hideInputGuide>
        <Text>正在启动守护进程于{defaultDir}...</Text>
      </Dialog>
    );
  }

  return (
    <Dialog title="助手设置" onCancel={onCancel} hideInputGuide>
      <Box flexDirection="column" gap={1}>
        <Text>未找到活跃的助手会话。</Text>
        <Text>
          是否在<Text bold>{defaultDir || '.'}</Text> 中启动守护进程以创建云端会话？</Text>
        <Box flexDirection="column">
          <ListItem isFocused={focusIndex === 0}>
            <Text>启动助手守护进程</Text>
          </ListItem>
          <ListItem isFocused={focusIndex === 1}>
            <Text>Cancel</Text>
          </ListItem>
        </Box>
        <Text dimColor>回车键选择 · Esc 键取消</Text>
      </Box>
    </Dialog>
  );
}

/** * /assistant 命令的实现。
 *
 * 首次调用激活 KAIROS（设置 kairosActive，启用简要
 * 和主动工具）。后续调用切换助手面板的显示状态。 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  _args: string,
): Promise<React.ReactNode> {
  const { setAppState, getAppState } = context;

  // 首次调用：激活 KAIROS
  if (!getKairosActive()) {
    setKairosActive(true);
    setAppState(
      (prev: AppState) =>
        ({
          ...prev,
          kairosEnabled: true,
          assistantPanelVisible: true,
        }) as AppState,
    );
    onDone('KAIROS 助手模式已激活。', { display: 'system' });
    return null;
  }

  // 后续调用：切换面板可见性
  const current = getAppState();
  const isVisible = (current as Record<string, unknown>).assistantPanelVisible;

  if (isVisible) {
    setAppState(
      (prev: AppState) =>
        ({
          ...prev,
          assistantPanelVisible: false,
        }) as AppState,
    );
    onDone('助手面板已隐藏。', { display: 'system' });
  } else {
    setAppState(
      (prev: AppState) =>
        ({
          ...prev,
          assistantPanelVisible: true,
        }) as AppState,
    );
    onDone('助手面板已打开。', { display: 'system' });
  }

  return null;
}
