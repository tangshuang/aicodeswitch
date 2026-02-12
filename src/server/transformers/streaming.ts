import { Transform } from 'stream';
import * as crypto from 'crypto';
import { convertOpenAIUsageToClaude, mapStopReason as mapOpenAIToClaudeStopReason } from './claude-openai';

// 导出 SSEEvent 类型供其他模块使用
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

      // 检查是否是 OpenAI Responses API 的事件
      // Responses API 事件类型如：response.reasoning_text.delta, response.output_text.delta 等
      if (event.event && event.event.startsWith('response.')) {
        this.handleResponsesAPIEvent(event);
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
      this.stopReason = mapOpenAIToClaudeStopReason(choice.finish_reason);
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

    // 处理 OpenAI Chat Completions API 的 thinking content
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

  // 处理 OpenAI Responses API 的流式事件
  private handleResponsesAPIEvent(event: SSEEvent) {
    const type = event.event;
    const data = event.data;

    // 处理 reasoning 文本增量（完整推理过程）
    if (type === 'response.reasoning_text.delta' && data?.delta) {
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
          thinking: data.delta,
        },
      });
    }

    // 处理 reasoning summary 文本增量（推理摘要）
    if (type === 'response.reasoning_summary_text.delta' && data?.delta) {
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
          thinking: data.delta,
        },
      });
    }

    // 处理普通文本增量
    if (type === 'response.output_text.delta' && data?.delta) {
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
          text: data.delta,
        },
      });
    }

    // 处理拒绝内容增量（内容过滤等）
    if (type === 'response.refusal.delta' && data?.delta) {
      // 拒绝内容可以作为文本发送
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
          text: data.delta,
        },
      });
    }

    // 处理函数调用参数增量
    if (type === 'response.function_call_arguments.delta' && data?.delta) {
      // OpenAI Responses API 的函数调用
      // 这需要与现有的 tool_calls 处理逻辑配合
      // 暂时先跳过，因为 Responses API 使用不同的函数调用格式
    }

    // 处理响应完成事件
    if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete') {
      // 确保所有内容块都已关闭
      this.finalize();
    }

    // 处理响应创建和进行中事件
    if (type === 'response.created' || type === 'response.in_progress') {
      this.ensureMessageStart();
    }
  }

  private finalize() {
    if (this.finalized) return;
    this.ensureMessageStart();

    for (const toolBlockIndex of Array.from(this.toolCallIndexToBlockIndex.values())) {
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
  private stopReason: string = 'stop'; // OpenAI 的 finish_reason
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
        } else if (data.content_block.type === 'thinking') {
          // thinking 块开始（无需特殊处理）
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
        } else if (data.delta.type === 'thinking_delta') {
          // 处理 thinking 增量，转换为 OpenAI 格式
          const thinking = data.delta.thinking || '';
          if (thinking) {
            // OpenAI 兼容格式：使用 delta.thinking.content
            this.push({ event: null, data: { id: '', model: this.model, choices: [{ index: 0, delta: { thinking: { content: thinking } } }] } });
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
        // 使用映射后的 stop reason
        this.push({ event: null, data: { id: '', model: this.model, choices: [{ index: 0, delta: {}, finish_reason: this.stopReason }] } });
        this.push({ event: 'done', data: { type: 'done' } });
        callback();
        return;
      }

      // 处理 message_delta 事件（包含 stop_reason 和 usage）
      if (type === 'message_delta' && data?.delta) {
        // 映射 Claude 的 stop_reason 到 OpenAI 的 finish_reason
        if (data.delta.stop_reason) {
          this.stopReason = this.mapStopReason(data.delta.stop_reason);
        }

        // 处理 usage 信息
        if (data.usage) {
          this.usage = {
            prompt_tokens: data.usage.input_tokens || 0,
            completion_tokens: data.usage.output_tokens || 0,
            total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
          };
        }

        // 不发送 delta 事件，只在最终 message_stop 时发送 finish_reason
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
        this.push({ event: null, data: { id: '', model: this.model, choices: [{ index: 0, delta: {}, finish_reason: this.stopReason }] } });
        this.push({ event: 'done', data: { type: 'done' } });
      }
      callback();
    } catch (error) {
      console.error('[ClaudeToOpenAIChatEventTransform] Error in _flush:', error);
      callback();
    }
  }

  /**
   * 将 Claude 的 stop_reason 映射到 OpenAI 的 finish_reason
   * Claude: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "max_thinking_length"
   * OpenAI: "stop" | "length" | "tool_calls" | "content_filter"
   */
  private mapStopReason(stopReason: string): string {
    switch (stopReason) {
      case 'end_turn':
        return 'stop';
      case 'max_tokens':
      case 'max_thinking_length':
        return 'length';
      case 'tool_use':
        return 'tool_calls';
      case 'stop_sequence':
        return 'stop';
      case 'content_filter':
        return 'content_filter';
      default:
        return 'stop';
    }
  }
}

// ============================================================================
// Gemini 流式转换器
// ============================================================================

/**
 * 将 Gemini SSE 流式事件转换为 Claude 格式
 */
export class GeminiToClaudeEventTransform extends Transform {
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
  private accumulatedText = new Map<number, string>(); // 累积每个候选的文本
  private accumulatedToolCalls = new Map<number, Array<{ name: string; args: Record<string, unknown> }>>();

  constructor(options?: { model?: string }) {
    super({ objectMode: true });
    this.model = options?.model ?? null;

    this.on('error', (err) => {
      console.error('[GeminiToClaudeEventTransform] Stream error:', err);
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

      // Gemini 流式响应格式: { candidates: [{ content: { parts: [...] }, finishReason: ... }], usageMetadata: {...} }
      const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
      const usageMetadata = chunk.usageMetadata;

      // 处理 usage
      if (usageMetadata) {
        this.usage = {
          input_tokens: usageMetadata.promptTokenCount || 0,
          output_tokens: usageMetadata.candidatesTokenCount || 0,
          cache_read_input_tokens: usageMetadata.cachedContentTokenCount || 0,
        };
      }

      // 处理 candidates
      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
        const candidate = candidates[candidateIndex];
        const content = candidate.content;

        // 处理 finishReason
        if (candidate.finishReason) {
          this.stopReason = this.mapGeminiFinishReason(candidate.finishReason);
        }

        if (!content || !Array.isArray(content.parts)) {
          continue;
        }

        this.ensureMessageStart();

        // 处理 parts
        for (const part of content.parts) {
          // 处理文本
          if (part.text && typeof part.text === 'string') {
            if (this.textBlockIndex === null) {
              this.textBlockIndex = this.assignContentBlockIndex();
              this.pushEvent('content_block_start', {
                type: 'content_block_start',
                index: this.textBlockIndex,
                content_block: { type: 'text' },
              });
            }

            // 累积文本
            const currentText = this.accumulatedText.get(candidateIndex) || '';
            this.accumulatedText.set(candidateIndex, currentText + part.text);

            this.pushEvent('content_block_delta', {
              type: 'content_block_delta',
              index: this.textBlockIndex,
              delta: {
                type: 'text_delta',
                text: part.text,
              },
            });
          }

          // 处理 functionCall -> tool_use
          if (part.functionCall) {
            const toolCalls = this.accumulatedToolCalls.get(candidateIndex) || [];
            toolCalls.push({
              name: part.functionCall.name || 'tool',
              args: part.functionCall.args || {},
            });
            this.accumulatedToolCalls.set(candidateIndex, toolCalls);

            const toolBlockIndex = this.assignContentBlockIndex();
            this.toolCalls.set(toolCalls.length - 1, {
              id: `tool_${toolCalls.length}_${Date.now()}`,
              name: part.functionCall.name || 'tool',
              arguments: JSON.stringify(part.functionCall.args || {}),
            });
            this.toolCallIndexToBlockIndex.set(toolCalls.length - 1, toolBlockIndex);

            this.pushEvent('content_block_start', {
              type: 'content_block_start',
              index: toolBlockIndex,
              content_block: {
                type: 'tool_use',
                id: this.toolCalls.get(toolCalls.length - 1)!.id,
                name: part.functionCall.name || 'tool',
              },
            });

            // 发送完整的参数
            this.pushEvent('content_block_delta', {
              type: 'content_block_delta',
              index: toolBlockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify(part.functionCall.args || {}),
              },
            });
          }

          // 处理 inlineData (图像输出，罕见)
          if (part.inlineData) {
            // 图像输出作为单独的内容块
            const imageBlockIndex = this.assignContentBlockIndex();
            this.pushEvent('content_block_start', {
              type: 'content_block_start',
              index: imageBlockIndex,
              content_block: {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: part.inlineData.mimeType,
                  data: part.inlineData.data,
                },
              },
            });
            this.pushEvent('content_block_stop', {
              type: 'content_block_stop',
              index: imageBlockIndex,
            });
          }
        }
      }

      callback();
    } catch (error) {
      console.error('[GeminiToClaudeEventTransform] Error in _transform:', error);
      callback();
    }
  }

  _flush(callback: (error?: Error | null) => void) {
    try {
      this.finalize();
      callback();
    } catch (error) {
      console.error('[GeminiToClaudeEventTransform] Error in _flush:', error);
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
      id: this.messageId || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model: this.model || 'gemini',
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

  private mapGeminiFinishReason(finishReason: string): string {
    switch (finishReason) {
      case 'STOP':
        return 'end_turn';
      case 'MAX_TOKENS':
        return 'max_tokens';
      case 'SAFETY':
      case 'RECITATION':
        return 'content_filter';
      case 'MALFORMED_FUNCTION_CALL':
        return 'tool_use';
      default:
        return 'end_turn';
    }
  }

  private finalize() {
    if (this.finalized) return;
    this.ensureMessageStart();

    // 关闭所有工具调用块
    for (const toolBlockIndex of Array.from(this.toolCallIndexToBlockIndex.values())) {
      this.pushEvent('content_block_stop', {
        type: 'content_block_stop',
        index: toolBlockIndex,
      });
    }

    // 关闭文本块
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

/**
 * 将 Gemini SSE 流式事件转换为 OpenAI Chat 格式
 */
export class GeminiToOpenAIChatEventTransform extends Transform {
  private pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  private usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;
  private finished = false;
  private model: string | null = null;
  private stopReason: string = 'stop';
  private errorEmitted = false;
  private accumulatedText = '';

  constructor(options?: { model?: string }) {
    super({ objectMode: true });
    this.model = options?.model ?? null;

    this.on('error', (err) => {
      console.error('[GeminiToOpenAIChatEventTransform] Stream error:', err);
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

      if (event.data?.type === 'done') {
        this.finished = true;
        this.push({ event: null, data: { id: '', model: this.model, choices: [{ index: 0, delta: {}, finish_reason: this.stopReason }] } });
        this.push({ event: 'done', data: { type: 'done' } });
        callback();
        return;
      }

      const chunk = event.data;
      if (!chunk) {
        callback();
        return;
      }

      // 处理 usage
      if (chunk.usageMetadata) {
        this.usage = {
          prompt_tokens: chunk.usageMetadata.promptTokenCount || 0,
          completion_tokens: chunk.usageMetadata.candidatesTokenCount || 0,
          total_tokens: chunk.usageMetadata.totalTokenCount || 0,
        };
      }

      const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];

      for (const candidate of candidates) {
        // 处理 finishReason
        if (candidate.finishReason) {
          this.stopReason = this.mapGeminiFinishReason(candidate.finishReason);
        }

        if (!candidate.content || !Array.isArray(candidate.content.parts)) {
          continue;
        }

        // 处理 parts
        for (const part of candidate.content.parts) {
          // 处理文本
          if (part.text && typeof part.text === 'string') {
            this.accumulatedText += part.text;
            this.push({ event: null, data: { id: '', model: this.model, choices: [{ index: 0, delta: { content: part.text } }] } });
          }

          // 处理 functionCall -> tool_calls
          if (part.functionCall) {
            const toolCallId = `call_${this.pendingToolCalls.length}_${Date.now()}`;
            this.pendingToolCalls.push({
              id: toolCallId,
              name: part.functionCall.name || 'tool',
              arguments: JSON.stringify(part.functionCall.args || {}),
            });

            this.push({
              event: null,
              data: {
                id: '',
                model: this.model,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      id: toolCallId,
                      type: 'function',
                      function: {
                        name: part.functionCall.name || 'tool',
                        arguments: JSON.stringify(part.functionCall.args || {}),
                      },
                    }],
                  },
                }],
              },
            });
          }

          // 处理 inlineData (图像输出，罕见)
          if (part.inlineData) {
            // 图像作为 content 的一部分发送
            const imageDataUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
            this.push({
              event: null,
              data: {
                id: '',
                model: this.model,
                choices: [{
                  index: 0,
                  delta: {
                    content: [{
                      type: 'image_url',
                      image_url: { url: imageDataUrl },
                    }],
                  },
                }],
              },
            });
          }
        }
      }

      callback();
    } catch (error) {
      console.error('[GeminiToOpenAIChatEventTransform] Error in _transform:', error);
      callback();
    }
  }

  _flush(callback: (error?: Error | null) => void) {
    try {
      if (!this.finished) {
        this.finished = true;
        this.push({
          event: null,
          data: {
            id: '',
            model: this.model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: this.stopReason,
            }],
          },
        });
        this.push({ event: 'done', data: { type: 'done' } });
      }
      callback();
    } catch (error) {
      console.error('[GeminiToOpenAIChatEventTransform] Error in _flush:', error);
      callback();
    }
  }

  private mapGeminiFinishReason(finishReason: string): string {
    switch (finishReason) {
      case 'STOP':
        return 'stop';
      case 'MAX_TOKENS':
        return 'length';
      case 'SAFETY':
      case 'RECITATION':
        return 'content_filter';
      case 'MALFORMED_FUNCTION_CALL':
        return 'tool_calls';
      default:
        return 'stop';
    }
  }
}
