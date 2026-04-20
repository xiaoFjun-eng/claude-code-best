import { type ChildProcess } from 'child_process';
import { resolve } from 'path';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { getBridgeDisabledReason, isBridgeEnabled } from '../../bridge/bridgeEnabled.js';
import { getBridgeAccessToken } from '../../bridge/bridgeConfig.js';
import { BRIDGE_LOGIN_INSTRUCTION } from '../../bridge/types.js';
import { Dialog } from '../../components/design-system/Dialog.js';
import { ListItem } from '../../components/design-system/ListItem.js';
import { useRegisterOverlay } from '../../context/overlayContext.js';
import { Box, Text } from '@anthropic/ink';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import { buildCliLaunch, spawnCli } from '../../utils/cliLaunch.js';
import type { ToolUseContext } from '../../Tool.js';
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js';
import { errorMessage } from '../../utils/errors.js';

type ServerStatus = 'stopped' | 'starting' | 'running' | 'error';

type Props = {
  onDone: LocalJSXCommandOnDone;
};

/** /remote-control-server 命令 — 管理由守护进程支持的持久化桥接服务器。

调用时，它会启动守护进程监管器作为子进程，该监管器进而生成运行无头桥接循环的 remoteControl 工作进程。服务器接受多个并发远程会话。

如果服务器已在运行，则显示一个管理对话框，其中包含状态信息以及停止或继续的选项。 */

// 模块级状态，用于在多次调用间跟踪守护进程
let daemonProcess: ChildProcess | null = null;
let daemonStatus: ServerStatus = 'stopped';
let daemonLogs: string[] = [];
const MAX_LOG_LINES = 50;

function RemoteControlServer({ onDone }: Props): React.ReactNode {
  const [status, setStatus] = useState<ServerStatus>(daemonStatus);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 如果已在运行，则显示管理对话框
    if (daemonProcess && !daemonProcess.killed) {
      setStatus('running');
      return;
    }

    let cancelled = false;
    void (async () => {
      // 启动前检查
      const checkError = await checkPrerequisites();
      if (cancelled) return;
      if (checkError) {
        onDone(checkError, { display: 'system' });
        return;
      }

      // 启动守护进程
      setStatus('starting');
      try {
        startDaemon();
        if (!cancelled) {
          setStatus('running');
          daemonStatus = 'running';
          onDone('远程控制服务器已启动。使用 /remote-control-server 进行管理。', { display: 'system' });
        }
      } catch (err) {
        if (!cancelled) {
          const msg = errorMessage(err);
          setStatus('error');
          setError(msg);
          daemonStatus = 'error';
          onDone(`远程控制服务器启动失败: ${msg}`, {
            display: 'system',
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (status === 'running' && daemonProcess && !daemonProcess.killed) {
    return <ServerManagementDialog onDone={onDone} />;
  }

  if (status === 'error' && error) {
    return null;
  }

  return null;
}

/** 当守护进程运行时使用 /remote-control-server 命令时显示的对话框。 */
function ServerManagementDialog({ onDone }: Props): React.ReactNode {
  useRegisterOverlay('remote-control-server-dialog');
  const [focusIndex, setFocusIndex] = useState(2);

  const logPreview = daemonLogs.slice(-5);

  function handleStop(): void {
    stopDaemon();
    onDone('远程控制服务器已停止。', { display: 'system' });
  }

  function handleRestart(): void {
    stopDaemon();
    try {
      startDaemon();
      onDone('远程控制服务器已重启。', { display: 'system' });
    } catch (err) {
      onDone(`重启失败: ${errorMessage(err)}`, { display: 'system' });
    }
  }

  function handleContinue(): void {
    onDone(undefined, { display: 'skip' });
  }

  const ITEM_COUNT = 3;

  useKeybindings(
    {
      'select:next': () => setFocusIndex(i => (i + 1) % ITEM_COUNT),
      'select:previous': () => setFocusIndex(i => (i - 1 + ITEM_COUNT) % ITEM_COUNT),
      'select:accept': () => {
        if (focusIndex === 0) {
          handleStop();
        } else if (focusIndex === 1) {
          handleRestart();
        } else {
          handleContinue();
        }
      },
    },
    { context: 'Select' },
  );

  return (
    <Dialog title="远程控制服务器" onCancel={handleContinue} hideInputGuide>
      <Box flexDirection="column" gap={1}>
        <Text>
          远程控制服务器{' '}
          <Text bold color="success">
            running
          </Text>
          {daemonProcess ? ` (PID: ${daemonProcess.pid})` : ''}
        </Text>
        {logPreview.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>最近日志:</Text>
            {logPreview.map((line, i) => (
              <Text key={i} dimColor>
                {line}
              </Text>
            ))}
          </Box>
        )}
        <Box flexDirection="column">
          <ListItem isFocused={focusIndex === 0}>
            <Text>停止服务器</Text>
          </ListItem>
          <ListItem isFocused={focusIndex === 1}>
            <Text>重启服务器</Text>
          </ListItem>
          <ListItem isFocused={focusIndex === 2}>
            <Text>Continue</Text>
          </ListItem>
        </Box>
        <Text dimColor>按 Enter 键选择 · 按 Esc 键继续</Text>
      </Box>
    </Dialog>
  );
}

/** 检查启动远程控制服务器的先决条件。 */
async function checkPrerequisites(): Promise<string | null> {
  const disabledReason = await getBridgeDisabledReason();
  if (disabledReason) {
    return disabledReason;
  }

  if (!getBridgeAccessToken()) {
    return BRIDGE_LOGIN_INSTRUCTION;
  }

  return null;
}

/** 将守护进程监管器作为子进程启动。 */
function startDaemon(): void {
  const dir = resolve('.');

  const launch = buildCliLaunch(['daemon', 'start', `--dir=${dir}`]);

  const child = spawnCli(launch, {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  daemonProcess = child;
  daemonLogs = [];

  child.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().trimEnd().split('\n');
    for (const line of lines) {
      daemonLogs.push(line);
      if (daemonLogs.length > MAX_LOG_LINES) {
        daemonLogs.shift();
      }
    }
  });

  child.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().trimEnd().split('\n');
    for (const line of lines) {
      daemonLogs.push(`[err] ${line}`);
      if (daemonLogs.length > MAX_LOG_LINES) {
        daemonLogs.shift();
      }
    }
  });

  child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    daemonProcess = null;
    daemonStatus = 'stopped';
    daemonLogs.push(`[daemon] 已退出 (code=${code ?? 'unknown'}, signal=${signal})`);
  });

  child.on('error', (err: Error) => {
    daemonProcess = null;
    daemonStatus = 'error';
    daemonLogs.push(`[daemon] 错误: ${err.message}`);
  });
}

/** 停止守护进程监管器。 */
function stopDaemon(): void {
  if (daemonProcess && !daemonProcess.killed) {
    daemonProcess.kill('SIGTERM');
    // 10秒宽限期后强制终止
    const pid = daemonProcess.pid;
    setTimeout(() => {
      try {
        if (pid) process.kill(pid, 0); // 检查是否仍在运行
        if (daemonProcess && !daemonProcess.killed) {
          daemonProcess.kill('SIGKILL');
        }
      } catch {
        // 进程已终止
      }
    }, 10_000);
  }
  daemonProcess = null;
  daemonStatus = 'stopped';
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: ToolUseContext & LocalJSXCommandContext,
  _args: string,
): Promise<React.ReactNode> {
  return <RemoteControlServer onDone={onDone} />;
}
