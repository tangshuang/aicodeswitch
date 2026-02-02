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
  private errorEmitted = false;

  constructor() {
    super({ readableObjectMode: true });
    // 捕获流中的未处理错误，防止进程崩溃
    this.on('error', (err) => {
      console.error('[SSEParserTransform] Stream error:', err);
      this.errorEmitted = true;
    });
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.errorEmitted) {
      callback();
      return;
    }

    try {
      this.buffer += chunk.toString('utf8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';

      for (const line of lines) {
        this.processLine(line);
      }
      callback();
    } catch (error) {
      console.error('[SSEParserTransform] Error in _transform:', error);
      // 不传递错误，避免中断流，而是记录并继续
      callback();
    }
  }

  _flush(callback: (error?: Error | null) => void) {
    try {
      if (this.buffer.trim()) {
        this.processLine(this.buffer.trim());
        this.flushEvent();
      }
      callback();
    } catch (error) {
      console.error('[SSEParserTransform] Error in _flush:', error);
      callback();
    }
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
  private errorEmitted = false;

  constructor() {
    super({
      writableObjectMode: true,  // 接收对象
      readableObjectMode: false, // 输出字符串/Buffer
    });

    this.on('error', (err) => {
      console.error('[SSESerializerTransform] Stream error:', err);
      this.errorEmitted = true;
    });
  }

  _transform(event: SSEEvent, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.errorEmitted) {
      callback();
      return;
    }

    try {
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
    } catch (error) {
      console.error('[SSESerializerTransform] Error in _transform:', error);
      callback();
    }
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
  private errorEmitted = false;

  constructor(options?: { model?: string }) {
    super({ objectMode: true });
    this.model = options?.model ?? null;

    this.on('error', (err) => {
      console.error('[OpenAIToClaudeEventTransform] Stream error:', err);
      this.errorEmitted = true;
    });
  }

  getUsage() {
    if (!this.usage) return undefined;
    return { ...this.usage };
  }

  _transform(event: SSEEvent, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.errorEmitted) {
      callback();
      return;
    }

    try {
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
    } catch (error) {
      console.error('[OpenAIToClaudeEventTransform] Error in _transform:', error);
      // 发送错误事件后继续
      try {
        this.pushEvent('error', { type: 'error', error: { type: 'api_error', message: 'Stream transformation error' } });
      } catch (e) {
        // 忽略推送错误的错误
      }
      callback();
    }
  }

  _flush(callback: (error?: Error | null) => void) {
    try {
      this.finalize();
      callback();
    } catch (error) {
      console.error('[OpenAIToClaudeEventTransform] Error in _flush:', error);
      callback();
    }
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


export class ClaudeToOpenAIChatEventTransform extends Transform {
  private pendingToolCallId: string | null = null;
  private pendingToolName: string | null = null;
  private pendingToolArgs = '';
  private toolCallIndex = 0;
  private usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;
  private finished = false;
  private model: string | null = null;
  private errorEmitted = false;

  constructor(options?: { model?: string }) {
    super({ objectMode: true });
    this.model = options?.model ?? null;

    this.on('error', (err) => {
      console.error('[ClaudeToOpenAIChatEventTransform] Stream error:', err);
      this.errorEmitted = true;
    });
  }

  getUsage() {
    return this.usage;
  }

  _transform(event: SSEEvent, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.errorEmitted) {
      callback();
      return;
    }

    try {
      if (this.finished) {
        callback();
        return;
      }

      const type = event.event;
      const data = event.data;

      if (type === 'message_start' && data?.message) {
        this.model = data.message.model || this.model;
        this.push({ event: null, data: { id: data.message.id, model: this.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] } });
        callback();
        return;
      }

      if (type === 'content_block_start' && data?.content_block) {
        if (data.content_block.type === 'text') {
          // 文本块开始
        } else if (data.content_block.type === 'tool_use') {
          this.pendingToolCallId = data.content_block.id;
          this.pendingToolName = data.content_block.name;
          this.pendingToolArgs = '';
        }
        callback();
        return;
      }

      if (type === 'content_block_delta' && data?.delta) {
        if (data.delta.type === 'text_delta') {
          const text = data.delta.text || '';
          if (text) {
            this.push({ event: null, data: { id: '', model: this.model, choices: [{ index: 0, delta: { content: text } }] } });
          }
        } else if (data.delta.type === 'input_json_delta') {
          this.pendingToolArgs += data.delta.partial_json || '';
        }
        callback();
        return;
      }

      if (type === 'content_block_stop') {
        if (this.pendingToolCallId && this.pendingToolName !== null) {
          const toolCall = {
            index: this.toolCallIndex,
            id: this.pendingToolCallId,
            type: 'function' as const,
            function: {
              name: this.pendingToolName,
              arguments: this.pendingToolArgs,
            },
          };
          this.push({ event: null, data: { id: '', model: this.model, choices: [{ index: 0, delta: { tool_calls: [toolCall] } }] } });
          this.toolCallIndex++;
          this.pendingToolCallId = null;
          this.pendingToolName = null;
          this.pendingToolArgs = '';
        }
        callback();
        return;
      }

      if (type === 'message_stop' || data?.type === 'message_stop') {
        this.finished = true;
        this.push({ event: null, data: { id: '', model: this.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } });
        this.push({ event: 'done', data: { type: 'done' } });
        callback();
        return;
      }

      if (data?.usage) {
        this.usage = {
          prompt_tokens: data.usage.input_tokens || 0,
          completion_tokens: data.usage.output_tokens || 0,
          total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
        };
      }

      callback();
    } catch (error) {
      console.error('[ClaudeToOpenAIChatEventTransform] Error in _transform:', error);
      callback();
    }
  }

  _flush(callback: (error?: Error | null) => void) {
    try {
      if (!this.finished) {
        this.finished = true;
        this.push({ event: null, data: { id: '', model: this.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } });
        this.push({ event: 'done', data: { type: 'done' } });
      }
      callback();
    } catch (error) {
      console.error('[ClaudeToOpenAIChatEventTransform] Error in _flush:', error);
      callback();
    }
  }
}
