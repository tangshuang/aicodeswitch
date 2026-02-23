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

---

## MCP Image Understanding Integration (2026-02-16)

### 功能概述

为路由规则的"图像理解"类型添加 MCP (Model Context Protocol) 支持，允许使用 MCP 工具处理图像理解请求，而不是直接调用上游 API。

### 核心组件

#### 1. `mcp-image-handler.ts` (新增)

新增模块，负责处理图像理解请求中的图片内容：

```typescript
// 主要导出函数
export async function extractImagesFromMessages(messages: any[])
export async function saveImageToTempFile(imageData: string, isBase64: boolean)
export function constructMCPMessages(messages: any[], imageInfos: ImageInfo[], mcp?: MCPServer)
export function cleanupTempImages(filePaths: string[])
export function isRuleUsingMCP(rule: Rule)
export function isMCPAvailable(rule: Rule, mcps: MCPServer[])
```

**工作流程**：
1. 遍历消息内容，提取图片块（支持 Claude 和 OpenAI 两种格式）
2. 将 base64 图片数据保存到临时文件 `/tmp/aicodeswitch-images/`
3. 修改消息内容，将图片块替换为本地文件路径引用 `[Image: /path/to/file]`
4. 请求完成后自动清理临时文件

**图片格式支持**：
- Claude 格式: `{type: "image", source: {type: "base64", media_type, data}}`
- OpenAI 格式: `{type: "image_url", image_url: {url: "data:image/...;base64,..."}}`

#### 2. `fs-database.ts` (修改)

**`validateRule()` 方法更新**：
- 当 `useMCP=true` 且 `contentType='image-understanding'` 时，必须提供 `mcpId`
- 当 `useMCP=false` 时，必须提供 `targetServiceId`
- 支持规则的 MCP 配置字段：`useMCP` 和 `mcpId`

```typescript
// 验证逻辑
if (rule.useMCP === true && rule.contentType === 'image-understanding') {
  if (!rule.mcpId) return { valid: false, error: '缺少 mcpId' };
} else {
  if (!rule.targetServiceId) return { valid: false, error: '缺少 targetServiceId' };
}
```

#### 3. `proxy-server.ts` (修改)

**`proxyRequest()` 方法增强**：

在方法开始处添加 MCP 处理逻辑（约 1571 行）：

```typescript
private async proxyRequest(req: Request, res: Response, route: Route, rule: Rule, service: APIService) {
  // ... 初始化代码

  // MCP 图像理解处理
  let tempImageFiles: string[] = [];
  let useMCPProcessing = false;
  let mcpConfig: any = undefined;

  // 检查 MCP 是否可用
  if (isRuleUsingMCP(rule)) {
    const mcps = this.dbManager.getMCPs();
    if (isMCPAvailable(rule, mcps)) {
      useMCPProcessing = true;
      mcpConfig = mcps.find(m => m.id === rule.mcpId);
    }
  }

  if (useMCPProcessing) {
    try {
      // 1. 提取图片
      const messages = requestBody.messages || [];
      const imageInfos = await extractImagesFromMessages(messages);

      if (imageInfos.length > 0) {
        // 2. 记录临时文件路径
        tempImageFiles = imageInfos.map(info => info.filePath);

        // 3. 构造 MCP 消息（传递 MCP 配置）
        requestBody.messages = constructMCPMessages(messages, imageInfos, mcpConfig);

        console.log(`[MCP] Processed ${imageInfos.length} images`);
        console.log(`[MCP] Using MCP tool: ${mcpConfig?.name}`);
      }
    } catch (error: any) {
      // 4. 错误处理：清理临时文件，降级到默认处理
      cleanupTempImages(tempImageFiles);
      useMCPProcessing = false;
    }
  }

  // ... 继续正常的代理流程
}
```

**`finalizeLog()` 方法增强**：

在日志记录完成后自动清理临时文件（约 1740 行）：

```typescript
const finalizeLog = async (statusCode: number, error?: string) => {
  // ... 原有日志记录逻辑

  // 清理 MCP 临时图片文件
  if (tempImageFiles.length > 0) {
    cleanupTempImages(tempImageFiles);
    console.log(`[MCP] Cleaned up ${tempImageFiles.length} temporary files`);
  }
};
```

### 技术实现细节

#### 1. 图片提取逻辑

```typescript
// extractImagesFromMessages() 核心逻辑
for (const message of messages) {
  const content = Array.isArray(message.content) ? message.content : [message.content];

  for (const block of content) {
    // Claude 格式
    if (block.type === 'image' && block.source?.data) {
      const { filePath, mimeType } = await saveImageToTempFile(block.source.data, true);
      images.push({ filePath, mimeType, index: messageIndex });
    }

    // OpenAI 格式
    if (block.type === 'image_url' && block.image_url?.url?.startsWith('data:')) {
      const { filePath, mimeType } = await saveImageToTempFile(block.image_url.url, true);
      images.push({ filePath, mimeType, index: messageIndex });
    }
  }
}
```

#### 2. 临时文件管理

- **存储位置**: `/tmp/aicodeswitch-images/` (系统临时目录)
- **文件命名**: `{randomUUID}.{extension}` (如 `a1b2c3d4e5f6g7h8.png`)
- **清理时机**: 请求完成时（无论成功或失败）
- **清理策略**: 立即删除，不保留任何临时文件

```typescript
// 临时文件路径示例
const uniqueId = crypto.randomBytes(16).toString('hex');
const filePath = path.join(os.tmpdir(), 'aicodeswitch-images', `${uniqueId}.png`);
// macOS: /var/folders/.../T/aicodeswitch-images/a1b2c3d4.png
// Linux: /tmp/aicodeswitch-images/a1b2c3d4.png
```

#### 3. 消息体转换

**原始消息** (包含 base64 图片):
```json
{
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "What's in this image?" },
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": "iVBORw0KGgoAAAANSUhEUgA..."
          }
        }
      ]
    }
  ]
}
```

**转换后消息** (明确的 MCP 调用指示):
```json
{
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "What's in this image?" },
        {
          "type": "text",
          "text": "[Image File: /tmp/aicodeswitch-images/a1b2c3d4.png]\n\n请使用 \"GLM 视觉理解\" MCP 工具来理解和分析这张图片。\n\nMCP 工具信息：\n- 名称: GLM 视觉理解\n- 类型: stdio\n- 说明: 提供 GLM-4.6V 视觉理解能力\n\n请主动调用此 MCP 工具来处理图片路径: /tmp/aicodeswitch-images/a1b2c3d4.png"
        }
      ]
    }
  ]
}
```

**关键改进**：
- 明确指定要使用的 MCP 工具名称
- 提供 MCP 工具的详细信息（名称、类型、说明）
- 明确指示 Agent 主动调用 MCP 工具
- 提供图片的本地路径供 MCP 工具处理

#### 4. MCP 工具识别

MCP 工具（如 GLM 视觉理解 MCP）会识别 `[Image: /path/to/file]` 格式的文本，并自动：
1. 检测本地文件是否存在
2. 读取文件内容
3. 使用视觉模型分析图片
4. 返回分析结果

参考文档: `documents/glm/视觉理解MCP.md`

### 数据流程

```
┌─────────────────────────────────────────────────────────────────┐
│  客户端请求 (Claude Code / Codex)                                │
│  { messages: [{ content: [{ type: "image", ... }] }] }         │
└───────────────────┬─────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│  Proxy Server (proxy-server.ts:1571)                            │
│  - 检测规则是否使用 MCP                                          │
│  - isRuleUsingMCP(rule) → true                                  │
└───────────────────┬─────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│  MCP Image Handler (mcp-image-handler.ts)                       │
│  1. extractImagesFromMessages() - 提取图片                      │
│  2. saveImageToTempFile() - 保存到 /tmp/                        │
│  3. constructMCPMessages() - 替换为本地路径                     │
└───────────────────┬─────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│  修改后的请求体                                                  │
│  { messages: [{ content: [                                       │
│    { type: "text", text: "..." },                               │
│    { type: "text", text: "[Image: /tmp/...]" }                  │
│  ]}] }                                                          │
└───────────────────┬─────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────────��──────────┐
│  上游 API 接收请求                                               │
│  - 将请求转发给配置的 API 服务                                   │
│  - MCP 工具识别本地文件路径                                     │
│  - MCP 读取并处理图片                                           │
└───────────────────┬─────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│  响应返回 & 清理                                                 │
│  - finalizeLog() 记录日志                                       │
│  - cleanupTempImages() 删除临时文件                             │
└─────────────────────────────────────────────────────────────────┘
```

### 配置示例

**路由规则配置** (在 UI 中):
```typescript
{
  id: "rule-123",
  routeId: "route-456",
  contentType: "image-understanding",
  useMCP: true,                    // 启用 MCP
  mcpId: "mcp-789",                // MCP 工具 ID
  sortOrder: 100,
  timeout: 300000                  // 5分钟超时
}
```

**MCP 工具配置** (在 MCP 管理页面):
```typescript
{
  id: "mcp-789",
  name: "GLM 视觉理解",
  type: "stdio",
  command: "npx",
  args: ["-y", "@z_ai/mcp-server"],
  env: {
    "Z_AI_API_KEY": "your-api-key",
    "Z_AI_MODE": "ZHIPU"
  },
  targets: ["claude-code", "codex"]
}
```

### 错误处理

| 错误场景 | 处理方式 |
|---------|---------|
| 图片提取失败 | 清理已创建的临时文件，降级到默认图像处理逻辑 |
| 临时文件写入失败 | 记录错误日志，降级到默认图像处理逻辑 |
| MCP 工具未配置 | 在 `isMCPAvailable()` 检查时降级到默认处理 |
| MCP 未在数据库中注册 | 在 `isMCPAvailable()` 检查时降级到默认处理 |
| MCP ID 缺失 | 在 `isMCPAvailable()` 检查时降级到默认处理 |
| 请求超时 | 按规则配置的超时时间处理，超时后清理临时文件 |

### 降级机制

当 MCP 不可用时，系统会自动降级到默认的图像处理逻辑，确保请求不会失败：

```typescript
// proxy-server.ts 中的降级逻辑
let useMCPProcessing = false;

if (isRuleUsingMCP(rule)) {
  const mcps = this.dbManager.getMCPs();
  if (isMCPAvailable(rule, mcps)) {
    useMCPProcessing = true;  // MCP 可用，使用 MCP 处理
  } else {
    console.warn('[MCP] MCP is not available, falling back to default image processing');
    // MCP 不可用，降级到默认处理
  }
}

if (useMCPProcessing) {
  try {
    // MCP 处理逻辑...
  } catch (error) {
    console.error('[MCP] Failed to process images, falling back to default processing');
    cleanupTempImages(tempImageFiles);
    useMCPProcessing = false;  // 处理失败，降级到默认处理
  }
}

// 继续正常的代理流程（默认图像处理）
```

**降级条件**：
1. `useMCP=true` 但 `mcpId` 为空
2. `mcpId` 配置但 MCP 未在数据库中注册
3. 图片提取或处理过程中发生错误

**降级行为**：
- 清理已创建的临时文件
- 记录警告日志
- 继续使用默认的代理流程处理图像请求
- 请求不会因为 MCP 问题而失败

### 性能考虑

- **内存**: 图片数据仅在提取时存在于内存，保存到文件后立即释放
- **磁盘**: 临时文件在请求完成后立即删除，不占用长期存储
- **并发**: 支持多个并发请求，每个请求使用独立的临时文件（UUID 命名）
- **安全**: 临时文件位于系统临时目录，重启后自动清理

### 注意事项

1. **MCP 配置**: 必须在 MCP 管理页面先添加并配置 MCP 工具
2. **规则匹配**: 仅对 `contentType='image-understanding'` 的规则生效
3. **图片格式**: 仅支持 base64 编码的图片，暂不支持远程 URL 图片
4. **文件清理**: 确保请求完成后清理函数被调用，避免临时文件堆积
5. **日志记录**: MCP 处理过程会输出日志，便于调试

### 相关文件

| 文件 | 修改内容 |
|------|---------|
| `server/mcp-image-handler.ts` | 新增：图片处理核心逻辑 |
| `server/proxy-server.ts` | 修改：集成 MCP 处理流程 |
| `server/fs-database.ts` | 修改：验证规则 MCP 字段 |
| `types/index.ts` | 修改：Rule 接口添加 `useMCP` 和 `mcpId` |
| `ui/pages/RoutesPage.tsx` | 修改：前端 MCP 配置界面 |

---

## Request Frequency Limit (2026-02-23)

### 功能概述

为路由规则添加请求频率限制功能，允许用户设置规则在特定时间窗口内的最大请求次数。当同一内容类型的请求频率超过限制时，系统会自动切换到其他同类型规则，实现负载均衡。

### 核心组件

#### 1. `types/index.ts` (修改)

在 `Rule` 接口中添加频率限制字段：

```typescript
export interface Rule {
  // ... 其他字段
  frequencyLimit?: number;       // 频率限制次数（并发数）
  frequencyWindow?: number;      // 频率限制时间窗口（秒），0 表示"同一时刻"
}
```

#### 2. `proxy-server.ts` (修改)

**新增属性**：

```typescript
// 频率限制跟踪：用于跟踪每个规则在当前时间窗口内的请求数
// key: ruleId, value: { count: number, windowStart: number }
private frequencyLimitTracker = new Map<string, { count: number; windowStart: number }>();
```

**新增方法**：

1. **`isFrequencyLimitExceeded(rule: Rule): boolean`**
   - 检查规则是否达到频率限制
   - 如果设置了 `frequencyLimit`，则跟踪请求数
   - `frequencyWindow = 0` 表示"同一时刻"（并发数），计数器持续累积
   - `frequencyWindow > 0` 表示时间窗口，计数器按时间窗口重置
   - 超过限制返回 `true`，否则返回 `false`

2. **`recordRequest(ruleId: string): void`**
   - 在请求成功后更新频率计数
   - 维护 `frequencyLimitTracker` 中的请求计数
   - 支持 `frequencyWindow = 0`（持续累积）和 `> 0`（按时间窗口重置）两种模式

3. **`cleanExpiredFrequencyTrackers(): void`**
   - 定期清理过期的频率限制跟踪数据
   - 清理不再存在的规则的跟踪数据

**修改的方法**：

1. **`findMatchingRule()`** - 在规则匹配检查中添加频率限制检查
2. **`getAllMatchingRules()`** - 在候选规则过滤中添加频率限制检查
3. **`proxyRequest()`** - 在请求完成后调用 `recordRequest()` 更新频率计数

#### 3. `ui/pages/RoutesPage.tsx` (修改)

**新增状态**：

```typescript
const [selectedFrequencyLimit, setSelectedFrequencyLimit] = useState<number | undefined>(undefined);
const [selectedFrequencyWindow, setSelectedFrequencyWindow] = useState<number | undefined>(undefined);
```

**新增 UI 组件**：

- 启用请求频率限制复选框
- 频率限制次数输入框（请求数）
- 时间窗口输入框（秒）

### 工作原理

#### 1. 频率限制检查流程

```
请求进入 → findMatchingRule() / getAllMatchingRules()
           ↓
    检查规则是否设置了频率限制
           ↓
    是 → 检查 frequencyLimitTracker 中当前计数
         ↓                              ↓
    超过限制                   未超过限制
         ↓                              ↓
    跳过该规则              增加计数，返回规则
    尝试其他同类型规则
```

#### 2. 频率计数更新

```
请求成功 → proxyRequest() 中的 finalizeLog()
           ↓
    调用 recordRequest(rule.id)
           ↓
    更新 frequencyLimitTracker 中的计数
```

#### 3. 规则切换逻辑

当同一内容类型存在多个规则时：
1. 系统按优先级尝试每个规则
2. 如果某规则达到频率限制，自动跳过
3. 继续尝试下一个同类型规则
4. 如果没有其他同类型规则，则继续使用当前规则（原行为不变）

### 配置示例

**路由规则配置** (在 UI 中):

**示例 1：限制并发数（同一时刻）**
```typescript
{
  id: "rule-123",
  routeId: "route-456",
  contentType: "default",
  targetServiceId: "service-789",
  frequencyLimit: 3,       // 最多3个并发请求
  frequencyWindow: 0,      // 0 表示"同一时刻"，计数器持续累积
  sortOrder: 100
}
```
效果：该规则最多同时处理 3 个请求，超过 3 个后自动切换到其他同类型规则。

**示例 2：限制请求速率**
```typescript
{
  id: "rule-456",
  routeId: "route-456",
  contentType: "default",
  targetServiceId: "service-789",
  frequencyLimit: 10,     // 60秒内最多10次请求
  frequencyWindow: 60,     // 时间窗口为60秒
  sortOrder: 100
}
```
效果：在 60 秒内，该规则最多处理 10 个请求，超过后自动切换到其他同类型规则。

### 数据结构

```typescript
// frequencyLimitTracker 存储结构
{
  "rule-id-1": {
    count: 5,        // 当前时间窗口内的请求数
    windowStart: 1708684800000  // 时间窗口开始时间戳
  },
  "rule-id-2": {
    count: 10,
    windowStart: 1708684800000
  }
}
```

### 与请求次数超量的区别

| 特性 | 请求次数超量 | 请求频率限制 |
|------|-------------|-------------|
| 统计方式 | 累计请求次数 | 时间窗口内请求数（或并发数） |
| 重置方式 | 手动/按时间间隔 | frequencyWindow=0 持续累积；>0 按时间窗口重置 |
| 用途 | 限制总用量 | 限制并发（frequencyWindow=0）或请求速率（frequencyWindow>0） |
| 作用时机 | 达到上限后规则失效 | 达到限制后切换到其他规则 |

### 错误处理

- **频率限制超出**: 跳过该规则，尝试其他同类型规则
- **无其他规则**: 继续使用当前规则（原行为不变）
- **跟踪数据过期**: 自动清理，不影响正常功能

### 性能考虑

- **内存**: 使用 Map 存储跟踪数据，键为规则 ID
- **清理**: 定期（1%概率）清理过期的跟踪数据
- **并发**: 支持多规则并发请求，每个规则独立计数

### 注意事项

1. **仅在有多规则时生效**: 频率限制仅在同一内容类型存在多个规则时生效
2. **无其他规则时行为不变**: 如果没有其他同类型规则，即使达到频率限制也会继续使用
3. **时间窗口**: 建议设置合理的时间窗口（如 60 秒）和次数限制（如 10 次）
4. **与请求次数超量配合**: 可以同时设置请求次数超量和频率限制，两者互不影响

### 相关文件

| 文件 | 修改内容 |
|------|---------|
| `types/index.ts` | 修改：Rule 接口添加 `frequencyLimit` 和 `frequencyWindow` |
| `server/proxy-server.ts` | 修改：添加频率限制跟踪和检查逻辑 |
| `ui/pages/RoutesPage.tsx` | 修改：前端频率限制配置界面 |

