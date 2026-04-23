# CLAUDE.md

此文件为在此代码仓库中工作的 Claude Code（claude.ai/code）提供指导。

## 项目概述

这是 Anthropic 官方 Claude Code CLI 工具的**逆向工程/反编译**版本。目标是恢复核心功能，同时精简次要能力。许多模块是桩代码或通过功能开关关闭。TypeScript 严格模式已启用（见“使用此代码库”部分的 tsc 要求）。

## Git 提交信息规范

使用 **Conventional Commits** 规范：

```
<类型>: <描述>
```

常见类型：`feat`、`fix`、`docs`、`chore`、`refactor`

示例：
- `feat: 添加模型 1M 上下文切换`
- `fix: 修复初次登陆的校验问题`
- `chore: remove prefetchOfficialMcpUrls call on startup`

## 命令

```bash
# 安装依赖
bun install

# 开发模式（运行 cli.tsx，并通过 -d 标志注入 MACRO 定义）
bun run dev

# 带调试器的开发模式（设置 BUN_INSPECT=9229 以指定端口）
bun run dev:inspect

# 管道模式
echo "say hello" | bun run src/entrypoints/cli.tsx -p

# 构建（代码拆分，输出 dist/cli.js + 分块文件）
bun run build

# 使用 Vite 构建（备用构建流程）
bun run build:vite

# 测试
bun test                  # 运行所有测试（3175 个测试 / 207 个文件 / 0 失败）
bun test src/utils/__tests__/hash.test.ts   # 运行单个文件
bun test --coverage       # 附带覆盖率报告

# 代码检查与格式化（Biome）
bun run lint              # 仅检查
bun run lint:fix          # 自动修复
bun run format            # 格式化所有 src/

# 健康检查
bun run health

# 检查未使用的导出
bun run check:unused

# 完整检查（类型检查 + 代码检查 + 测试）—— 完成任何任务后运行
bun run test:all

bun run typecheck

# 远程控制服务器
bun run rcs

# 文档开发服务器（Mintlify）
bun run docs:dev
```

详细的测试规范、覆盖状态和改进计划见 `docs/testing-spec.md`。

## 架构

### 运行时与构建

- **运行时**: Bun（不是 Node.js）。所有导入、构建和执行都使用 Bun API。
- **构建**: `build.ts` 执行 `Bun.build()` 并设置 `splitting: true`，入口点为 `src/entrypoints/cli.tsx`，输出 `dist/cli.js` 和分块文件。构建默认启用 19 个功能（见下方“功能开关”部分）。构建后自动将 `import.meta.require` 替换为 Node.js 兼容版本（产物可在 bun/node 下运行）。
- **开发模式**: `scripts/dev.ts` 通过 Bun `-d` 标志注入 `MACRO.*` 定义，运行 `src/entrypoints/cli.tsx`。默认启用全部功能。
- **模块系统**: ESM（`"type": "module"`），TSX 使用 `react-jsx` 转换。
- **Monorepo**: Bun workspaces — 15 个 workspace 包 + `packages/` 中通过 `workspace:*` 解析的若干辅助目录。
- **代码检查/格式化**: Biome（`biome.json`）。`bun run lint` / `bun run lint:fix` / `bun run format`。
- **定义**: 集中管理在 `scripts/defines.ts`。当前版本 `2.1.888`。
- **CI**: GitHub Actions — `ci.yml`（构建+测试）、`release-rcs.yml`（RCS 发布）、`update-contributors.yml`（自动更新贡献者）。

### 入口与启动

1. **`src/entrypoints/cli.tsx`**（373 行）— 真正的入口点。`main()` 函数按优先级处理多条快速路径：
   - `--version` / `-v` — 零模块加载
   - `--dump-system-prompt` — 功能开关控制（DUMP_SYSTEM_PROMPT）
   - `--claude-in-chrome-mcp` / `--chrome-native-host`
   - `--computer-use-mcp` — 独立 MCP 服务器模式
   - `--daemon-worker=<kind>` — 功能开关控制（DAEMON）
   - `remote-control` / `rc` / `remote` / `sync` / `bridge` — 功能开关控制（BRIDGE_MODE）
   - `daemon [子命令]` — 功能开关控制（DAEMON）
   - `ps` / `logs` / `attach` / `kill` / `--bg` — 功能开关控制（BG_SESSIONS）
   - `new` / `list` / `reply` — 模板任务命令
   - `environment-runner` / `self-hosted-runner` — BYOC runner
   - `--tmux` + `--worktree` 组合
   - 默认路径：加载 `main.tsx` 启动完整 CLI
2. **`src/main.tsx`**（约 6981 行）— Commander.js CLI 定义。注册大量子命令：`mcp`（serve/add/remove/list...）、`server`、`ssh`、`open`、`auth`、`plugin`、`agents`、`auto-mode`、`doctor`、`update` 等。主 `.action()` 处理器负责权限、MCP、会话恢复、REPL/无头模式分发。
3. **`src/entrypoints/init.ts`** — 一次性初始化（遥测、配置、信任对话框）。

### 核心循环

- **`src/query.ts`** — 主要的 API 查询函数。向 Claude API 发送消息，处理流式响应，执行工具调用，管理对话轮次循环。
- **`src/QueryEngine.ts`** — 封装 `query()` 的高层编排器。管理对话状态、压缩、文件历史快照、归属信息和轮次级记账。由 REPL 屏幕使用。
- **`src/screens/REPL.tsx`** — 交互式 REPL 屏幕（React/Ink 组件）。处理用户输入、消息显示、工具权限提示和键盘快捷键。

### API 层

- **`src/services/api/claude.ts`** — 核心 API 客户端。构建请求参数（系统提示、消息、工具、betas），调用 Anthropic SDK 流式端点，处理 `BetaRawMessageStreamEvent` 事件。
- **7 个提供者**: `firstParty`（Anthropic 直连）、`bedrock`（AWS）、`vertex`（Google Cloud）、`foundry`、`openai`、`gemini`、`grok`（xAI）。
- 提供者选择在 `src/utils/model/providers.ts` 中。优先级：modelType 参数 > 环境变量 > 默认 firstParty。

### 工具系统

- **`src/Tool.ts`** — 工具接口定义（`Tool` 类型）和实用函数（`findToolByName`、`toolMatchesName`）。
- **`src/tools.ts`**（392 行）— 工具注册表。组装工具列表；工具从 `@claude-code-best/builtin-tools` 包导入。部分工具通过 `feature()` 标志或 `process.env.USER_TYPE` 条件加载。
- **`packages/builtin-tools/src/tools/`** — 59 个子目录（含 shared/testing 等工具目录），通过 `@claude-code-best/builtin-tools` 包导出。主要分类：
  - **文件操作**: FileEditTool、FileReadTool、FileWriteTool、GlobTool、GrepTool
  - **Shell/执行**: BashTool、PowerShellTool、REPLTool
  - **代理系统**: AgentTool、TaskCreateTool、TaskUpdateTool、TaskListTool、TaskGetTool
  - **规划**: EnterPlanModeTool、ExitPlanModeV2Tool、VerifyPlanExecutionTool
  - **Web/MCP**: WebFetchTool、WebSearchTool、MCPTool、McpAuthTool
  - **调度**: CronCreateTool、CronDeleteTool、CronListTool
  - **其他**: LSPTool、ConfigTool、SkillTool、EnterWorktreeTool、ExitWorktreeTool 等

### UI 层（Ink）

- **`src/ink.ts`** — 带有 ThemeProvider 注入的 Ink 渲染包装器。
- **`packages/@ant/ink/`** — 自定义 Ink 框架（forked/internal），包含 components、core、hooks、keybindings、theme、utils。注意：不是 `src/ink/`。
- **`src/components/`** — 149 个组件目录/文件，在终端 Ink 环境中渲染。关键组件：
  - `App.tsx` — 根提供者（AppState、Stats、FpsMetrics）
  - `Messages.tsx` / `MessageRow.tsx` — 对话消息渲染
  - `PromptInput/` — 用户输入处理
  - `permissions/` — 工具权限批准 UI
  - `design-system/` — 可复用 UI 组件（Dialog、FuzzyPicker、ProgressBar、ThemeProvider 等）
- 组件使用 React Compiler 运行时（`react/compiler-runtime`）— 反编译输出中到处包含 `_c()` 记忆化调用。

### 状态管理

- **`src/state/AppState.tsx`** — 中央应用状态类型和上下文提供者。包含消息、工具、权限、MCP 连接等。
- **`src/state/AppStateStore.ts`** — 默认状态和存储工厂。
- **`src/state/store.ts`** — 用于 AppState 的 Zustand 风格存储（`createStore`）。
- **`src/state/selectors.ts`** — 状态选择器。
- **`src/bootstrap/state.ts`** — 会话全局状态的模块级单例（会话 ID、CWD、项目根目录、令牌计数、模型覆盖、客户端类型、权限模式）。

### Workspace 包

| 包 | 说明 |
|---------|------|
| `packages/@ant/ink/` | Forked Ink 框架（components、hooks、keybindings、theme） |
| `packages/@ant/computer-use-mcp/` | Computer Use MCP 服务器（截图/键鼠/剪贴板/应用管理） |
| `packages/@ant/computer-use-input/` | 键鼠模拟（dispatcher + darwin/win32/linux 后端） |
| `packages/@ant/computer-use-swift/` | 截图 + 应用管理（dispatcher + 各平台后端） |
| `packages/@ant/claude-for-chrome-mcp/` | Chrome 浏览器控制（通过 `--chrome` 启用） |
| `packages/@ant/model-provider/` | 模型提供者抽象层 |
| `packages/builtin-tools/` | 内置工具集（60 个工具实现，通过 `@claude-code-best/builtin-tools` 导出） |
| `packages/agent-tools/` | 代理工具集 |
| `packages/acp-link/` | ACP 代理服务器（WebSocket → ACP 代理桥接） |
| `packages/cc-knowledge/` | Claude Code 知识库（非 workspace 包） |
| `packages/langfuse-dashboard/` | Langfuse 可观测性面板（非 workspace 包） |
| `packages/mcp-client/` | MCP 客户端库 |
| `packages/mcp-server/` | MCP 服务端库（非 workspace 包） |
| `packages/remote-control-server/` | 自托管远程控制服务器（Docker 部署，含 Web UI）— Web UI 已重构为 React + Vite + Radix UI，支持 ACP 代理接入 |
| `packages/swarm/` | Swarm 解耦模块（非 workspace 包） |
| `packages/shell/` | Shell 抽象（非 workspace 包） |
| `packages/audio-capture-napi/` | 原生音频捕获（已恢复） |
| `packages/color-diff-napi/` | 颜色差异计算（完整实现，11 个测试） |
| `packages/image-processor-napi/` | 图像处理（已恢复） |
| `packages/modifiers-napi/` | 键盘修饰键检测（桩代码） |
| `packages/url-handler-napi/` | URL scheme 处理（桩代码） |

### 桥接 / 远程控制

- **`src/bridge/`**（约 38 个文件）— 远程控制 / 桥接模式。由 `BRIDGE_MODE` 功能开关控制。包含桥接 API、会话管理、JWT 认证、消息传输、权限回调等。入口：`bridgeMain.ts`。
- **`packages/remote-control-server/`** — 自托管 RCS，支持 Docker 部署，含 Web UI 控制面板（React 19 + Vite + Radix UI）。支持 ACP 代理通过 acp-link 接入（ACP WebSocket 处理器、中继处理器、SSE 事件流）。通过 `bun run rcs` 启动。
- CLI 快速路径：`claude remote-control` / `claude rc` / `claude bridge`。
- 详见 `docs/features/remote-control-self-hosting.md`。

### ACP 协议（代理客户端协议）

- **`src/services/acp/`** — ACP 代理实现，包含 `agent.ts`（AcpAgent 类）、`bridge.ts`（Claude Code ↔ ACP 桥接）、`permissions.ts`（权限处理）、`entry.ts`（入口）。
- **`packages/acp-link/`** — ACP 代理服务器，将 WebSocket 客户端桥接到 ACP 代理。提供 `acp-link` CLI 命令，支持自定义端口/HTTPS/认证/会话管理、RCS 集成（REST 注册 + WS 识别两步流程）、权限模式透传（fallback：客户端传值 > 配置 > `ACP_PERMISSION_MODE` 环境变量）。
- ACP 权限管道改进：`createAcpCanUseTool` 统一权限流水线，`applySessionMode` 模式同步，`bypassPermissions` 可用性检测（非 root/sandbox 环境）。
- ACP Plan 可视化已支持 `session/update plan` 类型的消息展示（PlanView 组件，含进度条/状态图标/优先级标签）。

### 守护进程模式

- **`src/daemon/`** — 守护进程模式（长驻 supervisor）。由 `DAEMON` 功能开关控制。包含 `main.ts`（入口）和 `workerRegistry.ts`（worker 管理）。

### 上下文与系统提示

- **`src/context.ts`** — 为 API 调用构建系统/用户上下文（git 状态、日期、CLAUDE.md 内容、内存文件）。
- **`src/utils/claudemd.ts`** — 从项目层次结构中发现并加载 CLAUDE.md 文件。

### 功能开关系统

功能开关控制在运行时启用哪些功能。代码中统一通过 `import { feature } from 'bun:bundle'` 导入，调用 `feature('FLAG_NAME')` 返回 `boolean`。

**启用方式**：环境变量 `FEATURE_<FLAG_NAME>=1`。例如 `FEATURE_BUDDY=1 bun run dev`。

**构建默认功能**（19 个，见 `build.ts`）：
- 基础：`BUDDY`、`TRANSCRIPT_CLASSIFIER`、`BRIDGE_MODE`、`AGENT_TRIGGERS_REMOTE`、`CHICAGO_MCP`、`VOICE_MODE`
- 统计/缓存：`SHOT_STATS`、`PROMPT_CACHE_BREAK_DETECTION`、`TOKEN_BUDGET`
- P0 本地：`AGENT_TRIGGERS`、`ULTRATHINK`、`BUILTIN_EXPLORE_PLAN_AGENTS`、`LODESTONE`
- P1 API 依赖：`EXTRACT_MEMORIES`、`VERIFICATION_AGENT`、`KAIROS_BRIEF`、`AWAY_SUMMARY`、`ULTRAPLAN`
- P2：`DAEMON`

**开发模式默认**：全部启用（见 `scripts/dev.ts`）。

**类型声明**：`src/types/internal-modules.d.ts` 中声明了 `bun:bundle` 模块的 `feature` 函数签名。

**新增功能的正确做法**：保留 `import { feature } from 'bun:bundle'` + `feature('FLAG_NAME')` 的标准模式，在运行时通过环境变量或配置控制，不要绕过功能开关直接导入。

### 多 API 兼容层

支持 OpenAI、Gemini、Grok 三种第三方 API，通过 `/login` 命令配置，均采用流适配器模式转为 Anthropic 内部格式。详见各兼容层的 docs 文档。

### 穷鬼模式（预算模式）

- 通过 `/poor` 命令切换，持久化到 `settings.json`。
- 启用后跳过 `extract_memories`、`prompt_suggestion` 和 `verification_agent`，显著减少令牌消耗。
- 实现在 `src/commands/poor/poorMode.ts`。

### 桩代码/已删除模块

| 模块 | 状态 |
|--------|--------|
| Computer Use（`@ant/*`） | 已恢复 — macOS + Windows + Linux（后端完整度不一） |
| `*-napi` 包 | `audio-capture-napi`、`image-processor-napi` 已恢复；`color-diff-napi` 完整；`modifiers-napi`、`url-handler-napi` 仍为桩代码 |
| 语音模式 | 已恢复 — 一键通语音输入（需 Anthropic OAuth） |
| OpenAI/Gemini/Grok 兼容层 | 已恢复 |
| 远程控制服务器 | 已恢复 — 自托管 RCS + Web UI |
| 分析 / GrowthBook / Sentry | 空实现 |
| Magic Docs / LSP 服务器 | 已移除 |
| 插件 / 市场 | 已移除 |
| MCP OAuth | 简化版 |

### 关键类型文件

- **`src/types/global.d.ts`** — 声明 `MACRO`、`BUILD_TARGET`、`BUILD_ENV` 和 Anthropic 内部标识符。
- **`src/types/internal-modules.d.ts`** — `bun:bundle`、`bun:ffi`、`@anthropic-ai/mcpb` 的类型声明。
- **`src/types/message.ts`** — 消息类型层次结构（UserMessage、AssistantMessage、SystemMessage 等）。
- **`src/types/permissions.ts`** — 权限模式和结果类型。

## 测试

- **框架**: `bun:test`（内置断言 + mock）
- **当前状态**: 3175 个测试 / 207 个文件 / 0 失败
- **单元测试**: 就近放置于 `src/**/__tests__/`，文件名 `<模块>.test.ts`
- **集成测试**: `tests/integration/` — 4 个文件（cli-arguments、context-build、message-pipeline、tool-chain）
- **共享 mock/fixture**: `tests/mocks/`（api-responses、file-system、fixtures/）
- **命名**: `describe("函数名")` + `test("行为描述")`，英文
- **包测试**: `packages/` 下各包也有独立测试（如 `color-diff-napi` 11 个测试）

### Mock 使用规范

**只 mock 有副作用的依赖链，不 mock 纯函数/纯数据模块。**

被迫 mock 的根源：`log.ts` / `debug.ts` → `bootstrap/state.ts`（模块级 `realpathSync` / `randomUUID` 副作用）。必须 mock 的模块：`log.ts`、`debug.ts`、`bun:bundle`、`settings/settings.js`、`config.ts`、`auth.ts`、第三方网络库。

<<<<<<< HEAD
不要 mock：纯函数模块（`errors.ts`、`stringUtils.js`）、mock 值与真实实现相同的模块、mock 路径与实际导入不匹配的模块。
=======
**`log.ts` 和 `debug.ts` 使用共享 mock**（`tests/mocks/log.ts` / `tests/mocks/debug.ts`），不要在测试文件中内联 mock 定义。使用方式：

```ts
import { logMock } from "../../../tests/mocks/log";
mock.module("src/utils/log.ts", logMock);

import { debugMock } from "../../../../tests/mocks/debug";
mock.module("src/utils/debug.ts", debugMock);
```

源文件导出变更时只需更新 `tests/mocks/` 下的对应文件，不需要逐个修改测试。

不要 mock：纯函数模块（`errors.ts`、`stringUtils.js`）、mock 值与真实实现相同的模块、mock 路径与实际 import 不匹配的模块。
>>>>>>> main

路径规则：统一用 `.ts` 扩展名 + `src/*` 别名路径，禁止双重 mock 同一模块。

### 类型检查

项目使用 TypeScript 严格模式，**tsc 必须零错误**。每次修改后运行：

```bash
bun run typecheck          # 等价于 bun run typecheck
```

**类型规范**：
- 生产代码禁止 `as any`；测试文件中 mock 数据可用 `as any`
- 类型不匹配优先用 `as unknown as SpecificType` 双重断言，或补充接口
- 未知结构对象用 `Record<string, unknown>` 替代 `any`
- 联合类型用类型守卫（type guard）收窄，不要强转
- `msg.request` 属性访问：`const req = msg.request as Record<string, unknown>`
- Ink `color` 属性：用 `as keyof Theme` 而非 `as any`

## 使用此代码库

- **tsc 必须通过** — `bun run typecheck` 必须零错误，任何修改都不能引入新的类型错误。
- **功能开关** — 默认全部关闭（`feature()` 返回 `false`）。开发/构建各有自己的默认启用列表。不要在 `cli.tsx` 中重定义 `feature` 函数。
- **React Compiler 输出** — 组件包含反编译的记忆化样板代码（`const $ = _c(N)`）。这是正常的。
- **`bun:bundle` 导入** — `import { feature } from 'bun:bundle'` 是 Bun 内置模块，由运行时/构建器解析。不要用自定义函数替代它。**`feature()` 只能直接用在 `if` 语句或三元表达式的条件位置**（Bun 编译器限制），不能赋值给变量、不能放在箭头函数体里、不能作为 `&&` 链的一部分。正确：`if (feature('X')) {}` 或 `feature('X') ? a : b`。
- **`src/` 路径别名** — tsconfig 将 `src/*` 映射到 `./src/*`。类似 `import { ... } from 'src/utils/...'` 的导入是有效的。
- **MACRO 定义** — 集中管理在 `scripts/defines.ts`。开发模式通过 `bun -d` 注入，构建通过 `Bun.build({ define })` 注入。修改版本号等常量只改这个文件。
- **构建产物兼容 Node.js** — `build.ts` 会自动后处理 `import.meta.require`，产物可直接用 `node dist/cli.js` 运行。
- **Biome 配置** — 大量 lint 规则被关闭（反编译代码不适合严格 lint）。`.tsx` 文件用 120 列行宽 + 强制分号；其他文件 80 列行宽 + 按需分号。
- **Ink 框架在 `packages/@ant/ink/`** — 不是 `src/ink/`（该目录不存在）。Ink 相关的组件、hooks、keybindings 都在 packages 中。
- **提供者优先级** — `modelType` 参数 > 环境变量 > 默认 `firstParty`。新增提供者需在 `src/utils/model/providers.ts` 注册。

## 设计上下文

完美的设计上下文保存在 `.impeccable.md` 中。设计 Web UI（RCS 控制面板、文档站、着陆页）时必须参考该文件。

### 核心设计原则

1. **深思而非取巧** — 每个设计选择都应感觉有意为之，而非追逐潮流
2. **细微处见温度** — 通过橙色色调的中性色、留白布局、有温度的文案来传达温暖
3. **清晰中见密度** — 技术用户需要信息密度，但不能混乱
4. **社区之声** — 设计应感觉是由使用者创造的，而非遥远的设计团队
5. **Anthropic 的影子** — 遵循 Anthropic 的设计直觉：干净的布局、充足的间距、温暖的色温

### 品牌色

- 主色：Claude 橙 `#D77757`（赤陶色）
- 辅色：Claude 蓝 `#5769F7`
- 暗色模式使用温暖的深色表面（非冷蓝黑色）

### 目标用户

技术团队/企业，在专业工作流中使用 AI 辅助编程。友好的开源社区氛围，非企业 SaaS 风格。

### 视觉参考

Anthropic 公司的设计风格 — 干净、考究、温暖的底色。大量留白，以排版为核心。避免 AI 产品常见的设计套路（渐变文字、玻璃态、霓虹色）。