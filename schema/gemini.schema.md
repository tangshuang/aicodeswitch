# Gemini API Schema 标准参考

Google Gemini 官方 API 数据格式规范和完整使用指南。

## 目录
- [API 概览](#api-概览)
- [GenerateContent API 标准格式](#generatecontent-api-标准格式)
- [模型选择](#模型选择)
- [思考 (Thinking) 功能](#思考-thinking-功能)
- [流式事件](#流式事件)
- [函数调用 (Function Calling)](#函数调用-function-calling)
- [错误处理](#错误处理)
- [快速参考](#快速参考)
- [最佳实践](#最佳实践)

---

## API 概览

### 官方 GenerateContent API

这是 **唯一的标准 Gemini API**：

```
POST /v1beta/models/{model}:generateContent
Host: generativelanguage.googleapis.com
```

所有下列功能都使用此 API：
- 文本生成
- 多模态输入（图像、音频、视频、文档）
- 函数调用
- 深度推理（Thinking）
- 代码执行
- 网络搜索

### 模型功能矩阵

| 特性 | Gemini 3 Flash | Gemini 3 Pro | Gemini 2.5 Flash | 支持情况 |
|-----|-----------|-----------|---------|---------|
| **最大 context** | 1M | 2M | 1M | 全部支持 |
| **最佳用途** | 快速响应 | 复杂推理 | 平衡性能 | 都用同 API |
| **流式响应** | ✅ | ✅ | ✅ | 全部支持 |
| **函数调用** | ✅ | ✅ | ✅ | 全部支持 |
| **多模态** | ✅ | ✅ | ✅ | 全部支持 |
| **Thinking 功能** | ✅ | ✅ | ✅ | 全部支持 |

---

## GenerateContent API 标准格式

### 请求格式 (完整规范)

```typescript
POST /v1beta/models/{model}:generateContent
Host: generativelanguage.googleapis.com
x-goog-api-key: YOUR_API_KEY
Content-Type: application/json

{
  // ===== 必需字段 =====
  "contents": Array<Content>,               // 用户消息历史

  // ===== 可选字段 =====
  "systemInstruction"?: Content,            // 系统提示
  "generationConfig"?: GenerationConfig,    // 生成配置
  "safetySettings"?: SafetySetting[],       // 安全设置
  "tools"?: Tool[],                         // 工具定义
  "toolConfig"?: ToolConfig,                // 工具配置
  "cachedContent"?: string                  // 缓存内容引用
}
```

### 内容格式 (Content)

```typescript
interface Content {
  role?: "user" | "model" | "tool";
  parts: Part[];
}

type Part = 
  | TextPart
  | InlineDataPart
  | FileDataPart
  | FunctionCallPart
  | FunctionResponsePart
  | ThoughtPart;

// 文本内容
interface TextPart {
  text: string;
}

// 内联数据（图像、音频等）
interface InlineDataPart {
  inlineData: {
    mimeType: string;                       // image/jpeg, audio/mp3, video/mp4 等
    data: string;                           // base64 编码
  };
}

// 文件数据
interface FileDataPart {
  fileData: {
    mimeType: string;
    fileUri: string;                        // gs:// 或上传的文件 URI
  };
}

// 函数调用
interface FunctionCallPart {
  functionCall: {
    name: string;
    args: object;
  };
}

// 函数响应
interface FunctionResponsePart {
  functionResponse: {
    name: string;
    response: object;
  };
}

// 思考内容
interface ThoughtPart {
  thought: boolean;
  thoughtSignature?: string;
}
```

### 生成配置 (GenerationConfig)

```typescript
interface GenerationConfig {
  // ===== 基础参数 =====
  temperature?: number;                     // 0.0-2.0，采样温度
  topP?: number;                            // 0.0-1.0，核采样
  topK?: number;                            // 排名采样
  candidateCount?: number;                  // 候选数量（通常为 1）
  maxOutputTokens?: number;                 // 最大输出 token 数
  stopSequences?: string[];                 // 停止序列
  
  // ===== 高级参数 =====
  presencePenalty?: number;                 // -2.0-2.0，出现惩罚
  frequencyPenalty?: number;                // -2.0-2.0，频率惩罚
  seed?: number;                            // 随机种子
  responseLogprobs?: boolean;               // 返回 log 概率
  logprobs?: number;                        // 返回的 logprobs 数量
  
  // ===== 响应格式 =====
  responseMimeType?: string;                // "text/plain" | "application/json"
  responseSchema?: Schema;                  // JSON schema 定义
  responseModalities?: Modality[];          // ["TEXT", "IMAGE", "AUDIO"]
  
  // ===== 思考配置 =====
  thinkingConfig?: ThinkingConfig;          // 思考配置
  
  // ===== 其他配置 =====
  speechConfig?: SpeechConfig;              // 语音配置
  imageConfig?: ImageConfig;                // 图像生成配置
  mediaResolution?: MediaResolution;        // 媒体分辨率
}
```

### 响应格式 (标准)

```typescript
{
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [
          {
            "text": string
          }
        ]
      },
      "finishReason": 
        "STOP" | 
        "MAX_TOKENS" | 
        "SAFETY" | 
        "RECITATION" |
        "OTHER" |
        "MALFORMED_FUNCTION_CALL",
      "safetyRatings": SafetyRating[],
      "citationMetadata"?: CitationMetadata,
      "tokenCount"?: number,
      "groundingMetadata"?: GroundingMetadata,
      "avgLogprobs"?: number,
      "logprobsResult"?: LogprobsResult
    }
  ],
  "promptFeedback"?: {
    "blockReason"?: "SAFETY" | "OTHER",
    "safetyRatings": SafetyRating[]
  },
  "usageMetadata": {
    "promptTokenCount": number,
    "cachedContentTokenCount"?: number,
    "candidatesTokenCount": number,
    "totalTokenCount": number,
    "thoughtsTokenCount"?: number
  }
}
```

### 最小请求示例

```bash
curl -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent" \
  -H "x-goog-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {
        "parts": [
          {
            "text": "Hello, how are you?"
          }
        ]
      }
    ]
  }'
```

### 响应示例

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "text": "Hello! I'm doing well, thank you for asking. How can I help you today?"
          }
        ],
        "role": "model"
      },
      "finishReason": "STOP",
      "safetyRatings": [
        {
          "category": "HARM_CATEGORY_HARASSMENT",
          "probability": "NEGLIGIBLE"
        }
      ]
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 6,
    "candidatesTokenCount": 18,
    "totalTokenCount": 24
  }
}
```

---

## 模型选择

Google 官方发布的模型列表（使用同一 GenerateContent API）：

### 最新模型（推荐）

```typescript
const models = {
  "gemini-3-flash-preview": {
    description: "最快速度，Pro 级推理能力",
    context: "1M tokens",
    cost: "低成本",
    best_for: "代理工作流、多轮对话、编码辅助"
  },
  "gemini-3-pro-preview": {
    description: "最强推理能力",
    context: "2M tokens",
    cost: "中等成本",
    best_for: "复杂分析、深度推理"
  },
  "gemini-2.5-flash": {
    description: "平衡性能和成本",
    context: "1M tokens",
    cost: "低成本",
    best_for: "大多数应用"
  },
  "gemini-2.5-pro": {
    description: "强大的多模态能力",
    context: "2M tokens",
    cost: "中等成本",
    best_for: "多模态理解、复杂任务"
  },
  "gemini-2.0-flash": {
    description: "快速响应",
    context: "1M tokens",
    cost: "低成本",
    best_for: "快速应答、简单任务"
  }
};
```

### 选择决策树

```
问题类型？
├─ 简单查询 (是) ──> gemini-2.0-flash
├─ 代码生成/代理工作流 ──> gemini-3-flash-preview
├─ 复杂推理、深度分析 ──> gemini-3-pro-preview
└─ 多模态理解 ──> gemini-2.5-pro

需要深思熟虑吗？
├─ 是 ──> 启用 thinking 功能
└─ 否 ──> 直接生成
```

---

## 多轮对话示例

```bash
curl -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent" \
  -H "x-goog-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {
        "role": "user",
        "parts": [{"text": "什么是 Python?"}]
      },
      {
        "role": "model",
        "parts": [{"text": "Python 是一门高级编程语言..."}]
      },
      {
        "role": "user",
        "parts": [{"text": "给个简单的例子"}]
      }
    ]
  }'
```

---

## 多模态输入示例

### 图像输入

```json
{
  "contents": [
    {
      "parts": [
        {
          "inlineData": {
            "mimeType": "image/jpeg",
            "data": "iVBORw0KGgoAAAANSUhEUgAAAA..."
          }
        },
        {
          "text": "这张图片里有什么?"
        }
      ]
    }
  ]
}
```

### 文件 URI 输入

```json
{
  "contents": [
    {
      "parts": [
        {
          "fileData": {
            "mimeType": "video/mp4",
            "fileUri": "gs://bucket/video.mp4"
          }
        },
        {
          "text": "总结这个视频的内容"
        }
      ]
    }
  ]
}
```

---

## 思考 (Thinking) 功能

### 官方定义

思考（Thinking）是 Gemini 提供的一项功能，允许模型在生成最终响应前进行内部推理。

**支持情况**：所有 Gemini 3 和 2.5 系列模型都支持

**关键特性**：
- 思考内容对用户可见（可选）
- 思考 token 单独计费
- 支持不同思考级别
- 改进复杂问题的准确性

### 配置方式

```json
{
  "generationConfig": {
    "thinkingConfig": {
      "includeThoughts": true,
      "thinkingLevel": "low"
    }
  }
}
```

### 思考级别

```typescript
type ThinkingLevel = 
  | "MINIMAL"      // 最少思考
  | "LOW"          // 低级思考
  | "MEDIUM"       // 中等思考
  | "HIGH";        // 高级思考
```

### 完整示例

```bash
curl -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent" \
  -H "x-goog-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {
        "parts": [
          {
            "text": "证明 sqrt(2) 是无理数"
          }
        ]
      }
    ],
    "generationConfig": {
      "thinkingConfig": {
        "includeThoughts": true,
        "thinkingLevel": "high"
      }
    }
  }'
```

---
## 流式事件

### 启用流式响应

使用 `streamGenerateContent` 端点：

```
POST /v1beta/models/{model}:streamGenerateContent?alt=sse
```

### 流式请求示例

```bash
curl -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse" \
  -H "x-goog-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "contents": [
      {
        "parts": [
          {
            "text": "写一首关于春天的诗"
          }
        ]
      }
    ]
  }'
```

### 流式事件格式

Gemini 使用 Server-Sent Events (SSE) 格式：

```
data: {"candidates": [{"content": {"parts": [{"text": "春"}]}}]}

data: {"candidates": [{"content": {"parts": [{"text": "天"}]}}]}

data: {"candidates": [{"content": {"parts": [{"text": "来"}]}}]}
```

每个事件都是一个完整的 JSON 对象，包含增量内容。

---

## 函数调用 (Function Calling)

### 概述

函数调用允许模型连接到外部工具和 API。模型不直接执行函数，而是返回结构化的函数调用建议。

### 函数声明格式

```typescript
interface Tool {
  functionDeclarations?: FunctionDeclaration[];
  codeExecution?: {};                       // 代码执行
  googleSearch?: {};                        // Google 搜索
}

interface FunctionDeclaration {
  name: string;                             // 函数名
  description: string;                      // 功能描述
  parameters: {
    type: "object";
    properties: {
      [key: string]: {
        type: string;                       // string, number, boolean, array
        description: string;
        enum?: string[];                    // 可选值列表
      };
    };
    required: string[];                     // 必需参数
  };
}
```

### 函数调用示例

```bash
curl -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent" \
  -H "x-goog-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {
        "parts": [
          {
            "text": "旧金山的天气如何?"
          }
        ]
      }
    ],
    "tools": [
      {
        "functionDeclarations": [
          {
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
        ]
      }
    ]
  }'
```

### 函数调用响应

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "functionCall": {
              "name": "get_weather",
              "args": {
                "location": "San Francisco"
              }
            }
          }
        ],
        "role": "model"
      },
      "finishReason": "STOP"
    }
  ]
}
```

### 返回函数结果

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [{"text": "旧金山的天气如何?"}]
    },
    {
      "role": "model",
      "parts": [
        {
          "functionCall": {
            "name": "get_weather",
            "args": {"location": "San Francisco"}
          }
        }
      ]
    },
    {
      "role": "user",
      "parts": [
        {
          "functionResponse": {
            "name": "get_weather",
            "response": {
              "temperature": 72,
              "condition": "sunny"
            }
          }
        }
      ]
    }
  ]
}
```

### 并行函数调用

Gemini 支持在单次响应中调用多个函数：

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "functionCall": {
              "name": "power_disco_ball",
              "args": {"power": true}
            }
          },
          {
            "functionCall": {
              "name": "start_music",
              "args": {"energetic": true, "loud": true}
            }
          },
          {
            "functionCall": {
              "name": "dim_lights",
              "args": {"brightness": 0.3}
            }
          }
        ]
      }
    }
  ]
}
```

### 工具配置

```typescript
interface ToolConfig {
  functionCallingConfig?: {
    mode?: "AUTO" | "ANY" | "NONE";        // 函数调用模式
    allowedFunctionNames?: string[];       // 允许的函数名列表
  };
}
```

---

## 错误处理

### 错误响应格式

```json
{
  "error": {
    "code": 400,
    "message": "描述性错误信息",
    "status": "INVALID_ARGUMENT"
  }
}
```

### 常见错误

| HTTP 状态码 | 错误类型 | 原因 | 处理方案 |
|-----------|---------|------|--------|
| 400 | INVALID_ARGUMENT | 参数错误 | 检查请求格式 |
| 401 | UNAUTHENTICATED | API Key 无效 | 更新 API Key |
| 403 | PERMISSION_DENIED | 权限不足 | 检查 API 权限 |
| 429 | RESOURCE_EXHAUSTED | 超过速率限制 | 指数退避重试 |
| 500 | INTERNAL | 服务器错误 | 重试或等待 |
| 503 | UNAVAILABLE | 服务不可用 | 稍后重试 |

### 安全过滤

当内容被安全过滤器阻止时：

```json
{
  "candidates": [
    {
      "finishReason": "SAFETY",
      "safetyRatings": [
        {
          "category": "HARM_CATEGORY_HARASSMENT",
          "probability": "HIGH"
        }
      ]
    }
  ],
  "promptFeedback": {
    "blockReason": "SAFETY",
    "safetyRatings": [...]
  }
}
```

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
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(request)
      });
      
      if (response.status === 429) {
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

---
## 快速参考

### 常用参数速查

| 参数 | 范围 | 默认值 | 说明 |
|-----|------|--------|------|
| temperature | 0.0-2.0 | 1.0 | 采样随机度，越低越稳定 |
| topP | 0.0-1.0 | 0.95 | 核采样，控制多样性 |
| topK | 1-40 | 40 | 排名采样 |
| maxOutputTokens | 1-8192 | 8192 | 最大输出长度 |
| candidateCount | 1-8 | 1 | 候选响应数量 |

### API 端点（官方）

```bash
# 标准生成
POST /v1beta/models/{model}:generateContent

# 流式生成
POST /v1beta/models/{model}:streamGenerateContent?alt=sse

# 基础 URL
https://generativelanguage.googleapis.com

# 认证头
x-goog-api-key: YOUR_API_KEY

# Content-Type
Content-Type: application/json
```

### 支持的 MIME 类型

**图像**：
- image/png
- image/jpeg
- image/webp
- image/heic
- image/heif

**音频**：
- audio/wav
- audio/mp3
- audio/aiff
- audio/aac
- audio/ogg
- audio/flac

**视频**：
- video/mp4
- video/mpeg
- video/mov
- video/avi
- video/x-flv
- video/mpg
- video/webm
- video/wmv
- video/3gpp

**文档**：
- application/pdf
- text/plain
- text/html
- text/css
- text/javascript
- application/x-javascript
- text/x-typescript
- application/x-typescript
- text/csv
- text/markdown
- text/x-python
- application/x-python-code
- application/json
- text/xml
- application/rtf
- text/rtf

---

## 最佳实践

### 1. 选择合适的模型

```typescript
// 快速简单查询 - 最省成本
"model": "gemini-2.0-flash"

// 代理工作流、编码 - 最佳性能
"model": "gemini-3-flash-preview"

// 复杂推理 - 最强能力
"model": "gemini-3-pro-preview"

// 多模态理解
"model": "gemini-2.5-pro"
```

### 2. 流式 vs 非流式

```typescript
// 使用流式：长响应、实时反馈
endpoint: "streamGenerateContent?alt=sse"

// 使用非流式：简短回复、需要完整响应
endpoint: "generateContent"
```

### 3. 安全设置

```typescript
// 调整安全阈值
"safetySettings": [
  {
    "category": "HARM_CATEGORY_HARASSMENT",
    "threshold": "BLOCK_MEDIUM_AND_ABOVE"
  },
  {
    "category": "HARM_CATEGORY_HATE_SPEECH",
    "threshold": "BLOCK_MEDIUM_AND_ABOVE"
  }
]
```

### 4. 函数调用最佳实践

```typescript
// ✅ 清晰的函数描述
{
  "name": "get_weather",
  "description": "获取指定城市的当前天气信息，包括温度、湿度和天气状况",
  "parameters": {
    "type": "object",
    "properties": {
      "location": {
        "type": "string",
        "description": "城市名称，例如：'北京' 或 '上海'"
      },
      "unit": {
        "type": "string",
        "enum": ["celsius", "fahrenheit"],
        "description": "温度单位"
      }
    },
    "required": ["location"]
  }
}

// ❌ 模糊的描述
{
  "name": "get_weather",
  "description": "获取天气",
  "parameters": {...}
}
```

### 5. 思考功能使用规则

```typescript
// ✅ 启用思考的场景
if (task.complexity === 'high' || 
    task.requires('reasoning', 'proof', 'analysis')) {
  thinkingConfig = {
    includeThoughts: true,
    thinkingLevel: 'high'
  };
}

// ❌ 不启用思考的场景
if (task.type === 'simple_lookup' || 
    task.needsSpeed === true) {
  // 不设置 thinkingConfig
}
```

### 6. 多模态输入优化

```typescript
// Base64 适合小文件（<4MB）
{
  "inlineData": {
    "mimeType": "image/jpeg",
    "data": "iVBORw0KGgoAAAANS..."
  }
}

// File URI 适合大文件
{
  "fileData": {
    "mimeType": "video/mp4",
    "fileUri": "gs://bucket/video.mp4"
  }
}
```

### 7. 上下文缓存

```typescript
// 对重复的长系统提示使用缓存
{
  "cachedContent": "cached-content-id",
  "contents": [...]
}

// 缓存可以减少成本和延迟
```

### 8. JSON 模式输出

```typescript
// 强制 JSON 输出
{
  "generationConfig": {
    "responseMimeType": "application/json",
    "responseSchema": {
      "type": "object",
      "properties": {
        "name": {"type": "string"},
        "age": {"type": "number"}
      },
      "required": ["name", "age"]
    }
  }
}
```

### 9. 错误处理核心清单

```typescript
✅ 检查 HTTP 状态码
✅ 检查 finishReason
✅ 处理安全过滤（SAFETY）
✅ 实现指数退避重试（429 状态码）
✅ 设置合理的请求超时（30-120 秒）
✅ 记录错误详情用于调试
✅ 对于 streaming，监听每个事件的错误
```

### 10. 监控和日志

```typescript
interface RequestMetrics {
  model: string;
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  thoughtsTokenCount?: number;
  responseTime: number;
  finishReason: string;
  status: 'success' | 'error';
  timestamp: Date;
}

// 定期分析指标优化成本
const avgTokensPerRequest = totalTokens / requestCount;
```

---
## 代码示例库

### Python 基础示例

```python
from google import genai

client = genai.Client(api_key="YOUR_API_KEY")

response = client.models.generate_content(
    model="gemini-3-flash-preview",
    contents="Hello, how are you?"
)

print(response.text)
```

### JavaScript 基础示例

```javascript
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: "YOUR_API_KEY" });

const response = await ai.models.generateContent({
  model: "gemini-3-flash-preview",
  contents: "Hello, how are you?"
});

console.log(response.text);
```

### Python 流式示例

```python
from google import genai

client = genai.Client(api_key="YOUR_API_KEY")

response = client.models.generate_content_stream(
    model="gemini-3-flash-preview",
    contents="写一首关于春天的诗"
)

for chunk in response:
    print(chunk.text, end="")
```

### JavaScript 流式示例

```javascript
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: "YOUR_API_KEY" });

const response = await ai.models.generateContentStream({
  model: "gemini-3-flash-preview",
  contents: "写一首关于春天的诗"
});

for await (const chunk of response) {
  console.log(chunk.text);
}
```

### Python 函数调用示例

```python
from google import genai
from google.genai import types

# 定义函数
get_weather_declaration = {
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

client = genai.Client(api_key="YOUR_API_KEY")
tools = types.Tool(function_declarations=[get_weather_declaration])

response = client.models.generate_content(
    model="gemini-3-flash-preview",
    contents="旧金山的天气如何?",
    config=types.GenerateContentConfig(tools=[tools])
)

# 检查函数调用
if response.candidates[0].content.parts[0].function_call:
    function_call = response.candidates[0].content.parts[0].function_call
    print(f"Function: {function_call.name}")
    print(f"Arguments: {function_call.args}")
```

### JavaScript 函数调用示例

```javascript
import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: "YOUR_API_KEY" });

const getWeatherDeclaration = {
  name: "get_weather",
  description: "获取指定城市的天气信息",
  parameters: {
    type: Type.OBJECT,
    properties: {
      location: {
        type: Type.STRING,
        description: "城市名称"
      }
    },
    required: ["location"]
  }
};

const response = await ai.models.generateContent({
  model: "gemini-3-flash-preview",
  contents: "旧金山的天气如何?",
  config: {
    tools: [{
      functionDeclarations: [getWeatherDeclaration]
    }]
  }
});

if (response.functionCalls && response.functionCalls.length > 0) {
  const functionCall = response.functionCalls[0];
  console.log(`Function: ${functionCall.name}`);
  console.log(`Arguments: ${JSON.stringify(functionCall.args)}`);
}
```

### Python 多模态示例

```python
from google import genai
from PIL import Image

client = genai.Client(api_key="YOUR_API_KEY")

image = Image.open("/path/to/image.jpg")

response = client.models.generate_content(
    model="gemini-3-flash-preview",
    contents=[image, "这张图片里有什么?"]
)

print(response.text)
```

### JavaScript 多模态示例

```javascript
import { GoogleGenAI, createUserContent, createPartFromUri } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: "YOUR_API_KEY" });

const image = await ai.files.upload({
  file: "/path/to/image.jpg"
});

const response = await ai.models.generateContent({
  model: "gemini-3-flash-preview",
  contents: [
    createUserContent([
      "这张图片里有什么?",
      createPartFromUri(image.uri, image.mimeType)
    ])
  ]
});

console.log(response.text);
```

---

## 版本信息

- **文档版本**：1.0（标准官方格式）
- **基于文档**：Google Gemini 官方 API 文档
- **支持的模型**：Gemini 3 Flash、Gemini 3 Pro、Gemini 2.5 Flash、Gemini 2.5 Pro、Gemini 2.0 Flash
- **最后更新**：2026 年 2 月 11 日
- **API 基础 URL**：https://generativelanguage.googleapis.com
- **API 版本**：v1beta

---

## 常见问题更正

| 问题 | ❌ 常见误解 | ✅ 官方事实 |
|-----|-----------|----------|
| Gemini 有多个不同的 API 吗？ | "有多个不同的端点" | ❌ 假的。只有 generateContent 和 streamGenerateContent |
| 如何选择使用哪个 API？ | "基于应用类型选择" | ✅ 通过 `model` 参数选择能力 |
| 是否有专门的聊天 API？ | "有单独的聊天端点" | ❌ 使用同一个 generateContent 端点 |
| 模型决定了 API 格式吗？ | "不同模型格式不同" | ❌ 所有模型使用完全相同的请求/响应格式 |
| 我应该使用哪个模型？ | "取决于是否用于代码" | ✅ 任何模型都可以做代码，选择取决于性能和成本需求 |
| 思考功能是否只在某些模型可用？ | "仅在某些模型可用" | ❌ Gemini 3 和 2.5 系列都支持 |

---

## 相关资源

- [Google AI for Developers](https://ai.google.dev/)
- [Gemini API 文档](https://ai.google.dev/gemini-api/docs)
- [模型概览](https://ai.google.dev/gemini-api/docs/models/gemini)
- [函数调用指南](https://ai.google.dev/gemini-api/docs/function-calling)
- [思考功能指南](https://ai.google.dev/gemini-api/docs/thinking)

---

## 附录：完整类型定义

### SafetySetting

```typescript
interface SafetySetting {
  category: HarmCategory;
  threshold: HarmBlockThreshold;
}

enum HarmCategory {
  HARM_CATEGORY_HARASSMENT = "HARM_CATEGORY_HARASSMENT",
  HARM_CATEGORY_HATE_SPEECH = "HARM_CATEGORY_HATE_SPEECH",
  HARM_CATEGORY_SEXUALLY_EXPLICIT = "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  HARM_CATEGORY_DANGEROUS_CONTENT = "HARM_CATEGORY_DANGEROUS_CONTENT"
}

enum HarmBlockThreshold {
  BLOCK_NONE = "BLOCK_NONE",
  BLOCK_ONLY_HIGH = "BLOCK_ONLY_HIGH",
  BLOCK_MEDIUM_AND_ABOVE = "BLOCK_MEDIUM_AND_ABOVE",
  BLOCK_LOW_AND_ABOVE = "BLOCK_LOW_AND_ABOVE"
}
```

### SafetyRating

```typescript
interface SafetyRating {
  category: HarmCategory;
  probability: HarmProbability;
  blocked?: boolean;
}

enum HarmProbability {
  NEGLIGIBLE = "NEGLIGIBLE",
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH"
}
```

### CitationMetadata

```typescript
interface CitationMetadata {
  citationSources: CitationSource[];
}

interface CitationSource {
  startIndex?: number;
  endIndex?: number;
  uri?: string;
  license?: string;
}
```

### GroundingMetadata

```typescript
interface GroundingMetadata {
  groundingChunks?: GroundingChunk[];
  groundingSupports?: GroundingSupport[];
  webSearchQueries?: string[];
  searchEntryPoint?: SearchEntryPoint;
  retrievalMetadata?: RetrievalMetadata;
}

interface GroundingChunk {
  web?: {
    uri: string;
    title?: string;
  };
  retrievedContext?: {
    uri: string;
    title?: string;
    text?: string;
  };
}

interface GroundingSupport {
  groundingChunkIndices?: number[];
  confidenceScores?: number[];
  segment?: {
    partIndex: number;
    startIndex: number;
    endIndex: number;
    text: string;
  };
}
```

### ThinkingConfig

```typescript
interface ThinkingConfig {
  includeThoughts?: boolean;                // 是否包含思考内容
  thinkingBudget?: number;                  // 思考预算（token 数）
  thinkingLevel?: ThinkingLevel;            // 思考级别
}

enum ThinkingLevel {
  MINIMAL = "MINIMAL",
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH"
}
```

### SpeechConfig

```typescript
interface SpeechConfig {
  voiceConfig?: {
    prebuiltVoiceConfig?: {
      voiceName: string;
    };
  };
  languageCode?: string;                    // BCP 47 格式，如 "en-US"
}
```

### ImageConfig

```typescript
interface ImageConfig {
  aspectRatio?: string;                     // "1:1", "16:9", "9:16" 等
  imageSize?: string;
}
```

### MediaResolution

```typescript
enum MediaResolution {
  MEDIA_RESOLUTION_LOW = "MEDIA_RESOLUTION_LOW",       // 64 tokens
  MEDIA_RESOLUTION_MEDIUM = "MEDIA_RESOLUTION_MEDIUM", // 256 tokens
  MEDIA_RESOLUTION_HIGH = "MEDIA_RESOLUTION_HIGH"      // 256 tokens (zoomed)
}
```

---

**注意**：本文档基于 Google Gemini API 官方文档编写，内容经过多次验证以确保准确性。如有疑问，请参考官方文档。
