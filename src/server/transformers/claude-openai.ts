/**
 * Claude ↔ OpenAI 转换函数
 * 保留被实际使用的函数
 */

/**
 * 将 OpenAI usage 转换为 Claude usage 格式
 * 被 streaming.ts 使用
 */
export const convertOpenAIUsageToClaude = (usage: any) => {
  const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
  return {
    input_tokens: (usage?.prompt_tokens || 0) - cached,
    output_tokens: usage?.completion_tokens || 0,
    cache_read_input_tokens: cached,
  };
};

/**
 * 将 OpenAI 的 finish_reason 映射到 Claude 的 stop_reason
 * OpenAI: "stop" | "length" | "tool_calls" | "content_filter"
 * Claude: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "max_thinking_length"
 * 被 streaming.ts 使用
 */
export const mapStopReason = (finishReason?: string | null): string => {
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'end_turn';
  }
};
