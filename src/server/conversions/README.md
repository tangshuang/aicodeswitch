# Format Conversion System

统一的 API 格式转换系统，在 4 种 AI API 格式之间进行请求/响应/流式转换。

## 支持的格式

| Format | 说明 | 端点路径 |
|--------|------|---------|
| `claude` | Anthropic Claude Messages API | `/v1/messages` |
| `responses` | OpenAI Responses API | `/v1/responses` |
| `completions` | OpenAI Chat Completions API | `/v1/chat/completions` |
| `gemini` | Google Gemini GenerateContent API | `/v1beta/models/{model}:{generateContent\|streamGenerateContent}` |

## 目录结构

```
conversions/
├── index.ts                      # 公共 API 入口：transformRequest / buildTargetBody / transformResponse / createStreamConverter
├── pipeline.ts                   # SSE 流式管线：SSEEventParser + SSEParserTransform + createStreamPipeline + serializeSSE
├── stream-converter-adapter.ts   # StreamConverter → Node.js Transform 流的桥接适配器
├── compact.ts                    # /v1/responses/compact 对话压缩（提取对话、构建提示词、解析摘要）
├── detector.ts                   # 请求格式自动检测（按路径 + body 结构推断）
├── url-normalizer.ts             # API URL 规范化工具（智能处理版本路径冲突）
├── types.ts                      # 共享类型定义（Format, SSEEvent, StreamConverter 等）
│
├── thinking/                     # 推理/思考模式配置
│   ├── providers.ts              # 各供应商的 ReasoningConfig 定义与匹配 + applyReasoningConfig 注入
│   ├── effort.ts                 # Claude thinking ↔ 其他格式的 effort 映射 + isOSeriesModel
│   └── mapper.ts                 # thinking/reasoning 内容块转换 + fixThinkingHistory + redactedThinkingPlaceholder
│
├── utils/                        # 跨 pair 共享的工具函数
│   ├── tool-schema.ts            # 5 种格式的 Tool/Function schema 互转 + Gemini schema 格式转换
│   ├── stop-reasons.ts           # 各格式 stop/finish reason/status 映射
│   ├── usage.ts                  # 各格式 token usage 字段映射
│   ├── id.ts                     # 各格式 ID 生成器（msg_, toolu_, chatcmpl-, resp_, call_, gemini_synth_）
│   ├── streaming-helpers.ts      # flushConverter / normalizeToolArgumentsFragment / parseEventData / createOutputEvent / serializeSSE
│   └── format-mappers.ts         # Gemini ↔ Completions 的 finishReason + usage 映射
│
└── pairs/                        # 13 个单向转换目录（含 1 个同格式降级兼容）
    ├── claude-completions/
    ├── claude-responses/
    ├── ...
```

## 命名规则

### 目录命名：`{client}-{upstream}`

- **左边** = 客户端请求的格式
- **右边** = 上游供应商的格式

例如 `completions-gemini` 表示：客户端要求 Completions 格式 → 转换函数 → 转发给 Gemini 上游完成推理 → 转换函数 → 响应 Completions 格式给客户端。

### 文件职责

每个 pair 目录包含 3 个文件，各负责一个单向转换：

| 文件 | 方向 | 导出内容 |
|------|------|---------|
| `request.ts` | 客户端 → 上游 | 请求 body 转换函数 |
| `response.ts` | 上游 → 客户端 | 响应 body 转换函数 |
| `streaming.ts` | 上游 SSE → 客户端 SSE | `StreamConverter` 类 |

### 函数命名规则

```
{sourceFormat}To{targetFormat}()           — 请求转换
{sourceFormat}To{targetFormat}Response()   — 响应转换
{Source}To{Target}Converter                — 流式转换器类
```

- 请求/响应函数：小写开头，如 `claudeToCompletions()`, `completionsResponseToClaude()`
- 流式转换器：大驼峰类名，如 `CompletionsToClaudeConverter`

## 转换矩阵

4 种格式排列组合 4×4 = 16 个方向（含自转），其中 12 个跨格式 + 4 个同格式：

| ↓ client \ upstream → | claude | responses | completions | gemini |
|-----------------------|--------|-----------|-------------|--------|
| **claude**            | —      | ✅        | ✅          | ✅     |
| **responses**         | ✅     | 🛡️        | ✅          | ✅     |
| **completions**       | ✅     | ✅        | —           | ✅     |
| **gemini**            | ✅     | ✅        | ✅          | —      |

> - ✅ = 跨格式转换（对应一个 pair 目录）
> - 🛡️ = 降级兼容（通过对codex发起的responses请求的处理，通常是裁剪或修改，以确保被服务商兼容，可以正确响应codex的请求）
> - — = 纯透传（不做任何处理）

> **注意**：使用 `reasoning_content` 字段的提供商（DeepSeek、Moonshot、Qwen 等）通过 provider config 驱动的后处理自动适配，无需独立的格式类型。

## Direct vs Composite Pairs

每个 pair 目录都是**完全独立**的单元——Direct pair 不依赖其他 pair 目录，只从 `utils/` 和 `thinking/` 导入共享工具。

### Direct Pair（直接转换）

自行实现完整的转换逻辑，不依赖其他 pair 目录。所有依赖仅限于 `utils/`、`thinking/` 和 `types.ts`。

| Pair | 客户端格式 | 上游格式 | 说明 |
|------|-----------|---------|------|
| `claude-completions` | claude | completions | Claude → Completions 完整转换 |
| `claude-responses` | claude | responses | Claude → Responses 完整转换 |
| `claude-gemini` | claude | gemini | Claude → Gemini 完整转换 |
| `claude-deepseek` | claude | deepseek | 已移除（通过 provider config 后处理实现） |
| `completions-claude` | completions | claude | Completions → Claude 完整转换 |
| `completions-responses` | completions | responses | Completions → Responses 完整转换 |
| `completions-gemini` | completions | gemini | Completions → Gemini 完整转换 |
| `completions-deepseek` | completions | deepseek | 已移除（通过 provider config 后处理实现） |
| `responses-claude` | responses | claude | Responses → Claude 完整转换 |
| `responses-completions` | responses | completions | Responses → Completions 完整转换（过滤非标准工具类型） |
| `gemini-claude` | gemini | claude | Gemini → Claude 完整转换 |
| `gemini-completions` | gemini | completions | Gemini → Completions 完整转换 |
| `deepseek-claude` | deepseek | claude | 已移除（completions 转换器已覆盖 reasoning_content） |
| `deepseek-completions` | deepseek | completions | 已移除（格式相同，由 completions passthrough 覆盖） |
| `responses-responses` | responses | responses | 同格式降级兼容（仅 `request.ts`，清理 OpenAI 私有扩展 + 转换消息格式） |

> **设计原则**：每个 Direct pair 是一个独立单元。可复用的底层工具（stop reason 映射、usage 映射、tool schema 转换等）统一放在 `utils/` 中。

> **Provider 后处理**：使用 `reasoning_content` 的提供商（DeepSeek、Moonshot、Qwen 等）通过 `buildTargetBody` 中的 provider config 驱动后处理，自动注入 thinking 参数、修复 reasoning 历史、剥离 `stream_options`，无需独立 pair。

### Composite Pair（组合转换）

通过链式调用两个 Direct pair 来实现间接转换。所有组合转换**统一以 `completions` 作为中间格式**。

**组合链路**（全部以 completions 为中间格式）：

| Pair | 链路 | 说明 |
|------|------|------|
| `responses-gemini` | responses → completions → gemini | 先转 Completions，再转 Gemini |
| `gemini-responses` | gemini → completions → responses | 先转 Completions，再转 Responses |

> **为什么选 completions 作为统一中间格式？**
> - Completions (OpenAI Chat) 是业界最通用的 API 格式
> - 所有 pair 都有与 completions 的直接转换，保证任意两种格式都能通过 completions 中转

**组合型实现模式：**

大多数 composite pair 严格遵循两步链式调用：

- **标准两步组合**（request + streaming 一律使用）：
  ```typescript
  // request.ts — 两步链式调用
  import { responsesToCompletions } from '../responses-completions/request.js';
  import { completionsToGemini } from '../completions-gemini/request.js';

  export function responsesToGeminiRequest(body: any): any {
    const completionsBody = responsesToCompletions(body);
    return completionsToGemini(completionsBody);
  }
  ```

组合型 streaming.ts 统一使用标准两步链式模式：

```typescript
import { GeminiToCompletionsConverter } from '../completions-gemini/streaming.js';
import { CompletionsToResponsesConverter } from '../responses-completions/streaming.js';
import { flushConverter } from '../../utils/streaming-helpers.js';

export class GeminiToResponsesConverter implements StreamConverter {
  private first = new GeminiToCompletionsConverter();
  private second = new CompletionsToResponsesConverter();

  convertEvent(event: SSEEvent): SSEEvent[] {
    return this.first.convertEvent(event)
      .flatMap(e => this.second.convertEvent(e));
  }

  flush(): SSEEvent[] {
    return flushConverter(this.first)
      .flatMap(e => this.second.convertEvent(e))
      .concat(flushConverter(this.second));
  }
}
```

## 依赖关系

### Direct pair 的依赖

每个 Direct pair 只从以下位置导入，**不依赖其他 pair 目录**：

```
pair 目录
├── ../../types.ts           # 类型定义
├── ../../utils/*.ts         # 共享工具（stop reasons, usage, tool schema, id 生成）
└── ../../thinking/*.ts      # thinking/reasoning 配置（仅部分 pair 需要）
```

### Composite pair 的依赖

Composite pair 导入两个 Direct pair 的函数/类进行链式调用：

```
composite pair 目录
├── ../{client}-completions/     # 第一段：客户端格式 → completions
├── ../completions-{upstream}/   # 第二段：completions → 上游格式
└── ../../utils/streaming-helpers.ts  # flushConverter 工具（仅 streaming.ts 需要）
```

> **注意**：composite pair 的 import 路径中的 pair 目录命名遵循 `{client}-{upstream}` 规则。例如 `responses-gemini` 的第一步导入 `../responses-completions/`（responses client → completions upstream 的 request 转换），第二步导入 `../completions-gemini/`（completions client → gemini upstream 的 request 转换）。

## 公共 API

### `transformRequest(options): TransformResult`

将客户端请求转为上游格式。内部组合 `buildTargetPath` + `buildTargetBody` 完成转换。

```typescript
import { transformRequest } from './conversions/index.js';

const result = transformRequest({
  fromFormat: 'claude',
  toFormat: 'completions',
  body: claudeRequestBody,
  providerConfig?: reasoningConfig,  // 可选：供应商推理配置，用于注入 thinking/effort
  sanitizeBody?: boolean,            // 可选：是否清理同格式 passthrough 的私有扩展（默认 false）
});
// result.body       — 转换后的请求 body
// result.headers    — 额外需要添加的 headers（通常为 {}）
// result.targetPath — 目标端点路径（如 '/v1/chat/completions'）
```

> **Responses passthrough 清理**：当 `fromFormat === toFormat === 'responses'` 且 `sanitizeBody: true` 时，`transformRequest` 会自动清理 OpenAI 私有扩展：
>
> 1. **Tool 类型过滤**：`tools` 数组中仅保留 `type: "function"` 的标准工具，移除 `custom`、`tool_search`、`web_search`、`file_search`、`code_interpreter` 等 OpenAI 私有类型（其他提供商返回 "unknown tool type" 400 错误）
> 2. **顶层字段移除**：删除 `text`（含 verbosity）、`reasoning`、`prompt_cache_key`、`client_metadata`、`include`、`parallel_tool_calls` 等 OpenAI 私有请求字段（其他提供商返回 "unknown field" 400 错误）
> 3. **消息格式修正**：`developer` 角色 → `system`；content 字符串规范化为 ContentItem 数组（根据 role 选择 `input_text`/`output_text` 类型）；`status: "completed"` 自动补全
>
> **何时开启清理**：proxy-server 通过 `APIService.isDowngradeCompatibility` 配置字段传入 `sanitizeBody: true`，启用降级兼容。该字段由用户在服务配置中显式开启（适用于火山方舟/豆包等非原始提供商）。
>
> 这与跨格式转换的处理方式一致（如 `responsesToClaudeTools` 也只保留 `function` 类型）。

### `buildTargetBody(options): any`

仅执行请求 body 转换。适用于需要单独获取转换后 body 的场景。

```typescript
import { buildTargetBody } from './conversions/index.js';

const convertedBody = buildTargetBody({
  fromFormat: 'claude',
  toFormat: 'completions',
  body: claudeRequestBody,
  providerConfig?: ReasoningConfig,  // 可选：供应商推理配置
  sanitizeBody?: boolean,            // 同 transformRequest
});
// 返回转换后的 body（含 provider 后处理）
```

> `transformRequest` 内部调用 `buildTargetBody` 来完成 body 转换，因此两者的转换逻辑完全一致。
>
> **Provider 后处理**：当 `toFormat === 'completions'` 且 `providerConfig` 存在时，`buildTargetBody` 在基本格式转换后自动执行 provider 级别的后处理（thinking 参数注入、reasoning 历史修复、stream_options 剥离）。

### `transformResponse(options): any`

将上游响应转回客户端格式。

```typescript
const clientResponse = transformResponse({
  fromFormat: 'completions',  // 上游格式
  toFormat: 'claude',         // 客户端格式
  response: upstreamResponse,
});
```

### `createStreamConverter(options): StreamConverter`

创建 SSE 流式转换器。

```typescript
const converter = createStreamConverter({
  fromFormat: 'completions',
  toFormat: 'claude',
});

// 每收到一个上游 SSE event，调用 convertEvent
const clientEvents: SSEEvent[] = converter.convertEvent(upstreamEvent);

// 流结束时调用 flush，获取缓冲区中剩余的事件
const remainingEvents: SSEEvent[] = converter.flush() ?? [];
```

### `createStreamPipeline(upstreamBody, fromFormat, toFormat, onEvent?): AsyncGenerator`

完整的 SSE 流式管线，处理解析→转换→序列化。定义在 `pipeline.ts` 中。

```typescript
import { createStreamPipeline } from './conversions/pipeline.js';

for await (const chunk of createStreamPipeline(
  response.body,       // ReadableStream 或 Node.js Readable
  'completions',       // 上游格式
  'claude',            // 客户端格式
  (event) => {         // 可选：监听解析后的 SSE 事件（如统计 usage）
    if (event?.usage) console.log('Token usage:', event.usage);
  },
)) {
  res.write(chunk);    // chunk 已经是转换后的客户端格式 SSE 文本
}
```

### `detectRequestFormat(path, body): Format`

自动检测请求格式。优先匹配路径，其次分析 body 结构。

```typescript
import { detectRequestFormat } from './conversions/index.js';

const format = detectRequestFormat('/v1/messages', requestBody);
// => 'claude'
```

> **注意**：`gemini` 是纯上游格式，客户端不会以该格式发请求，`detectRequestFormat` 永远不会返回它。此外 `/v1/responses/compact` 路径被特殊排除，不会匹配为 `responses` 格式。

### `getReasoningConfig(providerName, baseUrl, model): ReasoningConfig`

获取指定供应商的推理/思考配置。由 `proxy-server.ts` 在请求转换前获取，传入 `buildTargetBody` 进行自动后处理。

```typescript
import { getReasoningConfig } from './conversions/index.js';

// 在 proxy-server 中获取 provider config：
const config = getReasoningConfig(service.name, service.apiUrl, body.model);

// 传入转换函数，buildTargetBody 会自动执行后处理：
const result = convertRequest({ fromFormat, toFormat, body, providerConfig: config });
```

> **集成方式**：`getReasoningConfig` 由 `proxy-server.ts` 在调用 `transformRequestToUpstream` 前调用，获取的 `providerConfig` 传入转换管线。`buildTargetBody` 在完成基本格式转换后，根据 config 自动执行：thinking 参数注入（`applyReasoningConfig`）、reasoning 历史修复（`fixThinkingHistory`）、`stream_options` 剥离。

## StreamConverterAdapter

`stream-converter-adapter.ts` 提供 `StreamConverterAdapter` 类，将 conversions 系统的 `StreamConverter` 纯对象接口桥接为 Node.js `Transform` 流。

```typescript
import { StreamConverterAdapter } from './conversions/stream-converter-adapter.js';

// 在 Node.js stream.pipeline() 中使用
const adapter = new StreamConverterAdapter(converter);
pipeline(source, adapter, destination);
```

> **用途**：代理管道（proxy pipeline）使用 Node.js `Transform` 流通过 `stream.pipeline()` 串联，而新系统的 `StreamConverter` 是纯对象接口（`convertEvent`/`flush`）。此 adapter 在两者之间做透明桥接。

## 类型定义速览

```typescript
type Format = 'claude' | 'responses' | 'completions' | 'gemini';

interface TransformResult {
  body: any;
  headers: Record<string, string>;
}

interface TransformRequestOptions {
  fromFormat: Format;
  toFormat: Format;
  body: any;
  providerConfig?: ReasoningConfig;  // 可选：供应商推理配置
  sanitizeBody?: boolean;            // 可选：是否清理同格式 passthrough 的私有扩展（默认 false）
}

interface TransformResponseOptions {
  fromFormat: Format;
  toFormat: Format;
  response: any;
}

interface StreamConverterOptions {
  fromFormat: Format;
  toFormat: Format;
}

interface SSEEvent {
  event?: string;       // SSE event type
  data: any;            // SSE data（对象或字符串，与 legacy SSEParserTransform 兼容）
  id?: string;          // SSE event ID
}

interface StreamConverter {
  convertEvent(event: SSEEvent): SSEEvent[];
  flush?(): SSEEvent[];
}

interface ReasoningConfig {
  supportsThinking: boolean;
  supportsEffort: boolean;
  thinkingParam: string;     // 'thinking' | 'enable_thinking' | 'reasoning_split' | 'none'
  effortParam: string;       // 'reasoning_effort' | 'reasoning.effort' | 'none'
  effortValueMode: string;   // 'deepseek' | 'low_high' | 'openrouter' | 'passthrough'
  outputFormat: string;      // 'reasoning_content' | 'reasoning' | 'reasoning_details'
}
```

## Thinking/Reasoning 子系统

不同供应商对 thinking/reasoning 的实现差异很大，由 `thinking/` 子目录统一处理：

| 组件 | 职责 |
|------|------|
| `providers.ts` | 9 个供应商配置的 ReasoningConfig 模式匹配 + `applyReasoningConfig()` 注入函数 |
| `effort.ts` | Claude thinking ↔ effort 字符串 ↔ 其他格式的映射 + `isOSeriesModel()` |
| `mapper.ts` | thinking 内容块的格式转换 + `fixThinkingHistory()`（修复供应商吞掉 thinking 块的问题）+ `redactedThinkingPlaceholder()` |

### providers.ts — 供应商配置

9 个供应商的 ReasoningConfig（通过 `providerName`、`baseUrl`、`model` 字符串模糊匹配）：

| 供应商 | thinking 参数 | effort 参数 | 输出格式 |
|--------|-------------|------------|---------|
| DeepSeek | `thinking: { type: 'enabled' }` | `reasoning_effort` (deepseek mode) | `reasoning_content` |
| Moonshot/Kimi | `thinking: { type: 'enabled' }` | — | `reasoning_content` |
| Qwen/DashScope | `enable_thinking: true` | — | `reasoning_content` |
| Zhipu/GLM/BigModel | `thinking: { type: 'enabled' }` | — | `reasoning_content` |
| MiniMax | `reasoning_split: true` | — | `reasoning_details` |
| Mimo/Xiaomimimo | `thinking: { type: 'enabled' }` | — | `reasoning_content` |
| OpenRouter | — | `reasoning.effort` (openrouter mode) | `reasoning` |
| SiliconFlow | `enable_thinking: true` | — | `reasoning_content` |
| Stepfun/Step | `none`（`supportsThinking: true` 但不注入参数） | `reasoning_effort` (low_high mode) | `reasoning` |

> `applyReasoningConfig(body, config, effort)` 根据 config 将 thinking/effort 参数注入到请求 body 中。
>
> **集成方式**：这两个函数由 `proxy-server.ts` 的 `applyProviderReasoningConfig()` 方法在请求转换后、发送到上游前调用。转换器（如 `responsesToCompletions`）会无条件映射 `reasoning.effort` → `reasoning_effort`，`applyProviderReasoningConfig` 负责根据供应商配置清理不支持的参数并注入 provider 特有的 thinking 参数。

### effort.ts — Effort 映射

| 函数 | 说明 |
|------|------|
| `claudeThinkingToReasoningEffort(thinking)` | Claude thinking 配置 → effort 字符串（优先取 `output_config.effort`，否则按 `budget_tokens` 推导） |
| `claudeThinkingToResponsesReasoning(thinking)` | Claude thinking → Responses API `{ effort }` 对象 |
| `reasoningEffortToClaudeThinking(effort)` | effort 字符串 → Claude thinking 配置（low→2048, medium→8192, high→32000, xhigh→adaptive） |
| `isOSeriesModel(model)` | 检测是否为 OpenAI o-series 推理模型（o1-o9, o4, gpt-5） |

### mapper.ts — 内容块转换

| 函数 | 说明 |
|------|------|
| `thinkingToReasoningContent(thinking)` | Claude thinking 文本 → `reasoning_content` 字符串 |
| `reasoningContentToThinking(content)` | `reasoning_content` 字符串 → Claude thinking 块 |
| `reasoningToThinking(summary)` | Responses API reasoning summary 数组 → Claude thinking 块 |
| `thinkingToReasoningSummary(thinking)` | Claude thinking 文本 → Responses API reasoning summary 数组 |
| `fixThinkingHistory(messages, format)` | 修复历史消息：确保有 tool_use 的 assistant 消息也有 thinking/reasoning_content |
| `redactedThinkingPlaceholder()` | 返回 `[redacted thinking]` 占位文本 |

## Compact API（对话压缩）

`compact.ts` 提供 `/v1/responses/compact` 端点的核心逻辑，用于将长对话压缩为摘要。底层复用 `transformRequest()` 和 `transformResponse()` 与上游交互，自动支持所有 4 种格式。

### 两种客户端的 Compact 行为

| 客户端 | 触发方式 | 处理方式 |
|--------|---------|---------|
| **Claude Code** | 请求末尾包含 compact 指令（`CRITICAL: Respond with TEXT ONLY`） | 走正常 proxy 管道（`transformRequest` 处理），无需 compact 特殊逻辑 |
| **Codex** | 请求 `POST /v1/responses/compact` | 使用 `prepareCompactRequest` + `processCompactResponse` 统一处理 |

### 统一入口（推荐）

外部只需调用两个函数，传入目标格式和模型信息即可：

#### `prepareCompactRequest` — 构建上游请求

根据目标格式自动选择处理路径：

- **目标 `responses`** → 直接转发原始请求体（passthrough），响应也是正确的 compact 格式
- **目标其他格式** → 提取对话文本 → 构造压缩提示词 → 通过 `transformRequest` 转换为目标格式

```typescript
import { prepareCompactRequest, processCompactResponse } from './conversions/index.js';

// 构建上游请求
const { body, isPassthrough } = prepareCompactRequest({
  body: codexRequestBody,   // Codex 原始请求体（Responses API 格式）
  toFormat: 'claude',       // 上游目标格式
  model: 'claude-sonnet-4-6',
});

// proxy-server 根据目标格式和 isPassthrough 自行构建上游 URL
// 发送到上游...
const responseJson = await resp.json();

// 处理响应
const result = processCompactResponse(
  responseJson,    // 上游响应
  'claude',        // 上游格式
  'claude-sonnet-4-6',
  isPassthrough,   // 是否透传
  { inputTokens: 1000, outputTokens: 500 },  // 可选：usage 信息
);
// result 就是最终的 Responses API compact 响应
```

#### 两种路径的内部流程

```
responses 目标（passthrough）:
  原始 body → 直接发送到 /v1/responses/compact → 原始响应直接返回

其他格式目标（提示词模式）:
  原始 body → extractConversationText → buildCompactionPrompt
           → transformRequest(目标格式) → 发送到上游
           → extractSummaryFromResponse → buildCompactedResponse
```

### 底层 API（仍可独立使用）

| 函数 | 签名 | 说明 |
|------|------|------|
| `prepareCompactRequest` | `(options: CompactRequestOptions) => CompactRequestResult` | **统一入口**：构建 compact 上游请求 |
| `processCompactResponse` | `(response, fromFormat, model, isPassthrough, usage?) => any` | **统一入口**：处理 compact 上游响应 |
| `extractConversationText` | `(input: any[]) => string` | 从 Responses API `input` 数组提取可读对话文本（跳过 compaction、item_reference 项） |
| `extractMessageContent` | `(content: any) => string` | 从 Responses message content 提取文本（处理 string、content array、media 占位） |
| `COMPACTION_SYSTEM_PROMPT` | `string` | compact 使用的系统提示词常量 |
| `buildCompactionPrompt` | `(instructions?: string) => string` | 构建 compact 系统提示词 + 可选用户附加指令 |
| `buildCompactUpstreamRequest` | `(text, instructions, toFormat: Format, model) => { body }` | 构建上游 compact 请求（通过 `transformRequest` 自动适配格式） |
| `extractSummaryFromResponse` | `(response, fromFormat: Format) => string` | 从上游响应提取摘要文本（通过 `transformResponse` 转 Responses 格式后提取） |
| `buildCompactedResponse` | `(summary, model, inputTokens?, outputTokens?) => object` | 构建标准 Responses API compact 响应对象 |
| `sanitizeClaudeMessagesForCompact` | `(messages: any[]) => any[]` | 清理 Claude Messages 格式的 messages，为未配对的 `tool_use` 补充合成 `tool_result` |
| `isClaudeCompactRequest` | `(message: any) => boolean` | 检测消息是否为 Claude Code compact 命令请求（包含 `CRITICAL: Respond with TEXT ONLY` 指令） |
| `isLastClaudeMessageCompact` | `(messages: any[]) => boolean` | 检测消息列表中最后一条是否为 Claude Code compact 请求 |
| `isCodexCompactRequest` | `(path?: string) => boolean` | 检测请求路径是否为 Codex compact（`POST /v1/responses/compact`） |
| `flattenClaudeToolBlocksForCompact` | `(messages: any[]) => any[]` | 将 Claude 历史中的 tool_use/tool_result 块降级为普通文本块（compact 场景下避免严格校验） |
| `normalizeClaudeCompactRequestBody` | `(body: any) => any` | 移除 compact 请求中的 thinking/tools/tool_choice/mcp_servers 字段，确保上游仅生成纯文本摘要 |
| `stripClaudeCompactResponseContent` | `(response: any) => any` | 过滤 compact 响应中的 thinking/tool_use block，只保留纯文本摘要，避免客户端错误恢复 |
| `countUnpairedClaudeToolUses` | `(messages: any[]) => number` | 统计 Claude messages 中未配对的 tool_use 数量 |
| `summarizeClaudeMessagesForDebug` | `(messages: any[], startIndex, endIndex) => any[]` | 提取 messages 指定范围的摘要信息用于调试 |
| `collectCompactPayloadDebugInfo` | `(body: any, targetCallId?) => Record<string, any>` | 收集 compact 请求的调试信息（消息数量、工具调用检测等） |
| `collectClaudeToolUseDiagnostics` | `(messages: any[]) => string[]` | 生成 Claude messages 中 tool_use 配对情况的诊断日志 |

### 类型定义

```typescript
interface CompactRequestOptions {
  body: any;          // Codex 原始请求体（Responses API 格式）
  toFormat: Format;   // 上游目标格式
  model: string;      // 目标模型名称
}

interface CompactRequestResult {
  body: any;              // 发送给上游的请求体
  isPassthrough: boolean; // 是否为透传模式（responses → responses）
}
```

### 注意事项

- **Claude Code 的 compact 不走 prepareCompactRequest/processCompactResponse**：Claude Code 的 compact 本质是一条包含摘要指令的用户消息，由正常 proxy 管道处理（`transformRequest` / `transformResponse`）。但需注意，compact 请求中对话历史末尾可能有 `tool_use` 块缺少对应的 `tool_result`，导致上游 API 返回 400。`proxy-server.ts` 在转发前调用 `sanitizeClaudeMessagesForCompact()` 自动补充合成的 `tool_result` 块
- **Passthrough 模式**：当目标格式是 `responses` 时，`prepareCompactRequest` 返回原始请求体和 `isPassthrough: true`，`processCompactResponse` 直接返回原始响应，不做任何处理
- **提示词模式**：当目标格式是 Claude / Gemini / Completions 时，系统会自动提取对话文本、构造压缩提示词、转换为目标格式发送

## pipeline.ts 额外导出

除 `createStreamPipeline` 外，`pipeline.ts` 还导出以下公共 API：

| 导出 | 类型 | 说明 |
|------|------|------|
| `serializeSSE(event)` | 函数 | 将 `SSEEvent` 序列化为 wire-format SSE 文本块 |
| `SSEEventParser` | 类 | 轻量级 SSE 事件解析器（`pushChunk` + `flush`） |

> **注意**：`utils/streaming-helpers.ts` 也有一个同名 `serializeSSE` 函数，两者逻辑相同。`pipeline.ts` 版本用于管线内部，`streaming-helpers.ts` 版本供 pair 目录使用。


## URL 规范化（url-normalizer.ts）

`url-normalizer.ts` 提供 API URL 规范化工具，解决用户配置的 `apiUrl` 可能已包含版本路径（如 `/v1`、`/v4`）而系统又硬编码拼接版本路径导致的双重版本路径问题。

> **注意**：`url-normalizer.ts` 不通过 `conversions/index.ts` 导出，由 `proxy-server.ts` 直接导入使用。

| 函数 | 说明 |
|------|------|
| `buildUpstreamUrl(apiUrl, appendPath)` | 智能构建上游请求 URL：检测 `apiUrl` 末尾版本路径，智能处理版本冲突（如 `https://xxx.com/v4` + `/v1/messages` → `https://xxx.com/v4/messages`） |
| `normalizeApiUrl(apiUrl)` | 规范化 API URL，去除末尾斜杠和版本后缀 |

## 工具函数一览

### `utils/tool-schema.ts` — 工具定义转换

| 函数 | 说明 |
|------|------|
| `claudeToCompletionsTools(tools)` | Claude tools → OpenAI Chat function tools |
| `completionsToClaudeTools(tools)` | OpenAI Chat function tools → Claude tools |
| `claudeToResponsesTools(tools)` | Claude tools → Responses API function tools |
| `responsesToClaudeTools(tools)` | Responses API function tools → Claude tools |
| `claudeToGeminiTools(tools)` | Claude tools → Gemini functionDeclarations |
| `geminiToClaudeTools(tools)` | Gemini functionDeclarations → Claude tools |
| `completionsToGeminiTools(tools)` | OpenAI Chat function tools → Gemini functionDeclarations |
| `convertSchemaToGemini(schema)` | JSON Schema → Gemini schema（type 大写化 + 递归转换） |
| `convertSchemaFromGemini(schema)` | Gemini schema → JSON Schema（type 小写化 + 递归转换） |

> `cleanSchema` 为内部函数（去除 `cache_control` 等字段），不对外导出。

### `utils/stop-reasons.ts` — Stop/Finish/Status 映射

| 函数 | 说明 |
|------|------|
| `completionsToClaudeStopReason(reason)` | Completions finish_reason → Claude stop_reason |
| `claudeToCompletionsStopReason(reason)` | Claude stop_reason → Completions finish_reason |
| `geminiToClaudeStopReason(reason)` | Gemini finishReason → Claude stop_reason |
| `claudeToGeminiStopReason(reason)` | Claude stop_reason → Gemini finishReason |
| `responsesToClaudeStopReason(status, incompleteReason?, hasToolUse?)` | Responses status → Claude stop_reason |
| `claudeToResponsesStatus(reason)` | Claude stop_reason → Responses `{ status, incomplete_details }` |
| `completionsToResponsesFinishReason(reason)` | Completions finish_reason → Responses status |
| `responsesToCompletionsFinishReason(status)` | Responses status → Completions finish_reason |

### `utils/usage.ts` — Token Usage 映射

| 函数 | 说明 |
|------|------|
| `completionsToClaudeUsage(usage)` | Completions usage → Claude `{ input_tokens, output_tokens, cache_* }` |
| `claudeToCompletionsUsage(usage)` | Claude usage → Completions `{ prompt_tokens, completion_tokens, total_tokens }` |
| `geminiToClaudeUsage(metadata)` | Gemini usageMetadata → Claude usage |
| `claudeToGeminiUsage(usage)` | Claude usage → Gemini usageMetadata |
| `responsesToClaudeUsage(usage)` | Responses usage → Claude usage |
| `completionsToResponsesUsage(usage)` | Completions usage → Responses usage |

### `utils/id.ts` — ID 生成器

| 函数 | 说明 |
|------|------|
| `generateMessageId()` | Claude 消息 ID：`msg_<uuid-24hex>` |
| `generateToolUseId()` | Claude 工具调用 ID：`toolu_<uuid-24hex>` |
| `generateCompletionsId()` | OpenAI Chat ID：`chatcmpl-<uuid>` |
| `generateResponseId()` | OpenAI Responses ID：`resp_<uuid-24hex>` |
| `generateCallId()` | Responses API 函数调用 ID：`call_<uuid-24hex>` |
| `generateGeminiSynthId()` | Gemini 合成工具调用 ID：`gemini_synth_<uuid-16hex>` |

### `utils/streaming-helpers.ts` — 流式转换共享工具

| 函数 | 说明 |
|------|------|
| `flushConverter(converter)` | 刷新转换器内部缓冲区，返回剩余事件 |
| `normalizeToolArgumentsFragment(value)` | 将工具参数片段归一化为字符串 |
| `serializeSSE(event)` | 将 `SSEEvent` 序列化为 wire-format SSE 文本块 |
| `parseEventData(data)` | 解析 SSE event data（兼容对象和字符串） |
| `createOutputEvent(type, data, id?)` | 创建输出 `SSEEvent`（data 直接设为对象） |

### `utils/format-mappers.ts` — Gemini ↔ Completions 映射

| 函数 | 说明 |
|------|------|
| `mapGeminiFinishReason(reason)` | Gemini finishReason → Completions finish_reason |
| `mapCompletionsFinishReason(reason)` | Completions finish_reason → Gemini finishReason |
| `mapGeminiUsage(metadata)` | Gemini usageMetadata → Completions usage |
| `mapCompletionsUsage(usage)` | Completions usage → Gemini usageMetadata |

## 调用流程（Gateway 视角）

```
客户端请求
    │
    ▼
detectRequestFormat()          ← 检测客户端格式
    │
    ▼
transformRequest()             ← 客户端格式 → 上游格式
    └─ buildTargetBody()       ← 请求 body 转换 + provider 后处理
        ├─ 同格式 → passthrough（responses 格式 + sanitizeBody 时：过滤私有扩展）
        ├─ 跨格式 → pair 转换（tool-schema.ts 中自动过滤非 function 类型）
        └─ provider 后处理（completions 目标 + providerConfig 时）：
            ├─ fixThinkingHistory()    ← 修复 reasoning 历史（isReasoningContentCompletion）
            ├─ strip stream_options    ← 剥离不支持的参数
            └─ applyReasoningConfig()  ← 注入 thinking/effort 参数
    │
    ▼
buildUpstreamUrl()             ← URL 规范化（智能处理版本路径冲突，如 /v1 /v4）
    │
    ▼
fetch(upstream)                ← 转发给上游供应商
    │
    ├── 非流式 ──▶ transformResponse()     ← 上游响应 → 客户端格式
    │
    └── 流式 ──▶ createStreamPipeline()    ← SSE 解析 → 转换 → 序列化
```

## 扩展指南

### 添加新格式

1. 在 `types.ts` 的 `Format` 联合类型中添加新字符串
2. 在 `detector.ts` 中添加路径/结构检测规则（如果客户端会以该格式发请求）
3. 在 `src/server/source-type-mapping.ts` 的 `sourceTypeToFormat` 中添加旧版 SourceType 映射（如果需要兼容）
4. 创建 3 个新 pair 目录（与其他 3 种格式各一个），每个目录独立实现
5. 在 `index.ts` 中添加 import 和 switch case
6. 在 `utils/tool-schema.ts`、`stop-reasons.ts`、`usage.ts`、`id.ts` 中添加映射函数
7. 如需支持 thinking/reasoning，在 `thinking/providers.ts` 中添加配置

### 添加新供应商的 Reasoning 支持

在 `thinking/providers.ts` 的 `PROVIDER_CONFIGS` 数组中添加新条目：

```typescript
{
  patterns: ['newprovider'],
  config: {
    supportsThinking: true,
    supportsEffort: false,
    thinkingParam: 'thinking',
    effortParam: 'none',
    effortValueMode: 'passthrough',
    outputFormat: 'reasoning_content',
  },
}
```
