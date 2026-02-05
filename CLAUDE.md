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
aicos update             # Update to the latest version and restart
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
│                    │  (SQLite3)   │                        │
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
- Initializes database and proxy server

#### 2. Proxy Server - `server/proxy-server.ts`
- **Route Matching**: Finds active route based on target type (claude-code/codex)
- **Rule Matching**: Determines content type from request (image-understanding/thinking/long-context/background/default)
- **Request Transformation**: Converts between different API formats (Claude ↔ OpenAI Chat)
- **Streaming**: Handles SSE (Server-Sent Events) streaming responses with real-time transformation
- **Logging**: Tracks requests, responses, and errors

#### 3. Transformers - `server/transformers/`
- **streaming.ts**: SSE parsing/serialization and event transformation
- **claude-openai.ts**: Claude ↔ OpenAI Chat format conversion
  - Image content block conversion (Claude ↔ OpenAI formats)
  - Tool choice mapping (auto/any/tool ↔ auto/none/required)
  - Stop reason mapping (including max_thinking_length)
  - System prompt handling (string and array formats)
  - Thinking/Reasoning content conversion
- **chunk-collector.ts**: Collects streaming chunks for logging

**API 转换功能**：
转换器实现了以下 API 格式之间的双向转换：
- **Claude Messages API** ↔ **OpenAI Chat Completions API**
- **Claude Messages API** ↔ **OpenAI Responses API**
- **DeepSeek Chat** ↔ 其他格式（支持 developer 角色映射）

**支持的转换内容**：
- 文本内容 (text)
- 图像内容 (image ↔ image_url)
- 工具调用 (tool_use ↔ tool_calls)
- 工具结果 (tool_result)
- 思考内容 (thinking ↔ reasoning/thinking)
- 系统提示词 (system - 支持字符串和数组格式)

#### 4. Database - `server/database.ts`
- SQLite3 database wrapper
- Manages: Vendors, API Services, Routes, Rules, Logs
- Configuration storage (API key, logging settings, etc.)

#### 5. UI (React) - `ui/`
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
  - `RoutesPage.tsx` - Configure routing rules
  - `LogsPage.tsx` - View request/access/error logs
  - `SettingsPage.tsx` - Application settings
  - `WriteConfigPage.tsx` - Overwrite Claude Code/Codex config files
  - `UsagePage.tsx` - Usage statistics
- Styles:
  - `App.css` - Main application styles with sidebar collapse animations
  - `Tooltip.css` - Tooltip component styles

#### 6. Types - `types/`
- TypeScript type definitions for:
  - Database models (Vendors, Services, Routes, Rules)
  - API requests/responses
  - Configuration
  - Token usage tracking

#### 7. CLI - `bin/`
- `cli.js` - Main CLI entry point
- `start.js` - Server startup with PID management
- `stop.js` - Server shutdown
- `restart.js` - Restart server

#### 8. Tauri Desktop Application - `tauri/`
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

### Skills Management
- Lists global Skills for Claude Code and Codex
- Provides discovery search (discover/return toggle button) and installs Skills into target tool directories

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
2. **Data Directory**: Default: `~/.aicodeswitch/data/` (SQLite3 database)
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
│       ├── database.ts
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
  sudo apt install libwebkit2gtk-4.0-dev \
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
- **Database**: SQLite3
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

## Development

* 使用yarn作为包管理器，请使用yarn安装依赖，使用yarn来运行脚本。
* 前端依赖库安装在devDependencies中，请使用yarn install --dev安装。
* 所有对话请使用中文。生成代码中的文案及相关注释根据代码原本的语言生成。
* 在服务端，直接使用 __dirname 来获取当前目录，不要使用 process.cwd()
* 每次有新的变化时，你需要更新 CLAUDE.md 来让文档保持最新。
* 禁止在项目中使用依赖GPU的css样式处理。
* 禁止运行 dev:ui, dev:server, tauri:dev 等命令来进行测试。
