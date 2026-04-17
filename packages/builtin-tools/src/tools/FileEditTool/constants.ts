// 为避免循环依赖，单独放在一个文件中
export const FILE_EDIT_TOOL_NAME = 'Edit'

// 授予会话级别访问项目 .claude/ 文件夹的权限模式
export const CLAUDE_FOLDER_PERMISSION_PATTERN = '/.claude/**'

// 授予会话级别访问全局 ~/.claude/ 文件夹的权限模式
export const GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN = '~/.claude/**'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  '文件已被意外修改。在尝试写入前请重新读取。'
