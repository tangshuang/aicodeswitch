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

---

## Responses API（新一代响应接口）

### 概述

**Responses API** 是 OpenAI 最新的通用响应生成接口，是 Chat Completions API 的升级版本。提供更强大和灵活的能力：

**主要特性**：
- 文本和图像输入，文本输出
- 有状态的多轮对话（通过 conversation 或 previous_response_id）
- 内置工具：网络搜索、文件搜索、计算机使用等
- 函数调用（自定义工具）
- 后台处理和长期运行任务
- 响应存储和检索
- 流式和非流式响应
- 推理模型支持（gpt-5、o-series）
- 对话压缩（conversation compaction）

### API 端点

```bash
# 创建响应
POST /v1/responses

# 获取响应
GET /v1/responses/{response_id}

# 删除响应
DELETE /v1/responses/{response_id}

# 取消后台响应
POST /v1/responses/{response_id}/cancel

# 压缩对话
POST /v1/responses/compact

# 列出响应的输入项
GET /v1/responses/{response_id}/input_items

# 计算输入 token 数
POST /v1/responses/input_tokens
```

### 请求格式 - 创建响应

```typescript
POST /v1/responses
Host: api.openai.com
Authorization: Bearer sk-xxx
Content-Type: application/json

{
  // ===== 必需字段 =====
  "model": string,                          // 模型ID (gpt-4o, gpt-5, o3等)

  // ===== 输入和对话 =====
  "input"?: string | object,                // 文本、图像或文件输入
  "instructions"?: string,                  // 系统提示词
  "conversation"?: string | object,         // 对话ID或对象
  "previous_response_id"?: string,          // 上一个响应ID，用于多轮对话

  // ===== 响应配置 =====
  "max_output_tokens"?: number,             // 最大输出 token 数
  "temperature"?: number,                   // 0-2，采样温度
  "top_p"?: number,                         // 0-1，核采样
  "text"?: object,                          // 文本响应格式配置
  "stream"?: boolean,                       // 是否流式响应
  "stream_options"?: object,                // 流式选项

  // ===== 工具和函数调用 =====
  "tools"?: Tool[],                         // 内置工具和函数定义
  "tool_choice"?: string | object,          // 工具选择策略
  "max_tool_calls"?: number,                // 最大工具调用次数
  "parallel_tool_calls"?: boolean,          // 是否并行调用工具

  // ===== 后台处理 =====
  "background"?: boolean,                   // 后台运行响应
  "store"?: boolean,                        // 是否存储响应

  // ===== 高级特性 =====
  "reasoning"?: object,                     // 推理模型配置
  "prompt_cache_key"?: string,              // 提示词缓存键
  "prompt_cache_retention"?: string,        // 缓存保留策略（24h）
  "truncation"?: string,                    // 截断策略（auto/disabled）
  "include"?: string[],                     // 包含的额外输出字段
  "metadata"?: object,                      // 自定义元数据
  "safety_identifier"?: string,             // 用户安全标识
  "service_tier"?: string                   // 服务等级（auto/default/flex/priority）
}
```

### 输入格式

```typescript
// 文本输入
{
  "input": "Tell me a joke about programming"
}

// 图像输入
{
  "input": [
    {
      "type": "image",
      "source": {
        "type": "url",
        "url": "https://example.com/image.jpg"
      }
    },
    {
      "type": "text",
      "text": "What's in this image?"
    }
  ]
}

// 文件输入
{
  "input": [
    {
      "type": "document",
      "source": {
        "type": "file",
        "file_id": "file-abc123"
      }
    },
    {
      "type": "text",
      "text": "Summarize this document"
    }
  ]
}
```

### 工具定义

```typescript
// 函数调用工具
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather for a location",
        "parameters": {
          "type": "object",
          "properties": {
            "location": {
              "type": "string",
              "description": "City name"
            }
          },
          "required": ["location"]
        }
      }
    }
  ]
}

// 内置工具示例
{
  "tools": [
    {
      "type": "web_search"           // 网络搜索
    },
    {
      "type": "file_search"          // 文件搜索
    },
    {
      "type": "code_interpreter"     // 代码执行
    },
    {
      "type": "computer"             // 计算机使用
    }
  ]
}
```

### 请求示例

```bash
# 基础文本请求
curl https://api.openai.com/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-4o",
    "input": "Tell me a three sentence bedtime story about a unicorn."
  }'

# 多轮对话
curl https://api.openai.com/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-4o",
    "input": "What is your favorite color from the story?",
    "previous_response_id": "resp_67ccd2bed1ec8190b14f964abc054267..."
  }'

# 使用网络搜索
curl https://api.openai.com/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-4o",
    "input": "What is the latest news about AI?",
    "tools": [
      {
        "type": "web_search"
      }
    ]
  }'

# 后台处理
curl https://api.openai.com/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-4o",
    "input": "Process a large file and generate a report",
    "background": true,
    "store": true
  }'
```

### 响应格式

```json
{
  "id": "resp_67ccd2bed1ec8190b14f964abc0542670bb6a6b452d3795b",
  "object": "response",
  "created_at": 1741476542,
  "status": "completed",
  "completed_at": 1741476543,
  "error": null,
  "incomplete_details": null,
  "instructions": null,
  "max_output_tokens": null,
  "model": "gpt-4o-2024-08-06",
  "output": [
    {
      "type": "message",
      "id": "msg_67ccd2bf17f0819081ff3bb2cf6508e60bb6a6b452d3795b",
      "status": "completed",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "In a peaceful grove beneath a silver moon, a unicorn named Lumina discovered a hidden pool that reflected the stars...",
          "annotations": []
        }
      ]
    }
  ],
  "parallel_tool_calls": true,
  "previous_response_id": null,
  "reasoning": {
    "effort": null,
    "summary": null
  },
  "store": true,
  "temperature": 1.0,
  "text": {
    "format": {
      "type": "text"
    }
  },
  "tool_choice": "auto",
  "tools": [],
  "top_p": 1.0,
  "truncation": "disabled",
  "usage": {
    "input_tokens": 36,
    "input_tokens_details": {
      "cached_tokens": 0
    },
    "output_tokens": 87,
    "output_tokens_details": {
      "reasoning_tokens": 0
    },
    "total_tokens": 123
  },
  "metadata": {}
}
```

### 获取响应

```bash
# 获取已完成的响应
curl https://api.openai.com/v1/responses/resp_abc123 \
  -H "Authorization: Bearer $OPENAI_API_KEY"

# 流式获取背景响应
curl https://api.openai.com/v1/responses/resp_abc123?stream=true \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

### 删除响应

```bash
curl -X DELETE https://api.openai.com/v1/responses/resp_abc123 \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

### 取消后台响应

```bash
curl -X POST https://api.openai.com/v1/responses/resp_abc123/cancel \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

### 压缩长对话

```bash
curl -X POST https://api.openai.com/v1/responses/compact \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-5",
    "input": [
      {
        "role": "user",
        "content": "Create a landing page"
      },
      {
        "type": "message",
        "role": "assistant",
        "content": [
          {
            "type": "output_text",
            "text": "Here is a landing page..."
          }
        ]
      }
    ]
  }'
```

### 计算输入 Token 数

```bash
curl -X POST https://api.openai.com/v1/responses/input_tokens \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-4o",
    "input": "Tell me a joke."
  }'

# 响应
{
  "object": "response.input_tokens",
  "input_tokens": 11
}
```

### 响应状态

```
completed      - 已完成
failed         - 失败
in_progress    - 进行中
cancelled      - 已取消（仅后台任务）
queued         - 队列中（仅后台任务）
incomplete     - 不完整
```

### 流式响应

```bash
curl https://api.openai.com/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-4o",
    "input": "Write a poem",
    "stream": true
  }'
```

### 流式事件类型

#### **生命周期事件**

```typescript
// 1. response.created - 响应创建
{
  "type": "response.created",
  "sequence_number": 1,
  "response": {
    "id": "resp_67ccfcdd16748190a91872c75d38539e...",
    "status": "in_progress",
    ...
  }
}

// 2. response.in_progress - 响应进行中
{
  "type": "response.in_progress",
  "sequence_number": 1,
  "response": {...}
}

// 3. response.completed - 响应完成
{
  "type": "response.completed",
  "sequence_number": 1,
  "response": {
    "id": "resp_123",
    "status": "completed",
    "completed_at": 1740855870,
    "output": [...]
  }
}

// 4. response.failed - 响应失败
{
  "type": "response.failed",
  "sequence_number": 1,
  "response": {
    "id": "resp_123",
    "status": "failed",
    "error": {
      "code": "server_error",
      "message": "The model failed to generate a response."
    }
  }
}

// 5. response.incomplete - 响应不完整
{
  "type": "response.incomplete",
  "sequence_number": 1,
  "response": {
    "id": "resp_123",
    "status": "incomplete",
    "incomplete_details": {
      "reason": "max_tokens"
    }
  }
}

// 6. response.queued - 响应队列中
{
  "type": "response.queued",
  "sequence_number": 1,
  "response": {
    "id": "res_123",
    "status": "queued"
  }
}
```

#### **输出项事件**

```typescript
// 1. response.output_item.added - 输出项添加
{
  "type": "response.output_item.added",
  "output_index": 0,
  "sequence_number": 1,
  "item": {
    "id": "msg_123",
    "status": "in_progress",
    "type": "message",
    "role": "assistant",
    "content": []
  }
}

// 2. response.output_item.done - 输出项完成
{
  "type": "response.output_item.done",
  "output_index": 0,
  "sequence_number": 1,
  "item": {
    "id": "msg_123",
    "status": "completed",
    "type": "message",
    "role": "assistant",
    "content": [...]
  }
}
```

#### **内容部分事件**

```typescript
// 1. response.content_part.added - 内容部分添加
{
  "type": "response.content_part.added",
  "item_id": "msg_123",
  "output_index": 0,
  "content_index": 0,
  "sequence_number": 1,
  "part": {
    "type": "output_text",
    "text": "",
    "annotations": []
  }
}

// 2. response.content_part.done - 内容部分完成
{
  "type": "response.content_part.done",
  "item_id": "msg_123",
  "output_index": 0,
  "content_index": 0,
  "sequence_number": 1,
  "part": {
    "type": "output_text",
    "text": "Complete text here...",
    "annotations": []
  }
}
```

#### **文本输出事件**

```typescript
// 1. response.output_text.delta - 文本增量
{
  "type": "response.output_text.delta",
  "item_id": "msg_123",
  "output_index": 0,
  "content_index": 0,
  "delta": "Hello",
  "sequence_number": 1,
  "logprobs": []
}

// 2. response.output_text.done - 文本完成
{
  "type": "response.output_text.done",
  "item_id": "msg_123",
  "output_index": 0,
  "content_index": 0,
  "text": "Complete response text...",
  "sequence_number": 1,
  "logprobs": []
}

// 3. response.output_text.annotation.added - 文本注释添加
{
  "type": "response.output_text.annotation.added",
  "item_id": "item-abc",
  "output_index": 0,
  "content_index": 0,
  "annotation_index": 0,
  "annotation": {
    "type": "text_annotation",
    "text": "Citation text",
    "start": 0,
    "end": 10
  },
  "sequence_number": 1
}
```

#### **拒绝事件**

```typescript
// 1. response.refusal.delta - 拒绝文本增量
{
  "type": "response.refusal.delta",
  "item_id": "msg_123",
  "output_index": 0,
  "content_index": 0,
  "delta": "I cannot",
  "sequence_number": 1
}

// 2. response.refusal.done - 拒绝文本完成
{
  "type": "response.refusal.done",
  "item_id": "item-abc",
  "output_index": 1,
  "content_index": 2,
  "refusal": "I cannot help with this request.",
  "sequence_number": 1
}
```

#### **函数调用事件**

```typescript
// 1. response.function_call_arguments.delta - 函数参数增量
{
  "type": "response.function_call_arguments.delta",
  "item_id": "item-abc",
  "output_index": 0,
  "delta": "{\"arg\":",
  "sequence_number": 1
}

// 2. response.function_call_arguments.done - 函数参数完成
{
  "type": "response.function_call_arguments.done",
  "item_id": "item-abc",
  "name": "get_weather",
  "output_index": 1,
  "arguments": "{\"arg\": 123}",
  "sequence_number": 1
}
```

#### **网络搜索事件**

```typescript
// 1. response.web_search_call.in_progress
{
  "type": "response.web_search_call.in_progress",
  "output_index": 0,
  "item_id": "ws_123",
  "sequence_number": 0
}

// 2. response.web_search_call.searching
{
  "type": "response.web_search_call.searching",
  "output_index": 0,
  "item_id": "ws_123",
  "sequence_number": 0
}

// 3. response.web_search_call.completed
{
  "type": "response.web_search_call.completed",
  "output_index": 0,
  "item_id": "ws_123",
  "sequence_number": 0
}
```

#### **文件搜索事件**

```typescript
// 1. response.file_search_call.in_progress
{
  "type": "response.file_search_call.in_progress",
  "output_index": 0,
  "item_id": "fs_123",
  "sequence_number": 1
}

// 2. response.file_search_call.searching
{
  "type": "response.file_search_call.searching",
  "output_index": 0,
  "item_id": "fs_123",
  "sequence_number": 1
}

// 3. response.file_search_call.completed
{
  "type": "response.file_search_call.completed",
  "output_index": 0,
  "item_id": "fs_123",
  "sequence_number": 1
}
```

#### **推理事件**（仅 gpt-5、o-series）

```typescript
// 1. response.reasoning_summary_part.added
{
  "type": "response.reasoning_summary_part.added",
  "item_id": "rs_6806bfca0b2481918a5748308061a26...",
  "output_index": 0,
  "summary_index": 0,
  "sequence_number": 1,
  "part": {
    "type": "summary_text",
    "text": ""
  }
}

// 2. response.reasoning_summary_text.delta
{
  "type": "response.reasoning_summary_text.delta",
  "item_id": "rs_6806bfca0b2481918a5748308061a26...",
  "output_index": 0,
  "summary_index": 0,
  "delta": "**Analyzing the problem**\n\nThe user asked...",
  "sequence_number": 1
}

// 3. response.reasoning_summary_text.done
{
  "type": "response.reasoning_summary_text.done",
  "item_id": "rs_6806bfca0b2481918a5748308061a26...",
  "output_index": 0,
  "summary_index": 0,
  "text": "Full reasoning summary...",
  "sequence_number": 1
}

// 4. response.reasoning_text.delta - 完整推理过程增量
{
  "type": "response.reasoning_text.delta",
  "item_id": "rs_123",
  "output_index": 0,
  "content_index": 0,
  "delta": "The",
  "sequence_number": 1
}

// 5. response.reasoning_text.done - 完整推理过程完成
{
  "type": "response.reasoning_text.done",
  "item_id": "rs_123",
  "output_index": 0,
  "content_index": 0,
  "text": "The user is asking...",
  "sequence_number": 4
}
```

#### **代码解释器事件**

```typescript
// 1. response.code_interpreter_call.in_progress
{
  "type": "response.code_interpreter_call.in_progress",
  "output_index": 0,
  "item_id": "ci_12345",
  "sequence_number": 1
}

// 2. response.code_interpreter_call.interpreting
{
  "type": "response.code_interpreter_call.interpreting",
  "output_index": 4,
  "item_id": "ci_12345",
  "sequence_number": 1
}

// 3. response.code_interpreter_call.completed
{
  "type": "response.code_interpreter_call.completed",
  "output_index": 5,
  "item_id": "ci_12345",
  "sequence_number": 1
}

// 4. response.code_interpreter_call_code.delta
{
  "type": "response.code_interpreter_call_code.delta",
  "output_index": 0,
  "item_id": "ci_12345",
  "delta": "print('Hello, world')",
  "sequence_number": 1
}

// 5. response.code_interpreter_call_code.done
{
  "type": "response.code_interpreter_call_code.done",
  "output_index": 3,
  "item_id": "ci_12345",
  "code": "print('done')",
  "sequence_number": 1
}
```

#### **图像生成事件**

```typescript
// 1. response.image_generation_call.in_progress
{
  "type": "response.image_generation_call.in_progress",
  "output_index": 0,
  "item_id": "item-123",
  "sequence_number": 0
}

// 2. response.image_generation_call.generating
{
  "type": "response.image_generation_call.generating",
  "output_index": 0,
  "item_id": "item-123",
  "sequence_number": 0
}

// 3. response.image_generation_call.partial_image
{
  "type": "response.image_generation_call.partial_image",
  "output_index": 0,
  "item_id": "item-123",
  "partial_image_index": 0,
  "partial_image_b64": "...",
  "sequence_number": 0
}

// 4. response.image_generation_call.completed
{
  "type": "response.image_generation_call.completed",
  "output_index": 0,
  "item_id": "item-123",
  "sequence_number": 1
}
```

#### **MCP 工具事件**

```typescript
// 1. response.mcp_call.in_progress
{
  "type": "response.mcp_call.in_progress",
  "sequence_number": 1,
  "output_index": 0,
  "item_id": "mcp_682d437d90a88191bf88cd03aae0c3e5..."
}

// 2. response.mcp_call_arguments.delta
{
  "type": "response.mcp_call_arguments.delta",
  "output_index": 0,
  "item_id": "item-abc",
  "delta": "{",
  "sequence_number": 1
}

// 3. response.mcp_call_arguments.done
{
  "type": "response.mcp_call_arguments.done",
  "output_index": 0,
  "item_id": "item-abc",
  "arguments": "{\"arg1\": \"value1\", \"arg2\": \"value2\"}",
  "sequence_number": 1
}

// 4. response.mcp_call.completed
{
  "type": "response.mcp_call.completed",
  "sequence_number": 1,
  "item_id": "mcp_682d437d90a88191bf88cd03aae0c3e5...",
  "output_index": 0
}

// 5. response.mcp_call.failed
{
  "type": "response.mcp_call.failed",
  "sequence_number": 1,
  "item_id": "mcp_682d437d90a88191bf88cd03aae0c3e5...",
  "output_index": 0
}

// 6. response.mcp_list_tools.in_progress
{
  "type": "response.mcp_list_tools.in_progress",
  "sequence_number": 1,
  "output_index": 0,
  "item_id": "mcpl_682d4379df088191886b70f4ec39f904..."
}

// 7. response.mcp_list_tools.completed
{
  "type": "response.mcp_list_tools.completed",
  "sequence_number": 1,
  "output_index": 0,
  "item_id": "mcpl_682d4379df088191886b70f4ec39f904..."
}

// 8. response.mcp_list_tools.failed
{
  "type": "response.mcp_list_tools.failed",
  "sequence_number": 1,
  "output_index": 0,
  "item_id": "mcpl_682d4379df088191886b70f4ec39f904..."
}
```

#### **自定义工具事件**

```typescript
// 1. response.custom_tool_call_input.delta
{
  "type": "response.custom_tool_call_input.delta",
  "output_index": 0,
  "item_id": "ctc_1234567890abcdef",
  "delta": "partial input text",
  "sequence_number": 1
}

// 2. response.custom_tool_call_input.done
{
  "type": "response.custom_tool_call_input.done",
  "output_index": 0,
  "item_id": "ctc_1234567890abcdef",
  "input": "final complete input text",
  "sequence_number": 1
}
```

#### **错误事件**

```typescript
{
  "type": "error",
  "code": "ERR_SOMETHING",
  "message": "Something went wrong",
  "param": null,
  "sequence_number": 1
}
```

### 流式处理的事件顺序

一个典型的流式响应事件序列：

1. `response.created` - 响应开始创建
2. `response.in_progress` - 响应开始处理
3. `response.output_item.added` - 添加输出项（消息）
4. `response.content_part.added` - 添加内容部分
5. `response.output_text.delta`（多次） - 文本流式输出
6. `response.output_text.done` - 文本输出完成
7. `response.output_item.done` - 输出项完成
8. `response.completed` - 响应完成

对于带有工具调用的流式响应：

1. `response.created`
2. `response.output_item.added`
3. `response.function_call_arguments.delta`（多次）
4. `response.function_call_arguments.done`
5. `response.completed`

---

## 模型选择

### 当前可用模型

```typescript
const models = {
  // Chat Completions API 推荐
  "gpt-4-turbo": {
    context: 128000,
    description: "最强能力，支持Vision",
    cost: "$10/1M输入，$30/1M输出",
    best_for: "复杂推理、代码分析"
  },
  "gpt-4o": {
    context: 128000,
    description: "新一代旗舰模型，更快更便宜",
    cost: "$5/1M输入，$15/1M输出",
    best_for: "大多数应用（推荐首选）"
  },
  "gpt-4o-mini": {
    context: 128000,
    description: "轻量级，成本最低",
    cost: "$0.15/1M输入，$0.6/1M输出",
    best_for: "简单任务、高吞吐"
  },
  "gpt-3.5-turbo": {
    context: 4096,
    description: "经典快速模型",
    cost: "$0.5/1M输入，$1.5/1M输出",
    best_for: "对话、翻译"
  },

  // Realtime API
  "gpt-4o-realtime-preview": {
    context: 128000,
    description: "实时语音对话（预览版）",
    cost: "$5/1M输入，$20/1M输出",
    best_for: "实时语音交互"
  },

  // Completions API（已弃用）
  "gpt-3.5-turbo-instruct": {
    context: 4096,
    description: "文本补全（维护模式）",
    best_for: "仅用于兼容性"
  }
};
```

### 模型对比表

| 特性 | GPT-4 Turbo | GPT-4o | GPT-4o-mini | 3.5-Turbo |
|-----|-----------|--------|-----------|----------|
| 上下文 | 128k | 128k | 128k | 4k |
| Vision | ✅ | ✅ | ✅ | ❌ |
| 函数调用 | ✅ | ✅ | ✅ | ✅ |
| JSON 模式 | ✅ | ✅ | ✅ | ✅ |
| 推理能力 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ |
| 速度 | 中等 | 快 | 最快 | 快 |
| 成本 | 高 | 中 | 低 | 最低 |

### 选择决策树

```
你的任务是什么?
├─ 实时语音交互 ──> gpt-4o-realtime-preview
├─ 图像识别和分析 ──> gpt-4-turbo 或 gpt-4o
├─ 代码生成/分析 ──> gpt-4o（推荐）或 gpt-4-turbo
├─ 简单对话/翻译 ──> gpt-3.5-turbo 或 gpt-4o-mini
└─ 高吞吐量应用 ──> gpt-4o-mini

预算和延迟考虑?
├─ 预算充足，性能优先 ──> gpt-4-turbo
├─ 平衡成本和性能 ──> gpt-4o（推荐首选）
├─ 成本敏感 ──> gpt-4o-mini
└─ 低成本、快速 ──> gpt-3.5-turbo
```

---

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

### 三个 API 端点速查

```bash
# Responses API（推荐 - 新一代接口）
POST https://api.openai.com/v1/responses
GET https://api.openai.com/v1/responses/{response_id}
DELETE https://api.openai.com/v1/responses/{response_id}
POST https://api.openai.com/v1/responses/{response_id}/cancel
POST https://api.openai.com/v1/responses/compact
POST https://api.openai.com/v1/responses/input_tokens

# Chat Completions API（标准对话接口）
POST https://api.openai.com/v1/chat/completions

# Completions API（已弃用，维护中）
POST https://api.openai.com/v1/completions
```

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
// ✅ 优先使用 Responses API（推荐首选）
// - 新一代接口，功能最强
// - 支持有状态对话、内置工具（网搜、文搜、计算机使用）
// - 支持后台处理和长期运行任务
// - 支持推理模型（gpt-5、o-series）
// - 支持响应存储和检索

POST /v1/responses

// ✅ Chat Completions API（简单对话）
// - 轻量级对话接口
// - 支持函数调用和 Vision
// - 当不需要内置工具和后台处理时使用

POST /v1/chat/completions

// ⚠️ 仅在兼容性需求时使用 Completions API
// - 已进入维护模式
// - 不推荐用于新项目

POST /v1/completions
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

---

## 版本信息和更新

- **文档版本**：2.3（添加完整流式事件文档）
- **更新日期**：2026 年 2 月 3 日
- **覆盖 API**：Responses、Chat Completions、Completions（已弃用）
- **最新模型**：GPT-4o、GPT-4o-mini、GPT-5、O3
- **API 基础 URL**：https://api.openai.com

---

## 常见问题解答

| 问题 | 答案 |
|-----|------|
| 应该使用哪个 API？ | 优先使用 Responses API，它是 OpenAI 的新一代标准。Chat Completions API 仍可用但逐渐被替代。Completions API 已过时。 |
| Responses API 和 Chat Completions API 有什么区别？ | Responses API 支持有状态对话、内置工具（网搜、文搜等）、后台处理、推理模型。Chat Completions 更轻量，只支持基础对话和函数调用。 |
| Responses API 支持哪些内置工具？ | web_search（网络搜索）、file_search（文件搜索）、code_interpreter（代码执行）、computer（计算机使用）。 |
| 如何在 Responses API 中进行多轮对话？ | 使用 `previous_response_id` 参数引用之前的响应，或使用 `conversation` 参数。 |
| 后台处理如何工作？ | 设置 `"background": true`，响应会异步执行。可通过 `GET /v1/responses/{response_id}` 检查状态。 |
| 哪个模型性价比最好？ | gpt-4o 是目前的最佳选择，性能强、成本合理。 |
| Responses API 支持流式吗？ | 支持，设置 `"stream": true`。使用 Server-Sent Events 格式。 |
| 如何处理速率限制？ | 使用指数退避重试策略，从 Retry-After 头读取建议延迟。 |

