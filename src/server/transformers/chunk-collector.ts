import { Transform } from 'stream';
import { StringDecoder } from 'string_decoder';

/**
 * SSEEvent - 表示一个完整的SSE事件
 */
export interface SSEEvent {
  event?: string;
  id?: string;
  data?: string;
  raw: string; // 原始字符串
}

/**
 * 检测是否是客户端断开相关的错误（这些错误是正常的，不应记录为错误）
 */
function isClientDisconnectError(error: any): boolean {
  const code = error?.code;
  const name = error?.name;
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  return (
    code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    code === 'ERR_STREAM_UNABLE_TO_PIPE' ||
    code === 'ERR_STREAM_DESTROYED' ||
    code === 'ERR_CANCELED' ||
    name === 'CanceledError' ||
    message.includes('premature close') ||
    message.includes('canceled')
  );
}

/**
 * ChunkCollectorTransform - 收集stream chunks用于日志记录
 * 这个Transform会记录所有经过它的数据块,同时将数据原封不动地传递给下一个stream
 */
export class ChunkCollectorTransform extends Transform {
  private chunks: string[] = [];
  private errorEmitted = false;
  private stringDecoder = new StringDecoder('utf8');
  private lastRefreshTime = 0;
  private refreshCallback?: () => void;
  private readonly REFRESH_INTERVAL = 5000; // 每5秒最多刷新一次

  constructor(refreshCallback?: () => void) {
    super({ writableObjectMode: true, readableObjectMode: true });
    this.refreshCallback = refreshCallback;

    this.on('error', (err) => {
      if (isClientDisconnectError(err)) {
        console.warn('[ChunkCollectorTransform] Stream closed (client disconnected)');
      } else {
        console.error('[ChunkCollectorTransform] Stream error:', err);
      }
      this.errorEmitted = true;
    });
  }

  _transform(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.errorEmitted) {
      callback();
      return;
    }

    try {
      // 收集chunk数据 - 支持对象和Buffer/string
      if (typeof chunk === 'object' && chunk !== null && !Buffer.isBuffer(chunk)) {
        this.chunks.push(JSON.stringify(chunk));
      } else {
        // 使用 StringDecoder 正确处理多字节字符边界，避免中文乱码
        this.chunks.push(this.stringDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      }

      // 将chunk传递给下一个stream
      this.push(chunk);

      // 节流刷新规则使用状态（仅在有数据流过时触发）
      if (this.refreshCallback) {
        const now = Date.now();
        if (now - this.lastRefreshTime >= this.REFRESH_INTERVAL) {
          this.lastRefreshTime = now;
          this.refreshCallback();
        }
      }

      callback();
    } catch (error) {
      console.error('[ChunkCollectorTransform] Error in _transform:', error);
      callback();
    }
  }

  _flush(callback: (error?: Error | null) => void) {
    try {
      // 处理 StringDecoder 中剩余的字节
      const remaining = this.stringDecoder.end();
      if (remaining) {
        this.chunks.push(remaining);
      }
      callback();
    } catch (error) {
      console.error('[ChunkCollectorTransform] Error in _flush:', error);
      callback();
    }
  }

  /**
   * 获取收集的所有chunks
   */
  getChunks(): string[] {
    return this.chunks;
  }

  /**
   * 清空已收集的chunks
   */
  clearChunks(): void {
    this.chunks = [];
  }
}

/**
 * SSEEventCollectorTransform - 智能收集完整的SSE事件
 * 这个Transform会解析SSE流并将每个完整的事件存储为一个单独的entry
 * 确保每个chunk代表一条完整的消息,而不是随机的buffer片段
 */
export class SSEEventCollectorTransform extends Transform {
  private buffer = '';
  private currentEvent: { event?: string; id?: string; dataLines: string[]; rawLines: string[] } = {
    dataLines: [],
    rawLines: []
  };
  private events: SSEEvent[] = [];
  private errorEmitted = false;
  private stringDecoder = new StringDecoder('utf8');

  constructor() {
    super({ writableObjectMode: true, readableObjectMode: true });

    this.on('error', (err) => {
      if (isClientDisconnectError(err)) {
        console.warn('[SSEEventCollectorTransform] Stream closed (client disconnected)');
      } else {
        console.error('[SSEEventCollectorTransform] Stream error:', err);
      }
      this.errorEmitted = true;
    });
  }

  _transform(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.errorEmitted) {
      callback();
      return;
    }

    try {
      // 如果是对象（来自 SSEParserTransform 或上游转换器），先转换为字符串格式进行处理
      if (typeof chunk === 'object' && chunk !== null) {
        const sseEvent = chunk as { event?: string; id?: string; data?: any };
        const lines: string[] = [];
        if (sseEvent.event) lines.push(`event: ${sseEvent.event}`);
        if (sseEvent.id) lines.push(`id: ${sseEvent.id}`);
        if (sseEvent.data !== undefined) {
          if (typeof sseEvent.data === 'string') {
            lines.push(`data: ${sseEvent.data}`);
          } else {
            lines.push(`data: ${JSON.stringify(sseEvent.data)}`);
          }
        }
        if (lines.length > 0) {
          this.currentEvent.rawLines.push(...lines);
          if (sseEvent.event) this.currentEvent.event = sseEvent.event;
          if (sseEvent.id) this.currentEvent.id = sseEvent.id;
          if (sseEvent.data !== undefined) {
            const dataStr = typeof sseEvent.data === 'string' ? sseEvent.data : JSON.stringify(sseEvent.data);
            this.currentEvent.dataLines.push(dataStr);
          }
          this.flushEvent();
        }
        // 对象模式下保持原样透传，避免影响后续转换器读取 event/data 字段
        this.push(chunk);
      } else {
        // Buffer/string 模式 - 使用 StringDecoder 正确处理多字节字符边界
        this.buffer += this.stringDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        this.processBuffer();
        // 将chunk传递给下一个stream
        this.push(chunk);
      }
      callback();
    } catch (error) {
      console.error('[SSEEventCollectorTransform] Error in _transform:', error);
      callback();
    }
  }

  _flush(callback: (error?: Error | null) => void) {
    try {
      // 处理 StringDecoder 中剩余的字节
      const remaining = this.stringDecoder.end();
      if (remaining) {
        this.buffer += remaining;
      }
      // 处理剩余的buffer
      if (this.buffer.trim()) {
        this.processBuffer();
      }
      // 刷新最后一个事件
      this.flushEvent();
      // 不调用 this.end()，让 Node.js 自动管理流的生命周期
      callback();
    } catch (error) {
      console.error('[SSEEventCollectorTransform] Error in _flush:', error);
      callback();
    }
  }

  private processBuffer() {
    const lines = this.buffer.split('\n');
    // 保留最后一行(可能不完整)
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      this.processLine(line);
    }
  }

  private processLine(line: string) {
    // 记录原始行
    this.currentEvent.rawLines.push(line);

    // 空行表示一个事件结束
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
      this.currentEvent.dataLines.push(line.slice(5).trim());
      return;
    }
  }

  private flushEvent() {
    // 只有当有内容时才创建事件
    if (!this.currentEvent.event && this.currentEvent.dataLines.length === 0 && !this.currentEvent.id) {
      this.currentEvent = { dataLines: [], rawLines: [] };
      return;
    }

    // SSE格式要求事件以空行结束，所以添加一个空行
    const raw = this.currentEvent.rawLines.join('\n') + '\n';
    const event: SSEEvent = {
      event: this.currentEvent.event,
      id: this.currentEvent.id,
      data: this.currentEvent.dataLines.length > 0 ? this.currentEvent.dataLines.join('\n') : undefined,
      raw
    };

    this.events.push(event);
    this.currentEvent = { dataLines: [], rawLines: [] };
  }

  /**
   * 获取收集的所有SSE事件
   * 每个事件都是一个完整的SSE消息
   */
  getEvents(): SSEEvent[] {
    return this.events;
  }

  /**
   * 获取原始chunks(兼容旧接口)
   */
  getChunks(): string[] {
    return this.events.map(e => e.raw);
  }

  /**
   * 清空已收集的事件
   */
  clearEvents(): void {
    this.events = [];
  }

  /**
   * 从events中提取usage信息。
   *
   * 关键：必须遍历**全部**事件并合并，而不是命中第一个就返回——
   * Anthropic 流式把用量拆在两个事件里：`message_start.message.usage` 带 input_tokens，
   * `message_delta.usage` 带（累计的）output_tokens。旧实现命中 message_delta 即返回，
   * 导致 input_tokens 永远丢失。同时统一 OpenAI(prompt_tokens/completion_tokens) 与
   * Gemini(usageMetadata) 的字段命名，返回归一化的 {input_tokens, output_tokens, total_tokens, cache_read_input_tokens}。
   */
  extractUsage(): { input_tokens?: number; output_tokens?: number; total_tokens?: number; cache_read_input_tokens?: number } | null {
    let input_tokens: number | undefined;
    let output_tokens: number | undefined;
    let total_tokens: number | undefined;
    let cache_read_input_tokens: number | undefined;

    for (const event of this.events) {
      if (!event.data) continue;
      let data: any;
      try {
        data = JSON.parse(event.data);
      } catch {
        continue;
      }

      // Anthropic: message_start 携带 input（在 message.usage 下）
      const msgUsage = data?.message?.usage;
      if (msgUsage) {
        if (typeof msgUsage.input_tokens === 'number') input_tokens = msgUsage.input_tokens;
        if (typeof msgUsage.cache_read_input_tokens === 'number') cache_read_input_tokens = msgUsage.cache_read_input_tokens;
      }

      // 通用 usage 对象（Anthropic message_delta.usage / OpenAI usage）
      const usage = data?.usage;
      if (usage) {
        if (typeof usage.input_tokens === 'number') input_tokens = usage.input_tokens;
        if (typeof usage.output_tokens === 'number') output_tokens = usage.output_tokens; // message_delta 累计值，取最后一次
        if (typeof usage.cache_read_input_tokens === 'number') cache_read_input_tokens = usage.cache_read_input_tokens;
        if (typeof usage.prompt_tokens === 'number') input_tokens = usage.prompt_tokens;
        if (typeof usage.completion_tokens === 'number') output_tokens = usage.completion_tokens;
        if (typeof usage.total_tokens === 'number') total_tokens = usage.total_tokens;
        if (typeof usage.cached_tokens === 'number') cache_read_input_tokens = usage.cached_tokens;
      }

      // OpenAI: choices[].usage（部分上游把 usage 放在最后一个 choice 上）
      if (Array.isArray(data?.choices) && data.choices.length > 0) {
        const lastChoice = data.choices[data.choices.length - 1];
        const cu = lastChoice?.usage;
        if (cu) {
          if (typeof cu.prompt_tokens === 'number') input_tokens = cu.prompt_tokens;
          if (typeof cu.completion_tokens === 'number') output_tokens = cu.completion_tokens;
          if (typeof cu.total_tokens === 'number') total_tokens = cu.total_tokens;
        }
      }

      // Gemini: usageMetadata
      const um = data?.usageMetadata;
      if (um) {
        if (typeof um.promptTokenCount === 'number') input_tokens = um.promptTokenCount;
        if (typeof um.candidatesTokenCount === 'number') output_tokens = um.candidatesTokenCount;
        if (typeof um.totalTokenCount === 'number') total_tokens = um.totalTokenCount;
        if (typeof um.cachedContentTokenCount === 'number') cache_read_input_tokens = um.cachedContentTokenCount;
      }

      // 顶级裸字段兜底
      if (typeof data?.input_tokens === 'number') input_tokens = data.input_tokens;
      if (typeof data?.output_tokens === 'number') output_tokens = data.output_tokens;
      if (typeof data?.prompt_tokens === 'number') input_tokens = data.prompt_tokens;
      if (typeof data?.completion_tokens === 'number') output_tokens = data.completion_tokens;
      if (typeof data?.total_tokens === 'number') total_tokens = data.total_tokens;
    }

    if (input_tokens === undefined && output_tokens === undefined && total_tokens === undefined) {
      return null;
    }
    const result: { input_tokens?: number; output_tokens?: number; total_tokens?: number; cache_read_input_tokens?: number } = {};
    if (input_tokens !== undefined) result.input_tokens = input_tokens;
    if (output_tokens !== undefined) result.output_tokens = output_tokens;
    if (total_tokens !== undefined) {
      result.total_tokens = total_tokens;
    } else if (input_tokens !== undefined && output_tokens !== undefined) {
      result.total_tokens = input_tokens + output_tokens;
    }
    if (cache_read_input_tokens !== undefined) result.cache_read_input_tokens = cache_read_input_tokens;
    return result;
  }
}
