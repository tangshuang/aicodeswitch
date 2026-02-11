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

## API 格式转换

项目支持 Claude API 与 OpenAI Chat API 之间的双向转换，使得 Claude Code 可以使用 OpenAI 兼容的后端服务，Codex 也可以使用 Claude 后端服务。

### 转换逻辑位置

| 文件 | 函数/类 | 说明 |
|------|---------|------|
| `transformers/claude-openai.ts:312` | `transformClaudeRequestToOpenAIChat()` | Claude 请求 → OpenAI Chat 格式 |
| `transformers/claude-openai.ts:680` | `transformClaudeResponseToOpenAIChat()` | Claude 响应 → OpenAI Chat 格式 |
| `transformers/claude-openai.ts:588` | `transformOpenAIChatResponseToClaude()` | OpenAI Chat 响应 → Claude 格式 |
| `transformers/streaming.ts` | `ClaudeToOpenAIChatEventTransform` | Claude 流式事件 → OpenAI Chat 格式 |
| `transformers/streaming.ts` | `OpenAIToClaudeEventTransform` | OpenAI Chat 流式事件 → Claude 格式 |

### 路由调度逻辑

在 `proxy-server.ts:1648-1667` 中根据 `targetType` 和 `sourceType` 决定转换方向：

```typescript
// Codex 使用 Claude 后端服务
if (targetType === 'codex') {
  if (this.isClaudeSource(sourceType)) {
    requestBody = transformClaudeRequestToOpenAIChat(requestBody, rule.targetModel);
  }
}

// Claude Code 使用 OpenAI 兼容后端服务
if (targetType === 'claude-code') {
  if (this.isOpenAIChatSource(sourceType)) {
    requestBody = transformClaudeRequestToOpenAIChat(requestBody, rule.targetModel);
  }
}
```

### 支持的转换内容

| 内容类型 | Claude 格式 | OpenAI 格式 |
|---------|-------------|-------------|
| 文本 | `{type: "text", text: "..."}` | `string` 或 `{type: "text", text: "..."}` |
| 图像 | `{type: "image", source: {type, media_type, data}}` | `{type: "image_url", image_url: {url}}` |
| 工具调用 | `tool_use` block: `{type, id, name, input}` | `tool_calls` array: `[{id, type, function}]` |
| 工具结果 | `tool_result` block: `{type, tool_use_id, content}` | `role: "tool"` message |
| 思考内容 | `{type: "thinking", thinking: "..."}` | `reasoning` / `thinking` 字段 |
| 系统提示 | `system` 字段 (string 或 array) | `role: "system"` / `role: "developer"` message |
| 工具选择 | `"auto"` / `"any"` / `{type: "tool", name}` | `"auto"` / `"required"` / `{type: "function", function}` |
| 停止原因 | `end_turn` / `max_tokens` / `tool_use` / `max_thinking_length` | `stop` / `length` / `tool_calls` |

### 特殊处理

- **DeepSeek 兼容**: 自动将 `system` 角色映射为 `developer` 角色
- **图像格式**: 支持 base64 和 URL 两种格式互转
- **流式响应**: SSE 事件实时解析与格式转换
- **token 用量**: 统一转换为 Claude 格式的 `input_tokens` / `output_tokens`

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
