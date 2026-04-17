// 消息中用于标记技能/命令元数据的 XML 标签名
export const COMMAND_NAME_TAG = 'command-name'
export const COMMAND_MESSAGE_TAG = 'command-message'
export const COMMAND_ARGS_TAG = 'command-args'

// 用户消息里终端/bash 输入与输出的 XML 标签名
// 用于包裹表示终端活动的内容，而非真实用户输入的提示
export const BASH_INPUT_TAG = 'bash-input'
export const BASH_STDOUT_TAG = 'bash-stdout'
export const BASH_STDERR_TAG = 'bash-stderr'
export const LOCAL_COMMAND_STDOUT_TAG = 'local-command-stdout'
export const LOCAL_COMMAND_STDERR_TAG = 'local-command-stderr'
export const LOCAL_COMMAND_CAVEAT_TAG = 'local-command-caveat'

// 表示「终端输出而非用户提示」的终端相关标签集合
export const TERMINAL_OUTPUT_TAGS = [
  BASH_INPUT_TAG,
  BASH_STDOUT_TAG,
  BASH_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
] as const

export const TICK_TAG = 'tick'

// 任务通知（后台任务完成）的 XML 标签名
export const TASK_NOTIFICATION_TAG = 'task-notification'
export const TASK_ID_TAG = 'task-id'
export const TOOL_USE_ID_TAG = 'tool-use-id'
export const TASK_TYPE_TAG = 'task-type'
export const OUTPUT_FILE_TAG = 'output-file'
export const STATUS_TAG = 'status'
export const SUMMARY_TAG = 'summary'
export const REASON_TAG = 'reason'
export const WORKTREE_TAG = 'worktree'
export const WORKTREE_PATH_TAG = 'worktreePath'
export const WORKTREE_BRANCH_TAG = 'worktreeBranch'

// ultraplan 模式（远程并行规划会话）的 XML 标签名
export const ULTRAPLAN_TAG = 'ultraplan'

// 远程 /review 结果的 XML 标签名（传送过来的审查会话输出）。
// 远程会话将最终审查包在此标签内；本地轮询器解析提取。
export const REMOTE_REVIEW_TAG = 'remote-review'

// run_hunt.sh 的心跳约每 10 秒将编排器的 progress.json 回显在此标签内。
// 本地轮询器解析最新内容用于任务状态行。
export const REMOTE_REVIEW_PROGRESS_TAG = 'remote-review-progress'

// 队友消息（群体智能体间通信）的 XML 标签名
export const TEAMMATE_MESSAGE_TAG = 'teammate-message'

// 外部频道消息的 XML 标签名
export const CHANNEL_MESSAGE_TAG = 'channel-message'
export const CHANNEL_TAG = 'channel'

// 跨会话 UDS 消息（另一 Claude 会话收件箱）的 XML 标签名
export const CROSS_SESSION_MESSAGE_TAG = 'cross-session-message'

// 包裹 fork 子进程首条消息中规则/格式模板的 XML 标签。
// 便于会话渲染器折叠模板，仅展示指令部分。
export const FORK_BOILERPLATE_TAG = 'fork-boilerplate'
// 指令正文前的固定前缀，由渲染器剥离。须与 buildChildMessage（生成）
// 及 UserForkBoilerplateMessage（解析）保持同步。
export const FORK_DIRECTIVE_PREFIX = '你的指令：'

// 斜杠命令中请求帮助的常见参数形式
export const COMMON_HELP_ARGS = ['help', '-h', '--help']

// 斜杠命令中请求当前状态/信息的常见参数形式
export const COMMON_INFO_ARGS = [
  'list',
  'show',
  'display',
  'current',
  'view',
  'get',
  'check',
  'describe',
  'print',
  'version',
  'about',
  'status',
  '?',
]
