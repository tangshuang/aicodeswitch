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

### Electron Desktop Application
```bash
npm run electron:dev     # Run Electron development mode (vite + electron)
npm run electron:start   # Build and launch Electron app from current dist
npm run electron:build   # Build Electron desktop application (outputs to release/)
npm run electron:icon    # Copy logo to build/icon.png
```

**Prerequisites for Electron build:**
- Node.js ≥ 18 (for building only; end users do NOT need Node.js installed — the backend runs in-process inside Electron's bundled Node runtime)
- electron-builder handles all native packaging toolchain automatically; no Rust toolchain required

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

#### Electron Desktop Application (In-Process Backend)
```
┌─────────────────────────────────────────────────────────────┐
│              Electron Desktop Application                   │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Electron Main Process (`electron/main.js`)          │  │
│  │  - Window Management                                 │  │
│  │  - In-Process Express Server                         │  │
│  │    (require()s dist/server/main.js, calls start())   │  │
│  │  - Health Polling + navigate to http://127.0.0.1:PORT│  │
│  │  - gracefulShutdown() on before-quit                 │  │
│  │  - System Integration (tray, file dialogs)           │  │
│  └──────────────────────────────────────────────────────┘  │
│            │                           │                    │
│            ▼                           ▼                    │
│  ┌──────────────────┐      ┌──────────────────┐           │
│  │  WebView (React) │      │  In-Process Node │           │
│  │  - UI Components │ HTTP │    Backend       │           │
│  │  - User Interface│◄─────┤  - Express Server│           │
│  └──────────────────┘      │  - Proxy Logic   │           │
│                             │  - Database      │           │
│                             └──────────────────┘           │
└─────────────────────────────────────────────────────────────┘
```

**Electron In-Process Approach Benefits:**
- **No Node.js Prerequisite**: Backend runs inside Electron's bundled Node runtime; end users never need to install Node.js
- **Single-Process Simplicity**: No child-process lifecycle, port-detection, or IPC-with-subprocess to manage
- **No Backend Rewrite**: Existing Express server loaded via `require('dist/server/main.js').start()` works as-is
- **Cross-Platform**: Windows, macOS, and Linux support via electron-builder
- **Familiar Toolchain**: Pure JavaScript on the main process side, debuggable with standard Node tooling

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
- **Route Matching**: Finds active route based on target type (claude-code/codex/opencode)
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

#### 5.8. Agent Map Module - `server/agent-map/`
- **Purpose**: 任务可视化节点地图（observe-only），把每个 Claude Code / Codex Session 画成画布节点，状态由活跃度自动推断并经 SSE 实时推送
- **设计要点**：
  - 纯观测，不驱动 Agent / 不涉及 ATO；数据全部来自代理 `finalizeLog` 采集点
  - **状态推断**（可靠活动时钟 + 轮次语义，2026-06-23 重构）：`active` 严格 =「有在途请求且存活」——SSE 流已开始产出后普通 30s / 思考 3min（`THINKING_SILENCE_MS`）内有新 chunk（`heartbeat`）/首 Token 前在 5min 内；同步请求在 5min 内。**无在途（`inFlight==0`）时按上一轮响应语义分流**：末响应 `tool_use`（`lastTurnEnd===false`，客户端正在本地执行工具）→ 保持 active、且**不可通知**；末响应 `end_turn`（`lastTurnEnd===true`）或未知（`null`）→ idle/completed、可通知。末次 5xx → `error`。`detectTurnEnd` 对 Claude `stop_reason` / Codex `function_call`+`response.completed` 解析可靠。
  - **Thinking 识别**：`proxyRequest` 复用路由同款识别（`rule.contentType==='thinking'` 或 `hasThinkingSignal(req.body)`），经 `startRequest({thinking})` → `thinkingInFlight` 计数；思考期间 SSE 静默上限放宽到 3min，避免思考静默被误判停滞。
  - **在途注册表 + 陈旧度清扫**：`proxyRequest` 入口 `startRequest`、流式建立时 `markStreaming`、每个下游 chunk `heartbeat`、`finalizeLog` 内 `endRequest`。15s `sweep` 检测在途陈旧（SSE 30s / 思考 3min / 同步 5min）→ 强制转 idle 并**清零泄漏的在途计数器**（修复「永远卡在进行中」）；`startRequest` 还挂 `res.on('close')` 安全网，确保早退场景 `endRequest` 必触发一次。
  - **任务结束通知 + 展示状态防抖（经 `NOTIFY_DEBOUNCE_MS` 默认 8s 对齐）**：检测到一轮结束（`onFinalized`：`inFlight==0` 且末响应非 `tool_use`）即调度防抖通知；同时 `inferStatus` 在「结束」情形（end_turn / 未知）下**保持 `active` 满 8s** 才落实 `idle`——这样请求边界处不会「闪一下空闲」，期间发起新主请求会刷新 `lastActivityAt` 并取消挂起通知，继续保持 `active`、不弹。`fireNotify` 在防抖期满时把状态落实为 `idle`（仅 `inFlight==0`）并弹通知。`tool_use`（`lastTurnEnd===false`）保持 active、永不通知；后台类请求（`background`/`compact`/`count_tokens`）不取消挂起通知、不重置 `notifiedForTurn`，保证主任务真实结束仍能通知；499（用户取消）不弹；5xx 弹 ⚠️；`fireNotify` 复检开关 + 60s 冷却兜底。开关 `AppConfig.agentMapNotifyEnabled` 持久化。
  - **活动解析**：`activity-extractor.ts` 从单次请求抽出 `ActivityEvent`（prompt/tool_use/response/thinking/error），兼容 Claude/OpenAI/Responses/流式四种格式
  - 服务自持运行时态（不依赖 dbManager 做状态推断，兼容 global/access-key 两套会话存储）；dbManager 仅用于 attach 时种子化已有全局 Session
- **Key Files**: `agent-map-service.ts`（单例：在途注册表 + 可靠活动时钟 + 状态引擎 + 事件环形缓冲 + EventEmitter 广播 + 15s 清扫）、`activity-extractor.ts`、`routes.ts`、`index.ts`
- **HTTP API**: `GET /api/agent-map/stream`（SSE：init 快照 + session-update/activity/stats/heartbeat + 3s 心跳）、`/sessions`、`/sessions/:id/events?since=`、`/stats`
- **main.ts 接线**: `agentMapService.attach(dbManager)` + `registerAgentMapRoutes(app, agentMapService)`
- **proxy-server 归因**: `finalizeLog` 内 `onFinalized` 提取活动/重算状态/广播（覆盖普通路由 + AccessKey 两条分支，独立于 enableLogging）
- **前端**: `AgentMapPage.tsx`（菜单"任务地图"，默认首页 `/` 重定向至此）—— SVG 节点画布（状态光晕脉冲 + 拖拽布局 localStorage 持久化）+ 详情活动路径子图 + 全局活动流；SSE 走 fetch+getReader（带 `Access-Token`）

#### 6. UI (React) - `ui/`
- Main app: `App.tsx` - Navigation and layout with collapsible sidebar
- Components:
  - `Tooltip.tsx` - Tooltip component for displaying menu text when sidebar is collapsed
  - `Toast.tsx` - Toast notification component
  - `Confirm.tsx` - Confirmation dialog component
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
  - **TargetType**: 路由目标类型（'claude-code', 'codex', 'opencode'）

#### 9.5 OpenCode 目标工具（与 Claude Code / Codex 平级）

- **协议**：OpenCode 客户端经 `@ai-sdk/openai-compatible` 使用 **OpenAI Chat Completions** 格式直连代理，`baseURL = http://127.0.0.1:{PORT}/opencode/v1`，代理实际收到 `/opencode/v1/chat/completions`、`/opencode/v1/models`。内部映射为 `Format = 'completions'`（由 `clientFormatForTool()` 统一），复用既有 completions↔claude/responses/gemini 转换对，**无需新增转换代码**。
- **配置文件生命周期**：`~/.config/opencode/opencode.json`（纯 JSON，复用 `mergeJsonConfig`）。托管字段为 `provider.aicodeswitch` 段 + `model`/`small_model`/`mcp`（见 `config-managed-fields.ts` 的 `OPENCODE_CONFIG_MANAGED_FIELDS`）。`writeOpencodeConfig`/`restoreOpencodeConfig` 接入启动/全局更新/关闭三处生命周期；检测器 `isOpencodeProxyConfig`/`checkOpencodeConfigStatus`；fallback 读 `readOpencodeOriginalConfig`。CLI `aicos restore opencode`。
- **与 Claude Code 的差异**：OpenCode 无 count_tokens 端点、无类似 Claude Code 的特殊 compact 端点（其 compaction 是客户端内部行为，发普通 chat completion），故不触发 `shouldHandleCountTokensLocally` / compact guardrails（这些逻辑均门控在 `targetType === 'claude-code'`）。
- **MCP**：写入 `opencode.json` 的 `mcp` 段，格式 `{ type: 'local'|'remote', command?: [...], url?, enabled, env?/headers? }`（见 `writeMCPConfig` 的 opencode 分支）。
- **Skills**：OpenCode 没有 skills 目录/symlink 机制，故把每个启用到 opencode 的 Skill **转写为全局 command** 写入 `~/.config/opencode/commands/<skillId>.md`（frontmatter `description`+`agent: build`，正文取自 `SKILL.md` body）。复用 `createSkillSymlink`/`removeSkillSymlink`/`isSkillSymlinkExists` 的 opencode 分支（普通文件而非 symlink）；`getInstalledSkills` 与删 Skill 的 forEach、enable/disable 端点的 target 校验均含 opencode。语义差异：OpenCode command 是 `/skill-id` 显式触发的提示词模板，非 Claude Skill 的按需能力包。

#### 9. Electron Desktop Application - `electron/`
- **electron/main.js**: Electron main process
  - Window management (create, restore, close)
  - In-process server lifecycle: sets `process.env.AIC_IN_PROCESS='1'`, `PORT`, `NODE_ENV='production'`, then `require()`s `dist/server/main.js` and calls the exported `start()`
  - Health polling of `http://127.0.0.1:{PORT}/api/...`; once ready, navigates the window from `loading.html` to the served UI
  - On `before-quit`, calls the server module's exported `gracefulShutdown()` (restores Claude/Codex/OpenCode configs, closes DB/logs, releases the port) — in-process mode does NOT call `process.exit`
  - System integration (tray icon, file dialogs, app menu)
- **electron/preload.js**: contextBridge IPC
  - Exposes `aicodeswitch.onStartupLog(cb)` and `aicodeswitch.onStartupError(cb)` to the renderer so `loading.html` can show real-time startup logs and recover from errors
- **electron/loading.html**: Startup / error screen
  - Loaded before the server is ready; shows progress and a watchdog timer
  - Receives startup logs/errors over the preload bridge; offers fallback guidance (e.g. use the CLI version) on failure
- **Backend module contract**: `dist/server/main.js` must export `start()` and `gracefulShutdown()`. Electron sets `AIC_IN_PROCESS=1` so the server knows it is running in-process (e.g. skip `process.exit`, keep the event loop alive for the host). The `/api/shutdown` HTTP endpoint remains as a fallback.

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
  - Electron 关闭窗口后通过 before-quit 触发 gracefulQuit()
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
  - **存储与查询**：请求日志用 NDJSON 分片存储（`log-store/{namespace}/*.ndjson`，namespace 为 `global` 或 `key:{keyId}`），sidecar 索引包括 `shards-index.json` / `session-index.json` / `tombstones.json` / **`timeline-index.json`**（时间线索引）
    - **时间线索引**（`TimelineEntry[]`）：常驻内存的轻量描述符（`{file, offset, length, ts, id, targetType, vendorId, targetServiceId, targetModel}`），append 顺序维护、防抖落盘。`getRecent` / `query` 无关键词时走索引切片（零扫描、仅 hydrate 当前页），深翻页常量化；sidecar 缺失/过期时 `loadNsState` 触发后台一次性 `rebuildTimeline`，期间回退扫描。
    - **统一查询** `LogStore.query(ns, {filters, keyword, since, until, limit, offset})` → `{data, total}`：字段筛选无关键词走索引、有关键词回退全量扫描。`GET /api/logs` 接收 `targetType/vendorId/serviceId/model/keyword` 并返回 `{logs, total}`。
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
3. **Config File**: `~/.aicodeswitch/aicodeswitch.conf` (PORT, AUTH)。监听地址由 AUTH 决定（AUTH 开→`0.0.0.0` / AUTH 关→`127.0.0.1`），`HOST` 已忽略；写入本地工具配置与 UI/CLI 展示地址恒为 `127.0.0.1`
4. **Dev Ports**: UI (4568), Server (4567) - configured in `vite.config.ts` and `server/main.ts`
5. **Skills Search**: `SKILLSMP_API_KEY` is required for Skills discovery via SkillsMP
6. **API Endpoints**: All routes are prefixed with `/api/` except proxy routes (`/claude-code/`, `/codex/`, `/opencode/`)

### Electron Development Tips

1. **First-Time Setup**:
   - No Rust toolchain needed; just run `yarn install` (Electron + electron-builder come from devDependencies)
   - Run `npm run electron:dev` to verify the desktop setup (builds the server if missing, starts vite, launches Electron pointing at the vite dev server)

2. **Development Workflow**:
   - Use `npm run dev` for web development (faster iteration; vite + tsx watch)
   - Use `npm run electron:dev` when testing desktop-specific features (`scripts/electron-dev.js` sets `AIC_ELECTRON_DEV_SERVER=http://localhost:17808` so Electron loads the live UI from vite)
   - React UI communicates with the backend over plain HTTP to `http://127.0.0.1:{PORT}` — no special Electron API surface required in React code

3. **Backend Process Management**:
   - In Electron mode, the backend runs **in-process**: `electron/main.js` `require()`s `dist/server/main.js` and calls the exported `start()`. There is no child process to spawn or monitor.
   - In web mode, you manually start the backend with `npm run dev:server`
   - The backend always listens on `127.0.0.1` (PORT from `~/.aicodeswitch/aicodeswitch.conf`, default 4567)
   - **Service Detection**: On startup, Electron checks whether the configured port is already in use. If a Node server is already running (started via `aicos start` or a leftover), it POSTs `/api/shutdown` to the old service so it restores configs and exits; if unresponsive, the port's PID is killed (Unix `lsof`+`kill`, Windows `netstat`+`taskkill`).
   - On exit, Electron's `before-quit` calls the server module's exported `gracefulShutdown()` (same path as `aicos stop`'s SIGTERM), which runs `restoreClaudeConfig` / `restoreCodexConfig` / `restoreOpencodeConfig`, closes DB/log handles, and releases the port. In-process mode never calls `process.exit`. The `/api/shutdown` HTTP endpoint remains as a fallback.

4. **Debugging**:
   - **Renderer (React)**: Browser DevTools (F12 / Cmd+Opt+I) inside the Electron window
   - **Main process & backend**: Launch with `--inspect` (or `ELECTRON_ENABLE_LOGGING=1`) and attach a Node inspector; backend logs are also written to `~/.aicodeswitch/app-launch-debug.log`
   - **Build Issues**: electron-builder diagnostics appear in `release/` and stdout; the bundled app root (`app.getAppPath()`) contains `dist/`, `electron/`, and `package.json`

5. **Icon**:
   - Source is `build/icon.png` (a 1024×1024 PNG, copied from `src/ui/assets/logo.png` by `npm run electron:icon`)
   - electron-builder auto-generates `.ico` (Windows) and `.icns` (macOS) from it at build time; no manual per-platform icon generation

6. **No Node.js Detection Needed**:
   - Because the backend runs inside Electron's bundled Node runtime, end users do NOT need Node.js installed. There is no runtime Node.js prerequisite check.

7. **Auto-Deactivate Routes on Exit**:
   - When the application is closed, it automatically deactivates all active routes (via `before-quit` → `gracefulShutdown()` path) before restoring config files
   - This prevents configuration files from remaining in an overwritten state
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
├── electron/                # Electron desktop application (in-process backend)
│   ├── main.js                  # Main process: window mgmt + in-process server lifecycle
│   ├── preload.js               # contextBridge IPC (startup logs/errors)
│   └── loading.html             # Startup / error screen (watchdog via IPC)
├── build/                   # electron-builder resources
│   └── icon.png                 # 1024x1024 source icon (electron-builder derives .ico/.icns)
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
├── package.json                 # Includes `build` field (electron-builder config)
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

### Electron Desktop Application Build

#### Prerequisites

**Install Node.js:**
- Node.js ≥ 18 is required **to build** the application (LTS recommended)
- Download from: https://nodejs.org/
- End users do NOT need Node.js installed — the backend runs in-process inside Electron's bundled Node runtime

**No Rust Toolchain Required:**
- electron-builder handles all native packaging toolchain automatically; there is no `Cargo.toml`, `rustc`, or `tauri.conf.json` involved anymore.

**Platform Notes:**

- **Windows**: WebView2 runtime (pre-installed on Windows 10/11)
- **macOS**: No special requirements
- **Linux**: `libgtk-3`, `libnotify`, `libnss3`, `libxss1`, `libxtst6`, `xdg-utils` (typical on modern desktop distros)

#### Build Process

1. **Seed the icon** (already committed in this repo, only needed if you replace the logo):
   ```bash
   npm run electron:icon    # copies src/ui/assets/logo.png -> build/icon.png
   ```

2. **Development Mode**:
   ```bash
   npm run electron:dev     # scripts/electron-dev.js
   ```
   This will:
   - Build the server (`yarn build:server`) if `dist/server/main.js` is missing
   - Start the Vite dev server for the UI on `http://localhost:17808`
   - Launch Electron with `AIC_ELECTRON_DEV_SERVER=http://localhost:17808` so the window loads the live UI

3. **Production Build**:
   ```bash
   npm run electron:build   # yarn build && electron-builder
   ```
   This will:
   - Build the React UI (`yarn build:ui`) and the Node.js server (`yarn build:server`) into `dist/`
   - Run **electron-builder**, which reads the `build` field of `package.json` (`appId: net.tangshuang.aicodeswitch`, `productName: AI Code Switch`, output dir `release/`, `asar: false`, `extraMetadata.main: electron/main.js`) and packages `dist/**`, `electron/**`, and `package.json` (node_modules pruned automatically)
   - Create platform-specific installers in `release/`

   > **Version**: Read directly from `package.json`. There is no separate version-sync step (the old `sync-version.js` / `prepare-resources.js` / `move-bundle.js` scripts have been removed with the Tauri migration).

#### Build Output (electron-builder, in `release/`)

**Windows:**
- `.exe` (NSIS installer)

**macOS:**
- `.dmg`
- `.zip` (contains the `.app` bundle)

**Linux:**
- `.AppImage`
- `.deb`

#### Application Size

| Build Type | Size | Notes |
|------------|------|-------|
| Electron (bundled) | ~80-120 MB | Bundles Chromium + Node runtime; backend runs in-process |

Larger than the old Tauri shell, but the trade-off buys single-process simplicity and removes the end-user Node.js prerequisite.

### Electron In-Process Architecture Details

The Electron build loads the existing Node.js backend **in-process** — there is no child Node process to spawn:

1. **Electron Main Process (`electron/main.js`)**:
   - Manages application lifecycle and creates the BrowserWindow
   - Sets `process.env.AIC_IN_PROCESS='1'`, `process.env.PORT`, `process.env.NODE_ENV='production'`, then `require()`s `dist/server/main.js` and calls the exported `start()`
   - Polls `http://127.0.0.1:{PORT}` for health; once ready, navigates the window from `loading.html` to the served UI
   - On `before-quit`, calls the server module's exported `gracefulShutdown()` (restores Claude/Codex/OpenCode configs, closes DB/log handles, releases the port). In-process mode does NOT call `process.exit`.
   - `electron/preload.js` exposes `aicodeswitch.onStartupLog(cb)` / `aicodeswitch.onStartupError(cb)` to the renderer via contextBridge

2. **In-Process Node Backend**:
   - Runs the existing Express server unchanged (loaded via `require`)
   - Handles all proxy logic, API transformations, and database operations
   - Listens on `127.0.0.1:{PORT}` (default 4567, configurable via `~/.aicodeswitch/aicodeswitch.conf`)

3. **React Frontend (Renderer / WebView)**:
   - Rendered in the system's native WebView (WebView2 on Windows, WebKit on macOS/Linux)
   - Communicates with the in-process backend via plain HTTP to `http://127.0.0.1:{PORT}`
   - Uses standard fetch/axios; no Electron-specific API surface required in React code

**Key Benefits:**
- ✅ No backend rewrite required — existing Node.js code works as-is
- ✅ No Node.js prerequisite for end users (bundled runtime)
- ✅ Single process = no child-process lifecycle, port-detection, or IPC-with-subprocess complexity
- ✅ Cross-platform support (Windows, macOS, Linux)

**Trade-off:**
- ⚠️ Larger bundle (~80-120 MB) than the old Tauri shell, because it bundles Chromium + the Node runtime

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

### Desktop Application (Electron)
- **Core**: Electron 33
- **Language**: JavaScript (main process, reuses the existing Node backend in-process)
- **WebView**: System native (WebView2 on Windows, WebKit on macOS/Linux)
- **IPC**: Electron contextBridge (preload script)
- **Packaging**: electron-builder (config in `package.json` `build` field)

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

### Electron 应用构建流程
npm 发布成功后，自动触发 Electron 应用构建：
1. **触发条件**:
   - "Publish To NPM" 工作流成功完成
   - 或手动触发（可指定版本号）

2. **构建矩阵**:
   - **Windows**: windows-latest (x86_64)
     - 输出: `.exe` (NSIS)
   - **macOS**: (两个架构分别构建)
     - macos-14 (Apple Silicon, arm64): `.dmg`, `.zip`
     - macos-13 (Intel, x64): `.dmg`, `.zip`
   - **Linux**: ubuntu-22.04 (x64)
     - 输出: `.AppImage`, `.deb`

3. **发布到 GitHub Release**:
   - 自动创建或更新 Release
   - 上传所有平台的安装包（产物命名：`AI-Code-Switch-{version}-{platform}-{arch}.{ext}`）
   - 包含下载说明和系统要求

4. **手动触发构建**:
   - 在 GitHub Actions 页面选择 "Build and Release Electron App"
   - 可选：指定版本号（不指定则使用 package.json 中的版本）

### 工作流文件
- `.github/workflows/publish-to-npm.yaml` - NPM 发布
- `.github/workflows/build-electron.yaml` - Electron 构建和发布

## 最近变更

- 2026-07-06: 桌面端从 Tauri 迁移到 Electron
  - 桌面端整体从 Tauri (Rust + 外部 Node.js 子进程) 迁移到 Electron，后端 Express 服务器以**进程内嵌（in-process）**方式运行：`electron/main.js` 通过 `require('dist/server/main.js')` 调用其导出的 `start()` / `gracefulShutdown()`，并设置 `process.env.AIC_IN_PROCESS='1'`
  - 移除整个 `tauri/` 目录（含 `Cargo.toml`、`tauri.conf.json`、`main.rs`、`prepare-resources.js`、`sync-version.js`、`move-bundle.js`），不再需要 Rust 工具链
  - 新增桌面入口：`electron/main.js`（主进程：窗口 + 进程内服务器生命周期 + 健康轮询 + 跳转 + `before-quit` 触发 `gracefulShutdown`）、`electron/preload.js`（contextBridge 暴露 `onStartupLog` / `onStartupError`）、`electron/loading.html`（启动屏 + 看门狗）
  - 打包改用 `electron` + `electron-builder`（devDependencies），配置写在 `package.json` 的 `build` 字段（`appId: net.tangshuang.aicodeswitch`、`productName: AI Code Switch`、输出目录 `release/`、`asar: false`、`extraMetadata.main: electron/main.js`）；图标源文件 `build/icon.png`（1024×1024，由 `src/ui/assets/logo.png` 拷贝），electron-builder 自动生成 `.ico`/`.icns`
  - 新增 npm 脚本：`electron:dev`（`scripts/electron-dev.js`，构建缺失的服务端后启动 vite 并以 `AIC_ELECTRON_DEV_SERVER=http://localhost:17808` 拉起 Electron）、`electron:start`（`yarn build && electron .`）、`electron:build`（`yarn build && electron-builder`，输出到 `release/`）、`electron:icon`（拷贝 logo 到 `build/icon.png`）
  - CI 由 `.github/workflows/build-electron.yaml` 取代 `build-tauri.yaml`：在 "Publish To NPM" 成功后或手动触发；矩阵 windows-latest (nsis) / macos-14 (arm64 dmg+zip) / macos-13 (x64 dmg+zip) / ubuntu-22.04 (AppImage+deb)；产物命名 `AI-Code-Switch-{version}-{platform}-{arch}.{ext}` 并上传到 GitHub Release
  - 关键收益：终端用户**无需再安装 Node.js**（后端跑在 Electron 自带的 Node 运行时里）

- 2026-06-22: 新增 Agent Map（任务可视化节点地图）
  - 游戏化节点地图：把每个 Claude Code / Codex Session 画成画布节点，状态（进行中/空闲/已完成/异常）由活跃度自动推断并经 SSE 实时刷新；点开节点查看活动路径子图（提问→工具调用链→响应）
  - 纯观测功能：数据全部复用代理已有流量，不驱动 Agent、不涉及未实现的 ATO 编排
  - 新增 `server/agent-map/` 模块（`agent-map-service.ts` 单例：在途注册表 + 状态推断引擎 + 活动事件环形缓冲 + EventEmitter 广播 + 15s 状态清扫；`activity-extractor.ts` 服务端活动解析，兼容 Claude/OpenAI/Responses/流式；`routes.ts` SSE+REST）
  - 采集接入点：`proxy-server.ts` `proxyRequest` 入口 `agentMapService.startRequest`、`finalizeLog` 内 `endRequest`+`onFinalized`（独立于 enableLogging，覆盖普通路由 + AccessKey 两条分支）
  - `main.ts` 启动时 `agentMapService.attach(dbManager)`（种子化已有 Session + 启动清扫定时器），`registerRoutes` 内注册 `/api/agent-map/*`
  - `Session` 类型扩展 `status`/`lastActivitySummary`/`lastToolName`/`lastStatusCode`（可选，兼容旧数据）；新增 `ActivityEvent`/`SessionMapItem`/`AgentMapStats`/`AgentMapStreamEvent` 类型
  - 前端 `AgentMapPage.tsx`：SVG 节点画布（状态光晕脉冲、拖拽布局持久化）+ 详情活动路径子图 + 全局活动流；`/api/agent-map/stream` 走 fetch+getReader（带 Access-Token）
  - 移除 App.tsx 中指向不存在 HomePage.tsx 的 ATO 遗留菜单/路由，默认首页重定向到 `/agent-map`

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
* 每次有**代码**变更（忽略文档变更），以非常简单的概述，将变化内容记录到 CHANGELOG.md 中。
* 禁止在ui中使用依赖GPU的css样式。
* 禁止运行 dev:ui, dev:server, electron:dev 等命令来进行测试。
* 如果你需要创建文档，必须将文档放在 documents 目录下
* 如果你需要创建测试脚本，必须将脚本文件放在 scripts 目录下
* currentDate: Today's date is 2026-02-20.

**注意，codex已经不再支持 `wire_api = "chat"` 的设置了，因此，由codex发起的请求，一定是和 Responses API 的请求数据一致。**

## 禁止执行

- 禁止使用 git 命令来恢复代码，避免手动修改的代码被恢复后功能丢失
