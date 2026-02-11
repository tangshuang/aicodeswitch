# Server Module Conventions

**Generated:** 2026-02-11

## Overview

Node.js + TypeScript 后端服务，使用 Express 框架，处理 API 路由、代理转发、数据库持久化、格式转换等核心逻辑。

## Structure

```
src/server/
├── main.ts              # 入口: 配置加载、中间件注册、服务启动
├── proxy-server.ts      # 核心代理路由、规则匹配、流式响应
├── config.ts            # 环境变量与全局配置
├── database.ts          # 数据库抽象层 (SQLite/LevleDB 旧实现)
├── database-factory.ts  # 数据库工厂: 自动检测类型并创建实例
├── fs-database.ts       # 文件系统数据库: JSON 文件 CRUD
├── migrate-to-fs.ts     # 数据迁移工具 (SQLite → JSON)
├── auth.ts              # 认证中间件
├── utils.ts             # 工具函数 (端口检测等)
├── websocket-service.ts # WebSocket 服务
├── rules-status-service.ts # 路由状态管理
├── tools-service.ts     # 工具/Skills 管理
├── version-check.ts     # 版本检查
├── config-metadata.ts   # 配置元数据
└── transformers/        # API 格式转换
    ├── claude-openai.ts      # Claude ↔ OpenAI 格式互转
    ├── streaming.ts           # SSE 流式处理
    └── chunk-collector.ts     # 流式块收集器
```

## Key Patterns

### Route Organization
- API 路由前缀: `/api/`
- 代理路由: `/claude-code/`、`/codex/`
- 路由按功能模块划分 (vendors、routes、rules、logs、config 等)

### Database Access
- **旧实现**: `database.ts` - SQLite/LevelDB 抽象
- **新实现**: `fs-database.ts` - JSON 文件存储
- **自动迁移**: `migrate-to-fs.ts` - 启动时检测并迁移旧数据
- 数据文件位于: `~/.aicodeswitch/fs-db/*.json`

### Proxy & Transformation
- **请求路由**: `proxy-server.ts` 按内容类型匹配规则
- **格式转换**: `transformers/` 目录处理 Claude ↔ OpenAI 数据格式
- **流式处理**: SSE 流式响应与实时转换

### Error Handling
- 全局错误中间件捕获异常
- 错误日志记录完整上下文
- API 响应统一错误格式

## Important Files

| File | Purpose |
|------|---------|
| `main.ts` | 服务入口点，配置加载 |
| `proxy-server.ts` | 核心代理逻辑 |
| `fs-database.ts` | JSON 文件数据库 |
| `transformers/claude-openai.ts` | API 格式转换 |

## Conventions

- 使用 `__dirname` 获取目录路径
- 配置文件从 `~/.aicodeswitch/aicodeswitch.conf` 加载
- 所有数据操作使用异步 API
- 错误处理必须包含上下文信息

## Common Operations

```bash
# 开发运行
yarn dev:server

# 类型检查
npx tsc -p tsconfig.server.json --noEmit
```
