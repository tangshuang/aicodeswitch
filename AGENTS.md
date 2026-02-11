# AI Code Switch - 项目知识库

**生成时间:** 2026-02-11
**项目类型:** AI 代理工具 / 本地代理服务器

## 项目概述

AI Code Switch 是一个本地代理服务器，管理 AI 编程工具（Claude Code、Codex）到大语言模型的连接。支持模型 API 路由、API 格式转换（Claude ↔ OpenAI）、技能分发、日志记录等功能。

**核心技术栈:**
- 后端: Node.js + TypeScript + Express
- 前端: React + TypeScript + Vite
- 桌面: Tauri 2.0 (Rust 主进程)
- 存储: JSON 文件系统数据库 (~/.aicodeswitch/data/)
- 部署: CLI 工具 + Web UI + 桌面应用

## 目录结构

```
aicodeswitch/
├── src/
│   ├── server/          # Node.js 后端服务 (Express API + 代理服务器)
│   └── ui/             # React 前端应用
├── tauri/              # Tauri 桌面应用 (Rust + 嵌入式资源)
├── bin/                # CLI 脚本 (aicos 命令)
├── dist/               # 构建产物 (server/, ui/)
├── documents/          # 文档 (Tauri 研究、构建指南)
├── scripts/           # 构建/发布脚本
├── package.json       # npm 脚本、依赖声明
├── tsconfig.json      # TypeScript 配置
├── vite.config.ts     # Vite 构建配置
└── .github/workflows/ # CI/CD 流水线
```

## 快速定位

| 任务 | 位置 | 说明 |
|------|------|------|
| 核心代理逻辑 | `src/server/proxy-server.ts` | 请求路由、匹配规则、转发 |
| API 格式转换 | `src/server/transformers/` | Claude ↔ OpenAI 数据格式互转 |
| 数据库层 | `src/server/fs-database.ts` | JSON 文件存储 CRUD |
| UI 页面 | `src/ui/pages/` | 供应商管理、路由配置、日志等 |
| CLI 命令 | `bin/*.js` | start/stop/ui/update/restore 等 |
| Tauri 主进程 | `tauri/src/main.rs` | Rust 窗口管理、Node 进程生命周期 |
| 构建配置 | `package.json` scripts | dev/build/tauri:dev 等 |

## 代码规范

### 通用约定
- **包管理器:** yarn (使用 `yarn install`，前端依赖装在 devDependencies)
- **服务端路径:** 使用 `__dirname` 获取目录，不要用 `process.cwd()`
- **UI 样式:** 禁止使用依赖 GPU 的 CSS 样式
- **测试命令:** 禁止运行 `dev:ui`、`dev:server`、`tauri:dev` 进行测试
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
- 配置文件: `~/.aicodeswitch/aicodeswitch.conf`

## 特殊约定

### 数据库与迁移
- **数据格式:** 所有数据存为 JSON 文件 (`~/.aicodeswitch/fs-db/*.json`)
- **数据结构:** `vendors.json` 内嵌 `services` 数组（已迁移，旧结构已废弃）
- **自动迁移:** 启动时自动检测并迁移旧 SQLite/LevelDB/旧 JSON 结构
- **迁移工具:** `src/server/migrate-to-fs.ts`

### 路由与故障切换
- **路由规则:** 按请求内容类型 (image-understanding/thinking/long-context/background/default) 匹配
- **智能故障切换:** 同类型多条规则时，优先使用第一条；报错/超时时自动切换下一条

### 日志规范
- **日志类型:** 请求日志、错误日志、会话日志
- **敏感字段:** API 密钥等自动在 UI 层脱敏显示
- **会话标题:** 从首条用户消息提取，自动截断 (最大 100 字符)

### Tauri 桌面应用
- **Node.js 检测:** 启动时检查是否安装，未安装显示友好错误
- **退出处理:** 关闭时自动禁用所有激活的路由，防止配置文件残留
- **资源打包:** 构建时将 `dist/server` 和 `dist/ui` 嵌入 Tauri
- **原理:** 通过tauri来运行dist/server/main.js，并使用内置的webview来渲染ui页面

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

# Tauri
yarn tauri:dev        # 开发模式 (需要 Rust 工具链)
yarn tauri:build      # 构建桌面应用
yarn tauri:icon       # 生成图标

# CLI
yarn link             # 本地链接 CLI 进行测试
aicos start           # 启动代理服务
aicos ui              # 启动服务 + 打开浏览器 UI
aicos stop            # 停止服务
```

## 子模块文档

- `src/server/AGENTS.md` - 后端服务详细约定
- `src/ui/AGENTS.md` - 前端 React 应用约定
- `tauri/AGENTS.md` - Tauri 桌面应用约定

## 变更记录

每次代码变更后:
1. 更新 AGENTS.md 保持文档同步
2. 在 `CHANGELOG.md` 中以简单概述记录变更

- 2026-02-11: 调整 UI 弹层层级与日志页弹层叠放逻辑，修复侧栏遮挡问题。
- 2026-02-11: 请求日志补充记录规则内容类型，补齐统计页的请求类型分布数据。

---

*本文件由 `/init-deep` 自动生成*
