import chalk from 'chalk'
import { stat } from 'fs/promises'
import { dirname, resolve } from 'path'
import type { ToolPermissionContext } from '../../Tool.js'
import { getErrnoCode } from '../../utils/errors.js'
import { expandPath } from '../../utils/path.js'
import {
  allWorkingDirectories,
  pathInWorkingPath,
} from '../../utils/permissions/filesystem.js'

export type AddDirectoryResult =
  | {
      resultType: 'success'
      absolutePath: string
    }
  | {
      resultType: 'emptyPath'
    }
  | {
      resultType: 'pathNotFound' | 'notADirectory'
      directoryPath: string
      absolutePath: string
    }
  | {
      resultType: 'alreadyInWorkingDirectory'
      directoryPath: string
      workingDir: string
    }

export async function validateDirectoryForWorkspace(
  directoryPath: string,
  permissionContext: ToolPermissionContext,
): Promise<AddDirectoryResult> {
  if (!directoryPath) {
    return {
      resultType: 'emptyPath',
    }
  }

  // resolve() 会移除绝对路径末尾的斜杠，这可能是 expandPath 留下的
  // 因此 /foo 和 /foo/ 会映射到相同的存储键（CC-33）。
  const absolutePath = resolve(expandPath(directoryPath))

  // 检查路径是否存在且为目录（单次系统调用）
  try {
    const stats = await stat(absolutePath)
    if (!stats.isDirectory()) {
      return {
        resultType: 'notADirectory',
        directoryPath,
        absolutePath,
      }
    }
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    // 匹配先前 existsSync() 的语义：将以下任何情况视为“未找到”
    // 而不是重新抛出异常。特别是 EACCES/EPERM 不应导致
    // 当配置的附加目录无法访问时，启动过程崩溃。
    if (
      code === 'ENOENT' ||
      code === 'ENOTDIR' ||
      code === 'EACCES' ||
      code === 'EPERM'
    ) {
      return {
        resultType: 'pathNotFound',
        directoryPath,
        absolutePath,
      }
    }
    throw e
  }

  // 获取当前权限上下文
  const currentWorkingDirs = allWorkingDirectories(permissionContext)

  // 检查是否已在现有工作目录内
  for (const workingDir of currentWorkingDirs) {
    if (pathInWorkingPath(absolutePath, workingDir)) {
      return {
        resultType: 'alreadyInWorkingDirectory',
        directoryPath,
        workingDir,
      }
    }
  }

  return {
    resultType: 'success',
    absolutePath,
  }
}

export function addDirHelpMessage(result: AddDirectoryResult): string {
  switch (result.resultType) {
    case 'emptyPath':
      return '请提供一个目录路径。'
    case 'pathNotFound':
      return `未找到路径 ${chalk.bold(result.absolutePath)}。`
    case 'notADirectory': {
      const parentDir = dirname(result.absolutePath)
      return `${chalk.bold(result.directoryPath)} 不是目录。您是否想添加父目录 ${chalk.bold(parentDir)}？`
    }
    case 'alreadyInWorkingDirectory':
      return `${chalk.bold(result.directoryPath)} 已在现有工作目录 ${chalk.bold(result.workingDir)} 中可访问。`
    case 'success':
      return `已添加 ${chalk.bold(result.absolutePath)} 作为工作目录。`
  }
}
