# Tauri 桌面应用架构技术文档

> 本文档详细描述 AICodeSwitch Tauri 桌面应用的内部工作流程、架构设计和关键逻辑。

## 目录

- [1. 架构总览](#1-架构总览)
- [2. 核心组件与文件清单](#2-核心组件与文件清单)
- [3. 构建流程](#3-构建流程)
- [4. 生产环境启动序列](#4-生产环境启动序列)
- [5. 关闭序列](#5-关闭序列)
- [6. 资源打包与路径解析](#6-资源打包与路径解析)
- [7. WebView 加载机制](#7-webview-加载机制)
- [8. Node.js 进程管理](#8-nodejs-进程管理)
- [9. 前后端通信](#9-前后端通信)
- [10. 配置文件管理](#10-配置文件管理)
- [11. 跨平台差异](#11-跨平台差异)
- [12. IPC 现状与问题](#12-ipc-现状与问题)
- [13. CI/CD 构建管线](#13-cicd-构建管线)
- [14. 已知问题与风险分析](#14-已知问题与风险分析)
- [15. 关键数据流图](#15-关键数据流图)

---

## 1. 架构总览

AICodeSwitch Tauri 桌面应用采用**混合架构**（Hybrid Architecture）：

```
┌──────────────────────────────────────────────────────────────┐
│              Tauri Desktop Application                       │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Rust 主进程 (tauri/src/main.rs)                       │  │
│  │  - 窗口管理 (Tauri WebView)                            │  │
│  │  - Node.js 进程生命周期管理                             │  │
│  │  - 启动时检查 Node.js → 启动后端 → 导航 WebView       │  │
│  │  - 关闭时停用路由 → 终止进程 → 销毁窗口               │  │
│  │  - 无 IPC 命令处理器                                   │  │
│  └─────────────────────┬──────────────────────────────────┘  │
│                        │ 管理子进程                           │
│                        ▼                                     │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Node.js 后端进程                                     │   │
│  │  入口: dist/server/main.js                            │   │
│  │  - Express HTTP 服务器 (端口 4567)                    │   │
│  │  - /health 健康检查端点                               │   │
│  │  - /api/* 管理 API                                    │   │
│  │  - /v1/* 代理 API                                     │   │
│  │  - express.static 提供 React UI 静态文件              │   │
│  │  - JSON 文件数据库                                    │   │
│  │  - 路由、MCP、配置写入等所有业务逻辑                   │   │
│  └──────────────────────────────────────────────────────┘   │
│                        │                                     │
│           HTTP (localhost:{port})                              │
│                        │                                     │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  WebView (React UI)                                   │   │
│  │  - 通过 window.navigate 加载 http://localhost:{port}  │   │
│  │  - 标准的 fetch HTTP 调用与后端通信                    │   │
│  │  - TitleBar 组件使用 Tauri API 控制窗口               │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**核心设计原则**：

- Tauri **仅作为壳**（Shell），不承载任何业务逻辑
- 所有业务逻辑在 Node.js 后端进程中运行，代码与 CLI/Web 模式完全相同
- 前端与后端之间通过标准 HTTP 通信，**不使用 Tauri IPC**
- WebView 最终导航到 `http://localhost:{port}`，与浏览器访问体验一致

---

## 2. 核心组件与文件清单

### 2.1 Rust 主进程

| 文件 | 说明 |
|------|------|
| `tauri/src/main.rs` | Rust 主进程入口（约 517 行），管理窗口、Node.js 子进程、关闭流程 |
| `tauri/Cargo.toml` | Rust 依赖清单：tauri 2、tokio、reqwest、serde |
| `tauri/tauri.conf.json` | Tauri 2.0 应用配置（窗口、安全、打包、构建命令） |
| `tauri/build.rs` | 标准构建脚本 `tauri_build::build()` |

### 2.2 构建辅助

| 文件 | 说明 |
|------|------|
| `tauri/prepare-resources.js` | 构建前：复制 dist/ + package.json 到 resources/，执行 yarn install |
| `tauri/move-bundle.js` | 构建后：将 bundle 从 target/release/bundle 移到 target/bundle |
| `tauri/screens/index.html` | 启动画面（Splash Screen），纯 HTML/CSS/JS 动画页面 |

### 2.3 前端 Tauri 集成

| 文件 | 说明 |
|------|------|
| `src/ui/components/TitleBar.tsx` | 自定义标题栏组件，检测 Tauri 环境并使用 `window.__TAURI__` API |
| `src/ui/components/TitleBar.css` | 标题栏样式，使用 `-webkit-app-region` 实现拖拽 |

### 2.4 后端关键入口

| 文件 | 说明 |
|------|------|
| `src/server/main.ts` → `dist/server/main.js` | Node.js 后端入口，Express 服务器 |
| `vite.config.ts` | Vite 配置，开发代理和构建输出 |

---

## 3. 构建流程

### 3.1 构建命令链

```
yarn tauri:build
  └─ tauri build
       ├─ beforeBuildCommand: "npm run build && node tauri/prepare-resources.js"
       │    ├─ npm run build
       │    │    ├─ tsc -p tsconfig.server.json  → dist/server/main.js
       │    │    └─ vite build                    → dist/ui/
       │    └─ node tauri/prepare-resources.js
       │         ├─ 复制 dist/ → tauri/resources/dist/
       │         ├─ 复制 package.json → tauri/resources/package.json (去除 devDeps/scripts/bin)
       │         ├─ yarn install (在 tauri/resources/ 目录)
       │         ├─ 清理 node_modules 中的隐藏目录和 @types
       │         └─ 复制 screens/index.html → tauri/resources/screens/index.html
       │
       ├─ cargo build --release  (编译 Rust 代码)
       │
       └─ 打包资源 + 生成安装包
            ├─ resources/**/* 全部打包进应用
            └─ 生成 MSI / NSIS (Windows) 或 DMG (macOS)
```

### 3.2 prepare-resources.js 详细逻辑

```
输入: repoRoot/dist/ + repoRoot/package.json + tauri/screens/index.html
输出: tauri/resources/
    ├── dist/
    │   ├── server/main.js       ← 后端编译产物
    │   └── ui/                  ← 前端构建产物 (HTML/JS/CSS)
    ├── node_modules/            ← 生产依赖
    ├── package.json             ← 精简版（无 devDeps/scripts/bin）
    └── screens/
        └── index.html           ← 启动画面
```

**关键步骤**：

1. 清理旧的 `tauri/resources/` 目录
2. 复制 `dist/` 到 `tauri/resources/dist/`
3. 精简 `package.json`（删除 `devDependencies`、`scripts`、`bin`）
4. 在 `tauri/resources/` 执行 `yarn install --no-lockfile --no-non-interactive`
5. 清理 `node_modules` 中 `.开头的目录` 和 `@types` 目录
6. 复制启动画面 `index.html`

### 3.3 资源打包后的应用内部结构

安装后，应用内部的资源目录结构：

```
应用安装目录/
├── <Tauri 可执行文件>
└── resources/                           ← Tauri bundle.resources 配置
    ├── dist/
    │   ├── server/main.js
    │   └── ui/
    │       ├── index.html
    │       ├── assets/
    │       └── ...
    ├── node_modules/
    ├── package.json
    └── screens/
        └── index.html                   ← 启动画面
```

---

## 4. 生产环境启动序列

```
用户双击启动应用
    │
    ▼
[Tauri Runtime] 创建主窗口
    │ 加载 frontendDist → resources/screens/index.html (启动画面)
    │
    ▼
[.setup() Hook] (异步执行，不阻塞窗口显示)
    │
    ├─ cfg!(debug_assertions) == false → 进入生产模式逻辑
    │
    ├─ 1. read_port_from_config()
    │     读取 ~/.aicodeswitch/aicodeswitch.conf 中的 PORT=xxxx
    │     默认 4567
    │
    ├─ 2. tauri::async_runtime::spawn() 启动异步任务：
    │     │
    │     ├─ check_nodejs_installed()
    │     │    运行 node --version 验证 Node.js
    │     │    失败 → 弹出错误对话框，流程终止
    │     │
    │     ├─ is_server_running(port)
    │     │    HTTP GET http://localhost:{port}/health (1秒超时)
    │     │
    │     ├─ 情况A: 已有服务运行
    │     │    └─ window.navigate("http://localhost:{port}")
    │     │       WebView 从启动画面跳转到后端 UI
    │     │
    │     └─ 情况B: 无服务运行
    │          ├─ start_server(app, state, port)
    │          │    ├─ get_resource_root(app)
    │          │    │    解析: resource_dir/resources/ 或 resource_dir/
    │          │    │
    │          │    ├─ 定位: {resource_root}/dist/server/main.js
    │          │    │
    │          │    ├─ get_node_executable()
    │          │    │    Windows: "node.exe"
    │          │    │    macOS: 搜索常见路径后回退 "node"
    │          │    │
    │          │    ├─ Command::new(node_path)
    │          │    │    .arg(server_path)
    │          │    │    .current_dir(resource_root)
    │          │    │    .env("PORT", port)
    │          │    │    .env("NODE_ENV", "production")
    │          │    │    Windows: .creation_flags(CREATE_NO_WINDOW)
    │          │    │
    │          │    └─ wait_for_server(port)
    │          │         HTTP GET http://localhost:{port}/health
    │          │         最多 30 次，每次间隔 500ms（共 15 秒）
    │          │
    │          └─ window.navigate("http://localhost:{port}")
    │
    ▼
[WebView] 显示后端提供的 React UI
    │ Express 提供:
    │   - express.static(path.resolve(__dirname, '../ui'))
    │   - /api/* 管理 API
    │   - /v1/* 代理 API
    │   - /health 健康检查
    │
    ▼
[用户交互] 正常使用应用
```

### 4.1 启动时序图

```
时间 ──────────────────────────────────────────────────────────►

Rust 进程     [创建窗口]──[setup hook]──[检查Node]──[启动子进程]──[等待健康检查]──[导航WebView]
               │                                               │
WebView       [显示启动画面]──────────────────────────────────[显示 React UI]
               │                                               │
Node.js 进程                                                    [初始化]──[监听端口]
```

**关键时序**：

- 窗口和启动画面**立即显示**（用户无需等待）
- Node.js 检查和启动在**后台异步**进行
- 健康检查最多等待 15 秒（30 × 500ms）
- 启动画面到 React UI 的切换通过 `window.navigate()` 实现

---

## 5. 关闭序列

```
用户点击窗口关闭按钮
    │
    ▼
[on_window_event: CloseRequested]
    │
    ├─ api.prevent_close()    ← 阻止默认关闭行为
    │
    └─ tauri::async_runtime::spawn() 启动异步关闭任务：
         │
         ├─ read_port_from_config()
         │
         ├─ deactivate_active_routes(port)
         │    HTTP POST http://localhost:{port}/api/routes/deactivate-all
         │    等待响应完成（确保后端处理完毕）
         │    失败时仅打印警告，继续关闭流程
         │
         ├─ [仅生产模式] stop_server(state)
         │    ├─ Unix: SIGTERM → 等待 5 秒 → SIGKILL
         │    └─ Windows: 直接 kill()
         │
         └─ window.destroy()    ← 销毁窗口，应用退出
```

### 5.1 关闭时的风险

| 平台 | 行为 | 风险 |
|------|------|------|
| **Unix** | SIGTERM → 5s 超时 → SIGKILL | 低风险，Node.js SIGTERM 处理器会恢复配置文件 |
| **Windows** | 直接 `child.kill()` | **高风险**，Node.js 进程被强制终止，无法执行配置恢复 |

> **重要**：Windows 上的 `child.kill()` 等价于 `TerminateProcess()`，不等同于 SIGTERM。Node.js 的 `process.on('SIGTERM')` 处理器**不会执行**。虽然 `deactivate_active_routes()` 在 kill 之前调用了，但配置文件的恢复（`restoreClaudeConfig` / `restoreCodexConfig`）依赖 Node.js 的 SIGINT/SIGTERM 信号处理器，这在 Windows 上**不会触发**。

---

## 6. 资源打包与路径解析

### 6.1 资源路径解析流程

```rust
// get_resource_root() 逻辑
resource_dir = app.path().resource_dir()   // Tauri API 获取资源目录
resource_root = resource_dir / "resources"  // 先尝试 resources 子目录

if resource_root.exists() {
    return resource_root                     // {resource_dir}/resources/
} else {
    return resource_dir                      // 回退到 {resource_dir}/
}
```

### 6.2 Node.js 服务器路径

```
resource_root = get_resource_root(app)
server_path = resource_root / "dist" / "server" / "main.js"
working_dir = resource_root   ← Node.js 进程的工作目录
```

### 6.3 Express 静态文件路径

```typescript
// dist/server/main.js 中的 Express 服务器
app.use(express.static(path.resolve(__dirname, '../ui')));
```

解析链路：
```
__dirname = {resource_root}/dist/server/
path.resolve(__dirname, '../ui') = {resource_root}/dist/ui/
```

因此 Express 从 `dist/ui/` 目录提供 React UI 的静态文件。

### 6.4 潜在路径问题

| 场景 | 路径 | 是否可靠 |
|------|------|---------|
| macOS .app Bundle | `.../AI Code Switch.app/Contents/Resources/resources/` | ✅ 正常 |
| Windows NSIS 安装 | `C:\Program Files\AI Code Switch\resources\` | ✅ 通常正常 |
| Windows MSI 安装 | 取决于安装目录 | ⚠️ 路径含空格可能有风险 |
| 开发模式 | 不使用资源打包，直接用 Vite | ✅ 不受影响 |

---

## 7. WebView 加载机制

### 7.1 两阶段加载

```
阶段1: 启动画面 (本地文件)
    URL: tauri://localhost/ (或 asset://localhost/)
    内容: resources/screens/index.html
    特点: 纯静态 HTML/CSS/JS，无需后端

阶段2: React UI (HTTP)
    URL: http://localhost:{port}/
    内容: Express 提供的 React 应用
    特点: 完整的应用 UI，依赖后端 API
```

### 7.2 导航触发

```rust
// 导航在 Rust 异步任务中执行
let url: url::Url = format!("http://localhost:{}", port).parse().unwrap();
window.navigate(url)?;
has_navigated.store(true, Ordering::SeqCst);
```

`NavigationState` 通过 `AtomicBool` 防止重复导航。

### 7.3 启动画面

[tauri/screens/index.html](tauri/screens/index.html) 是一个独立的 HTML 文件，包含：
- 纯 CSS 动画（粒子、网格背景、光晕、旋转环）
- "AI Code Switch" 标题和功能卡片
- "正在进入……" 加载动画
- 无任何外部依赖

启动画面通过 `tauri.conf.json` 中的 `frontendDist: "resources/screens"` 配置加载。

---

## 8. Node.js 进程管理

### 8.1 进程状态

```rust
struct ServerProcess {
    process: Option<Child>,   // Rust 的 std::process::Child
}

// 通过 Mutex 包装，作为 Tauri managed state
Mutex<ServerProcess>
```

### 8.2 Node.js 可执行文件查找

| 平台 | 查找策略 |
|------|---------|
| **Windows** | 直接使用 `"node.exe"`，依赖系统 PATH |
| **macOS** | 按优先级搜索：`/usr/local/bin/node` → `/opt/homebrew/bin/node` → `/usr/bin/node` → `"node"` |
| **Linux** | 搜索 `/usr/local/bin/node` → Linux Homebrew 路径 → `/usr/bin/node` → `"node"` |

> **macOS 特殊原因**：macOS GUI 应用的 PATH 环境变量通常不包含 `/usr/local/bin` 等开发者工具路径，因此必须显式搜索。

### 8.3 Node.js 检查

```rust
fn check_nodejs_installed() -> Result<String, String> {
    // 运行 node --version
    // 成功 → 返回版本号字符串
    // 失败 → 返回包含安装链接的错误信息（中文）
}
```

如果检查失败，会通过 `tauri_plugin_dialog` 弹出错误对话框。

### 8.4 健康检查轮询

```rust
async fn wait_for_server(port: u16) -> Result<(), String> {
    // GET http://localhost:{port}/health
    // 最多 30 次尝试，每次间隔 500ms（共 15 秒）
    // Express 端点: app.get('/health', (_req, res) => res.json({ status: 'ok' }))
}
```

### 8.5 进程启动参数

```rust
Command::new(node_path)
    .arg(server_path)                     // dist/server/main.js
    .current_dir(resource_root)           // 工作目录 = 资源根
    .env("PORT", port.to_string())        // 端口
    .env("NODE_ENV", "production")        // 生产模式
    // Windows only:
    .creation_flags(CREATE_NO_WINDOW)     // 隐藏控制台窗口
```

---

## 9. 前后端通信

### 9.1 通信架构

```
┌──────────────┐    HTTP fetch()    ┌──────────────────┐
│  React UI    │ ─────────────────► │  Express Server   │
│  (WebView)   │ ◄───────────────── │  (Node.js)        │
│              │    JSON Response   │                   │
│  localhost:{port}                  │  localhost:{port} │
└──────────────┘                    └──────────────────┘
```

**关键点**：

- WebView 通过 `window.navigate()` 导航到 `http://localhost:{port}`
- 所有 API 调用使用标准 `fetch()` 发送到相对路径
- 因为 WebView 和 Express 在同源，不存在跨域问题
- **不使用 Tauri IPC**，与浏览器访问模式完全一致

### 9.2 API 客户端

前端使用 [src/ui/api/client.ts](src/ui/api/client.ts) 进行 API 调用，使用相对路径：

```typescript
// 示例 API 调用路径
GET  /api/vendors
POST /api/routes
GET  /api/routes/:id
POST /api/export
GET  /health
```

### 9.3 TitleBar 组件的特殊通信

[TitleBar.tsx](src/ui/components/TitleBar.tsx) 是唯一使用 Tauri API 的前端组件：

```typescript
// 检测 Tauri 环境
const isTauri = () => !!window.__TAURI__;

// 窗口控制（使用 Tauri window API）
window.__TAURI__!.window.getCurrent().minimize();
window.__TAURI__!.window.getCurrent().maximize();
window.__TAURI__!.window.getCurrent().close();

// 服务器状态轮询（调用未实现的 IPC 命令）
window.__TAURI__!.core.invoke('get_server_status');  // ⚠️ 未在 Rust 端注册
window.__TAURI__!.core.invoke('start_server_command'); // ⚠️ 未在 Rust 端注册
window.__TAURI__!.core.invoke('stop_server_command');  // ⚠️ 未在 Rust 端注册

// 事件监听
window.__TAURI__!.event.listen('server-started', () => { ... });
```

---

## 10. 配置文件管理

### 10.1 配置文件位置

```
~/.aicodeswitch/
├── aicodeswitch.conf    ← HOST、PORT、AUTH 等配置
└── data/                ← JSON 数据文件 (vendors/routes/rules/config/logs 等)
```

### 10.2 端口配置读取

Rust 和 Node.js 都从同一个文件读取端口：

| 组件 | 读取方式 |
|------|---------|
| **Rust** `read_port_from_config()` | `HOME`/`USERPROFILE` + `/.aicodeswitch/aicodeswitch.conf`，解析 `PORT=xxxx` |
| **Node.js** `dotenv` | `os.homedir() + /.aicodeswitch/aicodeswitch.conf`，通过 `dotenv.config()` 加载 |
| **Vite** `vite.config.ts` | 同 Node.js，用于开发代理配置 |

### 10.3 配置写入/恢复

Node.js 后端在启动时会自动写入 Claude Code / Codex 配置文件（`syncConfigsOnServerStartup`），在 SIGINT/SIGTERM 信号时恢复。

**Tauri 模式下的配置写入链路**：

```
Tauri 启动
  → Node.js 进程启动
    → start() 函数
      → syncConfigsOnServerStartup()
        → writeClaudeConfig()    (写入 ~/.claude/settings.json)
        → writeCodexConfig()     (写入 ~/.codex/config.toml, auth.json)

Tauri 关闭
  → deactivate_active_routes()   (HTTP POST，停用路由)
  → stop_server()
    → [Unix] SIGTERM → Node.js 信号处理器 → restoreClaudeConfig() + restoreCodexConfig()
    → [Windows] 直接 kill() → ⚠️ 配置不会恢复
```

---

## 11. 跨平台差异

### 11.1 平台特定代码一览

| 功能 | macOS/Linux | Windows |
|------|-------------|---------|
| **控制台隐藏** | N/A | `CREATE_NO_WINDOW (0x08000000)` |
| **Node.js 路径** | 搜索 5 个常见路径 | `"node.exe"` |
| **进程终止** | SIGTERM → 5s → SIGKILL | `child.kill()` (TerminateProcess) |
| **HOME 目录** | `$HOME` | `$USERPROFILE` |
| **窗口子系统** | 默认 | `windows_subsystem = "windows"` (release only) |

### 11.2 Windows 特殊处理

1. **隐藏 Node.js 控制台**：使用 `CommandExt::creation_flags(CREATE_NO_WINDOW)` 避免弹出黑色控制台窗口
2. **无优雅关闭**：`stop_server()` 直接调用 `child.kill()`，Node.js 的 SIGTERM 处理器不会执行
3. **Node.js 查找**：仅依赖系统 PATH，不搜索特定路径

### 11.3 macOS 特殊处理

1. **Node.js 路径搜索**：因为 macOS GUI 应用的 PATH 不包含 Homebrew 等开发者路径
2. **Apple Silicon 支持**：搜索 `/opt/homebrew/bin/node`
3. **Intel Mac 支持**：搜索 `/usr/local/bin/node`

---

## 12. IPC 现状与问题

### 12.1 当前状态

**Rust 端没有注册任何 IPC 命令处理器。**

```rust
// main.rs 中：
// - 没有 #[tauri::command] 函数
// - 没有 .invoke_handler() 注册
// - 只使用 .setup() 和 .on_window_event() 钩子
```

### 12.2 TitleBar 尝试调用的 IPC

| 命令 | Rust 实现 | 状态 |
|------|-----------|------|
| `get_server_status` | ❌ 未实现 | invoke 调用失败，catch 静默忽略 |
| `start_server_command` | ❌ 未实现 | invoke 调用失败，catch 静默忽略 |
| `stop_server_command` | ❌ 未实现 | invoke 调用失败，catch 静默忽略 |
| `restart_server_command` | ❌ 未实现 | invoke 调用失败，catch 静默忽略 |

### 12.3 Tauri 事件

| 事件 | 发送方 | 接收方 | 状态 |
|------|--------|--------|------|
| `server-started` | ❌ Rust 未发送 | TitleBar 监听 | 永远不触发 |
| `server-restarted` | ❌ Rust 未发送 | TitleBar 监听 | 永远不触发 |

### 12.4 实际影响

- TitleBar 的服务器状态显示**始终显示默认值**（running: true），因为 `get_server_status` 调用失败
- 开始/停止/重启按钮**不起作用**，因为对应 IPC 命令未实现
- 窗口最小化/最大化/关闭**正常工作**，因为这些使用 Tauri 内置的 window API
- 事件监听的 `server-started` / `server-restarted` **永远不会触发**

---

## 13. CI/CD 构建管线

### 13.1 触发条件

```
触发方式1: "Publish To NPM" 工作流成功完成 → 自动触发
触发方式2: GitHub Actions 手动触发（可指定版本号）
```

### 13.2 当前构建矩阵

```
┌───────────────┬──────────┬─────────────────────────┬────────────────┐
│ 平台          │ 架构     │ Rust Target              │ 输出格式       │
├───────────────┼──────────┼─────────────────────────┼────────────────┤
│ windows-latest│ x64      │ x86_64-pc-windows-msvc  │ MSI + NSIS exe │
└───────────────┴──────────┴─────────────────────────┴────────────────┘

⚠️ macOS 构建矩阵已移除，当前仅构建 Windows
```

### 13.3 构建步骤

```
1. Checkout 代码
2. Setup Node.js 20.x
3. Install Rust stable (指定 target)
4. Cache Cargo 依赖
5. yarn install --frozen-lockfile
6. 同步版本号到 tauri.conf.json
7. yarn build (构建 UI + Server)
8. node tauri/prepare-resources.js (准备资源)
9. 清理旧构建产物
10. npx tauri build --bundles msi nsis
11. 重命名产物 (加入版本号和平台)
12. 上传 artifacts
13. 创建 GitHub Release
```

---

## 14. 已知问题与风险分析

### 🔴 高风险：Windows 无法正常工作

#### 问题1: Windows 强制终止进程导致配置文件不恢复

**现象**：关闭 Tauri 应用后，Claude Code / Codex 的配置文件可能停留在代理覆盖状态。

**原因**：

```rust
// main.rs - stop_server()
#[cfg(not(unix))]
{
    let _ = child.kill();    // Windows 上直接 TerminateProcess
    let _ = child.wait();
}
```

Windows 上 `child.kill()` 会立即终止进程，Node.js 的 `process.on('SIGTERM')` 和 `process.on('SIGINT')` 处理器**不会执行**。后端 `main.ts` 中配置恢复逻辑依赖这些信号处理器。

**影响**：用户的 `~/.claude/settings.json` 和 `~/.codex/config.toml` 可能包含指向本地代理的配置，下次直接使用 Claude Code / Codex 时会连接失败。

**缓解措施**：`deactivate_active_routes()` 在 kill 之前调用，会停用路由。但 `restoreClaudeConfig` / `restoreCodexConfig` 不在 deactivate API 中执行，仅在信号处理器中执行。

#### 问题2: Windows 上 Node.js 可能不在 PATH 中

**现象**：应用启动后弹出 "Node.js 未安装" 错误对话框，或者直接卡在启动画面。

**原因**：

```rust
#[cfg(target_os = "windows")]
{
    "node.exe".to_string()  // 仅依赖系统 PATH
}
```

普通 Windows 用户（非开发者）可能没有将 Node.js 添加到系统 PATH，或者 PATH 环境变量在 GUI 应用上下文中与命令行不同。

#### 问题3: 端口冲突导致启动失败

**现象**：启动画面一直显示 "正在进入……"，15 秒后弹出错误对话框。

**原因**：如果上一次应用没有正确关闭（如崩溃、任务管理器杀进程），端口 4567 可能仍然被占用。Node.js 的端口检查会拒绝启动：

```typescript
const isPortUsable = await checkPortUsable(port);
if (!isPortUsable) {
    console.error(`端口 ${port} 已被占用，无法启动服务。`);
    process.exit(1);
}
```

但 Rust 端只检测已有的 `/health` 端点，不检测端口占用。如果旧进程处于半死状态（端口被占用但 /health 无响应），Rust 会尝试启动新进程，Node.js 启动后立即因端口冲突而退出，Rust 的 `wait_for_server` 超时 15 秒后才报错。

#### 问题4: prepare-resources.js 在 Windows CI 上的兼容性

**现象**：构建可能失败或资源不完整。

**风险点**：

```javascript
// 使用 execFileSync 执行 yarn
execFileSync('yarn', ['install', '--no-lockfile', '--no-non-interactive'], {
    cwd: destRoot,
    stdio: 'inherit',
    shell: true
});
```

- Windows 上 `yarn` 可能是 `.cmd` 文件，需要 `shell: true`（已设置）
- 路径含空格时（如 `C:\Program Files\...`）可能出问题

### 🟡 中风险

#### 问题5: 服务器启动后导航失败

**现象**：服务器启动成功，但 WebView 停留在启动画面。

**原因**：`window.navigate()` 可能在某些 WebView2 版本上失败，错误被 `eprintln!` 打印但不反馈给用户。

#### 问题6: Express 静态文件路径与资源路径不一致

**依赖链**：
```
Express: path.resolve(__dirname, '../ui')
= resource_root/dist/server/../../../ui → resource_root/dist/ui

这要求 dist/ui/ 必须存在于 resource_root 中
```

如果 `prepare-resources.js` 复制不完整，Express 将返回 404。

#### 问题7: 启动画面版本号硬编码

```html
<!-- tauri/screens/index.html -->
<div class="version">v1.0.0</div>
```

版本号不会自动同步，始终显示 "v1.0.0"。

### 🟢 低风险

#### 问题8: IPC 命令未实现

TitleBar 的服务器控制功能（开始/停止/重启）不起作用，但不影响核心使用，因为窗口关闭时 Rust 自动处理关闭流程。

#### 问题9: 数据目录首次创建

首次使用时 `~/.aicodeswitch/` 目录不存在，但 Node.js 服务器会自动创建。

---

## 15. 关键数据流图

### 15.1 用户请求流（代理请求）

```
Claude Code / Codex
    │
    │ HTTP Request (携带 sk_ / skr_ key)
    ▼
┌─────────────────────────────────────────┐
│  Express Server (localhost:{port})       │
│                                         │
│  /v1/messages       → Claude API 代理   │
│  /v1/chat/completions → OpenAI API 代理  │
│  /v1/responses      → OpenAI Responses   │
│                                         │
│  认证 → 路由匹配 → 格式转换 → 转发请求  │
│                                         │
│  ┌──────────┐  ┌───────────┐            │
│  │ 路由系统  │  │ 格式转换器  │            │
│  │ (Rules)  │  │ (Transformers)│         │
│  └──────────┘  └───────────┘            │
│         │                                │
│         ▼                                │
│    上游 API (Gemini/DeepSeek/etc.)       │
└─────────────────────────────────────────┘
```

### 15.2 管理界面请求流

```
React UI (WebView)
    │
    │ fetch('/api/...')
    ▼
┌─────────────────────────────────────────┐
│  Express Server (localhost:{port})       │
│                                         │
│  /api/vendors     → 供应商管理           │
│  /api/routes      → 路由管理             │
│  /api/mcps        → MCP 管理             │
│  /api/skills      → Skills 管理          │
│  /api/logs        → 日志查看             │
│  /api/sessions    → 会话管理             │
│  /api/settings    → 应用设置             │
│  /api/access-keys → 接入密钥管理         │
│  /health          → 健康检查             │
│                                         │
│  ┌─────────────────────────────┐        │
│  │  JSON 文件数据库             │        │
│  │  ~/.aicodeswitch/data/      │        │
│  └─────────────────────────────┘        │
└─────────────────────────────────────────┘
```

### 15.3 Tauri 进程关系图

```
┌─────────────────────────────────────────┐
│  操作系统                                │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │  Tauri 进程 (Rust)               │   │
│  │  PID: 1000                       │   │
│  │                                  │   │
│  │  ├─ WebView Window               │   │
│  │  │   URL: http://localhost:4567  │   │
│  │  │   (显示 React UI)             │   │
│  │  │                               │   │
│  │  └─ Child Process                │   │
│  │      PID: 1001 (Node.js)         │   │
│  │      Entry: dist/server/main.js  │   │
│  │      CWD: {resource_root}        │   │
│  │      PORT: 4567                  │   │
│  └──────────────────────────────────┘   │
│                                         │
└─────────────────────────────────────────┘

端口: 4567 (localhost)
数据: ~/.aicodeswitch/data/
配置: ~/.aicodeswitch/aicodeswitch.conf
日志: ~/.aicodeswitch/data/logs.json
```

---

## 附录 A：关键常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `DEFAULT_SERVER_PORT` | `4567` | 默认服务器端口 |
| `VITE_DEV_PORT` | `17808` | Vite 开发服务器端口 |
| `max_attempts` | `30` | 健康检查最大重试次数 |
| `retry_delay` | `500ms` | 健康检查重试间隔 |
| `SIGTERM_TIMEOUT` | `5s` | Unix 优雅关闭等待时间 |
| `HEALTH_CHECK_TIMEOUT` | `1s` | 已有服务检测超时 |
| Window Size | `1200×720` | 默认窗口大小 |
| Min Window | `800×600` | 最小窗口大小 |

## 附录 B：Tauri 配置摘要

来自 [tauri/tauri.conf.json](tauri/tauri.conf.json)：

| 配置项 | 值 |
|--------|-----|
| Product Name | AI Code Switch |
| Identifier | net.tangshuang.aicodeswitch |
| CSP | null（未启用） |
| Asset Protocol | 启用，scope: `**` |
| Decorations | true（使用系统原生标题栏） |
| Tray Icon | 启用 |
| Bundle Resources | `resources/**/*` |
| beforeBuildCommand | `npm run build && node tauri/prepare-resources.js` |
| frontendDist | `resources/screens` |
