/**
 * OpenAI Chat Completions → OpenAI Responses API response conversion.
 *
 * Converts a Chat Completions response body into an OpenAI Responses API response body.
 * Reasoning content (reasoning_content) is converted to a standard `reasoning` output
 * item following the official Responses API specification.
 */

import {
  completionsToResponsesFinishReason,
} from '../../utils/stop-reasons.js';
import { completionsToResponsesUsage } from '../../utils/usage.js';
import { generateResponseId, generateCallId } from '../../utils/id.js';

/**
 * Convert a Chat Completions response to a Responses API response.
 */
export function completionsToResponsesResponse(response: any): any {
  const choice = response.choices?.[0];
  if (!choice) return response;

  const output: any[] = [];

  // reasoning_content -> reasoning output item (official Responses API format)
  if (choice.message?.reasoning_content) {
    output.push({
      type: 'reasoning',
      id: generateCallId().replace('call_', 'rs_'),
      summary: [{ type: 'summary_text', text: choice.message.reasoning_content }],
    });
  }

  // Text content -> message item
  if (choice.message?.content) {
    const messageContent: any[] = [
      { type: 'output_text', text: choice.message.content, annotations: [] },
    ];
    // Refusal -> add as refusal in message content
    if (choice.message?.refusal) {
      messageContent.push({ type: 'refusal', refusal: choice.message.refusal });
    }
    output.push({
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: messageContent,
    });
  } else if (choice.message?.refusal) {
    // Message with only refusal, no text content
    output.push({
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [
        { type: 'output_text', text: '', annotations: [] },
        { type: 'refusal', refusal: choice.message.refusal },
      ],
    });
  }

  // Tool calls -> function_call items
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      output.push({
        type: 'function_call',
        status: 'completed',
        call_id: tc.id,
        name: tc.function?.name || '',
        arguments: tc.function?.arguments || '{}',
      });
    }
  }

  // If no message was emitted (edge case: only tool calls), still emit a message
  if (!choice.message?.content && !choice.message?.refusal && !choice.message?.tool_calls) {
    output.push({
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }],
    });
  }

  const finishReason = completionsToResponsesFinishReason(choice.finish_reason);
  const status = finishReason === 'incomplete' ? 'incomplete' : 'completed';
  const usage = completionsToResponsesUsage(response.usage);

  const result: any = {
    id: response.id?.startsWith('resp_') ? response.id : generateResponseId(),
    object: 'response',
    status,
    output,
    model: response.model,
    created_at: response.created || Math.floor(Date.now() / 1000),
    // 上游无 usage 时省略 usage 字段（不伪造 0）
    ...(usage ? { usage } : {}),
  };

  if (status === 'incomplete') {
    result.incomplete_details = { reason: 'max_output_tokens' };
  }

  return result;
}
