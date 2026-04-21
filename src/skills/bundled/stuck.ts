import { registerBundledSkill } from '../bundledSkills.js'

// 提示文本包含 `ps` 命令作为 Claude 运行的指令，而非本文件执行的命令。es
// lint-disable-next-li
// ne custom-rules/no-direct-ps-commands
const STUCK_PROMPT = `# /stuck — 诊断冻结/缓慢的 Claude Code 会话

用户认为本机上的另一个 Claude Code 会话已冻结、卡住或非常缓慢。请进行调查并将报告发布到 #claude-code-feedback 频道。

## 需要关注的现象

扫描其他 Claude Code 进程（排除当前进程 — PID 在 \`process.pid\` 中，但对于 shell 命令，只需排除你看到运行此提示的 PID）。进程名称通常是 \`claude\`（已安装版本）或 \`cli\`（原生开发构建版本）。

会话卡住的迹象：
- **持续高 CPU 使用率（≥90%）** — 可能是无限循环。请间隔 1-2 秒采样两次，以确认不是瞬时峰值。
- **进程状态为 \`D\`（不可中断睡眠）** — 通常是 I/O 挂起。注意 \`ps\` 输出中的 \`state\` 列；第一个字符是关键（忽略修饰符如 \`+\`、\`s\`、\`<\`）。
- **进程状态为 \`T\`（已停止）** — 用户可能意外按下了 Ctrl+Z。
- **进程状态为 \`Z\`（僵尸进程）** — 父进程未回收。
- **极高的 RSS（≥4GB）** — 可能存在内存泄漏，导致会话迟缓。
- **卡住的子进程** — 挂起的 \`git\`、\`node\` 或 shell 子进程可能导致父进程冻结。使用 \`pgrep -lP <pid>\` 检查每个会话。

## 调查步骤

1. **列出所有 Claude Code 进程**（macOS/Linux）：
   \`\`\`
   ps -axo pid=,pcpu=,rss=,etime=,state=,comm=,command= | grep -E '(claude|cli)' | grep -v grep
   \`\`\`
   筛选出 \`comm\` 为 \`claude\` 或（\`cli\` 且命令路径包含 "claude"）的行。

2. **对于任何可疑进程**，收集更多上下文：
   - 子进程：\`pgrep -lP <pid>\`
   - 如果 CPU 使用率高：1-2 秒后再次采样以确认是否持续
   - 如果某个子进程看起来挂起（例如 git 命令），使用 \`ps -p <child_pid> -o command=\` 记录其完整命令行
   - 如果可以推断出会话 ID，请检查该会话的调试日志：\`~/.claude/debug/<session-id>.txt\`（最后几百行通常显示挂起前的操作）

3. **对于真正冻结的进程，考虑进行堆栈转储**（高级，可选）：
   - macOS：\`sample <pid> 3\` 提供 3 秒的原生堆栈样本
   - 此操作输出较大 — 仅在进程明显挂起且你想知道*原因*时获取

## 报告

**仅在确实发现卡住进程时才发布到 Slack。** 如果所有会话看起来都正常，请直接告知用户 — 不要在频道中发布“一切正常”的消息。

如果确实发现卡住/缓慢的会话，请使用 Slack MCP 工具发布到 **#claude-code-feedback**（频道 ID：\`C07VBSHV7EV\`）。如果尚未加载，请使用 ToolSearch 查找 \`slack_send_message\`。

**使用两段式消息结构**以保持频道内容易于浏览：

1. **顶层消息** — 简短一行：主机名、Claude Code 版本和简要症状（例如“会话 PID 12345 在 10 分钟内 CPU 占用率高达 100%”或“git 子进程在 D 状态挂起”）。不要使用代码块，不要包含细节。
2. **线程回复** — 完整的诊断转储。将顶层消息的 \`ts\` 作为 \`thread_ts\` 传入。包括：
   - PID、CPU%、RSS、状态、运行时间、命令行、子进程
   - 你对可能问题的诊断
   - 如果已捕获，相关的调试日志尾部或 \`sample\` 输出

如果 Slack MCP 不可用，请将报告格式化为用户可以复制粘贴到 #claude-code-feedback 的消息（并告知他们自行将详细信息发布到线程中）。

## 注意事项
- 不要终止或向任何进程发送信号 — 此操作仅为诊断目的。
- 如果用户提供了参数（例如特定的 PID 或症状），请首先关注该处。`

export function registerStuckSkill(): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  registerBundledSkill({
    name: 'stuck',
    description:
      '[仅限 ANT] 调查本机上冻结/卡住/缓慢的 Claude Code 会话，并将诊断报告发布到 #claude-code-feedback。',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = STUCK_PROMPT
      if (args) {
        prompt += `
## 用户提供的上下文

${args}
`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
