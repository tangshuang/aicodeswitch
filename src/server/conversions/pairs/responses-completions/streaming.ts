/**
 * OpenAI Chat Completions SSE → OpenAI Responses API SSE streaming conversion.
 *
 * Stateful converter that translates Chat Completions SSE events into
 * OpenAI Responses API SSE events.
 */

import type { SSEEvent, StreamConverter } from '../../types.js';
import { completionsToResponsesUsage } from '../../utils/usage.js';
import { generateResponseId, generateCallId } from '../../utils/id.js';
import { normalizeToolArgumentsFragment, parseEventData } from '../../utils/streaming-helpers.js';

/**
 * CompletionsToResponsesConverter: Chat Completions SSE → Responses API SSE
 */
export class CompletionsToResponsesConverter implements StreamConverter {
  private started = false;
  private responseId = '';
  private model = '';
  private reasoningStarted = false;
  private textStarted = false;
  private reasoningOutputIndex = -1;
  private messageOutputIndex = -1;
  private currentToolCalls = new Map<
    number,
    { id: string; name: string; argumentsText: string; outputIndex: number }
  >();
  private pendingReasoningText = '';
  private accumulatedText = '';
  private finalized = false;
  private output: any[] = [];
  private nextOutputIndex = 0;
  private usage: any = null;
  private finishReason: string | null = null;

  convertEvent(event: SSEEvent): SSEEvent[] {
    if (!event.data) return [];

    // [DONE] -> trigger finalize
    if (event.data === '[DONE]' || event.data?.type === 'done') {
      return this.flush();
    }

    try {
      const chunk = parseEventData(event.data);
      const events: SSEEvent[] = [];
      const delta = chunk.choices?.[0]?.delta;
      const finishReason = chunk.choices?.[0]?.finish_reason;
      const usage = chunk.usage;
      const chunkId = chunk.id;
      const chunkModel = chunk.model;

      // First chunk -> emit response.created + response.in_progress
      if (!this.started) {
        this.responseId = chunkId?.startsWith('resp_') ? chunkId : generateResponseId();
        this.model = chunkModel || '';
        events.push(this.makeSSE('response.created', {
          id: this.responseId,
          object: 'response',
          status: 'in_progress',
          model: this.model,
          output: [],
        }));
        events.push(this.makeSSE('response.in_progress', {
          id: this.responseId,
          object: 'response',
          status: 'in_progress',
          model: this.model,
          output: [],
        }));
        this.started = true;
      }

      // --- reasoning_content ---
      if (delta?.reasoning_content) {
        this.pendingReasoningText += delta.reasoning_content;

        if (!this.reasoningStarted) {
          this.reasoningOutputIndex = this.nextOutputIndex++;
          const rsId = generateCallId().replace('call_', 'rs_');
          events.push(this.makeSSE('response.output_item.added', {
            output_index: this.reasoningOutputIndex,
            item: { type: 'reasoning', id: rsId },
          }));
          events.push(this.makeSSE('response.reasoning_summary_part.added', {
            output_index: this.reasoningOutputIndex,
            summary_index: 0,
            part: { type: 'summary_text' },
          }));
          this.reasoningStarted = true;
        }

        events.push(this.makeSSE('response.reasoning.delta', {
          output_index: this.reasoningOutputIndex,
          delta: delta.reasoning_content,
        }));
      }

      // --- content (text) ---
      if (delta?.content) {
        this.accumulatedText += delta.content;

        if (!this.textStarted) {
          this.messageOutputIndex = this.nextOutputIndex++;
          events.push(this.makeSSE('response.output_item.added', {
            output_index: this.messageOutputIndex,
            item: { type: 'message', status: 'in_progress', role: 'assistant', content: [] },
          }));
          events.push(this.makeSSE('response.content_part.added', {
            output_index: this.messageOutputIndex,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          }));
          this.textStarted = true;
        }

        events.push(this.makeSSE('response.output_text.delta', {
          output_index: this.messageOutputIndex,
          content_index: 0,
          delta: delta.content,
        }));
      }

      // --- tool_calls ---
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const toolIdx = tc.index ?? 0;
          const existing = this.currentToolCalls.get(toolIdx);

          if (!existing) {
            // New tool call
            const tcId = tc.id || generateCallId();
            const tcName = tc.function?.name || '';
            const tcOutputIndex = this.nextOutputIndex++;
            this.currentToolCalls.set(toolIdx, {
              id: tcId,
              name: tcName,
              argumentsText: '',
              outputIndex: tcOutputIndex,
            });

            events.push(this.makeSSE('response.output_item.added', {
              output_index: tcOutputIndex,
              item: {
                type: 'function_call',
                status: 'in_progress',
                call_id: tcId,
                name: tcName,
                arguments: '',
              },
            }));
          }

          // Arguments fragment
          const argsFragment = normalizeToolArgumentsFragment(tc.function?.arguments);
          if (argsFragment) {
            const current = this.currentToolCalls.get(toolIdx);
            if (current) {
              current.argumentsText += argsFragment;
            }

            events.push(this.makeSSE('response.function_call_arguments.delta', {
              output_index: current?.outputIndex ?? this.output.length,
              call_id: current?.id,
              delta: argsFragment,
            }));
          }
        }
      }

      // --- Finish reason ---
      if (finishReason) {
        this.finishReason = finishReason;
      }

      // --- Usage ---
      if (usage) {
        this.usage = usage;
      }

      return events;
    } catch {
      return [event];
    }
  }

  flush(): SSEEvent[] {
    if (this.finalized) return [];
    this.finalized = true;

    const events: SSEEvent[] = [];

    // Finalize reasoning
    if (this.reasoningStarted) {
      events.push(this.makeSSE('response.reasoning.done', {
        output_index: this.reasoningOutputIndex,
        summary: [{ type: 'summary_text', text: this.pendingReasoningText }],
      }));
      events.push(this.makeSSE('response.reasoning_summary_part.done', {
        output_index: this.reasoningOutputIndex,
      }));
      events.push(this.makeSSE('response.output_item.done', {
        output_index: this.reasoningOutputIndex,
        item: { type: 'reasoning' },
      }));
      this.output.push({
        type: 'reasoning',
        id: generateCallId().replace('call_', 'rs_'),
        summary: [{ type: 'summary_text', text: this.pendingReasoningText }],
      });
    }

    // Finalize text
    if (this.textStarted) {
      events.push(this.makeSSE('response.output_text.done', {
        output_index: this.messageOutputIndex,
        content_index: 0,
        text: '',
      }));
      events.push(this.makeSSE('response.content_part.done', {
        output_index: this.messageOutputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }));
      this.output.push({
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: this.accumulatedText }],
      });
      events.push(this.makeSSE('response.output_item.done', {
        output_index: this.messageOutputIndex,
        item: { type: 'message', status: 'completed', role: 'assistant' },
      }));
    }

    // Finalize tool calls
    for (const [, tc] of this.currentToolCalls) {
      events.push(this.makeSSE('response.function_call_arguments.done', {
        output_index: tc.outputIndex,
        call_id: tc.id,
      }));
      events.push(this.makeSSE('response.output_item.done', {
        output_index: tc.outputIndex,
        item: {
          type: 'function_call',
          status: 'completed',
          call_id: tc.id,
          name: tc.name,
          arguments: tc.argumentsText,
        },
      }));
      this.output.push({
        type: 'function_call',
        status: 'completed',
        call_id: tc.id,
        name: tc.name,
        arguments: tc.argumentsText,
      });
    }

    // Build full response object
    const status = this.finishReason === 'length' ? 'incomplete' : 'completed';
    const responseObj: any = {
      id: this.responseId,
      object: 'response',
      status,
      output: this.output,
      model: this.model,
      usage: this.usage ? completionsToResponsesUsage(this.usage) : {},
      created_at: Math.floor(Date.now() / 1000),
      metadata: {},
    };

    if (status === 'incomplete') {
      responseObj.incomplete_details = { reason: 'max_output_tokens' };
    }

    events.push(this.makeSSE('response.completed', { response: responseObj }));
    events.push({ data: '[DONE]', event: '' });

    return events;
  }

  private makeSSE(eventName: string, data: any): SSEEvent {
    return { event: eventName, data };
  }
}
