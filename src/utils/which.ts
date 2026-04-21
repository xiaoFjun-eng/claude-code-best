import { execa } from 'execa'
import { execSync_DEPRECATED } from './execSyncWrapper.js'

async function whichNodeAsync(command: string): Promise<string | null> {
  if (process.platform === 'win32') {
    // 在 Windows 上，使用 where.exe 并返回第一个结果
    const result = await execa(`where.exe ${command}`, {
      shell: true,
      stderr: 'ignore',
      reject: false,
    })
    if (result.exitCode !== 0 || !result.stdout) {
      return null
    }
    // where.exe 返回多个以换行符分隔的路径，返回第一个
    return result.stdout.trim().split(/\r?\n/)[0] || null
  }

  // 在 POSIX 系统（macOS、Linux、WSL）上，使用 which
  // 跨平台安全：Windows 已在上面处理 eslint-disable
  // -next-line custom-rules/no-cross-platform-process-issues
  const result = await execa(`which ${command}`, {
    shell: true,
    stderr: 'ignore',
    reject: false,
  })
  if (result.exitCode !== 0 || !result.stdout) {
    return null
  }
  return result.stdout.trim()
}

function whichNodeSync(command: string): string | null {
  if (process.platform === 'win32') {
    try {
      const result = execSync_DEPRECATED(`where.exe ${command}`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const output = result.toString().trim()
      return output.split(/\r?\n/)[0] || null
    } catch {
      return null
    }
  }

  try {
    const result = execSync_DEPRECATED(`which ${command}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return result.toString().trim() || null
  } catch {
    return null
  }
}

const bunWhich =
  typeof Bun !== 'undefined' && typeof Bun.which === 'function'
    ? Bun.which
    : null

/** 查找命令可执行文件的完整路径。
在 Bun 环境中运行时使用 Bun.which（快速，无需生成进程），
否则生成适合平台的命令。

@param command - 要查找的命令名称
@returns 命令的完整路径，如果未找到则返回 null */
export const which: (command: string) => Promise<string | null> = bunWhich
  ? async command => bunWhich(command)
  : whichNodeAsync

/** `which` 的同步版本。

@param command - 要查找的命令名称
@returns 命令的完整路径，如果未找到则返回 null */
export const whichSync: (command: string) => string | null =
  bunWhich ?? whichNodeSync
