# OpenAI API Schema 标准参考

OpenAI 官方 API 数据格式规范和完整使用指南。包括经典 Completions API、Chat Completions API 和最新 Responses API（实时对话）。

## 目录
- [API 概览](#api-概览)
- [Completions API（文本补全）](#completions-api文本补全)
- [Chat Completions API（对话模型）](#chat-completions-api对话模型)
- [Responses API（实时对话）](#responses-api实时对话)
- [模型选择](#模型选择)
- [流式事件](#流式事件)
- [错误处理](#错误处理)
- [快速参考](#快速参考)
- [最佳实践](#最佳实践)

---

## API 概览

### 官方 API 端点

OpenAI 提供三个主要 API 接口，各有不同的用途：

| API 类型 | 端点 | 用途 | 状态 |
|---------|------|------|------|
| **Responses API** | `/v1/responses` | 新一代响应接口（推荐） | ✅ 最新标准 |
| **Chat Completions API** | `/v1/chat/completions` | 对话、代码生成 | ✅ 仍可用 |
| **Completions API** | `/v1/completions` | 文本补全（已弃用） | ⚠️ 维护模式 |

### API 基础配置

```
基础 URL: https://api.openai.com/v1

认证方式:
Authorization: Bearer sk-xxxxx
  或
x-api-key: sk-xxxxx

Content-Type: application/json
```

---

## Completions API（文本补全）

### 概述

**Completions API** 是 OpenAI 早期的文本生成接口，适用于纯文本补全任务。此 API 已不推荐用于新项目，推荐使用 Chat Completions API。

### 请求格式

```typescript
POST /v1/completions
Host: api.openai.com
Authorization: Bearer sk-xxx
Content-Type: application/json

{
  // ===== 必需字段 =====
  "model": string,                          // 模型ID (例: gpt-3.5-turbo-instruct)
  "prompt": string | string[],              // 输入提示词，支持数组批量

  // ===== 常用可选字段 =====
  "max_tokens"?: number,                    // 最大输出长度，默认16
  "temperature"?: number,                   // 0.0-2.0，采样温度
  "top_p"?: number,                         // 0.0-1.0，核采样
  "frequency_penalty"?: number,             // -2.0-2.0，频率惩罚
  "presence_penalty"?: number,              // -2.0-2.0，出现惩罚
  "best_of"?: number,                       // 生成n个补全，返回最佳的
  "echo"?: boolean,                         // 回显输入提示词
  "stop"?: string | string[],               // 停止序列
  "stream"?: boolean,                       // 是否流式响应
  "suffix"?: string,                        // 补全文本的后缀
  "logit_bias"?: object,                    // 调整特定token的概率
  "n"?: number                              // 生成多少个补全，默认1
}
```

### 请求示例

```bash
curl -X POST https://api.openai.com/v1/completions \
  -H "Authorization: Bearer sk-xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-3.5-turbo-instruct",
    "prompt": "将这个句子翻译为英文：'你好世界'",
    "max_tokens": 100,
    "temperature": 0.7
  }'
```

### 响应格式

```json
{
  "id": "cmpl-8R8e...",
  "object": "text_completion",
  "created": 1699000000,
  "model": "gpt-3.5-turbo-instruct",
  "choices": [
    {
      "text": "\nHello, world!",
      "index": 0,
      "logprobs": null,
      "finish_reason": "length" | "stop" | "content_filter"
    }
  ],
  "usage": {
    "prompt_tokens": 15,
    "completion_tokens": 10,
    "total_tokens": 25
  }
}
```

### 参数说明

- **max_tokens**: 补全的最大token数。设置越高，响应越长但成本更高
- **temperature**: 越低越稳定（0）、越高越随机（2）
- **best_of**: 生成多个补全并返回最佳的，n必须≤best_of
- **suffix**: 在补全后附加的文本

---

## Chat Completions API（对话模型）

### 概述

**Chat Completions API** 是 OpenAI 推荐的通用 API，支持多轮对话、系统提示、函数调用等高级功能。

### 请求格式

```typescript
POST /v1/chat/completions
Host: api.openai.com
Authorization: Bearer sk-xxx
Content-Type: application/json

{
  // ===== 必需字段 =====
  "model": string,                          // 模型ID
  "messages": Array<Message>,               // 消息历史

  // ===== 常用可选字段 =====
  "temperature"?: number,                   // 0-2，采样温度
  "top_p"?: number,                         // 0-1，核采样
  "max_tokens"?: number,                    // 最大输出长度
  "frequency_penalty"?: number,             // -2-2，频率惩罚
  "presence_penalty"?: number,              // -2-2，出现惩罚
  "stream"?: boolean,                       // 是否流式响应
  "stop"?: string | string[],               // 停止序列
  "seed"?: number,                          // 随机种子，确保可复现
  "top_logprobs"?: number,                  // 返回每个位置的概率分布
  "logprobs"?: boolean,                     // 是否返回log概率
  "user"?: string,                          // 终端用户标识，用于滥用检测
  "tools"?: Tool[],                         // 函数定义
  "tool_choice"?: "auto" | "required" | object,  // 工具调用策略
  "function_call"?: "auto" | { "name": string }, // 函数调用（已弃用）
  "functions"?: Function[],                 // 函数定义（已弃用）
  "response_format"?: object,               // 响应格式（JSON模式）
  "logit_bias"?: object                     // 调整特定token概率
}
```

### 消息格式

```typescript
interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentBlock[];
  name?: string;                            // 消息发送者名字
  tool_call_id?: string;                    // tool响应时必需
  tool_calls?: ToolCall[];                  // assistant消息中的工具调用
}

type ContentBlock =
  | TextContent
  | ImageContent
  | ToolCallContent
  | ToolResultContent;

// 文本内容
interface TextContent {
  type: "text";
  text: string;
}

// 图像内容（仅vision模型支持）
interface ImageContent {
  type: "image_url";
  image_url: {
    url: string;                            // URL或data:URI
    detail?: "low" | "high" | "auto";       // 图像详细程度
  };
}

// 工具调用
interface ToolCallContent {
  type: "tool_call";
  id: string;
  function: {
    name: string;
    arguments: string;                      // JSON字符串
  };
}

// 工具结果
interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
```

### 工具定义格式

```typescript
interface Tool {
  type: "function";
  function: {
    name: string;                           // 函数名
    description: string;                    // 功能描述
    parameters: {
      type: "object";
      properties: {
        [key: string]: {
          type: string;                     // string, number, boolean, array等
          description: string;              // 参数说明
          enum?: string[];                  // 可选值列表
          items?: object;                   // 数组项的类型
        };
      };
      required: string[];                   // 必需参数列表
    };
    strict?: boolean;                       // 严格模式（GPT-4 Turbo+）
  };
}
```

### 请求示例

```bash
curl -X POST https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4-turbo",
    "messages": [
      {
        "role": "system",
        "content": "You are a helpful assistant."
      },
      {
        "role": "user",
        "content": "What is 2+2?"
      }
    ],
    "max_tokens": 100,
    "temperature": 0.7
  }'
```

### 多轮对话示例

```bash
curl -X POST https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -d '{
    "model": "gpt-4-turbo",
    "messages": [
      {
        "role": "system",
        "content": "You are a Python expert."
      },
      {
        "role": "user",
        "content": "如何读取文件?"
      },
      {
        "role": "assistant",
        "content": "在Python中，你可以使用 open() 函数..."
      },
      {
        "role": "user",
        "content": "写一个例子"
      }
    ]
  }'
```

### 函数调用示例

```bash
curl -X POST https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -d '{
    "model": "gpt-4-turbo",
    "messages": [
      {
        "role": "user",
        "content": "旧金山现在的天气如何?"
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "获取指定城市的天气信息",
          "parameters": {
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
      }
    ],
    "tool_choice": "auto"
  }'
```

### 响应格式

```json
{
  "id": "chatcmpl-8R8e...",
  "object": "chat.completion",
  "created": 1699000000,
  "model": "gpt-4-turbo",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "2 + 2 = 4"
      },
      "finish_reason": "stop" | "length" | "tool_calls" | "content_filter"
    }
  ],
  "usage": {
    "prompt_tokens": 20,
    "completion_tokens": 10,
    "total_tokens": 30
  },
  "system_fingerprint": "fp_a8d8f..."
}
```

### 工具调用响应示例

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_abc123",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"location\": \"San Francisco\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

### JSON 响应格式

```bash
# 强制JSON输出
curl -X POST https://api.openai.com/v1/chat/completions \
  -d '{
    "model": "gpt-4-turbo",
    "messages": [
      {
        "role": "user",
        "content": "生成一个JSON格式的用户信息"
      }
    ],
    "response_format": {
      "type": "json_object"
    }
  }'
```

## 流式事件

### 流式响应启用

在请求中添加：
```json
{"stream": true}
```

### Chat Completions 流式事件

#### 响应开始

```
data: {"id":"chatcmpl-8R8e...","object":"chat.completion.chunk","created":1699000000,"model":"gpt-4-turbo","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}
```

#### 内容增量

```
data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}
data: {"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}
```

#### 工具调用开始

```
data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}
```

#### 工具调用参数增量

```
data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"loca"}}]},"finish_reason":null}]}
data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"tion\":\"SF"}}]},"finish_reason":null}]}
```

#### 响应结束

```
data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### 流式请求示例

```bash
curl -X POST https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4-turbo",
    "messages": [
      {"role": "user", "content": "请写一首春天的诗"}
    ],
    "stream": true
  }'
```

### Python 流式处理示例

```python
import openai

with openai.OpenAI(api_key="sk-xxx") as client:
    with client.chat.completions.stream(
        model="gpt-4-turbo",
        messages=[
            {"role": "user", "content": "写一首诗"}
        ]
    ) as stream:
        for text in stream.text_stream:
            print(text, end="", flush=True)
```

---

## 错误处理

### 错误响应格式

```json
{
  "error": {
    "message": "错误描述信息",
    "type": "error_type",
    "param": "参数名称",
    "code": "invalid_api_key"
  }
}
```

### 常见错误

| HTTP 状态 | 错误类型 | 原因 | 处理方案 |
|---------|--------|------|--------|
| 400 | invalid_request_error | 参数错误或格式不合法 | 检查请求格式、参数值范围 |
| 401 | authentication_error | API Key 无效或过期 | 更新有效的 API Key |
| 403 | permission_error | 账户没有权限访问该模型 | 检查账户权限和模型可用性 |
| 429 | rate_limit_error | 超过速率限制 | 实施指数退避重试 |
| 500 | server_error | OpenAI 服务器错误 | 重试请求 |
| 503 | service_unavailable_error | 服务暂时不可用 | 稍后重试 |

### 错误响应示例

```json
{
  "error": {
    "message": "The model `gpt-4` does not exist",
    "type": "invalid_request_error",
    "param": "model",
    "code": "model_not_found"
  }
}
```

### 重试策略

```typescript
async function requestWithRetry(
  requestFn: () => Promise<any>,
  maxRetries: number = 3
): Promise<any> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (error: any) {
      const status = error.status;
      const isRetryable = status === 429 || status >= 500;

      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }

      // 指数退避：第一次等待1秒，第二次2秒，第三次4秒
      const delay = Math.pow(2, attempt - 1) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
```

---

## 快速参考

### 常用参数速查

| 参数 | 范围 | 默认值 | 说明 |
|-----|------|--------|------|
| temperature | 0-2 | 1 | 采样温度，越低越稳定，越高越随机 |
| top_p | 0-1 | 1 | 核采样，与temperature互斥或同用 |
| max_tokens | 1-上限 | - | 最大输出长度 |
| frequency_penalty | -2-2 | 0 | 频率惩罚，减少重复词汇 |
| presence_penalty | -2-2 | 0 | 出现惩罚，鼓励新话题 |
| stream | true/false | false | 是否流式响应 |
| stop | 字符串数组 | - | 停止生成的序列 |
| seed | 整数 | - | 随机种子，确保输出可复现 |

### 认证方式

```bash
# 方式1：Authorization头（推荐）
Authorization: Bearer sk-xxx

# 方式2：API Key头
x-api-key: sk-xxx

# Realtime API 还需要Beta头
OpenAI-Beta: realtime=v1
```

---

## 最佳实践

### 1. API 选择指南

```typescript
// ✅ Chat Completions API（简单对话）
// - 轻量级对话接口
// - 支持函数调用和 Vision
// - 当不需要内置工具和后台处理时使用

POST /v1/chat/completions
```

### 2. 模型选择原则

```typescript
// ✅ 首选 gpt-4o（新项目推荐）
// - 最佳性能/成本比
// - 支持所有高级功能
// - 速度和质量平衡

// ✅ 成本敏感用 gpt-4o-mini
// - 成本最低
// - 足以处理大多数任务
// - 吞吐量最高

// ✅ 复杂推理用 gpt-4-turbo
// - 最强推理能力
// - 上下文最大

// ⚠️ 避免使用 gpt-3.5-turbo
// 除非有明确的遗留兼容性需求
```

### 3. 成本优化

```typescript
// 估算请求成本
function estimateCost(
  inputTokens: number,
  outputTokens: number,
  model: string
) {
  const prices = {
    'gpt-4-turbo': { input: 0.01, output: 0.03 },
    'gpt-4o': { input: 0.005, output: 0.015 },
    'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
    'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 }
  };

  const price = prices[model];
  return (
    (inputTokens * price.input + outputTokens * price.output) / 1000000
  );
}

// 优化策略
// 1. 减少重复请求 - 缓存常见查询
// 2. 使用 mini 模型处理简单任务
// 3. 限制 max_tokens 避免冗长响应
// 4. 批量处理而非逐个请求
```

### 4. 错误处理核心清单

```typescript
✅ 捕获所有异常，检查 error.status
✅ 区分可重试错误（429, 5xx）和不可重试（401, 403）
✅ 实施指数退避重试策略
✅ 为流式响应监听每个事件的错误
✅ 设置合理的请求超时（30-60秒）
✅ 记录错误详情便于调试
✅ 对于 429 应优先增加延迟而非重试
```

### 5. 流式 vs 非流式

```typescript
// 使用流式响应：
// ✅ 长响应（预期>500 tokens）
// ✅ 需要实时反馈的交互式应用
// ✅ 用户体验优先

if (expectedLength > 500 || needsRealtimeFeedback) {
  stream: true
}

// 使用非流式响应：
// ✅ 短响应（<100 tokens）
// ✅ 需要完整响应后处理
// ✅ 简单的后端任务

if (expectedLength < 100 && canWaitForComplete) {
  stream: false
}
```

### 6. 函数调用最佳实践

```typescript
// ✅ 定义清晰的函数描述
function: {
  name: "calculate_distance",
  description: "计算两点间的直线距离（单位：公里）",
  parameters: {
    type: "object",
    properties: {
      lat1: { type: "number", description: "第一点纬度" },
      lon1: { type: "number", description: "第一点经度" },
      lat2: { type: "number", description: "第二点纬度" },
      lon2: { type: "number", description: "第二点经度" }
    },
    required: ["lat1", "lon1", "lat2", "lon2"]
  }
}

// ✅ 处理连续调用
for (let turn = 0; turn < maxTurns; turn++) {
  const response = await makeRequest();

  if (response.finish_reason !== 'tool_calls') break;

  // 执行所有函数调用
  const toolResults = await Promise.all(
    response.tool_calls.map(call => executeTool(call))
  );

  // 添加结果到消息历史继续对话
  messages.push({
    role: 'assistant',
    content: response.content
  });

  messages.push({
    role: 'user',
    content: toolResults.map(r => ({
      type: 'tool_result',
      tool_use_id: r.id,
      content: r.output
    }))
  });
}
```

### 7. Vision（图像识别）最佳实践

```typescript
// ✅ 使用 detail 参数控制分析粒度
{
  type: "image_url",
  image_url: {
    url: "https://example.com/image.jpg",
    detail: "high"  // low(快速)/auto(自适应)/high(详细)
  }
}

// ✅ Base64 用于小图像或私密图像
{
  type: "image_url",
  image_url: {
    url: "data:image/jpeg;base64,iVBORw0KGgo..."
  }
}

// ✅ URL 用于公开网络图像
{
  type: "image_url",
  image_url: {
    url: "https://example.com/large-image.jpg"
  }
}
```

### 8. 系统提示词工程

```typescript
// ✅ 清晰的角色定义和约束
system: `你是一个专业的 Python 代码审查助手。
对于每个代码片段，你需要：
1. 识别潜在的性能问题
2. 指出不遵循 PEP8 的地方
3. 建议安全改进
4. 提供重构建议

使用简洁、专业的语言。
每个问题都要提供具体代码示例。`

// ✅ 避免过度冗长或模糊的指令
// ❌ system: "你是一个助手，帮助人们"  // 太模糊
// ✅ system: "你是一个...[具体职责]"  // 清晰具体
```

### 9. 速率限制处理

```typescript
// OpenAI API 速率限制：
// - 同时连接数：有限制
// - RPM（每分钟请求）：有限制
// - TPM（每分钟 token）：有限制

// 应对策略
function throttledRequest(delay: number = 100) {
  return new Promise(resolve => {
    setTimeout(resolve, delay);
  });
}

async function smartRequest(requestFn) {
  while (true) {
    try {
      return await requestFn();
    } catch (error) {
      if (error.status === 429) {
        // 从响应头读取重试时间
        const retryAfter =
          error.headers?.['retry-after'] || '60';
        await throttledRequest(parseInt(retryAfter) * 1000);
      } else {
        throw error;
      }
    }
  }
}
```

### 10. 监控和日志

```typescript
interface RequestMetrics {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  responseTime: number;      // 毫秒
  finishReason: string;
  status: 'success' | 'error';
  timestamp: Date;
  costEstimate: number;      // 美元
  responseCount?: number;    // Responses API 生成的响应数量
}

// 定期分析
const analytics = {
  avgTokensPerRequest: totalTokens / requestCount,
  avgResponseTime: totalTime / requestCount,
  successRate: successCount / totalCount,
  estimatedMonthlyCost: estimateCost(totalTokens)
};

console.log('成本分析:', analytics);
```

---

## 代码示例库

### Node.js / TypeScript 基础示例

```typescript
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function main() {
  const message = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: "What is the capital of France?",
      },
    ],
  });

  console.log(message.choices[0].message.content);
}

main();
```

### Python 流式示例

```python
from openai import OpenAI

client = OpenAI(api_key="sk-xxx")

with client.chat.completions.stream(
    model="gpt-4o",
    messages=[
        {"role": "user", "content": "Write a poem about spring"}
    ],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

### JavaScript 函数调用示例

```javascript
const OpenAI = require("openai").default;

const openai = new OpenAI({ apiKey: "sk-xxx" });

async function main() {
  const tools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather information for a location",
        parameters: {
          type: "object",
          properties: {
            location: {
              type: "string",
              description: "City name",
            },
            unit: {
              type: "string",
              enum: ["celsius", "fahrenheit"],
              default: "celsius",
            },
          },
          required: ["location"],
        },
      },
    },
  ];

  const messages = [
    { role: "user", content: "What is the weather in Paris?" },
  ];

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: messages,
    tools: tools,
    tool_choice: "auto",
  });

  const toolCall = response.choices[0].message.tool_calls?.[0];
  if (toolCall?.function.name === "get_weather") {
    console.log("Function called:", toolCall.function.name);
    console.log("Arguments:", toolCall.function.arguments);
  }
}

main();
```

### Responses API 使用示例 - TypeScript

```typescript
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 基础文本请求
async function basicRequest() {
  const response = await openai.beta.responses.create({
    model: "gpt-4o",
    input: "Tell me a bedtime story about a unicorn."
  });

  console.log(response.output[0].content[0].text);
}

// 多轮对话
async function multiTurnConversation() {
  // 第一个请求
  const response1 = await openai.beta.responses.create({
    model: "gpt-4o",
    input: "What is Python?"
  });

  console.log("Assistant:", response1.output[0].content[0].text);

  // 第二个请求，引用第一个响应
  const response2 = await openai.beta.responses.create({
    model: "gpt-4o",
    input: "Give me a practical example",
    previous_response_id: response1.id
  });

  console.log("Assistant:", response2.output[0].content[0].text);
}

// 使用网络搜索
async function webSearch() {
  const response = await openai.beta.responses.create({
    model: "gpt-4o",
    input: "What is the latest news about AI?",
    tools: [
      {
        type: "web_search"
      }
    ]
  });

  console.log(response.output[0].content[0].text);
}

// 后台处理
async function backgroundProcessing() {
  const response = await openai.beta.responses.create({
    model: "gpt-4o",
    input: "Process this large dataset",
    background: true,
    store: true
  });

  console.log("Response ID:", response.id);
  console.log("Status:", response.status);

  // 稍后获取结果
  await new Promise(r => setTimeout(r, 5000));
  const completed = await openai.beta.responses.retrieve(response.id);
  console.log("Completed:", completed.status);
}

// 函数调用
async function functionCalling() {
  const response = await openai.beta.responses.create({
    model: "gpt-4o",
    input: "What is the weather in Paris?",
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather information",
          parameters: {
            type: "object",
            properties: {
              city: {
                type: "string",
                description: "City name"
              }
            },
            required: ["city"]
          }
        }
      }
    ]
  });

  if (response.output[0].content[0].type === "tool_use") {
    console.log("Function called:", response.output[0].content[0].name);
  }
}

basicRequest();
```

### Responses API 流式示例

```typescript
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function streamingResponse() {
  const response = await openai.beta.responses.stream({
    model: "gpt-4o",
    input: "Write a poem about spring"
  });

  for await (const event of response) {
    if (event.type === 'response.output_item.delta') {
      if (event.delta.content?.type === 'text') {
        process.stdout.write(event.delta.content.text);
      }
    }
  }
}

streamingResponse();
```

### Responses API 对话压缩

```typescript
// 当对话变得很长时，可以压缩以节省 token
const compacted = await openai.beta.responses.compact({
  model: "gpt-5",
  input: [
    {
      role: "user",
      content: "Create a landing page"
    },
    {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "Here is a landing page..."
        }
      ]
    }
  ]
});

console.log("Compacted response:", compacted.id);
```
