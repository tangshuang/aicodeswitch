```
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
```

## Project Overview

This project named AICodeSwitch is a local proxy server that manages AI programming tool connections to large language models, allowing tools like Claude Code and Codex to use custom model APIs instead of official ones.

## Development Commands

### Installation
```bash
npm install
```

### Development
```bash
npm run dev              # Run both UI and server in watch mode
npm run dev:ui           # Run only React UI (Vite dev server)
npm run dev:server       # Run only Node.js server (TSX watch)
```

### Build
```bash
npm run build            # Build both UI and server
npm run build:ui         # Build React UI to dist/ui
npm run build:server     # Build TypeScript server to dist/server
```

### Tauri Desktop Application
```bash
npm run tauri:dev        # Run Tauri development mode (requires Rust toolchain)
npm run tauri:build      # Build Tauri desktop application
npm run tauri:icon       # Generate application icons from source image
```

**Prerequisites for Tauri build:**
- Rust toolchain (rustc, cargo) - Install from https://rustup.rs/
- Windows: Microsoft Visual Studio C++ Build Tools
- macOS: Xcode Command Line Tools

### Linting
```bash
npm run lint             # Run ESLint on all .ts/.tsx files
```

### CLI Commands
```bash
npm link                 # Link local package for CLI testing
aicos start              # Start the proxy server
aicos stop               # Stop the proxy server
aicos restart            # Restart the proxy server
aicos status             # Show server status, running address and port
aicos ui                 # Open web UI in browser (starts server if needed)
aicos upgrade            # Upgrade to the latest version and restart
aicos restore            # Restore original configuration files
aicos version            # Show current version information
```

## Architecture

### High-Level Structure

#### Traditional Deployment (CLI/Web)
```
┌─────────────────────────────────────────────────────────────┐
│                     AICodeSwitch                          │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   React UI   │  │  Express API │  │  Proxy Core  │     │
│  │  (Vite dev)  │  │  (Node.js)   │  │              │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│            │              │              │                  │
│            └──────────────┼──────────────┘                  │
│                           ▼                                 │
│                    ┌──────────────┐                        │
│                    │   Database   │                        │
│                    │  (JSON Files) │                        │
│                    │  FS Storage  │                        │
│                    └──────────────┘                        │
│                           │                                 │
│                           ▼                                 │
│                    ┌──────────────┐                        │
│                    │  Transformers │                        │
│                    │  (Stream/SSE) │                        │
│                    └──────────────┘                        │
│                           │                                 │
│                           ▼                                 │
│                    ┌──────────────┐                        │
│                    │  Upstream    │                        │
│                    │  APIs (LLMs) │                        │
│                    └──────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

#### Tauri Desktop Application (Hybrid Architecture)
```
┌─────────────────────────────────────────────────────────────┐
│              Tauri Desktop Application                      │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Tauri Main Process (Rust)                           │  │
│  │  - Window Management                                 │  │
│  │  - Node.js Installation Check                        │  │
│  │  - Node.js Process Lifecycle Management              │  │
│  │  - System Integration                                │  │
│  └──────────────────────────────────────────────────────┘  │
│            │                           │                    │
│            ▼                           ▼                    │
│  ┌──────────────────┐      ┌──────────────────┐           │
│  │  WebView (React) │      │  Node.js Backend │           │
│  │  - UI Components │◄─────┤  - Express Server│           │
│  │  - User Interface│ HTTP │  - Proxy Logic   │           │
│  └──────────────────┘      │  - Database      │           │
│                             └──────────────────┘           │
└─────────────────────────────────────────────────────────────┘
```

**Tauri Hybrid Approach Benefits:**
- **Preserves Existing Code**: Node.js backend remains unchanged
- **Smaller App Size**: ~10-20MB (vs 150MB+ for Electron)
- **Better Performance**: Native system integration via Rust
- **Cross-Platform**: Windows, macOS, Linux support
- **No Rewrite Required**: Gradual migration path available

### Core Components

#### 1. Server (Node.js/Express) - `server/main.ts`
- Main entry point
- Configures Express with CORS, body parsing
- Reads configuration from `~/.aicodeswitch/aicodeswitch.conf`
- Sets up authentication middleware
- Registers all API routes
- Initializes database using `DatabaseFactory.createAuto()` which creates file system database
- Initializes proxy server

#### 2. Proxy Server - `server/proxy-server.ts`
- **Route Matching**: Finds active route based on target type (claude-code/codex)
- **Rule Matching**: Determines content type from request (image-understanding/thinking/long-context/background/default/compact)
- **Request Transformation**: Converts between different API formats (Claude ↔ OpenAI Chat)
- **Streaming**: Handles SSE (Server-Sent Events) streaming responses with real-time transformation
- **Claude Code Compact Guardrails**: Compact requests sanitize dangling tool history and strip `thinking`/`tools` capabilities before upstream forwarding; compact responses are reduced to plain text before being returned downstream
- **Logging**: Tracks requests, responses, and errors

#### 3. Transformers - `server/transformers/`
- **streaming.ts**: SSE parsing/serialization and event transformation
  - OpenAI ↔ Claude event transformation
  - Gemini ↔ Claude/OpenAI event transformation (streaming)
- **claude-openai.ts**: Claude ↔ OpenAI Chat format conversion
  - Image content block conversion (Claude ↔ OpenAI formats)
  - Tool choice mapping (auto/any/tool ↔ auto/none/required)
  - Stop reason mapping (including max_thinking_length)
  - System prompt handling (string and array formats)
  - Thinking/Reasoning content conversion
- **gemini.ts**: Gemini ↔ Claude/OpenAI Chat format conversion
  - Claude Messages API ↔ Gemini GenerateContent API
  - OpenAI Chat Completions API ↔ Gemini GenerateContent API
  - Image content block conversion (Claude/OpenAI ↔ Gemini inlineData)
  - Tool calls conversion (tool_use/tool_calls ↔ functionCall)
  - System instruction handling (system ↔ systemInstruction)
  - Thinking configuration conversion (thinking ↔ thinkingConfig)
  - Finish reason mapping (STOP/MAX_TOKENS/SAFETY ↔ end_turn/max_tokens/content_filter)
- **chunk-collector.ts**: Collects streaming chunks for logging

#### 4. MCP Image Handler - `server/mcp-image-handler.ts`
- **Purpose**: Handle image-understanding requests using MCP tools
- **Key Features**:
  - Extracts images from request messages (supports both Claude and OpenAI formats)
  - Saves images to temporary files (`/tmp/aicodeswitch-images/`)
  - Constructs MCP-compatible messages with local file path references
  - Automatically cleans up temporary files after request completion
- **Functions**:
  - `extractImagesFromMessages()`: Extracts all images from message array
  - `saveImageToTempFile()`: Saves base64 encoded images to temporary files
  - `constructMCPMessages()`: Replaces image content blocks with local file path references
  - `cleanupTempImages()`: Removes temporary image files
  - `isRuleUsingMCP()`: Checks if a rule is configured to use MCP for image understanding

**API 转换功能**：
转换器实现了以下 API 格式之间的双向转换：
- **Claude Messages API** ↔ **OpenAI Chat Completions API**
- **Claude Messages API** ↔ **OpenAI Responses API**
- **Claude Messages API** ↔ **Gemini GenerateContent API**
- **OpenAI Chat Completions API** ↔ **Gemini GenerateContent API**
- **OpenAI Chat Completions API** ↔ **OpenAI Responses API**
- **OpenAI Responses API** ↔ **Gemini GenerateContent API**

**Provider-driven 后处理**：`thinking/providers.ts` 通过 `getReasoningConfig()` 检测上游提供商（DeepSeek、Moonshot、Qwen 等），在 `buildTargetBody` 中自动注入 thinking 参数、修复 reasoning 历史消息、剥离 `stream_options` 等 provider 级别的后处理。

**支持的转换内容**：
- 文本内容 (text)
- 图像内容 (image ↔ image_url)
- 工具调用 (tool_use ↔ tool_calls)
- 工具结果 (tool_result)
- 思考内容 (thinking ↔ reasoning/thinking)
- 系统提示词 (system - 支持字符串和数组格式)

#### 5. Database - `server/fs-database.ts`
- **FileSystemDatabaseManager**: Pure JSON file-based storage (no database dependencies)
- **DatabaseFactory** (`server/database-factory.ts`): Creates file system database instances
- **Data Files**: Stores data as JSON in `~/.aicodeswitch/data/`:
  - `vendors.json` - AI service vendors with nested API services
  - `routes.json` - Route definitions
  - `rules.json` - Routing rules
  - `config.json` - Application configuration
  - `sessions.json` - User sessions
  - `logs.json` - Request logs
  - `error-logs.json` - Error logs
  - `blacklist.json` - Service blacklist entries
  - `mcps.json` - MCP (Model Context Protocol) tools
  - `service-performance.json` - 服务性能统计全局桶（首 Token 返回时间 TTFT / 吞吐 TPM，按 供应商→服务→模型 三级聚合 + 小时走势）

**Data Structure**:
- Vendors contain nested services array: `vendors[{ id, name, services: [{ id, name, apiUrl, ... }], ... }]`
- Services are no longer stored in a separate file, they are embedded within their parent vendor
- This structure ensures data consistency and simplifies cascade operations

#### 5.5. AccessKey Module - `server/access-keys/`
- **Purpose**: Multi-client API Key sharing without user accounts (仅在 AUTH 启用时可用)
- **Key Files**:
  - `index.ts` - Module entry point, initialization and persistence
  - `manager.ts` - AccessKey CRUD, hash-based O(1) lookup
  - `policy-manager.ts` - Policy CRUD with template support
  - `quota-checker.ts` - Token/request/RPM/concurrent quota checking
  - `usage-tracker.ts` - Per-key usage persistence with auto-flush
  - `key-logger.ts` - Per-key isolated log storage (sharded by date)
  - `key-session-tracker.ts` - Per-key isolated session tracking (独立于全局会话系统)
  - `key-resolver.ts` - sk_ Key authentication and resolution
- **Data Storage**:
  - `access-keys.json` - AccessKey records (with apiKeyHash for fast lookup)
  - `policies.json` - Policy configurations
  - `key-usage/{keyId}.json` - Per-key usage statistics
  - `key-logs/{keyId}/` - Per-key isolated log storage (sharded by date)
  - `key-sessions/{keyId}/sessions.json` - Per-key session records
  - `key-logs/{keyId}/` - Per-key isolated log directories
- **Request Flow**: sk_ key → resolve AccessKey → get Policy → quota check → route from policy → proxy → independent logging + session tracking
- **API Key Prefixes**: `sk_` = AccessKey, `skr_` = routing key (existing)
- **Authentication Headers**: Supports `Authorization: Bearer`, `x-api-key`, `x-goog-api-key`
- **Key Design**: AccessKey requests completely bypass existing log/statistics systems
- **写入本地功能**: 密钥详情页"写入本地"按钮可将真实 Key 写入 Claude Code (`~/.claude/settings.json` → `ANTHROPIC_AUTH_TOKEN`) 和 Codex (`~/.codex/auth.json` → `OPENAI_API_KEY`) 本地配置文件
- **认证架构**（`proxy-server.ts` 4 处统一）：
  - AUTH 未配置 → 所有代理请求直接放行，无认证
  - AUTH 已配置 + `sk_` 前缀 key → AccessKey 鉴权（策略 + 配额）
  - AUTH 已配置 + 无 `sk_` key → 401 拒绝
- **前端可见性**：
  - AUTH 关闭 → 隐藏"接入密钥"菜单，显示"会话""日志"
  - AUTH 开启 → 显示"接入密钥"菜单，隐藏"会话""日志"

#### 5.6. ATO Orchestrator Module - `server/orchestrator/`
- **Purpose**: 多 Agent 团队编排（Ralph Loop + 验证门控），作为 AICodeSwitch 的可选嵌入式模块。PRD 依据 `docs/PRD/supervisor-agent/supervisor-agent-v4.md`
- **设计要点**：
  - **厚路径 + 进程隔离**：编排逻辑放 `src/server/orchestrator/`，子 Agent（claude/codex CLI）作为独立 `child_process` spawn；子 Agent 流量天然走代理（base_url 已写入本地配置）
  - **Ralph Loop**：选就绪任务 → spawn 全新子 Agent → 退出后执行验证脚本（exit 0 = 完成）→ 失败重试/失败策略
  - **stdout 协议问答**：子 Agent 输出 `«ATO_QUESTION»{json}«/ATO_QUESTION»` 标记后退出，编排器下轮注入 `## Prior Decisions`。统一 claude-code（stream-json）与 codex（纯文本）
  - **两层混合路由**：Layer1 task 级（task → routeId）+ Layer2 请求级（代理 `determineContentType` 自动切模型，零代码复用）
  - **Token 预算复用**：团队绑定 AccessKey 即可复用 `quota-checker` 的 token limit 硬停止，不新建计数器
  - **配置态软锁**：`AppConfig.atoActiveTeamCount > 0` 时，`/api/restore-config/*` 拒绝恢复用户配置；spawn 前自检 `checkClaudeConfigStatus().isOverwritten`
- **Key Files**:
  - `types.ts` - Task/TeamRun/AgentAdapter/Decision 等类型
  - `adapters.ts` - `ClaudeCodeAdapter`/`CodexAdapter`/`AgentAdapterRegistry`，问题解析 `«ATO_QUESTION»`
  - `scheduler.ts` - `TeamScheduler`（Ralph Loop 单团队调度器，含验证与问答分支）
  - `manager.ts` - `OrchestratorManager`（团队生命周期、持久化 `.team/state.json`+`logs.jsonl`、L0/L1/L2 问题分级、软锁维护）
  - `routes.ts` - `registerOrchestratorRoutes` → `/api/orchestrator/*`
  - `index.ts` - 模块导出
- **HTTP API**: `/api/orchestrator/teams` (POST 创建/GET 列表)、`/teams/:id` (状态)、`/teams/:id/logs?since=` (增量日志)、`/teams/:id/stop`、`/teams/:id/questions/:qid/answer`、`/adapters/check`、`/routes`
- **main.ts 接线**: `start()` 中在 `registerRoutes` 后实例化 `OrchestratorManager` 并注册路由；`restore-config/*` 端点加软锁守卫；`shutdown()` 先 `shutdownAll()` 再恢复配置
- **proxy-server 归因**: `finalizeLog` 读取 `x-ato-task-id` header → 写入 `RequestLog.tags`（`ato:<taskId>`），唯一动代理内核的小改动
- **前端**: `HomePage.tsx`（ATO 对话界面，应用默认首页 `/`），群聊式日志流 + 任务状态 + 问题面板 + Agent 健康检查；"局域网同步""一键配置"两按钮迁移至该页右上角

#### 5.7. ATO 主 Agent（Leader）子系统 - `server/orchestrator/leader/`
- **Purpose**: 以 Claude Code 作为主 Agent，用户只通过一个聊天窗口与它对话；团队/任务/路由/记忆全部由主 Agent 经 MCP 工具自主管理（无需用户操作界面）
- **设计**:
  - **无状态运行 + 持久化记忆**：每轮 spawn `claude --print --output-format stream-json`，从磁盘读取记忆重建上下文（不依赖 `--resume`/`--input-format stream-json`）
  - **内置 stdio MCP**：`mcp-server.ts`（手写 JSON-RPC，无 SDK 依赖）暴露 `ato_list_routes/ato_create_team/ato_list_teams/ato_get_team/ato_stop_team/ato_answer_question/ato_check_adapters` + `memory_read/memory_write/conversation_recent`；经 HTTP 调本机 `/api/orchestrator/*`（跨进程解耦）
  - **MCP 注册**：`main.ts:ensureLeaderMcpRegistered()` 启动时写入 `~/.claude.json` 的 `mcpServers['ato-leader']`（`node dist/server/orchestrator/leader/mcp-server.js` + `env:{ATO_BASE,ATO_TOKEN}`）
  - **记忆目录** `~/.aicodeswitch/ato-leader/`：`memory/{profile.md, scratchpad.md}`（长期记忆，所有会话共享）+ `memory/conversation.jsonl`（遗留全局对话，首次启动迁移后弃用）+ `sessions/{index.json(会话索引), current.json(当前会话指针)}` + `sessions/<id>/{conversation.jsonl, artifacts.json}`（每会话对话历史 + 关联 CLI 会话文件）+ `teams-index.json` + `workspace/`（leader 的固定 cwd"家"，所有会话共享；内种 CLAUDE.md；编程工具在此自由创建记忆/计划/skills 等文件）
- **Key Files**: `memory.ts`(目录/记忆/会话索引+指针/原子写/遗留迁移读写) / `prompt.ts`(系统提示+上下文拼装) / `runner.ts`(流式 claude spawn + stream-json 增量解析 + 捕获 `session_id`) / `manager.ts`(`LeaderManager` 多会话 + 单活跃流 + artifacts 采集/清理 + Codex 快照差分) / `mcp-server.ts`(独立进程入口) / `routes.ts` / `index.ts`
- **HTTP API**: `POST /api/orchestrator/leader/message`(SSE 流式回复，作用于当前会话) / `GET .../leader/history`(当前会话) / `GET .../leader/status` / `POST .../leader/reset`(清当前会话) / `GET/POST .../leader/sessions`(列表/新建) / `POST .../leader/sessions/:id/activate` / `PATCH .../leader/sessions/:id`(改名) / `DELETE .../leader/sessions/:id`(删会话 + 清理关联 CLI 文件)
- **多会话管理**：用户可新建/切换/删除会话；对话历史按会话隔离（`sessions/<id>/conversation.jsonl`），profile/scratchpad 跨会话共享。每轮 Leader spawn 一个全新 CLI 进程（无 `--resume`），故一条会话 = N 个本地 CLI 会话文件：runner 捕获 Claude stream-json 的 `session_id`（`onSessionId`），manager 在 `sessions/<id>/artifacts.json` 累积；Codex 用每轮 spawn 前后递归快照 `~/.codex/sessions/**` 差分记录新增 rollout。删除会话时 Claude 按 `session_id` 精确 unlink `~/.claude/projects/*/<id>.jsonl`，Codex 按记录路径 unlink（best-effort）。`index.json`/`current.json` 原子写（tmp+rename），`resolveCurrentSessionId()` 读取时校验悬空并自愈。首次启动 `migrateLegacyConversationIfNeeded()` 把遗留全局对话迁移为「迁移的会话」。流式中的当前会话不可删（409）；删除当前会话后自动切到最近剩余或空态
- **前端**: `HomePage.tsx` 重写为 Codex 风格聊天窗（左侧会话列表面板 + 右侧调试面板均与对话窗口并列、默认收起/滑动展开；消息区 user/assistant 气泡 + ReactMarkdown + 工具调用折叠 chip，底部输入框，`fetch().body.getReader()` 流式逐字渲染）；菜单名「首页」
- **主 Agent 工具切换**: 用户可在首页顶栏选择主 Agent 由 Claude Code 还是 Codex 扮演（`runner.ts:streamLeader` 分派；`memory.ts:loadLeaderConfig/saveLeaderConfig` 持久化到 `ato-leader/config.json`；`GET/PUT /api/orchestrator/leader/config`；ato-leader MCP 同时写入 `.claude.json` 与 `~/.codex/config.toml`）。Codex 走 `codex exec` 纯文本流式（无 stream-json/工具事件）
- **已知约束**: `claude --print --output-format stream-json` 事件结构以真实环境为准（runner 增量解析可能需微调）；MCP 走 HTTP 调本机，若开启 AUTH 需 `ATO_TOKEN`；单活跃会话避免并发冲突
- **跨平台 CLI 解析（`orchestrator/cli-resolver.ts`）**：Windows 上 npm 全局包以 `.cmd` shim 分发，`spawn('claude', ...)` 默认无法解析 `.cmd`（ENOENT），加 `shell:true` 又会闪现 cmd 窗口。resolver 改为 `where` 定位 `.cmd` → 读出 shim 内 `%dp0%\node_modules\<pkg>\<entry>.js` → 替换 `%dp0%` 为真实目录 → 用 `process.execPath + [jsEntry]` 直调，绕开 cmd.exe。`leader/runner.ts`（`isClaudeAvailable`/`isCodexAvailable`/`streamClaude`/`streamCodex`）与 `orchestrator/adapters.ts`（两个 Adapter 的 `spawn` + `checkHealth`）统一走 resolver；解析失败回退原命令；结果进程内缓存
- **权限裁决（PermissionJudge，`leader/permission.ts`）**：claude 经 `--permission-prompt-tool mcp__ato-leader__permission_request`（leader `runner.ts` 与子 Agent `adapters.ts` 的 spawn 都加，强制 `--permission-mode default`）把权限请求路由到 ato-leader MCP → `POST /api/orchestrator/leader/permission`（同步阻塞）。裁决：先硬规则（deny/allow 正则）→ 否则 LLM 危险度分析（经本机代理 `/v1/messages` 打一次上游，不走 CLI、不递归）→ low 放行 / high 拒绝（deny message 含建议喂回 claude 让其 adapt）/ medium 按配置自动或上抛人类。上抛人类经 pending 队列 + `GET /permissions/stream` SSE 推前端，UI 卡片放行/拒绝 → `/permissions/:id/resolve`。配置在 `ato-leader/config.json` 的 `permission`（enabled/allowPatterns/denyPatterns/humanGateMedium/humanGateHigh）。**P0 待实测**：MCP 入参字段名（`tool_name`/`input`，已做容错）与返回形态（标准 text-content 包 JSON）

#### 6. UI (React) - `ui/`
- Main app: `App.tsx` - Navigation and layout with collapsible sidebar
- Components:
  - `Tooltip.tsx` - Tooltip component for displaying menu text when sidebar is collapsed
  - `Toast.tsx` - Toast notification component
  - `Confirm.tsx` - Confirmation dialog component
  - `ToolsInstallModal.tsx` - Tools installation modal
  - `NotificationBar.tsx` - Notification bar component
- Pages:
  - `VendorsPage.tsx` - Manage AI service vendors
  - `SkillsPage.tsx` - Manage global Skills and discovery
  - `MCPPage.tsx` - Manage MCP (Model Context Protocol) tools
  - `RoutesPage.tsx` - Configure routing rules
  - `LogsPage.tsx` - View request/access/error logs
  - `SettingsPage.tsx` - Application settings
  - `WriteConfigPage.tsx` - Overwrite Claude Code/Codex config files
  - `UsagePage.tsx` - Usage statistics
- Styles:
  - `App.css` - Main application styles with sidebar collapse animations
  - `Tooltip.css` - Tooltip component styles

#### 7. CLI - `bin/`
- `cli.js` - Main CLI entry point
- `start.js` - Server startup with PID management
- `stop.js` - Server shutdown
- `restart.js` - Restart server

#### 8. Types - `types/`
- TypeScript type definitions for:
  - Database models (Vendors, Services, Routes, Rules)
  - API requests/responses
  - Configuration
  - Token usage tracking
  - **SourceType**: API 服务的数据格式类型（'openai-chat', 'openai', 'claude-chat', 'claude', 等）
  - **TargetType**: 路由目标类型（'claude-code', 'codex'）

#### 9. Tauri Desktop Application - `tauri/`
- **src/main.rs**: Tauri main process (Rust)
  - Node.js process lifecycle management
  - Server startup/shutdown commands
  - Health check and status monitoring
  - System integration (window management, tray icon)
- **Cargo.toml**: Rust dependencies and build configuration
- **tauri.conf.json**: Tauri application configuration
  - Window settings (size, title, decorations)
  - Bundle configuration (icons, resources)
  - Security policies (CSP, asset protocol)
  - Build commands and paths
- **icons/**: Application icon resources
  - Multiple formats for different platforms (PNG, ICO, ICNS)
  - Generated via `npm run tauri:icon`

## Key Features

### Routing System
- **Routes**: Define target type (Claude Code or Codex) and activation status
- **Rules**: Match requests by content type and route to specific API services
- **Route Configuration Options**:
  - **Agent Teams (Claude Code only)**: Enables experimental Agent Teams feature
    - Sets `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1"` environment variable
    - Requires Claude Code version ≥ 2.1.32
    - Can be toggled on/off for both active and inactive routes
  - **Bypass Permissions Support (Claude Code only)**: 门控开关，决定 `bypassPermissions` 模式是否可见/可选
    - 开启后，默认权限模式下拉框中才会出现 `bypassPermissions` 选项
    - 关闭时若当前模式为 `bypassPermissions`，会自动同步写回 `default`
    - 可在激活/未激活路由下切换
  - **Default Permission Mode (Claude Code only)**: Claude Code 默认权限模式，写入 `permissions.defaultMode`
    - 选项：`default`、`acceptEdits`、`plan`、`auto`、`dontAsk`、`bypassPermissions`（默认 `default`）
    - `default`：每次编辑前都会请求批准
    - `acceptEdits`：自动编辑选中文本或整个文件；读取、文件编辑及常见文件系统命令免询问
    - `plan`：先探索代码并给出方案，确认后再编辑；仅读取免询问
    - `auto`：自动为每个任务选择最佳权限模式；所有操作免询问，带后台安全检查
    - `dontAsk`：仅预先批准的工具免询问
    - `bypassPermissions`：运行潜在危险命令前不请求批准；所有操作免询问，带后台安全检查（仅当 Bypass Permissions Support 门控开启时可选/生效；此时额外写入 `skipDangerousModePermissionPrompt: true`）
    - 后端写入兜底：`bypassPermissions` 仅在门控开启时才允许写出，否则强制降级为 `default`
  - **Effort Level (Claude Code only)**: Controls the effort level for Claude Code
    - Options: `low`, `medium`, `high` (default: `medium`)
    - Sets `effortLevel` in `~/.claude/settings.json`
  - **Autocompact PCT Override (Claude Code only)**: Controls auto-compaction percentage threshold
    - Value range: 1-100 (integer)
    - Sets `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` as string in `~/.claude/settings.json`
    - Leave empty to not write this field
  - **Compact Routing Note (Claude Code only)**: compact summaries are forwarded as plain-text-only requests
    - Proxy sanitizes unmatched `tool_use/server_tool_use` history before forwarding
    - Proxy removes `thinking`, `tools`, `tool_choice`, and `mcp_servers` from compact upstream requests
    - Proxy filters `thinking` / `tool_use` blocks from compact responses before sending them back to Claude Code
  - **Reasoning Effort (Codex only)**: Controls the reasoning effort level
    - Options: `low`, `medium`, `high`, `xhigh` (default: `high`)
    - Sets `model_reasoning_effort` in `~/.codex/config.toml`
- **Fallback Mechanism**:
  - When no route is activated, system automatically falls back to original config files
  - Claude Code: Reads `~/.claude/settings.json` (prefers backup file if exists)
  - Codex: Reads `~/.codex/config.toml` and `auth.json` (prefers backup files if exist)
  - Ensures tools continue working even without active routes
  - Logs include tags: `未通过中转` + `使用原始配置` when fallback is used
  - **Dead Loop Prevention**: Automatically detects if original config points to local proxy and rejects to avoid infinite loops

- **Content Type Detection**:
  - `high-iq`: High intelligence mode (persistent across conversation)
    - Only checks for `[!]`/`[x]` prefixes when a high-iq rule exists for the route
    - Use `[!]` prefix to enable: "[!] 重构A模块"
    - Use `[x]` prefix to explicitly cancel: "[x] 返回普通模式"
    - Searches backwards from the end of the message list for `[!]` or `[x]`
    - Regular messages (no prefix) are skipped during search; the most recent `[!]` or `[x]` determines the mode
    - `[x]` takes priority over `[!]` (cancels high-IQ even if earlier `[!]` exists)
    - Once enabled, the entire conversation uses the high-IQ model
    - State persists in session until explicitly cancelled with `[x]` or rule becomes unavailable
    - Automatically detects rule availability and gracefully degrades when rule is unavailable
  - `image-understanding`: Requests with image content
    - 支持使用 MCP 工具处理图像理解请求
    - 开启 MCP 后，图片会被提取并保存到临时文件
    - 请求消息中的图片引用会被替换为本地文件路径
    - MCP 工具会自动识别并处理本地图片
  - `thinking`: Requests with reasoning/thinking signals
  - `long-context`: Requests with large context
    - 触发条件（满足任一）：
      1. Session 累积 tokens 超过阈值（默认 1M tokens，可配置）
      2. 请求体显式标记：`long_context: true` 或 `longContext: true`
      3. `max_tokens` ≥ 8000
      4. 请求内容长度 ≥ 12000 字符
    - 新增 `sessionTokenThreshold` 字段（单位：k），用于配置 session 累积 tokens 阈值
    - 当 session 累积 tokens 超过阈值后，该 session 的所有新请求都会走长上下文规则
  - `background`: Background/priority requests, including `/count_tokens` endpoint requests and token counting requests with `{"role": "user", "content": "count"}`
  - `default`: All other requests

### Request Transformation
- Supports multiple source types:
  - OpenAI Chat
  - OpenAI Code
  - OpenAI Responses
  - Claude Chat
  - Claude Code
- Model override helper now keeps original payload when no override model is provided (prevents fallback request-body null regression)
- Claude Code -> Gemini/Gemini Chat/OpenAI Chat/OpenAI defaults to streaming (SSE) when `stream` is not explicitly set to `false`
- `/v1/messages/count_tokens` is handled locally in server for Claude Code bridge sources, and returns `{ "input_tokens": number }` directly

### Configuration Management
- OpenAI `sourceType=openai` service `apiUrl` is no longer normalized or validated against a `/v1` suffix; preserve user input as-is
- **服务进程生命周期自动写入/恢复配置文件**：
  - 服务启动时自动写入 Claude Code 和 Codex 配置文件（不依赖激活路由）
    - 适用入口：`aicos start` / `aicos ui` / `aicos restart` / `yarn dev:server`
  - 服务终止前自动恢复原始配置文件
    - 适用入口：`aicos stop`（SIGTERM）/ 开发态 `Ctrl+C`（SIGINT）
  - `aicos restore` 保留为手动恢复命令
- **路由激活/停用**：不再自动写入/恢复配置文件
  - `/api/routes/:id/activate` - 不调用配置写入
  - `/api/routes/:id/deactivate` - 不调用配置恢复
  - `/api/routes/deactivate-all` - 仅停用路由，不调用配置恢复（配置恢复由服务终止信号统一触发）
- **配置修改 API**：保留现有的修改 API
  - `/api/write-config/claude` - 手动写入 Claude Code 配置
  - `/api/write-config/codex` - 手动写入 Codex 配置
  - `/api/update-claude-agent-teams` - 更新全局 Agent Teams 配置（兼容旧调用）
  - `/api/update-claude-bypass-permissions-support` - 更新全局 bypassPermissions 支持配置（兼容旧调用）
  - `/api/update-codex-reasoning-effort` - 更新全局 Codex Reasoning Effort（兼容旧调用）
- Exports/ imports encrypted configuration data

**配置文件**：
- Claude Code: `~/.claude/settings.json`, `~/.claude.json`
- Codex: `~/.codex/config.toml`, `~/.codex/auth.json`
- 备份文件：`*.aicodeswitch_backup`

#### 智能配置合并

系统使用“管理字段 + 保留字段”的智能合并策略，核心目标是：
- 代理接管期间稳定覆盖必要字段
- 恢复时尽量保留工具运行期新增的非托管内容
- 避免重复覆盖、备份污染和状态错乱

**一、服务启动：备份与覆盖写入（生命周期入口）**
- 触发入口：
  - `aicos start` / `aicos ui` / `aicos restart`
  - `yarn dev:server`
- 执行流程（`syncConfigsOnServerStartup`）：
  - 直接读取全局配置：`AppConfig.enableAgentTeams` / `AppConfig.enableBypassPermissionsSupport` / `AppConfig.codexModelReasoningEffort`
  - 调用 `writeClaudeConfig` / `writeCodexConfig`
- 写入保护：
  - 通过 `checkClaudeConfigStatus` / `checkCodexConfigStatus` 检测是否已是代理覆盖态
  - 若 `isOverwritten=true`，拒绝重复覆盖（返回 `false`）
- 备份策略：
  - 仅当对应 `*.aicodeswitch_backup` 不存在时备份原文件
  - backup 已存在时不覆盖旧备份，避免原始配置丢失
- 覆盖策略（智能合并）：
  - 代理配置仅写入管理字段
  - 当前文件中的非管理字段会被保留
  - 使用原子写入，降低中断损坏风险
- 元数据：
  - 写入后记录 metadata（hash / proxy marker / 文件路径）用于状态识别

**二、服务停止：恢复原始配置（生命周期出口）**
- 触发入口：
  - `aicos stop`（SIGTERM）
  - 开发态 `Ctrl+C`（SIGINT）
  - Tauri 生产模式关闭窗口后的服务终止流程
- 恢复流程（`restoreClaudeConfig` / `restoreCodexConfig`）：
  - 若 backup 存在：
    - 读取 backup（恢复基线）
    - 读取当前配置（可能包含工具运行时新增内容）
    - 以 backup 为基础，合并当前配置的非管理字段
    - 原子写回后删除 backup
  - 删除 metadata（`deleteMetadata`）
- 若 backup 不存在：
  - 视为 no-op，直接返回成功
- 异常场景：
  - 如被强制 `SIGKILL`，可能来不及恢复，可通过 `aicos restore` 手动修复

**三、UI 修改工具配置时的处理逻辑**
- 路由页（`RoutesPage`）：
  - `enableAgentTeams` / `enableBypassPermissionsSupport` / `codexModelReasoningEffort`
  - 当前写入全局配置（`config.json`），不直接写用户配置文件
  - 这些设置在“下次服务启动”时写入并生效（同时需重启对应编程工具）
- 兼容接口保留：
  - `/api/update-claude-agent-teams`
  - `/api/update-claude-bypass-permissions-support`
  - `/api/update-codex-reasoning-effort`
  - 这三个接口现在更新全局配置，不再直接改写工具配置文件
- 手动入口保留：
  - `/api/write-config/*`、`/api/restore-config/*`
  - UI 中的 `/write-config` 页面可用于调试/运维手动覆盖或恢复

**全局配置迁移（兼容旧版本）**
- 服务启动初始化时会尝试把历史“路由级工具配置”迁移到全局配置（仅在全局字段尚不存在时）
  - `Route.enableAgentTeams` -> `AppConfig.enableAgentTeams`
  - `Route.enableBypassPermissionsSupport` -> `AppConfig.enableBypassPermissionsSupport`
  - `Route.codexModelReasoningEffort` -> `AppConfig.codexModelReasoningEffort`
- 迁移后会清理路由对象中的旧字段，避免后续歧义

**四、`aicos restore` 命令处理逻辑**
- 调用方式：
  - `aicos restore`（恢复全部）
  - `aicos restore claude-code`
  - `aicos restore codex`
- 恢复行为：
  - 与服务退出使用同一套“智能恢复”策略（backup 基线 + 当前非管理字段）
  - 恢复后删除 backup 文件，防止陈旧备份反复覆盖
- 附加行为：
  - 命令结束前会停用所有激活路由（直接更新 routes 数据文件）
  - 输出“重启服务/工具”提示

**五、管理字段定义（托管字段）**
- Claude Code `settings.json`：
  - `env.ANTHROPIC_AUTH_TOKEN`
  - `env.ANTHROPIC_BASE_URL`
  - `env.API_TIMEOUT_MS`
  - `env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
  - `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`（可选）
  - `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`（可选）
  - `permissions.defaultMode`（可选，仅托管该叶子字段，保留用户自配的 `permissions.allow/deny/ask` 等其它规则）
  - `skipDangerousModePermissionPrompt`（可选）
  - `effortLevel`（可选）
- Claude Code `.claude.json`：
  - `hasCompletedOnboarding`
  - `mcpServers`（可选）
- Codex `config.toml`：
  - `model_provider`
  - `model`
  - `model_reasoning_effort`
  - `disable_response_storage`
  - `preferred_auth_method`
  - `requires_openai_auth`
  - `enableRouteSelection`
  - `[model_providers.aicodeswitch]` 整个 section
  - `[mcp_servers]` 整个 section（可选）
- Codex `auth.json`：
  - `OPENAI_API_KEY`
- 保留字段：
  - 以上以外的全部字段（如 Claude 的 `projects`、Codex 的 `[projects...]`）

**六、其他关联逻辑**
- 状态检测：
  - `check*ConfigStatus` 返回 `isOverwritten / isModified / hasBackup`
  - 综合 proxy marker、hash、backup 与 metadata 判断状态
- 无效 metadata 清理：
  - `cleanupInvalidMetadata` 会清理“metadata 存在但 backup 丢失”的异常状态
- 合并实现细节：
  - 合并器按“叶子路径”复制非管理字段，避免父级对象整块复制导致管理字段被反向覆盖
- 原始配置读取兜底：
  - `original-config-reader` 优先读取 backup，再读取当前配置
  - Codex `auth.json` 兼容读取 `OPENAI_API_KEY`、`api_key` 等字段
- 路由停用接口职责：
  - `/api/routes/deactivate-all` 仅停用路由，不执行配置恢复
  - 配置恢复统一由服务终止信号触发
- MCP 例外说明：
  - MCP 同步仍会在相关路由/MCP 操作时更新 `.claude.json` 的 `mcpServers` 和 `~/.codex/config.toml` 的 `[mcp_servers]`
  - 该行为属于 MCP 配置同步，不属于代理主配置生命周期写入逻辑

**相关模块**
- `src/server/config-managed-fields.ts`：管理字段定义
- `src/server/config-merge.ts`：JSON/TOML 智能合并与原子写入
- `src/server/config-metadata.ts`：配置状态与元数据管理
- `src/server/main.ts`：生命周期写入/恢复与配置 API
- `bin/utils/config-helpers.js`：CLI 恢复侧合并工具
- `bin/restore.js`：`aicos restore` 命令实现
- `src/server/original-config-reader.ts`：原始配置读取兜底

#### Data Import/Export
- **Export**: Exports all configuration data (vendors, services, routes, rules, config) as AES-encrypted JSON
  - Export data format version: `3.0.0`
  - Vendors contain nested services array (current format)
- **Import**: Only supports current format (version `3.0.0`)
  - **Strict validation**: Validates all required fields for vendors, services, routes, rules
  - **Preview feature**: Shows data summary (counts of vendors, services, routes, rules) before import
  - **User confirmation**: Requires explicit confirmation after preview
  - **Detailed error messages**: Returns specific validation errors if data format is invalid
  - **Breaking change**: No longer supports importing data from versions prior to 3.0.0
- **API Endpoints**:
  - `POST /api/export` - Export encrypted data
  - `POST /api/import/preview` - Preview import data (new)
  - `POST /api/import` - Import data with confirmation

### LAN Config Sync
- **Purpose**: Sync Skills, MCP, and optionally vendor/service configs between AICodeSwitch nodes on the same LAN
- **Settings toggle**: `enableLanDiscovery` in AppConfig controls whether a node can be discovered
- **Discovery**: IP subnet scanning (concurrent, 30 requests/batch, 1.5s timeout per IP)
- **Security**: Sensitive fields (API keys, upstream URLs) are never transmitted; 404 returned when toggle is off
- **API Endpoints**:
  - `GET /api/lan/discover` - Return node config for LAN sync (no auth, controlled by toggle)
  - `GET /api/lan/scan` - Return local IP and subnet info
  - `POST /api/lan/sync` - Write synced data to local database
- **Frontend**: `SyncConfigModal` component with 5-step wizard (scan → select Skills → select MCP → vendor config → preview & sync)
- **Duplicate handling**: Skills/MCP with matching names are disabled (cannot be selected) with orange warning text

### Skills Management
- Lists global Skills for Claude Code and Codex
- Provides discovery search (discover/return toggle button) and installs Skills into target tool directories

### MCP Management
- Lists and manages Model Context Protocol (MCP) tools
- Supports three types: stdio, http, sse
- Allows configuration of command, URL, headers, and environment variables
- One-click installation for GLM MCP tools (Vision, Web Search, Web Reader, ZRead)
- Configures MCPs to target tools (Claude Code, Codex)
- **MCP Configuration Sync**: When a route is activated, MCP tools are automatically written to the target tool's global configuration file
  - For Claude Code: Writes to `~/.claude.json` under `mcpServers`
  - For Codex: Writes to `~/.codex/config.toml` under `[mcp_servers.<name>]` TOML sections
    - stdio: `command` + `args` + `[mcp_servers.name.env]`
    - http/sse: `url` + optional `headers`
  - MCPs are only written when there are active routes with enabled targets
  - MCP config is also synced on server startup for all activated tools

### Logging
- Request logs: Detailed API call records with token usage
  - Tool requests are logged across all server-handled paths (proxy/stream/fallback/early-error)
  - `tags` include relay status per request: `通过中转` or `未通过中转`
  - Local count_tokens direct-return requests include tag: `系统计算Token直返`
- Access logs: System access records
- Error logs: Error and exception records with comprehensive context
  - **Error Log Details**:
    - Basic error information: timestamp, method, path, status code, error message, error stack
    - Request context: targetType (client type), requestModel (requested model)
    - Routing context: ruleId (used rule), targetServiceId/Name (API service), targetModel (actual model)
    - Vendor context: vendorId/Name (service provider)
    - Request details: request headers, request body, response headers, response body
    - **Upstream Request Information**: URL, headers, body, proxy usage (actual request sent to upstream API)
    - **Upstream Response Body**: Actual response body sent to the client after transformation
      - For stream responses: Stores the SSE chunks array (actual format sent to client, after transformation)
      - For non-stream responses: Stores the JSON response body
    - Response time metrics
    - **Tags**: Array of labels for special request characteristics (e.g., "使用原始配置")
- **Data Sanitization**:
  - Sensitive authentication fields (api_key, authorization, password, secret, etc.) are automatically masked in the UI
  - Technical fields like `max_tokens`, `input_tokens`, `output_tokens` are NOT masked - they are legitimate API parameters
- **Session Management**:
  - Tracks user sessions based on session ID (Claude Code: `metadata.user_id`, Codex: `headers.session_id`)
  - Auto-generates session title from first user message content:
    - Extracts text from first user message
    - Cleans up whitespace and newlines
    - Intelligently truncates at word boundaries (max 100 chars)
    - Adds "..." for truncated titles
  - Records first request time, last request time, request count, and total tokens per session
  - **Session Route Binding**: Sessions can be bound to a specific route, overriding the global tool-level route binding
    - When a session is bound to a route, all subsequent requests for that session use the bound route
    - Route selection priority: session-level binding > global tool binding (ToolBindings) > fallback to original config
    - Binding is stored as `routeId`/`routeName` fields on the Session object
    - Route deletion cascades: automatically clears all session bindings for the deleted route
    - UI: "路由" button in SessionsPage opens route selection modal; RoutesPage shows bound session count per route card

### 服务性能统计（测速 / TPM）
- **全局被动统计，与 AUTH 模式无关**：在代理转发真实请求时自动采集，普通路由 + AccessKey 路由流量统一计入 `service-performance.json`，不主动发探测请求、不按 key/用户隔离
- **两个指标（每次请求记录，按「服务×模型」）**：
  - 首 Token 返回时间（TTFT）= 第一个 token 返回 − 请求发起
  - 吞吐 TPM = 输出 token / 生成阶段秒 × 60（从第一个 token 到返回结束每分钟吐出多少 token）
- **三级上卷**：模型 → 服务 → 供应商，加权聚合（sum+count）保证自洽；走势按小时桶（保留 72 桶）
- **流式精确 / 非流式估算**：流式经 `StreamTimingTransform` 记录首/末事件时间得 `precise` 口径；非流式按端到端 `estimated`，两者分开存放不互相污染
- **采集点**：两条转发路径（`proxyRequest` 标准 `/v1/*`、`proxyRequestForApiPath` API path）的 `finalizeLog` 公共点调用 `emitPerformance`；AccessKey 与普通路由在 `proxyRequest` 内合流，无需单独挂载
- **模块**：`server/performance-tracker.ts`（`ServicePerformanceTracker`）、`server/transformers/stream-timing-transform.ts`（`StreamTimingTransform`）
- **API**：`GET /api/performance/vendors`、`/vendors/:id`、`/services/:id`、`/services/:id/models/:model`
- **UI**：数据统计页（`StatisticsPage`）内「服务性能 / 测速统计」面板，提供指标（TTFT/TPM）× 维度（供应商/服务/模型）× 时段（24h/7d/30d）筛选 + 对比表 + 小时走势折线

### Usage Limits Auto-Sync
- **Service-Level Limits**: API services can have token and request count limits configured
- **Auto-Sync to Rules**: When an API service's usage limits are modified, all rules using that service are automatically updated with the new limits
- **Inheritance Detection**: When editing a rule, the system detects if the rule's limits match the service's limits and displays them as "inherited" (read-only)
- **Manual Override**: Rules can be configured with custom limits that differ from the service defaults

## Development Tips

1. **Environment Variables**: Copy `.env.example` to `.env` and modify as needed
2. **Data Directory**: Default: `~/.aicodeswitch/data/` (JSON files)
3. **Config File**: `~/.aicodeswitch/aicodeswitch.conf` (HOST, PORT, AUTH)
4. **Dev Ports**: UI (4568), Server (4567) - configured in `vite.config.ts` and `server/main.ts`
5. **Skills Search**: `SKILLSMP_API_KEY` is required for Skills discovery via SkillsMP
6. **API Endpoints**: All routes are prefixed with `/api/` except proxy routes (`/claude-code/`, `/codex/`)

### Tauri Development Tips

1. **First-Time Setup**:
   - Install Rust toolchain before running Tauri commands
   - Run `npm run tauri:dev` to verify setup is correct
   - Check Rust compilation errors in the terminal

2. **Development Workflow**:
   - Use `npm run dev` for web development (faster iteration)
   - Use `npm run tauri:dev` when testing desktop-specific features
   - React UI directly communicates with Node.js backend via HTTP

3. **Backend Process Management**:
   - In Tauri mode, the Rust process automatically manages the Node.js backend
   - In web mode, you manually start the backend with `npm run dev:server`
   - The backend always runs on localhost:4567 (configurable via `~/.aicodeswitch/aicodeswitch.conf`)
   - React UI uses standard HTTP requests (fetch/axios) to communicate with backend
   - **Service Detection & Restart**: On startup, Tauri app checks if the port is already in use
     - If a Node.js server is already running (started via `aicos start` or leftover from a previous run), the app **shuts it down first** then starts a fresh server (`shutdown_existing_server`: POST `/api/shutdown` → old service restores config + exits; if unresponsive, kills the process on the port via `kill_process_on_port` — Unix `lsof`+`kill`, Windows `netstat`+`taskkill`)
     - This ensures newly installed code actually runs — previously the app reused the stale service, so upgrades/reinstalls had no effect
     - On exit (`stop_server`), the app POSTs `/api/shutdown`, which (like `aicos stop`'s SIGTERM) runs the same Node `shutdown()` that `restoreClaudeConfig` + `restoreCodexConfig` before exiting

4. **Debugging**:
   - **Frontend**: Use browser DevTools (F12 in Tauri window)
   - **Backend**: Check Node.js console output
   - **Rust**: Use `println!` or `eprintln!` for logging
   - **Build Issues**: Check `tauri/target/` for detailed error logs

5. **Icon Generation**:
   - Prepare a 512x512 PNG source image
   - Run `npm run tauri:icon path/to/icon.png`
   - Icons are generated in `tauri/icons/`

6. **Node.js Detection**:
   - Tauri app checks for Node.js installation on startup (production mode only)
   - Checks by running `node --version` command
   - If Node.js is not installed, a friendly error dialog is displayed:
     - Title: "Node.js 未安装"
     - Message includes error details and installation link (https://nodejs.org/)
     - Application window closes after the dialog
   - Most developers already have Node.js installed
   - This check is skipped in development mode

7. **Auto-Deactivate Routes on Exit**:
   - When the application is closed, it automatically deactivates all active routes
   - This prevents configuration files from remaining in an overwritten state
   - The close event is intercepted and the following steps are executed:
     1. Fetch all routes via `GET /api/routes`
     2. Filter for active routes
     3. Send `POST /api/routes/:id/deactivate` for each active route
     4. Stop the Node.js server
     5. Destroy the window
   - This feature only works in production mode
   - If deactivation fails, the app still proceeds with shutdown to avoid hanging

### Project Structure

```
aicodeswitch/
├── src/
│   ├── ui/                      # React frontend
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── components/
│   │   ├── pages/
│   │   └── hooks/
│   └── server/                  # Node.js backend
│       ├── main.ts
│       ├── config.ts
│       ├── database-factory.ts  # Database factory
│       ├── fs-database.ts       # JSON file-based database manager
│       ├── proxy-server.ts
│       ├── access-keys/           # AccessKey sharing module
│       │   ├── index.ts           # Module entry point
│       │   ├── manager.ts         # AccessKey CRUD
│       │   ├── policy-manager.ts  # Policy CRUD
│       │   ├── quota-checker.ts   # Quota checking
│       │   ├── usage-tracker.ts   # Per-key usage tracking
│       │   ├── key-logger.ts      # Per-key isolated logging
│       │   ├── key-session-tracker.ts  # Per-key session tracking
│       │   └── key-resolver.ts    # sk_ Key resolution
│       └── transformers/
├── tauri/                   # Tauri desktop application
│   ├── src/
│   │   └── main.rs              # Rust main process
│   ├── icons/                   # Application icons
│   ├── Cargo.toml               # Rust dependencies
│   ├── tauri.conf.json          # Tauri configuration
│   └── build.rs                 # Build script
├── dist/                        # Build output
│   ├── ui/                      # Frontend build
│   └── server/                  # Backend build
├── bin/                         # CLI scripts
│   ├── cli.js
│   ├── start.js
│   ├── stop.js
│   ├── restart.js
├── types/                       # TypeScript types
├── documents/                   # Documentation
│   ├── tauri-research.md        # Tauri migration research
│   └── TAURI_BUILD_GUIDE.md    # Tauri build guide
├── package.json
├── vite.config.ts
├── tsconfig.json
└── CLAUDE.md                    # This file
```

## Build and Deployment

### Traditional CLI/Web Deployment

1. Run `npm run build` to create production builds
2. UI build outputs to `dist/ui/` (static files)
3. Server build outputs to `dist/server/` (JavaScript)
4. Configuration files are created in user's home directory on first run

### Tauri Desktop Application Build

#### Prerequisites

**Install Rust Toolchain:**
```bash
# Windows, macOS, Linux
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**Install Node.js:**
- Node.js is **required** to run the application backend
- Download from: https://nodejs.org/ (LTS version recommended)
- The application will check for Node.js installation on startup and display a friendly error message if not found

**Platform-Specific Requirements:**

- **Windows**:
  - Microsoft Visual Studio C++ Build Tools
  - WebView2 (usually pre-installed on Windows 10/11)

- **macOS**:
  - Xcode Command Line Tools: `xcode-select --install`

- **Linux**:
  ```bash
  # Debian/Ubuntu
  sudo apt install libwebkit2gtk-4.1-dev \
    build-essential \
    curl \
    wget \
    file \
    libssl-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev
  ```

#### Build Process

1. **Generate Application Icons** (optional, if you have a custom icon):
   ```bash
   npm run tauri:icon path/to/your/icon.png
   ```

2. **Development Mode**:
   ```bash
   npm run tauri:dev
   ```
   This will:
   - Start the Vite dev server for the UI
   - Compile the Rust code
   - Launch the Tauri window with hot-reload

3. **Production Build**:
   ```bash
   npm run tauri:build
   ```
   This will:
   - Build the React UI (`npm run build:ui`)
   - Build the Node.js server (`npm run build:server`)
   - **Sync version** (`prepare-resources.js` → `sync-version.js`): sync `package.json` version to `tauri/tauri.conf.json` and `tauri/Cargo.toml` before Rust compile
   - Compile the Rust code in release mode
   - Bundle the application with all resources
   - Create platform-specific installers

   > **Version Sync**: `package.json` is the single source of truth for the version. `tauri/sync-version.js` syncs it to `tauri.conf.json` (top-level `version`) and `Cargo.toml` (`[package] version`) via precise regex (only writes when the value differs; never touches dependency `{ version = "x" }`). It runs automatically inside `prepare-resources.js` (so `tauri:build` is always in sync before cargo compile), and can be triggered manually with `npm run version:sync`. This prevents installer version mismatches that cause Windows to reject overwrite upgrades.

#### Build Output

**Windows:**
- `tauri/target/release/aicodeswitch.exe` - Executable
- `tauri/target/release/bundle/msi/` - MSI installer
- `tauri/target/release/bundle/nsis/` - NSIS installer

**macOS:**
- `tauri/target/release/aicodeswitch` - Executable
- `tauri/target/release/bundle/dmg/` - DMG installer
- `tauri/target/release/bundle/macos/` - .app bundle

#### Application Size Comparison

| Build Type | Size | Notes |
|------------|------|-------|
| Tauri (without Node.js) | ~10-20 MB | Requires Node.js pre-installed |
| Tauri (with Node.js) | ~50-70 MB | Bundles Node.js runtime |
| Traditional Electron | ~150-200 MB | Bundles Chromium + Node.js |

### Tauri Hybrid Architecture Details

The Tauri build uses a **hybrid approach** that preserves the existing Node.js backend:

1. **Tauri Main Process (Rust)**:
   - Manages application lifecycle
   - Creates and controls the WebView window
   - Spawns and monitors the Node.js backend process
   - Provides IPC commands for frontend-backend communication

2. **Node.js Backend Process**:
   - Runs the existing Express server unchanged
   - Handles all proxy logic, API transformations, and database operations
   - Listens on localhost:4567 (configurable)

3. **React Frontend (WebView)**:
   - Rendered in the system's native WebView
   - Communicates with Node.js backend via HTTP (localhost)
   - Uses standard fetch/axios for API requests
   - No special Tauri integration required in React code

**Key Benefits:**
- ✅ No backend rewrite required
- ✅ All existing Node.js code works as-is
- ✅ Significantly smaller application size
- ✅ Better system integration
- ✅ Cross-platform support (Windows, macOS)
- ✅ Future migration path to full Rust backend if desired

## Technology Stack

### Backend
- **Runtime**: Node.js
- **Framework**: Express
- **Language**: TypeScript
- **Database**: JSON File Storage (no database dependencies)
- **Streaming**: SSE (Server-Sent Events)
- **HTTP Client**: Axios
- **Encryption**: CryptoJS (AES)

### Frontend
- **Framework**: React 18
- **Language**: TypeScript
- **Build Tool**: Vite
- **Routing**: React Router
- **UI Components**: Custom components

### Desktop Application (Tauri)
- **Core**: Tauri 2.0
- **Language**: Rust (main process)
- **WebView**: System native (WebView2 on Windows, WebKit on macOS)
- **IPC**: Tauri command system
- **Process Management**: Rust std::process

### CLI
- **Implementation**: Custom Yargs-like CLI
- **Process Management**: Node.js child_process

## CI/CD Pipeline

### NPM 发布流程
当 PR 合并到 main 分支时，自动触发 npm 发布：
1. 检查当前版本是否已被 npm 注册（使用 `can-npm-publish`）
2. 若当前版本未发布，直接使用该版本发布；否则运行 `npm run release` 创建新版本
3. 发布到 npm registry
4. 推送 tag 到 GitHub

### Tauri 应用构建流程
npm 发布成功后，自动触发 Tauri 应用构建：
1. **触发条件**:
   - "Publish To NPM" 工作流成功完成
   - 或手动触发（可指定版本号）

2. **构建矩阵**:
   - **macOS**: (两个架构分别构建)
     - Intel (x86_64): `.dmg`, `.app`
     - Apple Silicon (aarch64): `.dmg`, `.app`
   - **Windows**: Windows Latest (x86_64)
     - 输出: `.msi`, `.exe` (NSIS)

3. **发布到 GitHub Release**:
   - 自动创建或更新 Release
   - 上传所有平台的安装包
   - 包含下载说明和系统要求

4. **手动触发构建**:
   - 在 GitHub Actions 页面选择 "Build and Release Tauri App"
   - 可选：指定版本号（不指定则使用 package.json 中的版本）

### 工作流文件
- `.github/workflows/publish-to-npm.yaml` - NPM 发布
- `.github/workflows/build-tauri.yaml` - Tauri 构建和发布

## 最近变更

- 2026-06-22: 密钥详情页新增"会话"Tab
  - 密钥详情页新增"会话"Tab，支持按密钥查看独立会话列表（搜索、过滤、分页、自动刷新）
  - 每密钥独立会话存储（`key-sessions/<keyId>/sessions.json`），与全局会话系统完全隔离
  - 会话详情弹窗支持日志模式和对话模式双视图，支持 JSON 导出
  - 代理请求处理中自动追踪密钥级会话（覆盖全部代理路径）
  - 新增 `KeySessionTracker` 模块（`key-session-tracker.ts`）、`KeyLogger.getLogsBySessionId()` 方法
  - 提取共享聊天工具函数到 `session-chat-utils.tsx`（ChatViewFromSessionLogs、CollapsibleChatContent 等）
  - 新增 6 个 API 端点（`/api/access-keys/:id/sessions` 系列）

- 2026-06-20: 新增局域网配置同步功能
  - 设置页面新增"局域网同步"卡片（`enableLanDiscovery` 开关），控制本节点是否可被局域网内其他节点发现
  - 路由管理页面新增"同步配置"按钮，打开 `SyncConfigModal` 五步弹窗
  - 五步流程：扫描发现节点 → 选择 Skills → 选择 MCP → 供应商配置 → 预览确认
  - 后端新增 `GET /api/lan/discover`（免鉴权，由开关控制）、`GET /api/lan/scan`、`POST /api/lan/sync`
  - Skills 同步包含 SKILL.md 内容，MCP 同步包含完整配置（command/args/env/url），重名项自动禁用

- 2026-06-15: Tauri 后端启动健壮性与诊断增强
  - spawn 前主动检测 Node（`node --version` + Windows `where node`），未安装 / 不在 PATH / 版本过低时秒级报错，不再干等超时
  - 启动失败收集结构化诊断（Node 路径/版本、入口文件存在性、子进程状态、端口占用、启动日志尾部 40 行），在启动屏展示并支持一键复制、根因速判
  - 健康检查超时 15s → 30s，可用环境变量 `AIC_STARTUP_TIMEOUT`（秒）覆盖；失败后强制清理残留子进程
  - 修复 Node 端 `checkPortUsable` 无超时（1.5s 兜底）；修复 `app.listen` 的 `EADDRINUSE` 等错误被全局 `uncaughtException` 静默吞掉（改为明确报错并退出，启动期未捕获异常同样退出）
  - 影响文件：`tauri/src/main.rs`、`tauri/screens/index.html`、`src/server/utils.ts`、`src/server/main.ts`

- 2026-06-10: 认证体系简化与密钥详情页 Tabs 改造
  - 移除全局 `config.apiKey` 认证，简化为 AUTH 驱动的 AccessKey-only 认证
  - AUTH 未配置时：隐藏"接入密钥"菜单，代理无需认证；AUTH 已配置时：显示"接入密钥"，隐藏"会话""日志"，代理必须 AccessKey 认证
  - 密钥详情页重构为 Tabs 布局（基本信息 / 统计 / 日志），复用 LogDetailModal 和 Pagination 组件
  - 新增"写入本地"功能：将 AccessKey 真实 Key 写入 Claude Code / Codex 本地配置文件

- 2026-06-10: 新增 AccessKey 接入密钥共享功能
  - 通过 `sk_` 前缀 API Key 实现多端接入共享，无需用户体系
  - 策略（Policy）管理：路由绑定 + 多维配额限制 + 模型过滤
  - 每个 Key 独立的日志和统计空间，与现有系统完全隔离
  - 支持三种认证 Header：`Authorization: Bearer`、`x-api-key`、`x-goog-api-key`
  - 管理面板 JWT 认证从 `Authorization` 迁移到 `Access-Token` Header
  - 当 AUTH 开启时，带有 `Authorization` Header 的请求跳过管理面板认证，由代理引擎处理 AccessKey 鉴权

- 2026-03-11: 修复 Claude Code → Gemini thinking 参数冲突
  - 当存在 `budget_tokens` 时，Gemini `thinkingConfig` 仅写入 `thinkingBudget`，不再同时写入 `thinkingLevel`
  - 同步修复 `transformRequestFromClaudeToGemini` 与 `transformRequestFromResponsesToGemini`，避免 400 `You can only set only one of thinking budget and thinking level`

## Development

* 使用yarn作为包管理器，请使用yarn安装依赖，使用yarn来运行脚本。
* 前端依赖库安装在devDependencies中，请使用yarn install --dev安装。
* 所有对话请使用中文。生成代码中的文案及相关注释根据代码原本的语言生成。
* 在服务端，直接使用 __dirname 来获取当前目录，不要使用 process.cwd()
* 每次有新的架构变化时，你需要更新 CLAUDE.md, AGENTS.md 来让文档保持最新。
* 每次有变更，以非常简单的概述，将变化内容记录到 CHANGELOG.md 中。
* 禁止在ui中使用依赖GPU的css样式。
* 禁止运行 dev:ui, dev:server, tauri:dev 等命令来进行测试。
* 如果你需要创建文档，必须将文档放在 documents 目录下
* 如果你需要创建测试脚本，必须将脚本文件放在 scripts 目录下
* currentDate: Today's date is 2026-02-20.

**注意，codex已经不再支持 `wire_api = "chat"` 的设置了，因此，由codex发起的请求，一定是和 Responses API 的请求数据一致。**

## 禁止执行

- 禁止使用 git 命令来恢复代码，避免手动修改的代码被恢复后功能丢失
