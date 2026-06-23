/**
 * Core type definitions for the format conversion system.
 */

/** Supported API formats */
export type Format = 'claude' | 'responses' | 'completions' | 'gemini';

/** Result of a request transformation */
export interface TransformResult {
  body: any;
  headers: Record<string, string>;
}

/** A single SSE event */
export interface SSEEvent {
  event?: string;
  data: any;      // 对象（来自 SSEParserTransform）或字符串
  id?: string;
}

/** Interface for stateful streaming converters */
export interface StreamConverter {
  convertEvent(event: SSEEvent): SSEEvent[];
  flush?(): SSEEvent[];
}

/** Per-provider reasoning configuration */
export interface ReasoningConfig {
  supportsThinking: boolean;
  supportsEffort: boolean;
  /** Request body parameter name for enabling thinking: 'thinking' | 'enable_thinking' | 'reasoning_split' | 'chat_template_kwargs' | 'none' */
  thinkingParam: string;
  /** Request body parameter name for effort: 'reasoning_effort' | 'reasoning.effort' | 'none' */
  effortParam: string;
  /** How to map effort values: 'deepseek' | 'low_high' | 'openrouter' | 'passthrough' */
  effortValueMode: string;
  /** Expected output field: 'reasoning_content' | 'reasoning' | 'reasoning_details' */
  outputFormat: string;
  /**
   * 流式 usage（stream_options.include_usage）支持情况，决定是否保留 stream_options：
   * - 'supported'：供应商支持，始终保留 → 流式能拿到真实 usage
   * - 'unsupported'：供应商会对 stream_options 报错，始终剥离
   * - 'auto'（默认）：按 outputFormat 兜底——reasoning_content 剥离，其余保留（历史行为）
   * 判定入口：conversions/index.ts 的 completions 后处理
   */
  streamOptions?: 'supported' | 'unsupported' | 'auto';
}

/** Per-provider server_tool_use support configuration */
export interface ServerToolConfig {
  supportsServerToolUse: boolean;
}

/** Options for request transformation */
export interface TransformRequestOptions {
  fromFormat: Format;
  toFormat: Format;
  body: any;
  providerConfig?: ReasoningConfig;
  serverToolConfig?: ServerToolConfig;
  /**
   * 是否对请求体执行清理（过滤非标准字段/工具类型）。
   * - `true`: 清理 OpenAI 私有扩展，确保与非原始提供商兼容
   * - `false`（默认）: 跳过清理，保留原始请求中的所有字段/工具类型
   *
   * 当上游为格式原始提供商时（如 Responses API 的 api.openai.com），
   * proxy-server 应传入 `false` 以保留全部功能。
   */
  sanitizeBody?: boolean;
}

/** Options for response transformation */
export interface TransformResponseOptions {
  fromFormat: Format;
  toFormat: Format;
  response: any;
}

/** Options for creating a stream converter */
export interface StreamConverterOptions {
  fromFormat: Format;
  toFormat: Format;
}
