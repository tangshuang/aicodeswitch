import { Transform } from 'stream';
import crypto from 'crypto';
import { convertOpenAIUsageToClaude, mapStopReason } from './claude-openai';

export type SSEEvent = {
  event?: string;
  id?: string;
  data?: any;
};

export class SSEParserTransform extends Transform {
  private buffer = '';
  private currentEvent: SSEEvent = {};
  private dataLines: string[] = [];

  constructor() {
    super({ readableObjectMode: true });
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.buffer += chunk.toString('utf8');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      this.processLine(line);
    }
    callback();
  }

  _flush(callback: (error?: Error | null) => void) {
    if (this.buffer.trim()) {
      this.processLine(this.buffer.trim());
      this.flushEvent();
    }
    callback();
  }

  private processLine(line: string) {
    if (!line.trim()) {
      this.flushEvent();
      return;
    }

    if (line.startsWith('event:')) {
      this.currentEvent.event = line.slice(6).trim();
      return;
    }

    if (line.startsWith('id:')) {
      this.currentEvent.id = line.slice(3).trim();
      return;
    }

    if (line.startsWith('data:')) {
      this.dataLines.push(line.slice(5).trim());
    }
  }

  private flushEvent() {
    if (!this.currentEvent.event && this.dataLines.length === 0 && !this.currentEvent.id) {
      return;
    }

    if (this.dataLines.length > 0) {
      const data = this.dataLines.join('\n');
      if (data === '[DONE]') {
        this.currentEvent.data = { type: 'done' };
      } else {
        try {
          this.currentEvent.data = JSON.parse(data);
        } catch {
          this.currentEvent.data = data;
        }
      }
    }

    this.push(this.currentEvent);
    this.currentEvent = {};
    this.dataLines = [];
  }
}

export class SSESerializerTransform extends Transform {
  constructor() {
    super({ writableObjectMode: true });
  }

  _transform(event: SSEEvent, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    let output = '';
    if (event.event) {
      output += `event: ${event.event}\n`;
    }
    if (event.id) {
      output += `id: ${event.id}\n`;
    }
    if (event.data !== undefined) {
      if (event.data?.type === 'done') {
        output += 'data: [DONE]\n';
      } else if (typeof event.data === 'string') {
        output += `data: ${event.data}\n`;
      } else {
        output += `data: ${JSON.stringify(event.data)}\n`;
      }
    }
    output += '\n';
    this.push(output);
    callback();
  }
}

export const rewriteStream = <T, U>(
  stream: NodeJS.ReadableStream,
  processor: (data: T, controller: Transform) => Promise<U | undefined>
) => {
  const transformer = new Transform({
    objectMode: true,
    transform: (chunk, _encoding, callback) => {
      Promise.resolve(processor(chunk as T, transformer))
        .then((processed) => {
          if (processed !== undefined) {
            transformer.push(processed as U);
          }
          callback();
        })
        .catch((error) => callback(error));
    },
  });

  return stream.pipe(transformer);
};

export class OpenAIToClaudeEventTransform extends Transform {
  private contentIndex = 0;
  private textBlockIndex: number | null = null;
  private thinkingBlockIndex: number | null = null;
  private toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  private toolCallIndexToBlockIndex = new Map<number, number>();
  private hasMessageStart = false;
  private stopReason: string = 'end_turn';
  private usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } | null = null;
  private messageId: string | null = null;
  private model: string | null = null;
  private finalized = false;

  constructor(options?: { model?: string }) {
    super({ objectMode: true });
    this.model = options?.model ?? null;
  }

  getUsage() {
    if (!this.usage) return undefined;
    return { ...this.usage };
  }

  _transform(event: SSEEvent, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.finalized) {
      callback();
      return;
    }

    if (event.data?.type === 'done') {
      this.finalize();
      callback();
      return;
    }

    const chunk = event.data;
    if (!chunk) {
      callback();
      return;
    }

    if (chunk.id && !this.messageId) {
      this.messageId = chunk.id;
    }
    if (chunk.model && !this.model) {
      this.model = chunk.model;
    }

    if (chunk.usage) {
      this.usage = convertOpenAIUsageToClaude(chunk.usage);
    }

    if (Array.isArray(chunk.choices)) {
      for (const choice of chunk.choices) {
        this.handleChoice(choice);
      }
    }

    callback();
  }

  _flush(callback: (error?: Error | null) => void) {
    this.finalize();
    callback();
  }

  private assignContentBlockIndex() {
    const index = this.contentIndex;
    this.contentIndex += 1;
    return index;
  }

  private pushEvent(type: string, data: any) {
    this.push({ event: type, data });
  }

  private ensureMessageStart() {
    if (this.hasMessageStart) return;
    const message = {
      id: this.messageId || `msg_${crypto.randomUUID()}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model: this.model || 'unknown',
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    };
    this.pushEvent('message_start', { type: 'message_start', message });
    this.hasMessageStart = true;
  }

  private handleChoice(choice: any) {
    const delta = choice?.delta;
    if (!delta) return;

    if (typeof choice?.finish_reason === 'string') {
      this.stopReason = mapStopReason(choice.finish_reason);
    }

    if (typeof delta.content === 'string') {
      this.ensureMessageStart();
      if (this.textBlockIndex === null) {
        this.textBlockIndex = this.assignContentBlockIndex();
        this.pushEvent('content_block_start', {
          type: 'content_block_start',
          index: this.textBlockIndex,
          content_block: { type: 'text' },
        });
      }
      this.pushEvent('content_block_delta', {
        type: 'content_block_delta',
        index: this.textBlockIndex,
        delta: {
          type: 'text_delta',
          text: delta.content,
        },
      });
    }

    if (typeof delta.thinking?.content === 'string') {
      this.ensureMessageStart();
      if (this.thinkingBlockIndex === null) {
        this.thinkingBlockIndex = this.assignContentBlockIndex();
        this.pushEvent('content_block_start', {
          type: 'content_block_start',
          index: this.thinkingBlockIndex,
          content_block: { type: 'thinking', thinking: '' },
        });
      }
      this.pushEvent('content_block_delta', {
        type: 'content_block_delta',
        index: this.thinkingBlockIndex,
        delta: {
          type: 'thinking_delta',
          thinking: delta.thinking.content,
        },
      });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (let i = 0; i < delta.tool_calls.length; i += 1) {
        const toolCall = delta.tool_calls[i];
        const toolIndex = typeof toolCall?.index === 'number' ? toolCall.index : i;
        const toolName = toolCall?.function?.name;

        if (toolCall?.id && toolName) {
          this.ensureMessageStart();
          const toolBlockIndex = this.assignContentBlockIndex();
          this.toolCalls.set(toolIndex, {
            id: toolCall.id,
            name: toolName,
            arguments: '',
          });
          this.toolCallIndexToBlockIndex.set(toolIndex, toolBlockIndex);
          this.pushEvent('content_block_start', {
            type: 'content_block_start',
            index: toolBlockIndex,
            content_block: {
              type: 'tool_use',
              id: toolCall.id,
              name: toolName,
            },
          });
        }

        if (toolCall?.function?.arguments) {
          this.ensureMessageStart();
          const stored = this.toolCalls.get(toolIndex);
          if (stored) {
            stored.arguments += toolCall.function.arguments;
          }
          const toolBlockIndex = this.toolCallIndexToBlockIndex.get(toolIndex);
          if (toolBlockIndex !== undefined) {
            this.pushEvent('content_block_delta', {
              type: 'content_block_delta',
              index: toolBlockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: toolCall.function.arguments,
              },
            });
          }
        }
      }
    }
  }

  private finalize() {
    if (this.finalized) return;
    this.ensureMessageStart();

    for (const toolBlockIndex of this.toolCallIndexToBlockIndex.values()) {
      this.pushEvent('content_block_stop', {
        type: 'content_block_stop',
        index: toolBlockIndex,
      });
    }

    if (this.thinkingBlockIndex !== null) {
      this.pushEvent('content_block_stop', {
        type: 'content_block_stop',
        index: this.thinkingBlockIndex,
      });
      this.thinkingBlockIndex = null;
    }

    if (this.textBlockIndex !== null) {
      this.pushEvent('content_block_stop', {
        type: 'content_block_stop',
        index: this.textBlockIndex,
      });
      this.textBlockIndex = null;
    }

    const usage = this.usage || {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
    };

    this.pushEvent('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: this.stopReason,
        stop_sequence: null,
      },
      usage,
    });

    this.pushEvent('message_stop', { type: 'message_stop' });
    this.finalized = true;
  }
}

export class OpenAIResponsesToClaudeEventTransform extends Transform {
  private contentIndex = 0;
  private textBlockIndex: number | null = null;
  private toolCalls = new Map<string, { id: string; name: string; arguments: string }>();
  private toolCallKeyToBlockIndex = new Map<string, number>();
  private hasMessageStart = false;
  private stopReason: string = 'end_turn';
  private usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } | null = null;
  private messageId: string | null = null;
  private model: string | null = null;
  private finalized = false;

  constructor(options?: { model?: string }) {
    super({ objectMode: true });
    this.model = options?.model ?? null;
  }

  getUsage() {
    if (!this.usage) return undefined;
    return { ...this.usage };
  }

  _transform(event: SSEEvent, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.finalized) {
      callback();
      return;
    }

    const eventType = event.event || event.data?.type || '';

    if (eventType.includes('response.created')) {
      const response = event.data?.response || event.data;
      if (response?.id) this.messageId = response.id;
      if (response?.model) this.model = response.model;
      this.ensureMessageStart();
      callback();
      return;
    }

    if (eventType.includes('output_text')) {
      const deltaText = event.data?.delta ?? event.data?.text;
      if (typeof deltaText === 'string' && deltaText.length > 0) {
        this.handleTextDelta(deltaText);
      }
      if (eventType.includes('done')) {
        this.closeTextBlock();
      }
      callback();
      return;
    }

    if (eventType.includes('tool_call')) {
      const toolId = event.data?.tool_call_id || event.data?.id || event.data?.tool_call?.id || `tool_${this.toolCalls.size + 1}`;
      const toolName = event.data?.name || event.data?.tool_call?.name || 'tool';
      const delta = event.data?.delta ?? event.data?.arguments;
      if (typeof delta === 'string') {
        this.handleToolDelta(toolId, toolName, delta);
      }
      if (eventType.includes('done')) {
        const key = toolId || toolName;
        this.closeToolBlock(key);
      }
      callback();
      return;
    }

    if (eventType.includes('response.completed')) {
      const response = event.data?.response || event.data;
      if (response?.usage) {
        const inputTokens = response.usage?.input_tokens ?? response.usage?.prompt_tokens ?? 0;
        const outputTokens = response.usage?.output_tokens ?? response.usage?.completion_tokens ?? 0;
        const cacheRead = response.usage?.cache_read_input_tokens ?? response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
        this.usage = {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_input_tokens: cacheRead,
        };
      }
      this.finalize();
      callback();
      return;
    }

    callback();
  }

  _flush(callback: (error?: Error | null) => void) {
    this.finalize();
    callback();
  }

  private assignContentBlockIndex() {
    const index = this.contentIndex;
    this.contentIndex += 1;
    return index;
  }

  private pushEvent(type: string, data: any) {
    this.push({ event: type, data });
  }

  private ensureMessageStart() {
    if (this.hasMessageStart) return;
    const message = {
      id: this.messageId || `msg_${crypto.randomUUID()}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model: this.model || 'unknown',
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    };
    this.pushEvent('message_start', { type: 'message_start', message });
    this.hasMessageStart = true;
  }

  private handleTextDelta(text: string) {
    this.ensureMessageStart();
    if (this.textBlockIndex === null) {
      this.textBlockIndex = this.assignContentBlockIndex();
      this.pushEvent('content_block_start', {
        type: 'content_block_start',
        index: this.textBlockIndex,
        content_block: { type: 'text' },
      });
    }
    this.pushEvent('content_block_delta', {
      type: 'content_block_delta',
      index: this.textBlockIndex,
      delta: { type: 'text_delta', text },
    });
  }

  private closeTextBlock() {
    if (this.textBlockIndex === null) return;
    this.pushEvent('content_block_stop', {
      type: 'content_block_stop',
      index: this.textBlockIndex,
    });
    this.textBlockIndex = null;
  }

  private handleToolDelta(toolId: string, toolName: string, delta: string) {
    this.ensureMessageStart();
    const key = toolId || toolName;
    if (!this.toolCalls.has(key)) {
      const toolBlockIndex = this.assignContentBlockIndex();
      this.toolCalls.set(key, { id: toolId, name: toolName, arguments: '' });
      this.toolCallKeyToBlockIndex.set(key, toolBlockIndex);
      this.pushEvent('content_block_start', {
        type: 'content_block_start',
        index: toolBlockIndex,
        content_block: { type: 'tool_use', id: toolId, name: toolName },
      });
    }
    const toolEntry = this.toolCalls.get(key);
    if (toolEntry) {
      toolEntry.arguments += delta;
    }
    const blockIndex = this.toolCallKeyToBlockIndex.get(key);
    if (blockIndex !== undefined) {
      this.pushEvent('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'input_json_delta', partial_json: delta },
      });
    }
  }

  private closeToolBlock(key: string) {
    const blockIndex = this.toolCallKeyToBlockIndex.get(key);
    if (blockIndex === undefined) return;
    this.pushEvent('content_block_stop', {
      type: 'content_block_stop',
      index: blockIndex,
    });
    this.toolCallKeyToBlockIndex.delete(key);
    this.toolCalls.delete(key);
  }

  private finalize() {
    if (this.finalized) return;
    this.ensureMessageStart();
    this.closeTextBlock();

    for (const blockIndex of this.toolCallKeyToBlockIndex.values()) {
      this.pushEvent('content_block_stop', {
        type: 'content_block_stop',
        index: blockIndex,
      });
    }
    this.toolCallKeyToBlockIndex.clear();
    this.toolCalls.clear();

    const usage = this.usage || {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
    };

    this.pushEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.stopReason, stop_sequence: null },
      usage,
    });

    this.pushEvent('message_stop', { type: 'message_stop' });
    this.finalized = true;
  }
}

export class ClaudeToOpenAIResponsesEventTransform extends Transform {
  private responseId: string | null = null;
  private model: string | null = null;
  private createdAt: number = Date.now();
  private outputText = '';
  private textBlockIndex: number | null = null;
  private toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  private completedToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  private usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number } | null = null;
  private hasCreated = false;

  constructor(options?: { model?: string }) {
    super({ objectMode: true });
    this.model = options?.model ?? null;
  }

  getUsage() {
    if (!this.usage) return undefined;
    return { ...this.usage };
  }

  _transform(event: SSEEvent, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    const eventType = event.event || '';

    if (eventType === 'message_start') {
      const message = event.data?.message;
      if (message?.id) this.responseId = message.id;
      if (message?.model) this.model = message.model;
      this.ensureResponseCreated();
      callback();
      return;
    }

    if (eventType === 'content_block_start') {
      const block = event.data?.content_block;
      const index = event.data?.index;
      if (block?.type === 'text') {
        this.textBlockIndex = index;
      }
      if (block?.type === 'tool_use' && typeof index === 'number') {
        this.toolCalls.set(index, {
          id: block.id || `tool_${index}`,
          name: block.name || 'tool',
          arguments: '',
        });
      }
      callback();
      return;
    }

    if (eventType === 'content_block_delta') {
      const delta = event.data?.delta;
      const index = event.data?.index;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        this.ensureResponseCreated();
        this.outputText += delta.text;
        this.pushEvent('response.output_text.delta', {
          type: 'response.output_text.delta',
          delta: delta.text,
          output_index: 0,
          content_index: 0,
        });
      }
      if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string' && typeof index === 'number') {
        const tool = this.toolCalls.get(index);
        if (tool) {
          tool.arguments += delta.partial_json;
          this.ensureResponseCreated();
          this.pushEvent('response.output_tool_call.delta', {
            type: 'response.output_tool_call.delta',
            delta: delta.partial_json,
            output_index: index,
            tool_call_id: tool.id,
            name: tool.name,
          });
        }
      }
      callback();
      return;
    }

    if (eventType === 'content_block_stop') {
      const index = event.data?.index;
      if (typeof index === 'number') {
        if (this.textBlockIndex === index) {
          this.pushEvent('response.output_text.done', {
            type: 'response.output_text.done',
            text: this.outputText,
            output_index: 0,
            content_index: 0,
          });
          this.textBlockIndex = null;
        }
        const tool = this.toolCalls.get(index);
        if (tool) {
          this.completedToolCalls.push(tool);
          this.pushEvent('response.output_tool_call.done', {
            type: 'response.output_tool_call.done',
            output_index: index,
            tool_call: {
              id: tool.id,
              name: tool.name,
              arguments: tool.arguments,
            },
          });
          this.toolCalls.delete(index);
        }
      }
      callback();
      return;
    }

    if (eventType === 'message_delta') {
      if (event.data?.usage) {
        this.usage = {
          input_tokens: event.data.usage.input_tokens ?? 0,
          output_tokens: event.data.usage.output_tokens ?? 0,
          cache_read_input_tokens: event.data.usage.cache_read_input_tokens ?? 0,
        };
      }
      callback();
      return;
    }

    if (eventType === 'message_stop') {
      this.pushCompletedResponse();
      callback();
      return;
    }

    callback();
  }

  private ensureResponseCreated() {
    if (this.hasCreated) return;
    const response = {
      id: this.responseId || `resp_${crypto.randomUUID()}`,
      object: 'response',
      model: this.model || 'unknown',
      output: [],
      created_at: this.createdAt,
    };
    this.pushEvent('response.created', { type: 'response.created', response });
    this.hasCreated = true;
  }

  private pushEvent(event: string, data: any) {
    this.push({ event, data });
  }

  private pushCompletedResponse() {
    this.ensureResponseCreated();
    const output: any[] = [];
    if (this.outputText) {
      output.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: this.outputText }],
      });
    }
    for (const tool of this.completedToolCalls) {
      output.push({
        type: 'tool_call',
        id: tool.id,
        name: tool.name,
        arguments: tool.arguments,
      });
    }

    const inputTokens = this.usage?.input_tokens ?? 0;
    const cacheRead = this.usage?.cache_read_input_tokens ?? 0;
    const outputTokens = this.usage?.output_tokens ?? 0;

    const response = {
      id: this.responseId || `resp_${crypto.randomUUID()}`,
      object: 'response',
      model: this.model || 'unknown',
      output,
      output_text: this.outputText,
      status: 'completed',
      created_at: this.createdAt,
      usage: {
        input_tokens: inputTokens + cacheRead,
        output_tokens: outputTokens,
        total_tokens: inputTokens + cacheRead + outputTokens,
      },
    };
    this.pushEvent('response.completed', { type: 'response.completed', response });
  }
}
