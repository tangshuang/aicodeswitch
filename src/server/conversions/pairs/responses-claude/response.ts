/**
 * Claude Messages → OpenAI Responses API response conversion.
 *
 * Converts a Claude Messages response body into an OpenAI Responses API response body.
 */

import { generateResponseId, generateCallId } from '../../utils/id.js';
import { claudeToResponsesStatus } from '../../utils/stop-reasons.js';
import { thinkingToReasoningSummary } from '../../thinking/mapper.js';
import { toResponsesUsage } from '../../utils/usage.js';

/**
 * Convert a Claude Messages response to an OpenAI Responses API response.
 */
export function claudeToResponsesResponse(response: any): any {
  const output: any[] = [];

  for (const block of (response.content || [])) {
    if (block.type === 'thinking') {
      output.push({
        type: 'reasoning',
        id: `rs_${generateCallId().slice(5)}`,
        summary: thinkingToReasoningSummary(block.thinking || ''),
      });
    } else if (block.type === 'text') {
      output.push({
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: block.text,
          annotations: [],
        }],
      });
    } else if (block.type === 'tool_use') {
      output.push({
        type: 'function_call',
        status: 'completed',
        call_id: block.id,
        name: block.name,
        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
      });
    }
  }

  const { status, incomplete_details } = claudeToResponsesStatus(response.stop_reason);
  // 上游无 usage 时省略 usage 字段（不伪造 0）
  const usage = toResponsesUsage(response.usage);
  const responseId = response.id || generateResponseId();

  return {
    id: responseId,
    object: 'response',
    status,
    output,
    model: response.model || '',
    created_at: Math.floor(Date.now() / 1000),
    ...(usage ? { usage } : {}),
    ...(incomplete_details ? { incomplete_details } : {}),
    metadata: {},
  };
}
