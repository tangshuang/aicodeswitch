## 实现Skills搜索

使用skillsmp的api实现搜索功能

在 server 下，创建一个 config.ts 来保存 SKILLSMP_API_KEY

GET /api/v1/skills/ai-search
AI semantic search powered by Cloudflare AI

Parameter	Type	Required	Description
q	string	✓	AI search query

---

## Thinking/Reasoning 功能实现

### 概述

实现了 Claude 与 OpenAI 系列 API（Chat Completions、Responses、DeepSeek）之间的 thinking/reasoning 功能的双向转换。

### 设计思路

1. **统一抽象**：Claude 的 `thinking` 配置与 OpenAI 的 `reasoning` 配置虽有语义差异，但核心概念相似
2. **智能映射**：根据不同 API 规范进行自适应转换
3. **流式支持**：完整支持流式响应中的 thinking 内容转换

### 关键实现

#### 1. 请求配置转换

| 源格式 | 目标 API | 转换逻辑 |
|--------|----------|----------|
| `thinking: { type: "enabled" }` | OpenAI Chat | `thinking: { type: "enabled" }` |
| `thinking: { type: "enabled" }` | OpenAI Responses | `thinking: { type: "enabled" }, reasoning: { effort: "medium" }` |
| `thinking: { type: "disabled" }` | OpenAI Responses | `thinking: { type: "disabled" }, reasoning: { effort: "minimal" }` |
| `thinking: { type: "auto" }` | OpenAI Responses | `thinking: { type: "auto" }, reasoning: { effort: "low" }` |
| `reasoning_effort: "high"` | OpenAI Responses | `reasoning: { effort: "high" }` |

#### 2. Content Block 处理

- **Claude → OpenAI**：thinking content block 转换为特殊标记文本 `<thinking>...</thinking>`
- **OpenAI → Claude**：识别多种格式（`message.thinking`、`reasoning.summary`、`output[].content`）并转换为 thinking block

#### 3. 流式事件转换

**OpenAI → Claude**：
- `delta.thinking.content` → `thinking_delta` 事件
- `response.reasoning_text.delta` → `thinking_delta` 事件
- `response.reasoning_summary_text.delta` → `thinking_delta` 事件
- `response.output_text.delta` → `text_delta` 事件

**Claude → OpenAI**：
- `thinking_delta` → `delta.thinking.content`

### 文件位置

- `src/server/transformers/claude-openai.ts` - 请求/响应转换
- `src/server/transformers/streaming.ts` - 流式事件转换

### 注意事项

1. **类型安全**：使用 `(any)` 类型断言避免 TypeScript 类型错误
2. **向后兼容**：保持对旧格式响应的支持
3. **错误处理**：流式转换器中捕获异常避免中断整个流

---

## API 转换架构

### 概述

AI Code Switch 实现了多种 AI API 格式之间的双向转换，支持 Claude、OpenAI Chat Completions、OpenAI Responses、DeepSeek 等主流 API。

### 支持的 API 格式

| API 类型 | 端点 | 主要用途 | 状态 |
|---------|------|----------|------|
| **Claude Messages API** | `/v1/messages` | Anthropic 官方 API | ✅ 完整支持 |
| **OpenAI Chat Completions** | `/v1/chat/completions` | OpenAI 对话 API | ✅ 完整支持 |
| **OpenAI Responses API** | `/v1/responses` | OpenAI 新一代响应接口 | ✅ 完整支持 |
| **DeepSeek Chat** | `/v1/chat/completions` | DeepSeek 对话 API | ✅ 完整支持（developer 角色） |

### API 转换矩阵

| 源 API | 目标 API | 转换函数 | 支持状态 |
|--------|----------|----------|----------|
| Claude Messages | OpenAI Chat | [`transformClaudeRequestToOpenAIChat()`](src/server/transformers/claude-openai.ts#L278) | ✅ 完整 |
| Claude Messages | OpenAI Responses | `transformClaudeRequestToOpenAIChat()` + reasoning 映射 | ✅ 完整 |
| Claude Messages | DeepSeek Chat | `transformClaudeRequestToOpenAIChat()` + developer 角色映射 | ✅ 完整 |
| OpenAI Chat | Claude Messages | [`transformOpenAIChatResponseToClaude()`](src/server/transformers/claude-openai.ts#L363) | ✅ 完整 |
| OpenAI Responses | Claude Messages | 流式事件转换 + [`transformResponsesToChatCompletions()`](src/server/transformers/claude-openai.ts#L584) | ✅ 完整 |
| DeepSeek Chat | Claude Messages | `transformOpenAIChatResponseToClaude()` | ✅ 完整 |
| OpenAI Chat | OpenAI Responses | [`transformChatCompletionsToResponses()`](src/server/transformers/claude-openai.ts#L511) | ✅ 新增 |
| OpenAI Responses | OpenAI Chat | [`transformResponsesToChatCompletions()`](src/server/transformers/claude-openai.ts#L584) | ✅ 新增 |

### 内容块转换

#### 文本内容 (Text)
```typescript
// Claude
{ type: "text", text: "Hello" }

// OpenAI
{ type: "text", text: "Hello" } // 或直接 "Hello"
```

#### 图像内容 (Image)
```typescript
// Claude
{
  type: "image",
  source: { type: "base64", media_type: "image/jpeg", data: "..." }
}

// OpenAI
{
  type: "image_url",
  image_url: { url: "data:image/jpeg;base64,...", detail: "auto" }
}
```
**转换函数**: [`convertClaudeImageToOpenAI()`](src/server/transformers/claude-openai.ts#L35), [`convertOpenAIImageToClaude()`](src/server/transformers/claude-openai.ts#L79)

#### 思考内容 (Thinking)
```typescript
// Claude
{ type: "thinking", thinking: "Let me analyze..." }

// OpenAI Chat
{ thinking: { content: "Let me analyze..." } } // 或 delta.thinking.content

// OpenAI Responses
{ type: "thinking", text: "Let me analyze..." } // 在 output[].content 中
```

#### 工具调用 (Tool Calls)
```typescript
// Claude
{ type: "tool_use", id: "call_123", name: "get_weather", input: {...} }

// OpenAI
{
  tool_calls: [{
    id: "call_123",
    type: "function",
    function: { name: "get_weather", arguments: "{...}" }
  }]
}
```

#### 工具结果 (Tool Results)
```typescript
// Claude
{ type: "tool_result", tool_use_id: "call_123", content: "..." }

// OpenAI
{ role: "tool", tool_call_id: "call_123", content: "..." }
```

### 参数转换映射

#### 温度参数 (Temperature)
- 所有 API: `0.0 - 2.0` (OpenAI) / `0.0 - 1.0` (Claude)
- 直接传递，需注意范围差异

#### 停止序列 (Stop Sequences)
```typescript
// Claude
{ stop_sequences: ["END", "STOP"] }

// OpenAI
{ stop: ["END", "STOP"] } // 或 "END"
```

#### Token 限制
```typescript
// Claude
{ max_tokens: 4096 }

// OpenAI Chat
{ max_tokens: 4096 }

// OpenAI Responses
{ max_output_tokens: 4096 }
```

#### 工具选择 (Tool Choice)
```typescript
// Claude
{ tool_choice: "any" } // 或 { type: "tool", name: "func_name" }

// OpenAI
{ tool_choice: "required" } // 或 { type: "function", function: { name: "func_name" } }
```
**转换函数**: [`mapClaudeToolChoiceToOpenAI()`](src/server/transformers/claude-openai.ts#L136)

### Stop Reason 映射

#### OpenAI → Claude
| OpenAI finish_reason | Claude stop_reason |
|---------------------|-------------------|
| `stop` | `end_turn` |
| `length` | `max_tokens` |
| `tool_calls` | `tool_use` |
| `content_filter` | `content_filter` |

**转换函数**: [`mapStopReason()`](src/server/transformers/claude-openai.ts#L187)

#### Claude → OpenAI
| Claude stop_reason | OpenAI finish_reason |
|-------------------|---------------------|
| `end_turn` | `stop` |
| `max_tokens` | `length` |
| `max_thinking_length` | `length` |
| `tool_use` | `tool_calls` |
| `stop_sequence` | `stop` |
| `content_filter` | `content_filter` |

**转换函数**: [`mapClaudeStopReasonToOpenAI()`](src/server/transformers/claude-openai.ts#L207)

### 流式事件转换

#### OpenAI Chat → Claude
| OpenAI Chat Event | Claude Event | 转换位置 |
|------------------|--------------|----------|
| `data.choices[0].delta.content` | `content_block_delta` (text_delta) | [`OpenAIToClaudeEventTransform`](src/server/transformers/streaming.ts#L175) |
| `data.choices[0].delta.thinking.content` | `content_block_delta` (thinking_delta) | [`OpenAIToClaudeEventTransform`](src/server/transformers/streaming.ts#L334) |
| `data.choices[0].delta.tool_calls` | `content_block_delta` (input_json_delta) | [`OpenAIToClaudeEventTransform`](src/server/transformers/streaming.ts#L354) |
| `data.choices[0].finish_reason` | `message_delta` (stop_reason) | [`OpenAIToClaudeEventTransform`](src/server/transformers/streaming.ts#L504) |

#### OpenAI Responses → Claude
| Responses Event | Claude Event | 转换位置 |
|----------------|--------------|----------|
| `response.reasoning_text.delta` | `content_block_delta` (thinking_delta) | [`handleResponsesAPIEvent()`](src/server/transformers/streaming.ts#L408) |
| `response.reasoning_summary_text.delta` | `content_block_delta` (thinking_delta) | [`handleResponsesAPIEvent()`](src/server/transformers/streaming.ts#L429) |
| `response.output_text.delta` | `content_block_delta` (text_delta) | [`handleResponsesAPIEvent()`](src/server/transformers/streaming.ts#L450) |
| `response.refusal.delta` | `content_block_delta` (text_delta) | [`handleResponsesAPIEvent()`](src/server/transformers/streaming.ts#L471) |
| `response.completed/failed/incomplete` | `message_stop` | [`handleResponsesAPIEvent()`](src/server/transformers/streaming.ts#L500) |

#### Claude → OpenAI Chat
| Claude Event | OpenAI Chat Event | 转换位置 |
|--------------|------------------|----------|
| `content_block_delta` (text_delta) | `data.choices[0].delta.content` | [`ClaudeToOpenAIChatEventTransform`](src/server/transformers/streaming.ts#L622) |
| `content_block_delta` (thinking_delta) | `data.choices[0].delta.thinking.content` | [`ClaudeToOpenAIChatEventTransform`](src/server/transformers/streaming.ts#L628) |
| `content_block_delta` (input_json_delta) | `data.choices[0].delta.tool_calls` | [`ClaudeToOpenAIChatEventTransform`](src/server/transformers/streaming.ts#L594) |
| `message_delta` (stop_reason) | `data.choices[0].finish_reason` | [`ClaudeToOpenAIChatEventTransform`](src/server/transformers/streaming.ts#L632) |

### Token Usage 转换

```typescript
// OpenAI 格式
{
  prompt_tokens: 100,
  completion_tokens: 50,
  total_tokens: 150,
  prompt_tokens_details: { cached_tokens: 20 }
}

// Claude 格式
{
  input_tokens: 80,          // prompt - cached
  output_tokens: 50,
  cache_read_input_tokens: 20  // cached
}
```
**转换函数**: [`convertOpenAIUsageToClaude()`](src/server/transformers/claude-openai.ts#L173)

### 特殊处理

#### DeepSeek Developer 角色
某些 OpenAI 兼容 API（如 DeepSeek）不支持 `system` 角色，需要使用 `developer` 角色。

**检测函数**: [`shouldUseDeveloperRole()`](src/server/transformers/claude-openai.ts#L229)

#### System 提示词数组
Claude 支持数组格式的 system 提示词（包含缓存控制），转换时会提取文本内容。

**处理位置**: [`transformClaudeRequestToOpenAIChat()`](src/server/transformers/claude-openai.ts#L169)

### 文件结构

```
src/server/transformers/
├── claude-openai.ts       # 请求/响应转换
│   ├── transformClaudeRequestToOpenAIChat()
│   ├── transformOpenAIChatResponseToClaude()
│   ├── transformClaudeResponseToOpenAIChat()
│   ├── transformChatCompletionsToResponses()
│   ├── transformResponsesToChatCompletions()
│   ├── convertClaudeImageToOpenAI()
│   ├── convertOpenAIImageToClaude()
│   ├── mapClaudeToolChoiceToOpenAI()
│   ├── mapStopReason()
│   └── mapClaudeStopReasonToOpenAI()
└── streaming.ts            # 流式事件转换
    ├── SSEParserTransform              # SSE 解析
    ├── SSESerializerTransform          # SSE 序列化
    ├── OpenAIToClaudeEventTransform    # OpenAI → Claude 流式
    ├── ClaudeToOpenAIChatEventTransform # Claude → OpenAI 流式
    └── handleResponsesAPIEvent()       # Responses API 事件处理
```

### 开发注意事项

1. **类型安全**：转换函数使用 `any` 类型处理动态 API 格式
2. **向后兼容**：保持对旧版本 API 响应的支持
3. **错误恢复**：流式转换器捕获异常避免中断整个流
4. **性能优化**：使用数组格式构建消息（当包含图像时）
5. **完整测试**：覆盖所有转换路径和边界情况

### 相关文档

- [Claude API Schema](schemes/claude.schema.md) - Claude 官方 API 规范
- [OpenAI API Schema](schemes/openai.schema.md) - OpenAI 官方 API 规范
- [CLAUDE.md](CLAUDE.md) - 项目架构文档

