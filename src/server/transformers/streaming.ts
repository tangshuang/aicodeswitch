import { Transform } from 'stream';
import * as crypto from 'crypto';

/**
 * SSEEvent - 表示一个完整的SSE事件
 */
export interface SSEEvent {
  event?: string;
  id?: string;
  data?: any;
}

/**
 * 将 OpenAI usage 转换为 Claude usage 格式
 */
const convertOpenAIUsageToClaude = (usage: any) => {
  const promptTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  const cached =
    usage?.prompt_tokens_details?.cached_tokens ??
    usage?.input_tokens_details?.cached_tokens ??
    0;
  return {
    input_tokens: Math.max(promptTokens - cached, 0),
    output_tokens: completionTokens,
    cache_read_input_tokens: cached,
  };
};

/**
 * 将 OpenAI 的 finish_reason 映射到 Claude 的 stop_reason
 */
const mapOpenAIToClaudeStopReason = (finishReason?: string | null): string => {
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
      if (this.buffer.length > 0) {
        this.processLine(this.buffer.replace(/\r$/, ''));
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
      const rawValue = line.slice(5).replace(/\r$/, '');
      // SSE 规范仅移除 "data:" 后的一个可选空格，不能使用 trim 破坏原始内容
      this.dataLines.push(rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue);
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
      const isDoneEvent = event.data?.type === 'done';
      if (event.event && !isDoneEvent) {
        output += `event: ${event.event}\n`;
      }
      if (event.id && !isDoneEvent) {
        output += `id: ${event.id}\n`;
      }
      if (event.data !== undefined) {
        let dataToSerialize = event.data;
        // OpenAI Responses 事件通常需要在 data 内包含 type 字段，便于客户端按规范解析
        if (
          event.event &&
          dataToSerialize &&
          typeof dataToSerialize === 'object' &&
          !Array.isArray(dataToSerialize) &&
          dataToSerialize.type === undefined
        ) {
          dataToSerialize = { type: event.event, ...dataToSerialize };
        }

        if (dataToSerialize?.type === 'done') {
          output += 'data: [DONE]\n';
        } else if (typeof dataToSerialize === 'string') {
          output += `data: ${dataToSerialize}\n`;
        } else {
          output += `data: ${JSON.stringify(dataToSerialize)}\n`;
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

  _flush(callback: (error?: Error | null) => void) {
    // 如果 [DONE] 已经发送，不需要额外操作
    // Node.js 会自动关闭流
    callback();
  }
}

export class OpenAIToClaudeEventTransform extends Transform {
  private contentIndex = 0;
  private textBlockIndex: number | null = null;
  private thinkingBlockIndex: number | null = null;
  private toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  private toolCallIndexToBlockIndex = new Map<number, number>();
  private responseToolCalls = new Map<string, { id: string; name: string; arguments: string }>();
  private responseToolCallBlockIndex = new Map<string, number>();
  private completedToolCallIds = new Set<string>();
  private hasMessageStart = false;
  private stopReason: string = 'end_turn';
  private usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } | null = null;
  private messageId: string | null = null;
  private model: string | null = null;
  private finalized = false;
  private errorEmitted = false;

  constructor(options?: { model?: string }) {
    super({ objectMode: true });
    void options;

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

      const responseEventType = event.event || event.data?.type;
      // 检查是否是 OpenAI Responses API 的事件
      // Responses API 事件类型如：response.reasoning_text.delta, response.output_text.delta 等
      if (typeof responseEventType === 'string' && responseEventType.startsWith('response.')) {
        this.handleResponsesAPIEvent(responseEventType, event.data);
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
  private handleResponsesAPIEvent(type: string, data: any) {

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
    if (type === 'response.function_call.start' && data) {
      const callId = data.call_id || data.item_id;
      if (callId) {
        this.ensureMessageStart();
        const blockIndex = this.assignContentBlockIndex();
        this.responseToolCalls.set(callId, {
          id: callId,
          name: data.name || 'tool',
          arguments: data.arguments || '',
        });
        this.responseToolCallBlockIndex.set(callId, blockIndex);
        this.pushEvent('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'tool_use',
            id: callId,
            name: data.name || 'tool',
          },
        });
      }
    }

    if (type === 'response.function_call_arguments.delta' && data?.delta) {
      const callId = data.call_id || data.item_id;
      if (callId) {
        if (!this.responseToolCalls.has(callId)) {
          this.ensureMessageStart();
          const blockIndex = this.assignContentBlockIndex();
          this.responseToolCalls.set(callId, {
            id: callId,
            name: data.name || 'tool',
            arguments: '',
          });
          this.responseToolCallBlockIndex.set(callId, blockIndex);
          this.pushEvent('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'tool_use',
              id: callId,
              name: data.name || 'tool',
            },
          });
        }
        const stored = this.responseToolCalls.get(callId);
        if (stored) {
          stored.arguments += data.delta;
        }
        const blockIndex = this.responseToolCallBlockIndex.get(callId);
        if (blockIndex !== undefined) {
          this.pushEvent('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: data.delta,
            },
          });
        }
      }
    }

    if (type === 'response.function_call_arguments.done' && data) {
      const callId = data.call_id || data.item_id;
      if (callId) {
        if (!this.responseToolCalls.has(callId)) {
          this.ensureMessageStart();
          const blockIndex = this.assignContentBlockIndex();
          this.responseToolCalls.set(callId, {
            id: callId,
            name: data.name || 'tool',
            arguments: typeof data.arguments === 'string' ? data.arguments : '',
          });
          this.responseToolCallBlockIndex.set(callId, blockIndex);
          this.pushEvent('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'tool_use',
              id: callId,
              name: data.name || 'tool',
            },
          });
        }
        const blockIndex = this.responseToolCallBlockIndex.get(callId);
        if (blockIndex !== undefined && !this.completedToolCallIds.has(callId)) {
          this.pushEvent('content_block_stop', {
            type: 'content_block_stop',
            index: blockIndex,
          });
          this.completedToolCallIds.add(callId);
        }
      }
    }

    // 处理响应完成事件
    if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete') {
      if (type === 'response.incomplete' && data?.incomplete_details?.reason === 'max_tokens') {
        this.stopReason = 'max_tokens';
      } else if (type === 'response.failed' || data?.incomplete_details?.reason === 'content_filter') {
        this.stopReason = 'content_filter';
      } else {
        this.stopReason = 'end_turn';
      }
      if (data?.response?.usage) {
        this.usage = convertOpenAIUsageToClaude(data.response.usage);
      }
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

    for (const [callId, toolBlockIndex] of this.responseToolCallBlockIndex.entries()) {
      if (this.completedToolCallIds.has(callId)) continue;
      this.pushEvent('content_block_stop', {
        type: 'content_block_stop',
        index: toolBlockIndex,
      });
      this.completedToolCallIds.add(callId);
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
    void options;

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
            this.push({
              event: null,
              data: {
                id: '',
                model: this.model,
                choices: [{
                  index: 0,
                  delta: {
                    // Chat Completions chunk 的 delta.content 应为字符串
                    content: '[Image content]',
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

// ======================= transform SSE for codex =======================

/**
 * 将 Chat Completions SSE 流式事件转换为 Responses API 格式
 * 当源是 openai-chat，目标是 codex 时使用
 */
export class ChatCompletionsToResponsesEventTransform extends Transform {
  private messageId: string | null = null;
  private model: string | null = null;
  private responseCreated = false;
  private textIndex = 0;
  private toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  private toolCallIndexToContentIndex = new Map<number, number>();
  private stopReason: string = 'completed';
  private incompleteReason: string = 'max_tokens';
  private usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null = null;
  private finalized = false;
  private errorEmitted = false;

  constructor(options?: { model?: string }) {
    super({ objectMode: true });
    this.model = options?.model ?? null;

    this.on('error', (err) => {
      console.error('[OpenAIChatToResponsesEventTransform] Stream error:', err);
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

      // 处理 OpenAI Chat Completions 事件
      if (chunk.id && !this.messageId) {
        this.messageId = chunk.id;
      }
      if (chunk.model && !this.model) {
        this.model = chunk.model;
      }

      // 处理 usage
      if (chunk.usage) {
        this.usage = {
          input_tokens: chunk.usage.prompt_tokens || 0,
          output_tokens: chunk.usage.completion_tokens || 0,
          total_tokens: (chunk.usage.prompt_tokens || 0) + (chunk.usage.completion_tokens || 0),
        };
      }

      // 处理 choices
      if (Array.isArray(chunk.choices)) {
        for (const choice of chunk.choices) {
          this.handleChoice(choice);
        }
      }

      callback();
    } catch (error) {
      console.error('[OpenAIChatToResponsesEventTransform] Error in _transform:', error);
      callback();
    }
  }

  _flush(callback: (error?: Error | null) => void) {
    try {
      // 检查是否已经 finalized（避免重复发送结束事件）
      if (this.finalized) {
        callback();
        return;
      }

      this.finalize();
      callback();
    } catch (error) {
      console.error('[OpenAIChatToResponsesEventTransform] Error in _flush:', error);
      callback();
    }
  }

  private pushEvent(eventType: string, data: any) {
    this.push({ event: eventType, data });
  }

  private sendResponseCreated() {
    if (this.responseCreated) return;
    const id = this.messageId || `response_${Date.now()}`;
    this.pushEvent('response.created', { id });
    this.pushEvent('response.in_progress', { id });
    this.responseCreated = true;
  }

  private handleChoice(choice: any) {
    // 处理 finish_reason 映射（放在最前面）
    // OpenAI: "stop" | "length" | "tool_calls" | "content_filter"
    // Responses: status = "completed" | "incomplete"
    if (typeof choice?.finish_reason === 'string') {
      if (choice.finish_reason === 'length' || choice.finish_reason === 'max_tokens') {
        this.stopReason = 'incomplete';
        this.incompleteReason = 'max_tokens';
      } else if (choice.finish_reason === 'content_filter') {
        this.stopReason = 'incomplete';
        this.incompleteReason = 'content_filter';
      } else {
        this.stopReason = 'completed';
      }
      // 发送 completion 事件并返回
      this.finalize();
      return;
    }

    const delta = choice.delta;
    if (!delta) return;

    // 处理文本内容
    if (typeof delta.content === 'string') {
      this.sendResponseCreated();
      this.pushEvent('response.output_text.delta', { delta: delta.content });
    }

    // 处理 thinking 内容
    if (typeof delta.reasoning?.content === 'string') {
      this.sendResponseCreated();
      this.pushEvent('response.reasoning_text.delta', { delta: delta.reasoning.content });
    }

    // 处理工具调用
    if (Array.isArray(delta.tool_calls)) {
      for (let i = 0; i < delta.tool_calls.length; i++) {
        const toolCall = delta.tool_calls[i];
        const toolIndex = typeof toolCall?.index === 'number' ? toolCall.index : i;
        const toolName = toolCall?.function?.name;

        // 发送工具调用开始
        if (toolCall?.id && toolName) {
          this.sendResponseCreated();

          if (toolCall.function) {
            // 发送 function_call.start
            this.pushEvent('response.function_call.start', {
              call_id: toolCall.id,
              item_id: toolCall.id,
              name: toolName,
              arguments: '{}',
            });

            // 存储 tool call
            this.toolCalls.set(toolIndex, {
              id: toolCall.id,
              name: toolName,
              arguments: '',
            });
            this.toolCallIndexToContentIndex.set(toolIndex, this.textIndex);
          }
        }

        // 发送工具参数增量
        if (toolCall?.function?.arguments) {
          this.sendResponseCreated();

          const stored = this.toolCalls.get(toolIndex);
          if (stored) {
            stored.arguments += toolCall.function.arguments;
          }

          this.pushEvent('response.function_call_arguments.delta', {
            call_id: stored?.id || '',
            item_id: stored?.id || '',
            delta: toolCall.function.arguments,
          });
        }
      }
    }

    // 处理 refusal（拒绝内容）
    if (typeof delta.refusal === 'string') {
      this.sendResponseCreated();
      this.pushEvent('response.refusal.delta', { delta: delta.refusal });
    }
  }

  private finalize() {
    if (this.finalized) return;
    this.sendResponseCreated();

    for (const [, call] of this.toolCalls) {
      this.pushEvent('response.function_call_arguments.done', {
        call_id: call.id,
        item_id: call.id,
        name: call.name,
        arguments: call.arguments || '{}',
      });
    }

    // 发送 response.completed 或 response.incomplete
    this.pushEvent(this.stopReason === 'incomplete' ? 'response.incomplete' : 'response.completed', {
      incomplete_details: this.stopReason === 'incomplete' ? { reason: this.incompleteReason } : undefined,
    });

    // 发送 usage（如果有）
    if (this.usage) {
      this.pushEvent('response.usage', {
        input_tokens: this.usage.input_tokens,
        output_tokens: this.usage.output_tokens,
        total_tokens: this.usage.total_tokens,
      });
    }

    this.finalized = true;
  }
}

/**
 * 将 Claude SSE 流式事件转换为 Responses API 格式
 * 当源是 claude/claude-chat，目标是 codex 时使用
 */
export class ClaudeToResponsesEventTransform extends Transform {
  private messageId: string | null = null;
  private model: string | null = null;
  private responseCreated = false;
  private textIndex = 0;
  private toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  private toolCallIndexToContentIndex = new Map<number, number>();
  private activeToolIndexByContentIndex = new Map<number, number>();
  private completedToolCallIds = new Set<string>();
  private stopReason: string = 'completed';
  private incompleteReason: string = 'max_tokens';
  private usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null = null;
  private finalized = false;
  private errorEmitted = false;

  constructor(options?: { model?: string }) {
    super({ objectMode: true });
    this.model = options?.model ?? null;

    this.on('error', (err) => {
      console.error('[ClaudeToResponsesEventTransform] Stream error:', err);
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
      if (this.finalized) {
        callback();
        return;
      }

      if (event.data?.type === 'done') {
        this.finalize();
        callback();
        return;
      }

      const type = event.event;
      const data = event.data;

      // 处理 message_start
      if (type === 'message_start' && data?.message) {
        this.messageId = data.message.id;
        this.model = data.message.model || this.model;

        if (!this.responseCreated) {
          this.pushEvent('response.created', { id: this.messageId || `response_${Date.now()}` });
          this.pushEvent('response.in_progress', { id: this.messageId || `response_${Date.now()}` });
          this.responseCreated = true;
        }
        callback();
        return;
      }

      // 处理 content_block_start
      if (type === 'content_block_start' && data?.content_block) {
        if (data.content_block.type === 'text') {
          // 文本块开始，无需特殊处理，等待 delta
        } else if (data.content_block.type === 'thinking') {
          // thinking 块，处理为 reasoning 文本
          if (!this.responseCreated) {
            this.pushEvent('response.created', { id: this.messageId || `response_${Date.now()}` });
            this.pushEvent('response.in_progress', { id: this.messageId || `response_${Date.now()}` });
            this.responseCreated = true;
          }
        } else if (data.content_block.type === 'tool_use') {
          // 工具调用
          if (!this.responseCreated) {
            this.pushEvent('response.created', { id: this.messageId || `response_${Date.now()}` });
            this.pushEvent('response.in_progress', { id: this.messageId || `response_${Date.now()}` });
            this.responseCreated = true;
          }

          const contentIndex = typeof data.index === 'number' ? data.index : this.assignContentIndex();
          const toolIndex = this.toolCalls.size;
          this.toolCalls.set(toolIndex, {
            id: data.content_block.id,
            name: data.content_block.name,
            arguments: '',
          });
          this.toolCallIndexToContentIndex.set(toolIndex, contentIndex);
          this.activeToolIndexByContentIndex.set(contentIndex, toolIndex);

          // 发送 function_call.start 事件
          this.pushEvent('response.function_call.start', {
            call_id: data.content_block.id,
            item_id: data.content_block.id,
            name: data.content_block.name,
            arguments: '{}',
          });
        }
        callback();
        return;
      }

      // 处理 content_block_delta
      if (type === 'content_block_delta' && data?.delta) {
        if (data.delta.type === 'text_delta') {
          if (!this.responseCreated) {
            this.pushEvent('response.created', { id: this.messageId || `response_${Date.now()}` });
            this.pushEvent('response.in_progress', { id: this.messageId || `response_${Date.now()}` });
            this.responseCreated = true;
          }
          const text = data.delta.text || '';
          if (text) {
            this.pushEvent('response.output_text.delta', { delta: text });
          }
        } else if (data.delta.type === 'thinking_delta') {
          // thinking 增量，转换为 reasoning 文本增量
          const thinking = data.delta.thinking || '';
          if (thinking) {
            this.pushEvent('response.reasoning_text.delta', { delta: thinking });
          }
        } else if (data.delta.type === 'input_json_delta') {
          // 工具参数增量
          const contentIndex = typeof data.index === 'number' ? data.index : undefined;
          const toolIndex = contentIndex !== undefined
            ? this.activeToolIndexByContentIndex.get(contentIndex) ?? (this.toolCalls.size - 1)
            : (this.toolCalls.size - 1);
          const stored = this.toolCalls.get(toolIndex);
          if (stored) {
            stored.arguments += data.delta.partial_json || '';
          }
          const toolBlockIndex = this.toolCallIndexToContentIndex.get(toolIndex);
          if (toolBlockIndex !== undefined) {
            this.pushEvent('response.function_call_arguments.delta', {
              call_id: stored?.id || '',
              item_id: stored?.id || '',
              delta: data.delta.partial_json || '',
            });
          }
        }
        callback();
        return;
      }

      // 处理 content_block_stop
      if (type === 'content_block_stop') {
        const contentIndex = typeof data?.index === 'number' ? data.index : undefined;
        const toolIndex = contentIndex !== undefined ? this.activeToolIndexByContentIndex.get(contentIndex) : undefined;
        const stored = toolIndex !== undefined ? this.toolCalls.get(toolIndex) : undefined;
        if (stored && !this.completedToolCallIds.has(stored.id)) {
          this.pushEvent('response.function_call_arguments.done', {
            call_id: stored.id,
            item_id: stored.id,
            name: stored.name,
            arguments: stored.arguments || '{}',
          });
          this.completedToolCallIds.add(stored.id);
        }
        callback();
        return;
      }

      // 处理 message_delta
      if (type === 'message_delta' && data?.delta) {
        // 映射 stop_reason
        if (data.delta.stop_reason) {
          const mapped = this.mapStopReasonToResponses(data.delta.stop_reason);
          this.stopReason = mapped.status;
          if (mapped.reason) {
            this.incompleteReason = mapped.reason;
          }
        }

        // 处理 usage
        if (data.usage) {
          this.usage = {
            input_tokens: data.usage.input_tokens || 0,
            output_tokens: data.usage.output_tokens || 0,
            total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
          };
        }
        callback();
        return;
      }

      // 处理 message_stop
      if (type === 'message_stop' || data?.type === 'message_stop') {
        this.finalize();
        callback();
        return;
      }

      // 处理 usage 字段（在顶层）
      if (data?.usage) {
        this.usage = {
          input_tokens: data.usage.input_tokens || 0,
          output_tokens: data.usage.output_tokens || 0,
          total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
        };
      }

      callback();
    } catch (error) {
      console.error('[ClaudeToResponsesEventTransform] Error in _transform:', error);
      callback();
    }
  }

  _flush(callback: (error?: Error | null) => void) {
    try {
      this.finalize();
      callback();
    } catch (error) {
      console.error('[ClaudeToResponsesEventTransform] Error in _flush:', error);
      callback();
    }
  }

  private assignContentIndex() {
    const index = this.textIndex;
    this.textIndex += 1;
    return index;
  }

  private pushEvent(eventType: string, data: any) {
    this.push({ event: eventType, data });
  }

  private mapStopReasonToResponses(stopReason: string): { status: 'completed' | 'incomplete'; reason?: string } {
    switch (stopReason) {
      case 'end_turn':
      case 'stop_sequence':
        return { status: 'completed' };
      case 'max_tokens':
      case 'max_thinking_length':
        return { status: 'incomplete', reason: 'max_tokens' };
      case 'tool_use':
        return { status: 'completed' };
      case 'content_filter':
        return { status: 'incomplete', reason: 'content_filter' };
      default:
        return { status: 'completed' };
    }
  }

  private finalize() {
    if (this.finalized) return;

    if (!this.responseCreated) {
      this.pushEvent('response.created', { id: this.messageId || `response_${Date.now()}` });
      this.pushEvent('response.in_progress', { id: this.messageId || `response_${Date.now()}` });
      this.responseCreated = true;
    }

    for (const [, call] of this.toolCalls) {
      if (this.completedToolCallIds.has(call.id)) continue;
      this.pushEvent('response.function_call_arguments.done', {
        call_id: call.id,
        item_id: call.id,
        name: call.name,
        arguments: call.arguments || '{}',
      });
      this.completedToolCallIds.add(call.id);
    }

    // 发送 response.completed 或 response.incomplete
    if (this.stopReason === 'incomplete') {
      this.pushEvent('response.incomplete', {
        incomplete_details: { reason: this.incompleteReason },
      });
    } else {
      this.pushEvent('response.completed', {});
    }

    // 发送 usage（如果有）
    if (this.usage) {
      this.pushEvent('response.usage', {
        input_tokens: this.usage.input_tokens,
        output_tokens: this.usage.output_tokens,
        total_tokens: this.usage.total_tokens,
      });
    }

    this.finalized = true;
  }
}

/**
 * 将 Gemini SSE 流式事件转换为 Responses API 格式
 * 当源是 gemini/gemini-chat，目标是 codex 时使用
 */
export class GeminiToResponsesEventTransform extends Transform {
  private responseId: string | null = null;
  private responseCreated = false;
  private stopReason: string = 'completed';
  private incompleteReason: string = 'max_tokens';
  private usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null = null;
  private finalized = false;
  private errorEmitted = false;

  constructor(options?: { model?: string }) {
    super({ objectMode: true });
    void options;

    this.on('error', (err) => {
      console.error('[GeminiToResponsesEventTransform] Stream error:', err);
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
      if (!this.responseId) {
        this.responseId = `response_${Date.now()}`;
      }

      // 处理 usage
      if (usageMetadata) {
        this.usage = {
          input_tokens: usageMetadata.promptTokenCount || 0,
          output_tokens: usageMetadata.candidatesTokenCount || 0,
          total_tokens: (usageMetadata.promptTokenCount || 0) + (usageMetadata.candidatesTokenCount || 0),
        };
      }

      // 处理 candidates
      for (const candidate of candidates) {
        // 处理 finishReason
        if (candidate.finishReason) {
          const mapped = this.mapGeminiFinishReasonToResponses(candidate.finishReason);
          this.stopReason = mapped.status;
          if (mapped.reason) {
            this.incompleteReason = mapped.reason;
          }
        }

        if (!candidate.content || !Array.isArray(candidate.content.parts)) {
          continue;
        }

        // 确保响应已创建
        if (!this.responseCreated) {
          this.pushEvent('response.created', { id: this.responseId });
          this.pushEvent('response.in_progress', { id: this.responseId });
          this.responseCreated = true;
        }

        // 处理 parts
        for (const part of candidate.content.parts) {
          // 处理文本 -> output_text.delta
          if (part.text && typeof part.text === 'string') {
            this.pushEvent('response.output_text.delta', { delta: part.text });
          }

          // 处理 functionCall -> function_call.start 和 function_call_arguments.delta
          if (part.functionCall) {
            const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
            const name = part.functionCall.name || 'tool';
            const args = part.functionCall.args || {};
            const argsJson = JSON.stringify(args);

            // Gemini 通常一次返回完整参数，这里同时发 delta/done，兼容严格与宽松客户端
            this.pushEvent('response.function_call_arguments.delta', {
              call_id: callId,
              item_id: callId,
              delta: argsJson,
            });
            this.pushEvent('response.function_call_arguments.done', {
              call_id: callId,
              item_id: callId,
              name: name,
              arguments: argsJson,
            });
          }

          // 处理 inlineData (图像输出，罕见)
          if (part.inlineData) {
            // Responses 输出流以文本/工具调用为主，图像输出块在此忽略
          }
        }
      }

      callback();
    } catch (error) {
      console.error('[GeminiToResponsesEventTransform] Error in _transform:', error);
      callback();
    }
  }

  _flush(callback: (error?: Error | null) => void) {
    try {
      this.finalize();
      callback();
    } catch (error) {
      console.error('[GeminiToResponsesEventTransform] Error in _flush:', error);
      callback();
    }
  }

  private pushEvent(eventType: string, data: any) {
    this.push({ event: eventType, data });
  }

  private mapGeminiFinishReasonToResponses(finishReason: string): { status: 'completed' | 'incomplete'; reason?: string } {
    switch (finishReason) {
      case 'STOP':
        return { status: 'completed' };
      case 'MAX_TOKENS':
        return { status: 'incomplete', reason: 'max_tokens' };
      case 'SAFETY':
      case 'RECITATION':
        return { status: 'incomplete', reason: 'content_filter' };
      case 'MALFORMED_FUNCTION_CALL':
        return { status: 'completed' };
      default:
        return { status: 'completed' };
    }
  }

  private finalize() {
    if (this.finalized) return;

    // 发送 response.created 和 response.in_progress（如果还没有）
    if (!this.responseCreated) {
      const id = this.responseId || `response_${Date.now()}`;
      this.pushEvent('response.created', { id });
      this.pushEvent('response.in_progress', { id });
      this.responseCreated = true;
    }

    // 发送 response.completed 或 response.incomplete
    if (this.stopReason === 'incomplete') {
      this.pushEvent('response.incomplete', {
        incomplete_details: { reason: this.incompleteReason },
      });
    } else {
      this.pushEvent('response.completed', {});
    }

    // 发送 usage（如果有）
    if (this.usage) {
      this.pushEvent('response.usage', {
        input_tokens: this.usage.input_tokens,
        output_tokens: this.usage.output_tokens,
        total_tokens: this.usage.total_tokens,
      });
    }

    this.finalized = true;
  }
}


// ======================= transform SSE for claude code =======================

/**
 * 将 Chat Completions SSE 流式事件转换为 Claude SSE 格式
 * 当源是 openai-chat，目标是 claude code 时使用
 */
export class ChatCompletionsToClaudeEventTransform extends Transform {
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
      console.error('[ChatCompletionsToClaudeEventTransform] Stream error:', err);
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

      // 处理 id 和 model
      if (chunk.id && !this.messageId) {
        this.messageId = chunk.id;
      }
      if (chunk.model && !this.model) {
        this.model = chunk.model;
      }

      // 处理 usage
      if (chunk.usage) {
        this.usage = {
          input_tokens: chunk.usage.prompt_tokens || 0,
          output_tokens: chunk.usage.completion_tokens || 0,
          cache_read_input_tokens: 0,
        };
      }

      // 处理 choices
      if (Array.isArray(chunk.choices)) {
        for (const choice of chunk.choices) {
          this.handleChoice(choice);
        }
      }

      callback();
    } catch (error) {
      console.error('[ChatCompletionsToClaudeEventTransform] Error in _transform:', error);
      callback();
    }
  }

  _flush(callback: (error?: Error | null) => void) {
    try {
      this.finalize();
      callback();
    } catch (error) {
      console.error('[ChatCompletionsToClaudeEventTransform] Error in _flush:', error);
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
    // 处理 finish_reason 映射
    // OpenAI: "stop" | "length" | "tool_calls" | "content_filter"
    // Claude: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "max_thinking_length"
    if (typeof choice?.finish_reason === 'string') {
      this.stopReason = this.mapOpenAIFinishReason(choice.finish_reason);
    }

    const delta = choice?.delta;
    if (!delta) return;

    // 处理文本内容
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

    // 处理 thinking 内容 (OpenAI 中的 reasoning)
    const thinkingText = typeof delta.reasoning?.content === 'string'
      ? delta.reasoning.content
      : (typeof delta.thinking?.content === 'string' ? delta.thinking.content : null);
    if (thinkingText) {
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
          thinking: thinkingText,
        },
      });
    }

    // 处理 tool_calls
    if (Array.isArray(delta.tool_calls)) {
      for (let i = 0; i < delta.tool_calls.length; i++) {
        const toolCall = delta.tool_calls[i];
        const toolIndex = typeof toolCall?.index === 'number' ? toolCall.index : i;
        const toolName = toolCall?.function?.name;

        // 发送工具调用开始
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

        // 发送工具参数增量
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

  private mapOpenAIFinishReason(finishReason: string): string {
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

    // 关闭 thinking 块
    if (this.thinkingBlockIndex !== null) {
      this.pushEvent('content_block_stop', {
        type: 'content_block_stop',
        index: this.thinkingBlockIndex,
      });
      this.thinkingBlockIndex = null;
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
 * 将 Responses API SSE 流式事件转换为 Claude SSE 格式
 * 当源是 openai-responses，目标是 claude code 时使用
 */
export class ResponsesToClaudeEventTransform extends Transform {
  private contentIndex = 0;
  private textBlockIndex: number | null = null;
  private thinkingBlockIndex: number | null = null;
  private toolCalls = new Map<string, { id: string; name: string; arguments: string }>();
  private toolCallIndexToBlockIndex = new Map<string, number>();
  private completedToolCallIds = new Set<string>();
  private hasMessageStart = false;
  private stopReason: string = 'end_turn';
  private usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } | null = null;
  private messageId: string | null = null;
  private model: string | null = null;
  private finalized = false;
  private errorEmitted = false;
  private responseId: string | null = null;

  constructor(options?: { model?: string }) {
    super({ objectMode: true });
    this.model = options?.model ?? null;

    this.on('error', (err) => {
      console.error('[ResponsesToClaudeEventTransform] Stream error:', err);
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

      const data = event.data;
      const eventType = event.event || data?.type;
      const responsePayload = data?.response && typeof data.response === 'object' ? data.response : undefined;

      if (!eventType) {
        callback();
        return;
      }

      // 处理响应事件类型（兼容 event 字段和 data.type 字段）
      if (eventType === 'response.created' || eventType === 'response.in_progress') {
        this.responseId = data?.id || responsePayload?.id || this.responseId;
      }

      if (eventType === 'response.output_text.delta' && typeof data?.delta === 'string') {
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
          delta: { type: 'text_delta', text: data.delta },
        });
      }

      if (eventType === 'response.reasoning_text.delta' && typeof data?.delta === 'string') {
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
          delta: { type: 'thinking_delta', thinking: data.delta },
        });
      }

      // 兼容标准 Responses：通过 output_item.added 建立函数调用块
      if (eventType === 'response.output_item.added' && data?.item?.type === 'function_call') {
        const itemId = data.item?.call_id || data.item?.id || data?.item_id;
        if (itemId) {
          this.ensureToolCallStarted(itemId, data.item?.name || 'tool', data.item?.arguments || '');
        }
      }

      if (eventType === 'response.function_call.start' && data) {
        const itemId = data.call_id || data.item_id;
        if (itemId) {
          this.ensureToolCallStarted(itemId, data.name || 'tool', data.arguments || '');
        }
      }

      if (eventType === 'response.function_call_arguments.delta' && data) {
        const itemId = data.call_id || data.item_id;
        if (itemId) {
          this.ensureToolCallStarted(itemId, data.name || 'tool', '');
          this.appendToolCallDelta(itemId, data.delta || '');
        }
      }

      if (eventType === 'response.function_call_arguments.done' && data) {
        const itemId = data.call_id || data.item_id;
        if (itemId) {
          this.ensureToolCallStarted(itemId, data.name || 'tool', '');
          if (typeof data.arguments === 'string') {
            const stored = this.toolCalls.get(itemId);
            if (stored && data.arguments.startsWith(stored.arguments)) {
              this.appendToolCallDelta(itemId, data.arguments.slice(stored.arguments.length));
            } else if (stored && stored.arguments !== data.arguments) {
              // 上游直接返回完整 arguments（非增量）时，补全为单次 delta
              this.appendToolCallDelta(itemId, data.arguments);
            }
          }
          this.closeToolCall(itemId);
        }
      }

      if (eventType === 'response.refusal.delta' && typeof data?.delta === 'string') {
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
          delta: { type: 'text_delta', text: data.delta },
        });
      }

      if (eventType === 'response.usage' && data) {
        this.usage = {
          input_tokens: data.input_tokens || 0,
          output_tokens: data.output_tokens || 0,
          cache_read_input_tokens: 0,
        };
      }

      if (eventType === 'response.completed' || eventType === 'response.failed' || eventType === 'response.incomplete') {
        const reason = data?.incomplete_details?.reason || responsePayload?.incomplete_details?.reason;
        if (eventType === 'response.incomplete' && reason === 'max_tokens') {
          this.stopReason = 'max_tokens';
        } else if (eventType === 'response.failed' || reason === 'content_filter') {
          this.stopReason = 'content_filter';
        } else {
          this.stopReason = 'end_turn';
        }

        if (responsePayload?.usage) {
          this.usage = convertOpenAIUsageToClaude(responsePayload.usage);
        }

        this.finalize();
      }

      callback();
    } catch (error) {
      console.error('[ResponsesToClaudeEventTransform] Error in _transform:', error);
      callback();
    }
  }

  _flush(callback: (error?: Error | null) => void) {
    try {
      this.finalize();
      callback();
    } catch (error) {
      console.error('[ResponsesToClaudeEventTransform] Error in _flush:', error);
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

  private ensureToolCallStarted(itemId: string, name: string, initialArguments: string) {
    if (this.toolCalls.has(itemId)) {
      return;
    }
    this.ensureMessageStart();
    const toolBlockIndex = this.assignContentBlockIndex();
    this.toolCalls.set(itemId, {
      id: itemId,
      name: name || 'tool',
      arguments: '',
    });
    this.toolCallIndexToBlockIndex.set(itemId, toolBlockIndex);
    this.pushEvent('content_block_start', {
      type: 'content_block_start',
      index: toolBlockIndex,
      content_block: {
        type: 'tool_use',
        id: itemId,
        name: name || 'tool',
      },
    });
    if (initialArguments) {
      this.appendToolCallDelta(itemId, initialArguments);
    }
  }

  private appendToolCallDelta(itemId: string, delta: string) {
    if (!delta) return;
    const stored = this.toolCalls.get(itemId);
    if (stored) {
      stored.arguments += delta;
    }
    const toolBlockIndex = this.toolCallIndexToBlockIndex.get(itemId);
    if (toolBlockIndex !== undefined) {
      this.pushEvent('content_block_delta', {
        type: 'content_block_delta',
        index: toolBlockIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: delta,
        },
      });
    }
  }

  private closeToolCall(itemId: string) {
    if (this.completedToolCallIds.has(itemId)) {
      return;
    }
    const toolBlockIndex = this.toolCallIndexToBlockIndex.get(itemId);
    if (toolBlockIndex !== undefined) {
      this.pushEvent('content_block_stop', {
        type: 'content_block_stop',
        index: toolBlockIndex,
      });
      this.completedToolCallIds.add(itemId);
    }
  }

  private finalize() {
    if (this.finalized) return;
    this.ensureMessageStart();

    // 关闭所有工具调用块
    for (const [itemId, toolBlockIndex] of this.toolCallIndexToBlockIndex.entries()) {
      if (this.completedToolCallIds.has(itemId)) continue;
      this.pushEvent('content_block_stop', {
        type: 'content_block_stop',
        index: toolBlockIndex,
      });
    }

    // 关闭 thinking 块
    if (this.thinkingBlockIndex !== null) {
      this.pushEvent('content_block_stop', {
        type: 'content_block_stop',
        index: this.thinkingBlockIndex,
      });
      this.thinkingBlockIndex = null;
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
 * 将 Gemini SSE 流式事件转换为 Claude SSE 格式
 * 当源是 gemini/gemini-chat，目标是 claude code 时使用
 */
export class GeminiToClaudeEventTransform extends Transform {
  private contentIndex = 0;
  private textBlockIndex: number | null = null;
  private toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  private toolCallIndexToBlockIndex = new Map<number, number>();
  private hasMessageStart = false;
  private stopReason: string = 'end_turn';
  private usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } | null = null;
  private messageId: string | null = null;
  private model: string | null = null;
  private finalized = false;
  private errorEmitted = false;
  private toolCallCounter = 0;

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
      for (const candidate of candidates) {
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
            const toolIndex = this.toolCallCounter++;
            const toolBlockIndex = this.assignContentBlockIndex();
            this.toolCalls.set(toolIndex, {
              id: `tool_${toolIndex}_${Date.now()}`,
              name: part.functionCall.name || 'tool',
              arguments: JSON.stringify(part.functionCall.args || {}),
            });
            this.toolCallIndexToBlockIndex.set(toolIndex, toolBlockIndex);

            this.pushEvent('content_block_start', {
              type: 'content_block_start',
              index: toolBlockIndex,
              content_block: {
                type: 'tool_use',
                id: this.toolCalls.get(toolIndex)!.id,
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
