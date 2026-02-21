```
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
```

## AI Code Switch - Project Overview

AI Code Switch is a local proxy server that manages AI programming tool connections to large language models, allowing tools like Claude Code and Codex to use custom model APIs instead of official ones.

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
- Linux: Development packages (webkit2gtk, etc.)

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
│                     AI Code Switch                          │
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
- Initializes database using `DatabaseFactory.createAuto()` which automatically:
  - Detects and migrates old SQLite/LevelDB databases if present
  - Creates new file system database if none exists
- Initializes proxy server

#### 2. Proxy Server - `server/proxy-server.ts`
- **Route Matching**: Finds active route based on target type (claude-code/codex)
- **Rule Matching**: Determines content type from request (image-understanding/thinking/long-context/background/default)
- **Request Transformation**: Converts between different API formats (Claude ↔ OpenAI Chat)
- **Streaming**: Handles SSE (Server-Sent Events) streaming responses with real-time transformation
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
- **DeepSeek Chat** ↔ 其他格式（支持 developer 角色映射）

**支持的转换内容**：
- 文本内容 (text)
- 图像内容 (image ↔ image_url)
- 工具调用 (tool_use ↔ tool_calls)
- 工具结果 (tool_result)
- 思考内容 (thinking ↔ reasoning/thinking)
- 系统提示词 (system - 支持字符串和数组格式)

#### 5. Database - `server/fs-database.ts`
- **FileSystemDatabaseManager**: Pure JSON file-based storage (no database dependencies)
- **DatabaseFactory** (`server/database-factory.ts`): Auto-detects database type and handles migration
- **Migration Tool** (`server/migrate-to-fs.ts`): Migrates data from SQLite/LevelDB to JSON files
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

**Data Structure**:
- Vendors contain nested services array: `vendors[{ id, name, services: [{ id, name, apiUrl, ... }], ... }]`
- Services are no longer stored in a separate file, they are embedded within their parent vendor
- This structure ensures data consistency and simplifies cascade operations

**Migration from SQLite**:
- Automatic migration on first startup using `DatabaseFactory.createAuto()`
- Detects old SQLite database (`app.db`) and automatically migrates to file system database
- Migration process includes:
  - Exporting all data from SQLite (vendors, services, routes, rules, config, sessions, logs, error logs)
  - Restructuring services to be nested within vendors
  - Creating JSON files in `~/.aicodeswitch/data/`
  - Backing up old database files to `~/.aicodeswitch/data/backup/`
  - Verifying migration success
- If migration fails, a new file system database is created anyway (user can manually restore backup)

**Migration from Old File System Database**:
- Automatic migration on startup if `services.json` exists (old structure)
- Migration process includes:
  - Reading vendors.json and services.json
  - Grouping services by vendorId
  - Embedding services into vendors
  - Backing up old services.json to `services.json.backup.{timestamp}`
  - Saving new vendors.json with nested services

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
- **Content Type Detection**:
  - `image-understanding`: Requests with image content
    - 支持使用 MCP 工具处理图像理解请求
    - 开启 MCP 后，图片会被提取并保存到临时文件
    - 请求消息中的图片引用会被替换为本地文件路径
    - MCP 工具会自动识别并处理本地图片
  - `thinking`: Requests with reasoning/thinking signals
  - `long-context`: Requests with large context (≥12000 chars or ≥8000 max tokens)
  - `background`: Background/priority requests, including `/count_tokens` endpoint requests and token counting requests with `{"role": "user", "content": "count"}`
  - `default`: All other requests

### Request Transformation
- Supports multiple source types:
  - OpenAI Chat
  - OpenAI Code
  - OpenAI Responses
  - Claude Chat
  - Claude Code
  - DeepSeek Chat

### Configuration Management
- Writes/ restores Claude Code config files (`~/.claude/settings.json`, `~/.claude.json`)
- Writes/ restores Codex config files (`~/.codex/config.toml`, `~/.codex/auth.json`)
- Exports/ imports encrypted configuration data

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
  - For Codex: Configuration support planned
  - MCPs are only written when there are active routes with enabled targets

### Logging
- Request logs: Detailed API call records with token usage
- Access logs: System access records
- Error logs: Error and exception records with comprehensive context
  - **Error Log Details**:
    - Basic error information: timestamp, method, path, status code, error message, error stack
    - Request context: targetType (client type), requestModel (requested model)
    - Routing context: ruleId (used rule), targetServiceId/Name (API service), targetModel (actual model)
    - Vendor context: vendorId/Name (service provider)
    - Request details: request headers, request body, response headers, response body
    - **Upstream Request Information**: URL, headers, body, proxy usage
    - Response time metrics
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
7. **Database Migration**: If you have an old SQLite database, it will be automatically migrated to JSON files on first startup.

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
   - **Service Detection**: On startup, Tauri app checks if port is already in use
     - If a Node.js server is already running (e.g., started via `aicos start`), the app will connect to it instead of starting a new process
     - This prevents conflicts when users have both the CLI tool and desktop app installed

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
│       ├── database-factory.ts  # Database factory with migration support
│       ├── fs-database.ts       # JSON file-based database manager
│       ├── migrate-to-fs.ts     # Migration tool (SQLite → JSON)
│       ├── proxy-server.ts
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
   - Compile the Rust code in release mode
   - Bundle the application with all resources
   - Create platform-specific installers

#### Build Output

**Windows:**
- `tauri/target/release/aicodeswitch.exe` - Executable
- `tauri/target/release/bundle/msi/` - MSI installer
- `tauri/target/release/bundle/nsis/` - NSIS installer

**macOS:**
- `tauri/target/release/aicodeswitch` - Executable
- `tauri/target/release/bundle/dmg/` - DMG installer
- `tauri/target/release/bundle/macos/` - .app bundle

**Linux:**
- `tauri/target/release/aicodeswitch` - Executable
- `tauri/target/release/bundle/deb/` - DEB package
- `tauri/target/release/bundle/appimage/` - AppImage

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
- ✅ Cross-platform support (Windows, macOS, Linux)
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
- **WebView**: System native (WebView2 on Windows, WebKit on macOS/Linux)
- **IPC**: Tauri command system
- **Process Management**: Rust std::process

### CLI
- **Implementation**: Custom Yargs-like CLI
- **Process Management**: Node.js child_process

## CI/CD Pipeline

### NPM 发布流程
当 PR 合并到 main 分支时，自动触发 npm 发布：
1. 运行 `npm run release` 创建版本 tag
2. 发布到 npm registry
3. 推送 tag 到 GitHub

### Tauri 应用构建流程
npm 发布成功后，自动触发 Tauri 应用构建：
1. **触发条件**:
   - "Publish To NPM" 工作流成功完成
   - 或手动触发（可指定版本号）

2. **构建矩阵**:
   - **Linux**: Ubuntu 22.04 (x86_64)
     - 输出: `.deb`, `.AppImage`
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

## Development

* 使用yarn作为包管理器，请使用yarn安装依赖，使用yarn来运行脚本。
* 前端依赖库安装在devDependencies中，请使用yarn install --dev安装。
* 所有对话请使用中文。生成代码中的文案及相关注释根据代码原本的语言生成。
* 在服务端，直接使用 __dirname 来获取当前目录，不要使用 process.cwd()
* 每次有新的变化时，你需要更新 CLAUDE.md 来让文档保持最新。
* 每次有变更，以非常简单的概述，将变化内容记录到 CHANGELOG.md 中。
* 禁止在ui中使用依赖GPU的css样式。
* 禁止运行 dev:ui, dev:server, tauri:dev 等命令来进行测试。
* 如果你需要创建文档，必须将文档放在 documents 目录下
* 如果你需要创建测试脚本，必须将脚本文件放在 scripts 目录下
* currentDate: Today's date is 2026-02-20.