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

---

## Import/Export Data Migration (2026-02-12)

### 重构内容

重构了数据导入/导出功能，仅支持当前数据库格式，添加严格数据校验和预览功能。

### 后端修改

#### `fs-database.ts`
- **新增** `CURRENT_EXPORT_VERSION = '3.0.0'` 版本标记
- **新增** `validateVendor()` - 验证供应商及其服务数据格式
- **新增** `validateRoute()` - 验证路由数据格式
- **新增** `validateRule()` - 验证规则数据格式
- **新增** `validateConfig()` - 验证配置数据格式
- **新增** `validateExportData()` - 严格验证整个导出数据结构
- **新增** `previewImportData()` - 预览导入数据，返回数据概览
- **重写** `exportData()` - 使用版本 3.0.0，移除旧格式兼容性
- **重写** `importData()` - 返回 `ImportResult` 对象，包含详细错误信息

#### `main.ts`
- **新增** `/api/import/preview` 端点 - 用于预览导入数据
- **修改** `/api/import` 端点 - 支持新的返回格式 `ImportResult`

#### `types/index.ts`
- **新增** `ImportResult` 接口 - 导入操作返回结果
- **新增** `ImportPreview` 接口 - 预览操作返回结果

### 前端修改

#### `api/client.ts`
- **新增** `previewImportData()` API 调用
- **更新** `importData()` 返回类型为 `ImportResult`

#### `pages/SettingsPage.tsx`
- **新增** 预览状态管理 (`previewData`, `isPreviewing`, `isImporting`)
- **新增** `handlePreview()` - 预览数据并显示概览
- **新增** `handleCancelImport()` - 取消导入流程
- **重写** 导入UI流程：
  1. 输入密码和数据 → 点击"预览数据"
  2. 显示数据概览（供应商数、服务数、路由数、规则数）
  3. 用户确认后执行导入

### 行为变更

| 功能 | 旧行为 | 新行为 |
|------|--------|--------|
| 版本检查 | 字符串比较，兼容旧版本 | 严格等于 `3.0.0`，不兼容旧版本 |
| 数据校验 | 无校验，直接导入 | 完整字段校验，提供具体错误信息 |
| 导入流程 | 直接导入 | 先预览，再确认导入 |
| 返回值 | `boolean` | `ImportResult` 对象 |

### API 变更

#### `POST /api/import/preview` (新增)
```typescript
Request: { encryptedData: string, password: string }
Response: ImportPreview {
  success: boolean;
  message?: string;
  data?: {
    vendors: number;
    services: number;
    routes: number;
    rules: number;
    exportDate: number;
    version: string;
  };
}
```

#### `POST /api/import` (修改)
```typescript
Request: { encryptedData: string, password: string }
Response: ImportResult {
  success: boolean;
  message: string;
  details?: string;
}
```

### 注意事项

- **破坏性变更**: 不再支持导入 3.0.0 版本之前导出的数据文件
- **数据校验**: 导入时会验证所有必需字段，包括供应商、服务、路由、规则的完整结构
- **错误信息**: 导入失败时会返回具体的错误原因（如"供应商[0]缺少有效的 id 字段"）
