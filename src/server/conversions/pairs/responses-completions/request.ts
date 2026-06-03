/**
 * OpenAI Responses API → OpenAI Chat Completions API request conversion.
 *
 * Converts a Responses API request body into a Chat Completions request body.
 */

import { isOSeriesModel } from '../../thinking/effort.js';
import { generateCallId } from '../../utils/id.js';

/**
 * Convert an OpenAI Responses API request body to a Chat Completions request body.
 */
export function responsesToCompletions(body: any): any {
  const messages: any[] = [];

  // --- instructions -> system message ---
  if (body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }

  // --- input -> messages ---
  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    // We accumulate items that belong to the same assistant message
    // (e.g. reasoning + content + function_calls need to merge)
    let pendingAssistantMessage: any = null;
    let pendingToolCalls: any[] = [];
    let pendingReasoningContent: string | undefined;

    for (const item of body.input) {
      if (item.type === 'message') {
        // Flush any pending assistant message before processing a new message
        flushPendingAssistant(messages, pendingAssistantMessage, pendingToolCalls, pendingReasoningContent);
        pendingAssistantMessage = null;
        pendingToolCalls = [];
        pendingReasoningContent = undefined;

        if (item.role === 'system' || item.role === 'developer') {
          // Merge system/developer messages into the system message at head
          const text = extractContent(item.content, item.role === 'assistant' ? 'output_text' : 'input_text');
          if (text) {
            const existingSystem = messages.find((m: any) => m.role === 'system');
            if (existingSystem) {
              existingSystem.content += '\n' + text;
            } else {
              messages.unshift({ role: 'system', content: text });
            }
          }
        } else if (item.role === 'user') {
          const text = extractContent(item.content, 'input_text');
          messages.push({ role: 'user', content: text || '' });
        } else if (item.role === 'assistant') {
          const text = extractContent(item.content, 'output_text');
          pendingAssistantMessage = { role: 'assistant', content: text || null };
        }
      } else if (item.type === 'function_call') {
        // Accumulate as tool_calls on the nearest assistant message
        if (!pendingAssistantMessage) {
          pendingAssistantMessage = { role: 'assistant', content: null };
        }
        pendingToolCalls.push({
          id: item.call_id || generateCallId(),
          type: 'function' as const,
          function: {
            name: item.name || '',
            arguments: item.arguments || '{}',
          },
        });
      } else if (item.type === 'function_call_output') {
        // Flush any pending assistant message first
        flushPendingAssistant(messages, pendingAssistantMessage, pendingToolCalls, pendingReasoningContent);
        pendingAssistantMessage = null;
        pendingToolCalls = [];
        pendingReasoningContent = undefined;

        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: item.output || '',
        });
      } else if (item.type === 'reasoning') {
        if (!pendingAssistantMessage) {
          pendingAssistantMessage = { role: 'assistant', content: null };
        }
        const summaryTexts = Array.isArray(item.summary)
          ? item.summary.map((s: any) => s.text || '').filter(Boolean)
          : [];
        if (summaryTexts.length > 0) {
          pendingReasoningContent = summaryTexts.join('\n');
        }
      }
    }

    // Flush any remaining pending assistant message
    flushPendingAssistant(messages, pendingAssistantMessage, pendingToolCalls, pendingReasoningContent);
  }

  // --- Build result ---
  const result: any = {
    model: body.model,
    messages,
    stream: body.stream ?? false,
  };

  // --- Parameter mapping ---
  if (body.max_output_tokens !== undefined) {
    if (body.model && isOSeriesModel(body.model)) {
      result.max_completion_tokens = body.max_output_tokens;
    } else {
      result.max_tokens = body.max_output_tokens;
    }
  }
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;

  // --- Reasoning effort ---
  if (body.reasoning?.effort) {
    result.reasoning_effort = body.reasoning.effort;
  }

  // --- Tools ---
  // 仅转换标准 function 类型工具，过滤掉 OpenAI 私有扩展类型
  // （custom/tool_search/web_search/file_search/code_interpreter 等）
  // 这些非标准类型没有 name 字段，直接转换会导致上游 API 返回参数错误
  const functionTools = (body.tools || []).filter((t: any) => t.type === 'function');
  if (functionTools.length > 0) {
    result.tools = functionTools.map((tool: any) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.parameters || {},
      },
    }));
  }

  // --- Tool choice mapping ---
  if (body.tool_choice !== undefined) {
    result.tool_choice = responsesToCompletionsToolChoice(body.tool_choice);
  }

  // --- Auto-inject stream_options when streaming ---
  if (result.stream) {
    result.stream_options = { include_usage: true };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract text content from a Responses API message item's content array.
 */
function extractContent(content: any, textType: string): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part: any) => part.type === textType || part.type === 'text')
    .map((part: any) => part.text || '')
    .join('');
}

/**
 * Flush a pending assistant message with accumulated tool_calls and reasoning_content.
 */
function flushPendingAssistant(
  messages: any[],
  pendingAssistant: any | null,
  pendingToolCalls: any[],
  pendingReasoningContent: string | undefined,
): void {
  if (!pendingAssistant && pendingToolCalls.length === 0 && !pendingReasoningContent) {
    return;
  }

  const msg: any = {
    role: 'assistant',
    content: pendingAssistant?.content || null,
  };

  if (pendingReasoningContent) {
    msg.reasoning_content = pendingReasoningContent;
  }

  if (pendingToolCalls.length > 0) {
    msg.tool_calls = pendingToolCalls;
    // When tool_calls are present but no reasoning_content was provided,
    // inject a placeholder so the receiver can detect tool-use context
    if (!pendingReasoningContent) {
      msg.reasoning_content = 'tool call';
    }
  }

  messages.push(msg);
}

/**
 * Map Responses API tool_choice to Chat Completions tool_choice.
 */
function responsesToCompletionsToolChoice(toolChoice: any): any {
  if (typeof toolChoice === 'string') {
    switch (toolChoice) {
      case 'required': return 'required';
      case 'auto': return 'auto';
      case 'none': return 'none';
      default: return 'auto';
    }
  }
  if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  return 'auto';
}
