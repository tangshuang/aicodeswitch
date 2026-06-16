/**
 * Usage/token count mapping across all API formats.
 */

/** Map OpenAI Chat usage to Claude usage */
export function completionsToClaudeUsage(usage: any): { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } {
  if (!usage) return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    output_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
  };
}

/** Map Claude usage to OpenAI Chat usage */
export function claudeToCompletionsUsage(usage: any): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  if (!usage) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const prompt = usage.input_tokens ?? 0;
  const completion = usage.output_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

/** Map Gemini usageMetadata to Claude usage */
export function geminiToClaudeUsage(metadata: any): { input_tokens: number; output_tokens: number } {
  if (!metadata) return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: metadata.promptTokenCount ?? 0,
    output_tokens: (metadata.totalTokenCount ?? 0) - (metadata.promptTokenCount ?? 0),
  };
}

/** Map Claude usage to Gemini usageMetadata */
export function claudeToGeminiUsage(usage: any): any {
  if (!usage) return {};
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  return {
    promptTokenCount: input,
    candidatesTokenCount: output,
    totalTokenCount: input + output,
  };
}

/** Map Responses API usage to Claude usage */
export function responsesToClaudeUsage(usage: any): { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } {
  if (!usage) return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? usage.input_tokens_details?.cached_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
  };
}

/**
 * 构造标准 Responses API usage 对象（转换层兼容入口）。
 *
 * 真实值优先：input_tokens ?? prompt_tokens、output_tokens ?? completion_tokens、total_tokens。
 * 覆盖上游 chat completions / claude / gemini 三种格式的字段命名归一。
 *
 * 仅当上游确实提供了任意 token 字段时返回归一化对象；否则返回 null（调用方应省略 usage 字段，
 * 不伪造 0）。这是避免 Codex `ResponseCompleted: missing field input_tokens` 的关键——
 * 既不吐空 `{}`，也不吐伪造的 `{0,0,0}`。
 */
export function toResponsesUsage(usage: any): { input_tokens: number; output_tokens: number; total_tokens: number } | null {
  if (!usage || typeof usage !== 'object') return null;
  const input_tokens = usage.input_tokens ?? usage.prompt_tokens;
  const output_tokens = usage.output_tokens ?? usage.completion_tokens;
  const total_tokens = usage.total_tokens;
  // 上游没返回任何 token 字段 → 不伪造，返回 null
  if (input_tokens == null && output_tokens == null && total_tokens == null) return null;
  return {
    input_tokens: input_tokens ?? 0,
    output_tokens: output_tokens ?? 0,
    total_tokens: total_tokens ?? ((input_tokens ?? 0) + (output_tokens ?? 0)),
  };
}

/** Map OpenAI Chat usage to Responses API usage（薄封装，保持现有调用方不变） */
export function completionsToResponsesUsage(usage: any): any {
  return toResponsesUsage(usage);
}
