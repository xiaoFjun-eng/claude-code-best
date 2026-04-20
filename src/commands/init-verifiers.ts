import type { Command } from '../commands.js'

const command = {
  type: 'prompt',
  name: 'init-verifiers',
  description:
    '创建验证器技能，用于自动化验证代码变更',
  contentLength: 0, // 动态内容
  progressMessage: '正在分析您的项目并创建验证器技能',
  source: 'builtin',
  async getPromptForCommand() {
    return [
      {
        type: 'text',
        text: `使用 TodoWrite 工具来跟踪您在这个多步骤任务中的进度。

## 目标

创建一个或多个验证器技能，供 Verify 代理用于自动验证此项目或文件夹中的代码变更。如果项目有不同的验证需求（例如，同时有 Web UI 和 API 端点），您可以创建多个验证器。

**请勿为单元测试或类型检查创建验证器。** 这些已由标准的构建/测试工作流处理，不需要专门的验证器技能。请专注于功能验证：Web UI（Playwright）、CLI（Tmux）和 API（HTTP）验证器。

## 阶段 1：自动检测

分析项目以检测不同子目录中的内容。项目可能包含多个需要不同验证方法的子项目或区域（例如，一个仓库中包含 Web 前端、API 后端和共享库）。

1.  **扫描顶级目录**以识别不同的项目区域：
    -   查找子目录中独立的 package.json、Cargo.toml、pyproject.toml、go.mod 文件
    -   识别不同文件夹中的不同应用程序类型

2.  **对于每个区域，检测：**

    a.  **项目类型和技术栈**
        -   主要语言和框架
        -   包管理器（npm、yarn、pnpm、pip、cargo 等）

    b.  **应用程序类型**
        -   Web 应用（React、Next.js、Vue 等）→ 建议基于 Playwright 的验证器
        -   CLI 工具 → 建议基于 Tmux 的验证器
        -   API 服务（Express、FastAPI 等）→ 建议基于 HTTP 的验证器

    c.  **现有的验证工具**
        -   测试框架（Jest、Vitest、pytest 等）
        -   E2E 工具（Playwright、Cypress 等）
        -   package.json 中的开发服务器脚本

    d.  **开发服务器配置**
        -   如何启动开发服务器
        -   它运行在哪个 URL 上
        -   指示服务器已就绪的文本是什么

3.  **已安装的验证包**（针对 Web 应用）
    -   检查是否安装了 Playwright（查看 package.json 的 dependencies/devDependencies）
    -   检查 MCP 配置（.mcp.json）中的浏览器自动化工具：
        -   Playwright MCP 服务器
        -   Chrome DevTools MCP 服务器
        -   Claude Chrome 扩展 MCP（通过 Claude 的 Chrome 扩展进行浏览器使用）
    -   对于 Python 项目，检查 playwright、pytest-playwright

## 阶段 2：验证工具设置

根据阶段 1 检测到的内容，帮助用户设置合适的验证工具。

### 对于 Web 应用程序

1.  **如果浏览器自动化工具已安装/配置**，询问用户他们想使用哪一个：
    -   使用 AskUserQuestion 展示检测到的选项
    -   示例：“我发现已配置了 Playwright 和 Chrome DevTools MCP。您希望使用哪一个进行验证？”

2.  **如果未检测到浏览器自动化工具**，询问他们是否想要安装/配置一个：
    -   使用 AskUserQuestion：“未检测到浏览器自动化工具。您想为 UI 验证设置一个吗？”
    -   提供的选项：
        -   **Playwright**（推荐）- 完整的浏览器自动化库，支持无头模式，非常适合 CI
        -   **Chrome DevTools MCP** - 通过 MCP 使用 Chrome DevTools 协议
        -   **Claude Chrome 扩展** - 使用 Claude Chrome 扩展进行浏览器交互（需要在 Chrome 中安装该扩展）
        -   **无** - 跳过浏览器自动化（将仅使用基本的 HTTP 检查）

3.  **如果用户选择安装 Playwright**，根据包管理器运行相应的命令：
    -   对于 npm：\`npm install -D @playwright/test && npx playwright install\`
    -   对于 yarn：\`yarn add -D @playwright/test && yarn playwright install\`
    -   对于 pnpm：\`pnpm add -D @playwright/test && pnpm exec playwright install\`
    -   对于 bun：\`bun add -D @playwright/test && bun playwright install\`

4.  **如果用户选择 Chrome DevTools MCP 或 Claude Chrome 扩展**：
    -   这些需要配置 MCP 服务器，而不是安装包
    -   询问他们是否希望您将 MCP 服务器配置添加到 .mcp.json
    -   对于 Claude Chrome 扩展，告知他们需要从 Chrome 网上应用店安装该扩展

5.  **MCP 服务器设置**（如果适用）：
    -   如果用户选择了基于 MCP 的选项，在 .mcp.json 中配置相应的条目
    -   更新验证器技能的 allowed-tools 以使用适当的 mcp__* 工具

### 对于 CLI 工具

1.  检查 asciinema 是否可用（运行 \`which asciinema\`）
2.  如果不可用，告知用户 asciinema 可以帮助记录验证会话，但它是可选的
3.  Tmux 通常是系统安装的，只需验证其可用性

### 对于 API 服务

1.  检查 HTTP 测试工具是否可用：
    -   curl（通常系统已安装）
    -   httpie（\`http\` 命令）
2.  通常不需要安装

## 阶段 3：交互式问答

根据阶段 1 检测到的区域，您可能需要创建多个验证器。对于每个不同的区域，使用 AskUserQuestion 工具进行确认：

1.  **验证器名称** - 基于检测结果建议一个名称，但让用户选择：

    如果只有一个项目区域，使用简单格式：
    -   "verifier-playwright" 用于 Web UI 测试
    -   "verifier-cli" 用于 CLI/终端测试
    -   "verifier-api" 用于 HTTP API 测试

    如果有多个项目区域，使用格式 \`verifier-<project>-<type>\`：
    -   "verifier-frontend-playwright" 用于前端 Web UI
    -   "verifier-backend-api" 用于后端 API
    -   "verifier-admin-playwright" 用于管理仪表板

    \`<project>\` 部分应该是子目录或项目区域的简短标识符（例如，文件夹名或包名）。

    允许自定义名称，但名称中必须包含 "verifier" — Verify 代理通过查找文件夹名中的 "verifier" 来发现技能。

2.  **基于类型的项目特定问题**：

    对于 Web 应用（playwright）：
    -   开发服务器命令（例如，"npm run dev"）
    -   开发服务器 URL（例如，"http://localhost:3000"）
    -   就绪信号（服务器就绪时出现的文本）

    对于 CLI 工具：
    -   入口点命令（例如，"node ./cli.js" 或 "./target/debug/myapp"）
    -   是否使用 asciinema 录制

    对于 API：
    -   API 服务器命令
    -   基础 URL

3.  **身份验证与登录**（针对 Web 应用和 API）：

    使用 AskUserQuestion 询问：“您的应用是否需要身份验证/登录才能访问正在验证的页面或端点？”
    -   **无需身份验证** - 应用可公开访问，无需登录
    -   **是的，需要登录** - 应用需要身份验证才能继续验证
    -   **部分页面需要身份验证** - 公共路由和需要认证的路由混合

    如果用户选择需要登录（或部分需要），询问后续问题：
    -   **登录方法**：用户如何登录？
        -   基于表单的登录（登录页面上的用户名/密码）
        -   API 令牌/密钥（作为请求头或查询参数传递）
        -   OAuth/SSO（基于重定向的流程）
        -   其他（让用户描述）
    -   **测试凭据**：验证器应使用什么凭据？
        -   询问登录 URL（例如，"/login"、"http://localhost:3000/auth"）
        -   询问测试用户名/邮箱和密码，或 API 密钥
        -   注意：建议用户使用环境变量存储密钥（例如，\`TEST_USER\`、\`TEST_PASSWORD\`），而不是硬编码
    -   **登录后指示器**：如何确认登录成功？
        -   URL 重定向（例如，重定向到 "/dashboard"）
        -   元素出现（例如，"欢迎" 文本、用户头像）
        -   设置 Cookie/令牌

## 阶段 4：生成验证器技能

**所有验证器技能都创建在项目根目录的 \`.claude/skills/\` 目录中。** 这确保了当 Claude 在项目中运行时，它们会被自动加载。

将技能文件写入 \`.claude/skills/<verifier-name>/SKILL.md\`。

### 技能模板结构

\`\`\`markdown
---
name: <verifier-name>
description: <基于类型的描述>
allowed-tools:
  # 适合验证器类型的工具
---

# <验证器标题>

您是一个验证执行器。您接收一个验证计划并严格按照书面说明执行。

## 项目上下文
<来自检测的项目特定详细信息>

## 设置说明
<如何启动任何所需的服务>

## 身份验证
<如果需要身份验证，请在此处包含分步登录说明>
<包含登录 URL、凭据环境变量和登录后验证>
<如果不需要身份验证，请省略此部分>

## 报告

使用验证计划中指定的格式报告每个步骤的 PASS 或 FAIL。

## 清理

验证后：
1. 停止任何已启动的开发服务器
2. 关闭任何浏览器会话
3. 报告最终摘要

## 自我更新

如果验证失败是因为此技能的说明已过时（开发服务器命令/端口/就绪信号已更改等）——而不是因为被测试的功能损坏——或者如果用户在运行过程中纠正了您，请使用 AskUserQuestion 进行确认，然后使用最小的针对性修复来编辑此 SKILL.md。
\`\`\`

### 按类型划分的允许工具

**verifier-playwright**：
\`\`\`yaml
allowed-tools:
  - Bash(npm:*)
  - Bash(yarn:*)
  - Bash(pnpm:*)
  - Bash(bun:*)
  - mcp__playwright__*
  - Read
  - Glob
  - Grep
\`\`\`

**verifier-cli**：
\`\`\`yaml
allowed-tools:
  - Tmux
  - Bash(asciinema:*)
  - Read
  - Glob
  - Grep
\`\`\`

**verifier-api**：
\`\`\`yaml
allowed-tools:
  - Bash(curl:*)
  - Bash(http:*)
  - Bash(npm:*)
  - Bash(yarn:*)
  - Read
  - Glob
  - Grep
\`\`\`


## 阶段 5：确认创建

写入技能文件后，告知用户：
1.  每个技能创建的位置（始终在 \`.claude/skills/\` 中）
2.  Verify 代理将如何发现它们 — 文件夹名称必须包含 "verifier"（不区分大小写）才能自动发现
3.  他们可以编辑技能以进行自定义
4.  他们可以再次运行 /init-verifiers 来为其他区域添加更多验证器
5.  如果验证器检测到其自身说明已过时（错误的开发服务器命令、更改的就绪信号等），它将提供自我更新功能`,
      },
    ]
  },
} satisfies Command

export default command
