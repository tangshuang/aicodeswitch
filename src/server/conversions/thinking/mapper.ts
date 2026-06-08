/**
 * Thinking content mapping across API formats.
 */

/** Claude thinking text → reasoning_content string */
export function thinkingToReasoningContent(thinking: string): string {
  return thinking;
}

/** reasoning_content string → Claude thinking block */
export function reasoningContentToThinking(content: string): { type: 'thinking'; thinking: string } {
  return { type: 'thinking', thinking: content };
}

/** Responses API reasoning summary → Claude thinking block */
export function reasoningToThinking(summary: any[]): { type: 'thinking'; thinking: string } {
  const text = summary
    .filter((s: any) => s.type === 'summary_text')
    .map((s: any) => s.text || '')
    .join('');
  return { type: 'thinking', thinking: text || '' };
}

/** Claude thinking text → Responses API reasoning summary array */
export function thinkingToReasoningSummary(thinking: string): any[] {
  return [{ type: 'summary_text', text: thinking }];
}

/**
 * 将 assistant 消息中的 redacted_thinking 块转换为 thinking 块。
 * 用于不支持 redacted_thinking 的上游 provider（如 DeepSeek Anthropic 端点）。
 *
 * DeepSeek V4 模型的 Anthropic 兼容端点在 thinking 模式下仅识别 content[].thinking，
 * 不识别 redacted_thinking 类型。Claude Code 在多轮对话中会将历史 thinking 压缩为
 * redacted_thinking 以节省 token，因此需要在转发前做转换。
 */
export function convertRedactedThinkingForProvider(messages: any[]): any[] {
  return messages.map(msg => {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg;
    const hasRedacted = msg.content.some((b: any) => b.type === 'redacted_thinking');
    if (!hasRedacted) return msg;
    return {
      ...msg,
      content: msg.content.map((b: any) =>
        b.type === 'redacted_thinking'
          ? { type: 'thinking', thinking: '[thinking content redacted]' }
          : b
      ),
    };
  });
}

/** Fix history messages: ensure thinking/reasoning_content is present alongside tool use */
export function fixThinkingHistory(messages: any[], format: 'claude' | 'completions'): any[] {
  return messages.map(msg => {
    if (msg.role !== 'assistant') return msg;

    const hasToolUse =
      (format === 'claude' && msg.content?.some?.((b: any) => b.type === 'tool_use')) ||
      (format === 'completions' && (msg.tool_calls?.length > 0));

    if (!hasToolUse) return msg;

    if (format === 'claude') {
      const hasThinking = msg.content?.some?.((b: any) => b.type === 'thinking');
      if (!hasThinking) {
        return {
          ...msg,
          content: [{ type: 'thinking', thinking: 'tool call' }, ...(msg.content || [])],
        };
      }
    } else {
      if (!msg.reasoning_content) {
        return { ...msg, reasoning_content: 'tool call' };
      }
    }

    return msg;
  });
}

/** Placeholder for redacted thinking blocks */
export function redactedThinkingPlaceholder(): string {
  return '[redacted thinking]';
}
