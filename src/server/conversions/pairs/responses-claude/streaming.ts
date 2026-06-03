/**
 * Claude Messages SSE → OpenAI Responses API SSE streaming conversion.
 *
 * Stateful converter that translates Claude Messages SSE events into
 * OpenAI Responses API SSE events.
 */

import type { SSEEvent, StreamConverter } from '../../types.js';
import { generateResponseId, generateCallId } from '../../utils/id.js';
import { claudeToResponsesStatus } from '../../utils/stop-reasons.js';
import { parseEventData } from '../../utils/streaming-helpers.js';

/**
 * ClaudeToResponsesConverter: Claude Messages SSE → Responses API SSE
 */
export class ClaudeToResponsesConverter implements StreamConverter {
  private finalized = false;
  private textStarted = false;
  private thinkingStarted = false;
  private responseId = generateResponseId();
  private model = '';
  private usage: any = { input_tokens: 0, output_tokens: 0 };
  private output: any[] = [];
  private currentToolCallId: string | null = null;
  private currentToolName: string | null = null;
  private currentToolArguments = '';
  private reasoningText = '';
  private pendingStopReason: string | null = null;

  convertEvent(event: SSEEvent): SSEEvent[] {
    if (!event.data) return [];

    const events: SSEEvent[] = [];

    try {
      const data = parseEventData(event.data);

      switch (data.type) {
        case 'message_start': {
          this.model = data.message?.model || '';
          this.responseId = data.message?.id || this.responseId;
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
          break;
        }

        case 'content_block_start': {
          const block = data.content_block;
          if (block?.type === 'thinking') {
            // Close text if open
            this.closeText(events);
            const rsIdx = this.output.length;
            events.push(this.makeSSE('response.output_item.added', {
              output_index: rsIdx,
              item: { type: 'reasoning', id: `rs_${generateCallId().slice(5)}` },
            }));
            events.push(this.makeSSE('response.reasoning_summary_part.added', {
              output_index: rsIdx,
              summary_index: 0,
              part: { type: 'summary_text' },
            }));
            this.thinkingStarted = true;
            this.reasoningText = '';
          } else if (block?.type === 'text') {
            // Close thinking if open
            this.closeThinking(events);
            const msgIdx = this.output.length;
            events.push(this.makeSSE('response.output_item.added', {
              output_index: msgIdx,
              item: { type: 'message', status: 'in_progress', role: 'assistant', content: [] },
            }));
            events.push(this.makeSSE('response.content_part.added', {
              output_index: msgIdx,
              content_index: 0,
              part: { type: 'output_text', text: '', annotations: [] },
            }));
            this.textStarted = true;
          } else if (block?.type === 'tool_use') {
            // Close any open blocks
            this.closeText(events);
            this.closeThinking(events);
            this.currentToolCallId = block.id;
            this.currentToolName = block.name;
            this.currentToolArguments = '';
            const toolIdx = this.output.length;
            events.push(this.makeSSE('response.output_item.added', {
              output_index: toolIdx,
              item: {
                type: 'function_call',
                status: 'in_progress',
                call_id: block.id,
                name: block.name,
                arguments: '',
              },
            }));
          }
          break;
        }

        case 'content_block_delta': {
          const delta = data.delta;
          if (delta?.type === 'thinking_delta') {
            const text = delta.thinking || '';
            if (text) {
              this.reasoningText += text;
              events.push(this.makeSSE('response.reasoning.delta', {
                output_index: this.output.length,
                delta: text,
              }));
            }
          } else if (delta?.type === 'text_delta') {
            const text = delta.text || '';
            if (text) {
              events.push(this.makeSSE('response.output_text.delta', {
                output_index: this.textMessageOutputIndex(),
                content_index: 0,
                delta: text,
              }));
            }
          } else if (delta?.type === 'input_json_delta') {
            const partialJson = delta.partial_json || '';
            if (partialJson) {
              this.currentToolArguments += partialJson;
              events.push(this.makeSSE('response.function_call_arguments.delta', {
                output_index: this.output.length,
                call_id: this.currentToolCallId,
                delta: partialJson,
              }));
            }
          }
          break;
        }

        case 'content_block_stop': {
          // If this was a tool_use block, emit function_call_arguments.done and output_item.done
          if (this.currentToolCallId !== null) {
            const tcIdx = this.output.length;
            events.push(this.makeSSE('response.function_call_arguments.done', {
              output_index: tcIdx,
              call_id: this.currentToolCallId,
            }));
            events.push(this.makeSSE('response.output_item.done', {
              output_index: tcIdx,
              item: {
                type: 'function_call',
                status: 'completed',
                call_id: this.currentToolCallId,
                name: this.currentToolName || '',
                arguments: this.currentToolArguments,
              },
            }));
            this.output.push({
              type: 'function_call',
              status: 'completed',
              call_id: this.currentToolCallId,
              name: this.currentToolName,
              arguments: this.currentToolArguments,
            });
            this.currentToolCallId = null;
            this.currentToolName = null;
            this.currentToolArguments = '';
          }
          break;
        }

        case 'message_delta': {
          this.pendingStopReason = data.delta?.stop_reason || null;
          if (data.usage) {
            this.usage = {
              input_tokens: this.usage.input_tokens,
              output_tokens: data.usage.output_tokens ?? data.usage.tokens ?? 0,
            };
          }
          break;
        }

        case 'message_stop': {
          this.finalize(events);
          break;
        }

        default:
          break;
      }
    } catch {
      // Ignore parse errors
    }

    return events;
  }

  /**
   * Get the output index of the text message.
   * The text message is at the last output index that hasn't been pushed yet.
   */
  private textMessageOutputIndex(): number {
    // During streaming, text output hasn't been pushed yet.
    // Its index is determined by what's already been pushed + whether it's after reasoning.
    return this.thinkingStarted ? this.output.length : this.output.length;
  }

  private closeText(events: SSEEvent[]): void {
    if (this.textStarted) {
      const msgIdx = this.output.length;
      events.push(this.makeSSE('response.output_text.done', {
        output_index: msgIdx,
        content_index: 0,
        text: '',
      }));
      events.push(this.makeSSE('response.content_part.done', {
        output_index: msgIdx,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }));
      this.output.push({ type: 'message', status: 'completed', role: 'assistant' });
      events.push(this.makeSSE('response.output_item.done', {
        output_index: this.output.length - 1,
        item: { type: 'message', status: 'completed', role: 'assistant' },
      }));
      this.textStarted = false;
    }
  }

  private closeThinking(events: SSEEvent[]): void {
    if (this.thinkingStarted) {
      const rsIdx = this.output.length;
      events.push(this.makeSSE('response.reasoning.done', {
        output_index: rsIdx,
        summary: [{ type: 'summary_text', text: this.reasoningText }],
      }));
      events.push(this.makeSSE('response.reasoning_summary_part.done', {
        output_index: rsIdx,
      }));
      events.push(this.makeSSE('response.output_item.done', {
        output_index: rsIdx,
        item: { type: 'reasoning' },
      }));
      this.output.push({ type: 'reasoning' });
      this.thinkingStarted = false;
      this.reasoningText = '';
    }
  }

  private finalize(events: SSEEvent[]): void {
    if (this.finalized) return;
    this.finalized = true;

    // Close any open blocks
    this.closeText(events);
    this.closeThinking(events);

    const { status, incomplete_details } = claudeToResponsesStatus(this.pendingStopReason);

    const responseObj: any = {
      id: this.responseId,
      object: 'response',
      status,
      output: this.output,
      model: this.model,
      created_at: Math.floor(Date.now() / 1000),
      usage: {
        input_tokens: this.usage.input_tokens,
        output_tokens: this.usage.output_tokens,
        total_tokens: this.usage.input_tokens + this.usage.output_tokens,
      },
      metadata: {},
    };

    if (incomplete_details) {
      responseObj.incomplete_details = incomplete_details;
    }

    events.push(this.makeSSE('response.completed', { response: responseObj }));
    events.push({ data: '[DONE]', event: '' });
  }

  private makeSSE(eventName: string, data: any): SSEEvent {
    return {
      event: eventName,
      data,
    };
  }
}
