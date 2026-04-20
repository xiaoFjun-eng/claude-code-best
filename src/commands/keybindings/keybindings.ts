import { mkdir, writeFile } from 'fs/promises'
import { dirname } from 'path'
import {
  getKeybindingsPath,
  isKeybindingCustomizationEnabled,
} from '../../keybindings/loadUserBindings.js'
import { generateKeybindingsTemplate } from '../../keybindings/template.js'
import { getErrnoCode } from '../../utils/errors.js'
import { editFileInEditor } from '../../utils/promptEditor.js'

export async function call(): Promise<{ type: 'text'; value: string }> {
  if (!isKeybindingCustomizationEnabled()) {
    return {
      type: 'text',
      value:
        '按键绑定自定义功能未启用。此功能目前处于预览阶段。',
    }
  }

  const keybindingsPath = getKeybindingsPath()

  // 使用 'wx' 标志（独占创建）写入模板 — 如果文件已存在，则失败并返回
  // EEXIST。避免 stat 预检查（TOCTOU 竞态条件 + 额外的系统调用）。
  let fileExists = false
  await mkdir(dirname(keybindingsPath), { recursive: true })
  try {
    await writeFile(keybindingsPath, generateKeybindingsTemplate(), {
      encoding: 'utf-8',
      flag: 'wx',
    })
  } catch (e: unknown) {
    if (getErrnoCode(e) === 'EEXIST') {
      fileExists = true
    } else {
      throw e
    }
  }

  // 在编辑器中打开
  const result = await editFileInEditor(keybindingsPath)
  if (result.error) {
    return {
      type: 'text',
      value: `${fileExists ? 'Opened' : 'Created'} ${keybindingsPath}。无法在编辑器中打开：${result.error}`,
    }
  }
  return {
    type: 'text',
    value: fileExists
      ? `已在您的编辑器中打开 ${keybindingsPath}。`
      : `已使用模板创建 ${keybindingsPath}。已在您的编辑器中打开。`,
  }
}
