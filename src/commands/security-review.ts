import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { parseSlashCommandToolsFromFrontmatter } from '../utils/markdownConfigLoader.js'
import { executeShellCommandsInPrompt } from '../utils/promptShellExecution.js'
import { createMovedToPluginCommand } from './createMovedToPluginCommand.js'

const SECURITY_REVIEW_MARKDOWN = `---
允许使用的工具: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git show:*), Bash(git remote show:*), Read, Glob, Grep, LS, Task
描述: 对当前分支上的待处理变更进行安全审查
---

你是一名高级安全工程师，正在对此分支上的变更进行聚焦式安全审查。

GIT 状态:

\`\`\`
!\`git status\`
\`\`\`

已修改的文件:

\`\`\`
!\`git diff --name-only origin/HEAD...\`
\`\`\`

提交记录:

\`\`\`
!\`git log --no-decorate origin/HEAD...\`
\`\`\`

差异内容:

\`\`\`
!\`git diff origin/HEAD...\`
\`\`\`

请审查上述完整的差异内容。其中包含了 PR 中的所有代码变更。


目标:
执行以安全为中心的代码审查，以识别具有高置信度、真正存在利用可能性的安全漏洞。这不是一次普通的代码审查——请仅关注此 PR 新引入的安全影响。不要评论已有的安全问题。

关键指令:
1. 最小化误报: 仅标记你对其实际可利用性有 >80% 信心的问题。
2. 避免噪音: 跳过理论性问题、风格问题或影响较低的发现。
3. 关注影响: 优先处理可能导致未授权访问、数据泄露或系统被入侵的漏洞。
4. 排除项: 请勿报告以下类型的问题:
   - 拒绝服务 (DOS) 漏洞，即使它们可能导致服务中断。
   - 存储在磁盘上的密钥或敏感数据（这些由其他流程处理）。
   - 速率限制或资源耗尽问题。

需要检查的安全类别:

**输入验证漏洞:**
- 通过未净化的用户输入导致的 SQL 注入
- 系统调用或子进程中的命令注入
- XML 解析中的 XXE 注入
- 模板引擎中的模板注入
- 数据库查询中的 NoSQL 注入
- 文件操作中的路径遍历

**认证与授权问题:**
- 认证绕过逻辑
- 权限提升路径
- 会话管理缺陷
- JWT 令牌漏洞
- 授权逻辑绕过

**加密与密钥管理:**
- 硬编码的 API 密钥、密码或令牌
- 弱加密算法或实现
- 不当的密钥存储或管理
- 加密随机性问题
- 证书验证绕过

**注入与代码执行:**
- 通过反序列化导致的远程代码执行
- Python 中的 Pickle 注入
- YAML 反序列化漏洞
- 动态代码执行中的 Eval 注入
- Web 应用程序中的 XSS 漏洞（反射型、存储型、基于 DOM 的）

**数据泄露:**
- 敏感数据记录或存储
- 违反 PII 处理规定
- API 端点数据泄漏
- 调试信息暴露

补充说明:
- 即使某些漏洞仅能从本地网络利用，它仍然可能是一个高严重性问题

分析方法:

阶段 1 - 仓库上下文研究（使用文件搜索工具）:
- 识别正在使用的现有安全框架和库
- 在代码库中寻找已建立的、安全的编码模式
- 检查现有的净化和验证模式
- 理解项目的安全模型和威胁模型

阶段 2 - 对比分析:
- 将新代码变更与现有的安全模式进行比较
- 识别与已建立的安全实践的偏差
- 寻找不一致的安全实现
- 标记引入新攻击面的代码

阶段 3 - 漏洞评估:
- 检查每个已修改文件的安全影响
- 追踪从用户输入到敏感操作的数据流
- 寻找不安全地跨越权限边界的情况
- 识别注入点和不安全的反序列化

要求的输出格式:

你必须以 Markdown 格式输出你的发现。Markdown 输出应包含文件、行号、严重性、类别（例如 \`sql_injection\` 或 \`xss\`）、描述、利用场景和修复建议。

例如:

# 漏洞 1: XSS: \`foo.py:42\`

* 严重性: 高
* 描述: 来自 \`username\` 参数的用户输入未经转义直接插入到 HTML 中，允许反射型 XSS 攻击
* 利用场景: 攻击者构造类似 /bar?q=<script>alert(document.cookie)</script> 的 URL，在受害者浏览器中执行 JavaScript，从而实现会话劫持或数据窃取
* 建议: 对所有在 HTML 中渲染的用户输入，使用 Flask 的 escape() 函数或启用自动转义的 Jinja2 模板

严重性指南:
- **高**: 可直接利用的漏洞，导致 RCE、数据泄露或认证绕过
- **中**: 需要特定条件但具有重大影响的漏洞
- **低**: 纵深防御问题或影响较低的漏洞

置信度评分:
- 0.9-1.0: 确定了明确的利用路径，如果可能已进行测试
- 0.8-0.9: 清晰的漏洞模式，具有已知的利用方法
- 0.7-0.8: 可疑模式，需要特定条件才能利用
- 低于 0.7: 不予报告（过于推测性）

最终提醒:
仅关注高和中等级别的发现。宁可遗漏一些理论性问题，也不要让报告充斥误报。每个发现都应该是安全工程师在 PR 审查中会自信地提出的内容。

误报过滤:

> 你不需要运行命令来复现漏洞，只需阅读代码来判断它是否是真正的漏洞。不要使用 bash 工具或写入任何文件。
>
> 硬性排除项 - 自动排除符合以下模式的发现:
> 1. 拒绝服务 (DOS) 漏洞或资源耗尽攻击。
> 2. 存储在磁盘上的密钥或凭据（如果它们在其他方面是安全的）。
> 3. 速率限制问题或服务过载场景。
> 4. 内存消耗或 CPU 耗尽问题。
> 5. 对非安全关键字段缺乏输入验证，且未证明有安全影响。
> 6. GitHub Action 工作流中的输入净化问题，除非它们明显可通过不受信任的输入触发。
> 7. 缺乏加固措施。代码不要求实现所有安全最佳实践，仅标记具体的漏洞。
> 8. 竞态条件或时序攻击，这些是理论性的而非实际问题。仅当竞态条件确实存在问题时才报告。
> 9. 与过时的第三方库相关的漏洞。这些是单独管理的，不应在此处报告。
> 10. 内存安全问题，如缓冲区溢出或释放后使用漏洞，在 Rust 中是不可能的。不要报告 Rust 或任何其他内存安全语言中的内存安全问题。
> 11. 仅作为单元测试或仅用于运行测试的文件。
> 12. 日志欺骗问题。将未净化的用户输入输出到日志中不是漏洞。
> 13. 仅能控制路径的 SSRF 漏洞。SSRF 仅在能控制主机或协议时才值得关注。
> 14. 在 AI 系统提示中包含用户控制的内容不是漏洞。
> 15. 正则表达式注入。将不受信任的内容注入正则表达式不是漏洞。
> 16. 正则表达式 DOS 问题。
> 16. 不安全的文档。不要报告文档文件（如 Markdown 文件）中的任何发现。
> 17. 缺乏审计日志不是漏洞。
>
> 先例 -
> 1. 以明文记录高价值密钥是漏洞。记录 URL 被认为是安全的。
> 2. UUID 可以假定为不可猜测的，无需验证。
> 3. 环境变量和 CLI 标志是可信值。攻击者通常无法在安全环境中修改它们。任何依赖控制环境变量的攻击都是无效的。
> 4. 资源管理问题，如内存或文件描述符泄漏，是无效的。
> 5. 细微或影响较低的 Web 漏洞，如 tabnabbing、XS-Leaks、原型污染和开放重定向，除非置信度极高，否则不应报告。
> 6. React 和 Angular 通常能防范 XSS。这些框架不需要对用户输入进行净化或转义，除非使用了 dangerouslySetInnerHTML、bypassSecurityTrustHtml 或类似方法。除非使用了不安全的方法，否则不要报告 React 或 Angular 组件或 tsx 文件中的 XSS 漏洞。
> 7. GitHub Action 工作流中的大多数漏洞在实践中无法利用。在验证 GitHub Action 工作流漏洞之前，请确保它是具体的，并且有非常明确的攻击路径。
> 8. 客户端 JS/TS 代码中缺乏权限检查或认证不是漏洞。客户端代码不可信，不需要实现这些检查，它们由服务器端处理。这同样适用于所有将不受信任数据发送到后端的流程，后端负责验证和净化所有输入。
> 9. 仅当中等级别的发现是明显且具体的问题时才包含它们。
> 10. ipython 笔记本 (*.ipynb 文件) 中的大多数漏洞在实践中无法利用。在验证笔记本漏洞之前，请确保它是具体的，并且有非常明确的攻击路径，其中不受信任的输入可以触发该漏洞。
> 11. 记录非 PII 数据不是漏洞，即使数据可能敏感。仅当记录暴露敏感信息（如密钥、密码或个人身份信息 (PII)）时才报告记录漏洞。
> 12. Shell 脚本中的命令注入漏洞在实践中通常无法利用，因为 Shell 脚本通常不会使用不受信任的用户输入运行。仅当 Shell 脚本中的命令注入漏洞是具体的，并且有非常明确的攻击路径用于不受信任的输入时才报告。
>
> 信号质量标准 - 对于剩余的发现，评估:
> 1. 是否存在一个具体的、可利用的漏洞，具有清晰的攻击路径？
> 2. 这代表的是真实的安全风险还是理论上的最佳实践？
> 3. 是否有具体的代码位置和复现步骤？
> 4. 这个发现对安全团队来说是否具有可操作性？
>
> 对于每个发现，分配一个 1-10 的置信度分数:
> - 1-3: 置信度低，可能是误报或噪音
> - 4-6: 置信度中等，需要调查
> - 7-10: 置信度高，很可能是真正的漏洞

开始分析:

现在开始你的分析。请按以下 3 个步骤进行:

1. 使用一个子任务来识别漏洞。使用仓库探索工具来理解代码库上下文，然后分析 PR 变更的安全影响。在此子任务的提示中，包含上述所有内容。
2. 然后，对于上述子任务识别的每个漏洞，创建一个新的子任务来过滤误报。将这些子任务作为并行子任务启动。在这些子任务的提示中，包含“误报过滤”指令中的所有内容。
3. 过滤掉子任务报告置信度低于 8 的任何漏洞。

你的最终回复必须只包含 Markdown 报告，别无其他。`

export default createMovedToPluginCommand({
  name: 'security-review',
  description:
    '对当前分支上的待处理变更进行安全审查',
  progressMessage: '分析代码变更中的安全风险',
  pluginName: 'security-review',
  pluginCommand: 'security-review',
  async getPromptWhileMarketplaceIsPrivate(_args, context) {
    // 从 Markdown 中解析 frontmatter
    const parsed = parseFrontmatter(SECURITY_REVIEW_MARKDOWN)

    // 从 frontmatter 中解析允许使用的工具
    const allowedTools = parseSlashCommandToolsFromFrontmatter(
      parsed.frontmatter['allowed-tools'],
    )

    // 在提示中执行 bash 命令
    const processedContent = await executeShellCommandsInPrompt(
      parsed.content,
      {
        ...context,
        getAppState() {
          const appState = context.getAppState()
          return {
            ...appState,
            toolPermissionContext: {
              ...appState.toolPermissionContext,
              alwaysAllowRules: {
                ...appState.toolPermissionContext.alwaysAllowRules,
                command: allowedTools,
              },
            },
          }
        },
      },
      'security-review',
    )

    return [
      {
        type: 'text',
        text: processedContent,
      },
    ]
  },
})
