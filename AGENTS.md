# AI Code Switch - 项目知识库

**生成时间:** 2026-02-11
**项目类型:** AI 代理工具 / 本地代理服务器

## 项目概述

AI Code Switch 是一个本地代理服务器，管理 AI 编程工具（Claude Code、Codex）到大语言模型的连接。支持模型 API 路由、API 格式转换（Claude ↔ OpenAI）、技能分发、日志记录等功能。

**核心技术栈:**
- 后端: Node.js + TypeScript + Express
- 前端: React + TypeScript + Vite
- 桌面: Electron 33 (主进程以 in-process 方式加载 Node 后端)
- 存储: JSON 文件系统数据库 (~/.aicodeswitch/data/)
- 部署: CLI 工具 + Web UI + 桌面应用

## 目录结构

```
aicodeswitch/
├── src/
│   ├── server/          # Node.js 后端服务 (Express API + 代理服务器)
│   └── ui/             # React 前端应用
├── electron/           # Electron 桌面应用 (主进程 + preload + loading 屏)
├── build/              # electron-builder 资源 (icon.png)
├── bin/                # CLI 脚本 (aicos 命令)
├── dist/               # 构建产物 (server/, ui/)
├── documents/          # 文档
├── scripts/           # 构建/发布脚本 (含 electron-dev.js)
├── package.json       # npm 脚本、依赖声明、electron-builder build 字段
├── tsconfig.json      # TypeScript 配置
├── vite.config.ts     # Vite 构建配置
└── .github/workflows/ # CI/CD 流水线
```

## 快速定位

| 任务 | 位置 | 说明 |
|------|------|------|
| 核心代理逻辑 | `src/server/proxy-server.ts` | 请求路由、匹配规则、转发 |
| API 格式转换 | `src/server/transformers/` | Claude ↔ OpenAI ↔ Gemini 数据格式互转 |
| 数据库层 | `src/server/fs-database.ts` | JSON 文件存储 CRUD |
| UI 页面 | `src/ui/pages/` | 供应商管理、路由配置、日志等 |
| CLI 命令 | `bin/*.js` | start/stop/ui/upgrade/restore 等 |
| Electron 主进程 | `electron/main.js` | 窗口管理 + 进程内服务器生命周期 (`require('dist/server/main.js').start()`) |
| 构建配置 | `package.json` scripts / `build` 字段 | dev/build/electron:dev、electron-builder 配置 |

## 代码规范

### 通用约定
- **包管理器:** yarn (使用 `yarn install`，前端依赖装在 devDependencies)
- **服务端路径:** 使用 `__dirname` 获取目录，不要用 `process.cwd()`
- **UI 样式:** 禁止使用依赖 GPU 的 CSS 样式
- **测试命令:** 禁止运行 `dev:ui`、`dev:server`、`electron:dev` 进行测试
- **文档位置:** 新建文档放 `documents/` 目录
- **测试脚本:** 新建测试放 `scripts/` 目录

### TypeScript 规范
- 后端: `src/server/**/*.ts`
- 前端: `src/ui/**/*.{tsx,ts}`
- 编译配置: `tsconfig.json` (后端), `tsconfig.json` (前端)
- 类型定义: `src/types/index.ts`

### 路径约定
- API 路由前缀: `/api/` (除代理路由 `/claude-code/`、`/codex/`)
- 服务端口: 4567 (服务器), 4568 (UI 开发服务器)
- 数据目录: `~/.aicodeswitch/fs-db/`
- 配置文件: `~/.aicodeswitch/aicodeswitch.conf`（PORT、AUTH）。监听地址由 AUTH 决定（AUTH 开→`0.0.0.0` / AUTH 关→`127.0.0.1`），`HOST` 已忽略；写入本地工具配置与 UI/CLI 展示地址恒为 `127.0.0.1`

## 特殊约定

### 数据库
- **数据格式:** 所有数据存为 JSON 文件 (`~/.aicodeswitch/fs-db/*.json`)
- **数据结构:** `vendors.json` 内嵌 `services` 数组

### 路由与故障切换
- **路由规则:** 按请求内容类型 (image-understanding/thinking/long-context/background/default/compact) 匹配
- **智能故障切换:** 同类型多条规则时，优先使用第一条；报错/超时时自动切换下一条

### 日志规范
- **日志类型:** 请求日志、错误日志、会话日志
- **敏感字段:** API 密钥等自动在 UI 层脱敏显示
- **会话标题:** 从首条用户消息提取，自动截断 (最大 100 字符)

### Electron 桌面应用
- **进程内后端:** `electron/main.js` `require()`s `dist/server/main.js` 调用其 `start()` / `gracefulShutdown()`，设置 `AIC_IN_PROCESS=1`；不再 spawn 子进程，终端用户无需安装 Node.js
- **退出处理:** `before-quit` 触发 `gracefulShutdown()`（恢复 Claude/Codex/OpenCode 配置、关闭 DB/日志、释放端口），随后停用所有激活路由，防止配置文件残留
- **资源打包:** electron-builder 打包 `dist/**`、`electron/**`、`package.json`（node_modules 自动裁剪），`asar: false`，输出到 `release/`
- **启动屏:** `electron/loading.html`（经 preload.js 暴露的 `onStartupLog` / `onStartupError`）在服务器就绪前展示启动进度，就绪后窗口跳转到 `http://127.0.0.1:{PORT}`
- **原理:** Electron 主进程内嵌运行 `dist/server/main.js`，并使用内置 WebView 渲染 UI 页面

## 构建与发布

```bash
# 开发
yarn dev              # 并行运行 UI + Server (watch 模式)
yarn dev:ui           # 仅运行 React UI (Vite)
yarn dev:server       # 仅运行 Node Server (tsx watch)

# 构建
yarn build            # 构建 UI + Server
yarn build:ui         # 构建 React UI
yarn build:server     # 构建 TypeScript Server

# Electron
yarn electron:dev     # 开发模式 (vite + electron，AIC_ELECTRON_DEV_SERVER)
yarn electron:start   # 构建并启动当前 dist 的桌面应用
yarn electron:build   # 构建桌面应用安装包 (输出到 release/)
yarn electron:icon    # 拷贝 logo 到 build/icon.png

# CLI
yarn link             # 本地链接 CLI 进行测试
aicos start           # 启动代理服务
aicos ui              # 启动服务 + 打开浏览器 UI
aicos stop            # 停止服务
```

## 子模块文档

- `src/server/AGENTS.md` - 后端服务详细约定
- `src/ui/AGENTS.md` - 前端 React 应用约定

## 最近变更

- 2026-06-17: 新增服务性能测速与吞吐统计（被动流量，全局）
  - 以「供应商 → 服务 → 模型」三级聚合两个指标：首 Token 返回时间（TTFT）、吞吐 TPM（生成阶段每分钟吐出 token 数），走势按小时桶
  - 被动采集，与 AUTH 模式无关（普通路由 + AccessKey 路由统一计入 `service-performance.json`）；流式经 `StreamTimingTransform` 精确打点，非流式端到端估算
  - 采集点在两条转发路径（`proxyRequest` / `proxyRequestForApiPath`）的 `finalizeLog` 公共点；聚合模块 `server/performance-tracker.ts`（加权 sum+count）
  - 新增 4 个 API `/api/performance/*`；数据统计页新增「服务性能」面板（指标 × 维度 × 时段筛选）
- 2026-06-13: 新增 Claude Code 默认权限模式配置项 `permissions.defaultMode`
  - 新增全局配置 `claudePermissionsDefaultMode`，支持 6 种模式（`default`/`acceptEdits`/`plan`/`auto`/`dontAsk`/`bypassPermissions`），默认 `default`
  - 保留 `enableBypassPermissionsSupport` 作为门控：仅当其开启时 `bypassPermissions` 才可选/生效；关闭时若当前为该模式自动同步写回 `default`
  - 管理字段由整对象 `permissions` 收窄为叶子 `permissions.defaultMode`，保留用户自配的 `allow/deny/ask` 规则（`src/server/config-managed-fields.ts` 与 `bin/utils/managed-fields.js` 同步）
- 2026-06-03: 强化 Claude Code compact 链路
  - compact 请求在转发到上游前会补齐未配对的 `tool_use/server_tool_use`，并主动移除 `thinking`、`tools`、`tool_choice`、`mcp_servers`
  - compact 响应回传给 Claude Code 前会过滤 `thinking` / `tool_use` block，只保留纯文本摘要，避免 compact 成功后客户端继续进入错误恢复流程
- 2026-03-11: 修复 Claude Code → Gemini thinking 配置互斥冲突
  - 生成 `thinkingConfig` 时，若存在 `budget_tokens` 则仅写入 `thinkingBudget`，不再同时写入 `thinkingLevel`
  - 覆盖 `transformRequestFromClaudeToGemini` 与 `transformRequestFromResponsesToGemini`，修复 Gemini 400 报错

## Development

每次代码变更后:

* 每次有新的架构变化时，你需要更新 CLAUDE.md, AGENTS.md 来让文档保持最新。
* 在 `CHANGELOG.md` 中以简单概述记录变更
