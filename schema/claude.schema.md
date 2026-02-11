# Claude API Schema 标准参考

Anthropic 官方 Messages API 数据格式规范和完整使用指南。

## 目录
- [API 概览](#api-概览)
- [Messages API 标准格式](#messages-api-标准格式)
- [模型选择](#模型选择)
- [思考 (Thinking) 功能](#思考-thinking-功能)
- [流式事件](#流式事件)
- [错误处理](#错误处理)
- [快速参考](#快速参考)
- [最佳实践](#最佳实践)

---

## API 概览

### 官方 Messages API

这是 **唯一的标准 Claude API**：

```
POST /v1/messages
Host: api.anthropic.com
```

所有下列都使用此 API：
- 代码生成任务
- 自然对话
- 文本分析
- 图像识别
- 工具调用
- 深度推理（Thinking）

### 模型功能矩阵

| 特性 | Claude 3.5 Sonnet | Claude 3.5 Haiku | Claude 3 Opus | 支持情况 |
|-----|-----------|-----------|---------|---------|
| **最大 context** | 200k | 200k | 200k | 全部支持 |
| **最佳用途** | 平衡性能 | 快速应答 | 复杂推理 | 都用同 API |
| **流式响应** | ✅ | ✅ | ✅ | 全部支持 |
| **工具调用** | ✅ | ✅ | ✅ | 全部支持 |
| **图像支持** | ✅ | ✅ | ✅ | 全部支持 |
| **Thinking 功能** | ✅ | ✅ | ✅ | 全部支持 |

---

## Messages API 标准格式

### 请求格式 (完整规范)

```typescript
POST /v1/messages
Host: api.anthropic.com
Content-Type: application/json
x-api-key: sk-ant-...
anthropic-version: 2023-06-01

{
  // ===== 必需字段 =====
  "model": string,                          // 模型ID
  "max_tokens": number,                     // 1-200000
  "messages": Array<Message>,               // 用户消息历史

  // ===== 可选字段 =====
  "system"?: string | SystemBlock[],        // 系统提示
  "temperature"?: number,                   // 0.0-1.0，采样温度
  "top_p"?: number,                         // 0.0-1.0，核采样
  "top_k"?: number,                         // 排名采样
  "stream"?: boolean,                       // 是否流式响应
  "tools"?: Tool[],                         // 工具定义
  "tool_choice"?: ToolChoice,               // 工具调用策略
  "stop_sequences"?: string[],              // 停止序列
  "thinking"?: ThinkingConfig,              // 思考配置
  "budget_tokens"?: number                  // 思考预算（新名称）
}
```

### 消息格式

```typescript
interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

type ContentBlock = 
  | TextContent
  | ImageContent
  | ToolUseContent
  | ToolResultContent
  | ThinkingContent
  | DocumentContent;

// 文本内容
interface TextContent {
  type: "text";
  text: string;
}

// 图像内容
interface ImageContent {
  type: "image";
  source: {
    type: "base64" | "url" | "file";
    media_type?: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    data?: string;      // base64 编码
    url?: string;
    file_id?: string;
  };
}

// 工具使用
interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: object;
}

// 工具结果
interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string | object;
  is_error?: boolean;
}

// 思考内容
interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

// 文档内容
interface DocumentContent {
  type: "document";
  source: {
    type: "file" | "base64";
    file_id?: string;
    data?: string;
    media_type?: string;
  };
  title?: string;
}
```

### 响应格式 (标准)

```typescript
{
  "id": string,                             // 消息 ID
  "type": "message",                        // 固定值
  "role": "assistant",                      // 角色
  "content": ContentBlock[],                // 响应内容
  "model": string,                          // 使用的模型
  "stop_reason": 
    "end_turn" | 
    "max_tokens" | 
    "tool_use" | 
    "stop_sequence" | 
    "max_thinking_length",
  "stop_sequence"?: string | null,          // 触发的停止序列
  "usage": {
    "input_tokens": number,                 // 输入 token 数
    "output_tokens": number,                // 输出 token 数
    "cache_creation_input_tokens"?: number, // 缓存创建 token
    "cache_read_input_tokens"?: number      // 缓存读取 token
  },
  "thinking_tokens_used"?: number           // 思考使用的 token
}
```

### 最小请求示例

```bash
curl -X POST https://api.anthropic.com/v1/messages \
  -H "x-api-key: sk-ant-..." \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello"}
    ]
  }'
```

### 响应示例

```json
{
  "id": "msg_1234567890",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "Hello! How can I help you today?"
    }
  ],
  "model": "claude-3-5-sonnet-20241022",
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 10,
    "output_tokens": 15
  }
}
```

---

## 模型选择

Anthropic 官方发布的模型列表（使用同一 Messages API）：

### 最新模型（推荐）

```typescript
const models = {
  "claude-3-5-sonnet-20241022": {
    description: "最强性能/成本比（推荐首选）",
    input_cost: "$3 / 1M tokens",
    output_cost: "$15 / 1M tokens",
    best_for: "大多数应用"
  },
  "claude-3-5-haiku-20241022": {
    description: "最快，成本最低",
    input_cost: "$0.80 / 1M tokens",
    output_cost: "$4 / 1M tokens",
    best_for: "快速应答，简单任务"
  },
  "claude-3-opus-20240229": {
    description: "最强推理能力",
    input_cost: "$15 / 1M tokens",
    output_cost: "$75 / 1M tokens",
    best_for: "复杂分析，深度推理"
  }
};
```

### 选择决策树

```
问题类型？
├─ 简单查询 (是) ──> claude-3-5-haiku
├─ 代码生成 (中等复杂) ──> claude-3-5-sonnet
├─ 复杂推理、深度分析 ──> claude-3-opus
└─ 成本敏感 ──> haiku

需要深思熟虑吗？
├─ 是 ──> 启用 thinking 功能
└─ 否 ──> 直接生成
```

---

## 多轮对话示例

```bash
curl -X POST https://api.anthropic.com/v1/messages \
  -H "x-api-key: sk-ant-..." \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 1024,
    "messages": [
      {
        "role": "user",
        "content": "什么是 Python?"
      },
      {
        "role": "assistant",
        "content": "Python 是一门高级编程语言..."
      },
      {
        "role": "user",
        "content": "给个简单的例子"
      }
    ]
  }'
```

---

## 工具调用示例

```bash
curl -X POST https://api.anthropic.com/v1/messages \
  -H "x-api-key: sk-ant-..." \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 1024,
    "tools": [
      {
        "name": "get_weather",
        "description": "获取天气信息",
        "input_schema": {
          "type": "object",
          "properties": {
            "location": {
              "type": "string",
              "description": "城市名称"
            }
          },
          "required": ["location"]
        }
      }
    ],
    "messages": [
      {
        "role": "user",
        "content": "旧金山的天气如何?"
      }
    ]
  }'
```

---

## 图像处理示例

```json
{
  "model": "claude-3-5-sonnet-20241022",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": "image/jpeg",
            "data": "iVBORw0KGgoAAAANSUhEUgAAAA..."
          }
        },
        {
          "type": "text",
          "text": "这张图片里有什么?"
        }
      ]
    }
  ]
}
```

---

## 思考 (Thinking) 功能

### 官方定义

思考（Extended Thinking）是 Anthropic 提供的一项功能，允许模型在生成最终响应前进行内部推理。

**支持情况**：所有模型都支持，通过同一个 Messages API 启用

**关键特性**：
- 思考内容对用户可见
- 思考 token 单独计费，通常更便宜（约为输出成本的 30-50%）
- 预算范围：1,000 - 500,000 tokens
- 改进复杂问题的准确性

### 配置方式

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000
  }
}
```

### 预算选择指南

```typescript
const budgetRecommendations = {
  "simple_tasks": 2000,      // 快速计算、简单推理
  "moderate_tasks": 5000,    // 代码审查、一般分析
  "complex_tasks": 15000,    // 数学证明、架构设计
  "very_complex": 30000      // 深度研究、复杂算法
};
```

### 响应格式示例

```json
{
  "content": [
    {
      "type": "thinking",
      "thinking": "让我分析这个问题...\n第一步：识别问题类型\n第二步：考虑边界情况\n第三步：推导解决方案"
    },
    {
      "type": "text",
      "text": "基于以上分析，答案是..."
    }
  ],
  "thinking_tokens_used": 4521,
  "usage": {
    "input_tokens": 50,
    "output_tokens": 150,
    "thinking_tokens_used": 4521
  }
}
```

### 完整示例

```bash
curl -X POST https://api.anthropic.com/v1/messages \
  -H "x-api-key: sk-ant-..." \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-opus-20240229",
    "max_tokens": 2048,
    "thinking": {
      "type": "enabled",
      "budget_tokens": 10000
    },
    "messages": [
      {
        "role": "user",
        "content": "证明 sqrt(2) 是无理数"
      }
    ]
  }'
```

### 处理思考超时

当响应中 `stop_reason === "max_thinking_length"` 时，表示思考预算不足：

```typescript
if (response.stop_reason === "max_thinking_length") {
  // 增加预算后重新请求
  const newBudget = (response.thinking_tokens_used || 5000) * 1.5;
  console.log(`思考预算不足，将${newBudget}重试`);
  
  // 重新发送请求，使用更大的 budget_tokens
}
```

---

## 流式事件

### 启用流式响应

在请求中添加：
```json
{"stream": true}
```

### 事件类型

#### 消息开始
```
event: message_start
data: {"type":"message_start","message":{...}}
```

#### 内容块开始
```
event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
```

#### 文本增量
```
event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
```

#### 思考增量
```
event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"让我分析..."}}
```

#### 工具输入增量
```
event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"arg\":"}}
```

#### 内容块结束
```
event: content_block_stop
data: {"type":"content_block_stop","index":0}
```

#### Token 更新
```
event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42,"thinking_tokens":5234}}
```

#### 消息停止
```
event: message_stop
data: {"type":"message_stop"}
```

### 流式请求示例

```bash
curl -X POST http://api.anthropic.com/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-ant-..." \
  -d '{
    "model": "claude-3-sonnet-20240229",
    "max_tokens": 512,
    "stream": true,
    "messages": [
      {"role": "user", "content": "Write a poem about spring"}
    ]
  }'
```

---

## 错误处理

### 错误响应格式

```json
{
  "type": "error",
  "error": {
    "type": "error_type",
    "message": "描述性错误信息"
  }
}
```

### 常见错误

| HTTP 状态码 | 错误类型 | 原因 | 处理方案 |
|-----------|---------|------|--------|
| 400 | invalid_request_error | 参数错误 | 检查请求格式 |
| 401 | authentication_error | API Key 无效 | 更新 API Key |
| 429 | rate_limit_error | 超过速率限制 | 指数退避重试 |
| 500 | api_error | 服务器错误 | 重试或等待 |
| 529 | model_overloaded_error | 模型过载 | 稍后重试 |

### 重试策略

```typescript
async function requestWithRetry(
  request: any,
  maxRetries: number = 3
) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {...},
        body: JSON.stringify(request)
      });
      
      if (response.status === 429) {
        // 速率限制：指数退避
        const delay = Math.pow(2, attempt - 1) * 1000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      return await response.json();
    } catch (error) {
      if (attempt === maxRetries) throw error;
      await new Promise(r => setTimeout(r, 100 * attempt));
    }
  }
}
```

### 错误响应示例

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "max_tokens must be between 1 and 4096"
  }
}
```

---

## 快速参考

### 常用参数速查

| 参数 | 范围 | 默认值 | 说明 |
|-----|------|--------|------|
| temperature | 0.0-1.0 | 1.0 | 采样随机度，越低越稳定 |
| top_p | 0.0-1.0 | - | 核采样，控制多样性 |
| max_tokens | 1-4096* | - | 最大输出长度 *Chat 可到 200k |
| stream | true/false | false | 是否启用流式响应 |
| stop_sequences | 字符串数组 | - | 停止生成的关键词 |

### API 端点（官方）

```bash
# 官方 API（所有请求都使用此端点）
POST /v1/messages

# 官方 API 基础 URL
https://api.anthropic.com

# 认证头
x-api-key: sk-ant-YOUR_API_KEY

# 版本头（必需）
anthropic-version: 2023-06-01

# Content-Type
Content-Type: application/json
```

**注意**：官方只定义了 `/v1/messages` 端点，不存在 `/claude-code/v1/messages` 或 `/claude-chat/v1/messages`。这些是代理层的实现细节。

### 常用工具定义模板

```typescript
{
  "tools": [
    {
      "name": "function_name",
      "description": "函数功能描述",
      "input_schema": {
        "type": "object",
        "properties": {
          "param1": {
            "type": "string",
            "description": "参数说明"
          },
          "param2": {
            "type": "number",
            "description": "参数说明"
          }
        },
        "required": ["param1"]
      }
    }
  ]
}
```

---

## 最佳实践

### 1. 选择合适的模型（官方推荐）

```typescript
// 快速简单查询 - 最省成本
"model": "claude-3-5-haiku-20241022"

// 一般任务 - 最佳成本/性能比（推荐首选）
"model": "claude-3-5-sonnet-20241022"

// 复杂推理 - 最强能力
"model": "claude-3-opus-20240229"

// 注意：所有模型都使用同一 API (/v1/messages)
```

### 2. 流式 vs 非流式

```typescript
// 使用流式：长响应、实时反馈
"stream": true

// 使用非流式：简短回复、需要完整响应
"stream": false
```

### 3. Token 成本控制

```typescript
// 估算请求成本
const estimatedCost = {
  inputTokens: request.messages.length * avgTokensPerMessage,
  outputTokens: max_tokens * 0.5,  // 粗略估计
  thinkingTokens: thinking ? budget_tokens : 0
};

// 思考成本通常比输出便宜 40-80%
const thinkingCostMultiplier = 0.4;  // 40% of output cost
```

### 4. 错误处理核心清单

```typescript
✅ 检查 HTTP 状态码
✅ 检查 response.type === "error"
✅ 实现指数退避重试（429 状态码）
✅ 设置合理的请求超时（30-120 秒）
✅ 记录错误详情用于调试
✅ 对于 streaming，监听每个事件的错误
```

### 5. 思考功能使用规则

```typescript
// ✅ 启用思考的场景
if (task.complexity === 'high' || 
    task.requires('reasoning', 'proof', 'analysis')) {
  thinking = { type: 'enabled', budget_tokens: 10000 };
}

// ❌ 不启用思考的场景
if (task.type === 'simple_lookup' || 
    task.needsSpeed === true) {
  thinking = { type: 'disabled' };
}
```

### 6. 对话管理

```typescript
// 保持合理的历史记录
const maxMessages = 20;
if (messages.length > maxMessages) {
  // 移除旧消息，保留系统消息和最近消息
  messages = messages.slice(-maxMessages);
}

// 或使用 system 提示词总结长历史
system = `前面的对话中用户提到了...`;
```

### 7. 超时设置建议

```typescript
// 基于 max_tokens 计算超时
const timeout = {
  shortResponse: 10000,    // max_tokens < 1k
  mediumResponse: 30000,   // max_tokens 1k-10k
  longResponse: 120000,    // max_tokens > 10k
  withThinking: 180000     // 启用思考时加倍
};
```

### 8. 提示词缓存优化

```typescript
// 对重复的长系统提示使用缓存
{
  "system": [
    {
      "type": "text",
      "text": "[大型系统提示]",
      "cache_control": { "type": "ephemeral" }
    }
  ]
}

// 缓存可以减少成本和延迟
```

### 9. 图像处理最佳实践

```typescript
// Base64 最适合小图像（<100KB）
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/jpeg",
    "data": "iVBORw0KGgoAAAANS..."
  }
}

// URL 最适合网络图像
{
  "type": "image",
  "source": {
    "type": "url",
    "url": "https://example.com/image.jpg"
  }
}
```

### 10. 监控和日志

```typescript
interface RequestMetrics {
  requestId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  responseTime: number;
  status: 'success' | 'error' | 'retry';
  timestamp: Date;
}

// 定期分析指标优化成本
const avgCostPerRequest = totalTokens / requestCount;
```

---

## 代码示例库

### Python 基础示例

```python
import requests
import json

def call_claude(messages, model="claude-3-sonnet-20240229", max_tokens=1024):
    response = requests.post(
        "http://api.anthropic.com/v1/messages",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer your-api-key"
        },
        json={
            "model": model,
            "max_tokens": max_tokens,
            "messages": messages
        }
    )
    return response.json()

# 使用
result = call_claude([
    {"role": "user", "content": "Hello!"}
])
print(result["content"][0]["text"])
```

### JavaScript 流式示例

```javascript
async function callClaudeStream(messages, onChunk) {
  const response = await fetch(
    'http://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer your-api-key'
      },
      body: JSON.stringify({
        model: 'claude-3-sonnet-20240229',
        max_tokens: 1024,
        stream: true,
        messages
      })
    }
  );

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const event of events) {
      if (!event.trim()) continue;
      const data = JSON.parse(event.split('data: ')[1]);
      
      if (data.delta?.type === 'text_delta') {
        onChunk(data.delta.text);
      }
    }
  }
}
```

### TypeScript 工具调用示例

```typescript
interface ToolCall {
  name: string;
  arguments: Record<string, any>;
}

async function executeToolCall(toolCall: ToolCall): Promise<string> {
  const tools: Record<string, Function> = {
    'get_weather': async (location: string) => {
      return `Weather in ${location}: Sunny, 25°C`;
    },
    'calculate': async (expression: string) => {
      return eval(expression).toString();
    }
  };

  const tool = tools[toolCall.name];
  if (!tool) throw new Error(`Tool ${toolCall.name} not found`);
  
  return await tool(...Object.values(toolCall.arguments));
}
```

---

## 版本信息

- **文档版本**：2.0（标准官方格式）
- **基于文档**：Anthropic 官方 API 文档
- **支持的模型**：Claude 3.5 Sonnet、Claude 3.5 Haiku、Claude 3 Opus
- **最后更新**：2026 年 2 月 3 日
- **API 基础 URL**：https://api.anthropic.com
- **API 版本**：anthropic-version: 2023-06-01

---

## 常见问题更正

| 问题 | ❌ 常见误解 | ✅ 官方事实 |
|-----|-----------|----------|
| Claude Code 和 Chat API 有区别吗？ | "它们是不同的 API" | ❌ 假的。都使用同一个 `/v1/messages` 端点 |
| 如何选择使用哪个 API？ | "基于应用名称选择" | ❌ 不存在这样的选择。通过 `model` 参数选择能力 |
| 是否有 `/claude-code` 端点？ | "官方提供此端点" | ❌ 官方只提供 `/v1/messages` 端点 |
| 模型决定了 API 格式吗？ | "不同模型格式不同" | ❌ 所有模型使用完全相同的请求/响应格式 |
| 我应该使用哪个模型？ | "取决于是否用于代码" | ✅ 正确。任何模型都可以做代码，选择取决于性能和成本需求 |
| 思考功能是否只在某些 API 可用？ | "仅在某些端点可用" | ❌ 所有模型都支持，通过同一 API |

---

## 相关资源

- [Anthropic 官方文档](https://docs.anthropic.com)
- [Claude API 参考](https://docs.anthropic.com/en/api/messages)
- [模型概览](https://docs.anthropic.com/en/docs/about/models/models-overview)
