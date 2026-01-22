import { Transform } from 'stream';

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
 * ChunkCollectorTransform - 收集stream chunks用于日志记录
 * 这个Transform会记录所有经过它的数据块,同时将数据原封不动地传递给下一个stream
 */
export class ChunkCollectorTransform extends Transform {
  private chunks: string[] = [];

  constructor() {
    super();
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    // 收集chunk数据
    this.chunks.push(chunk.toString('utf8'));

    // 将chunk传递给下一个stream
    this.push(chunk);

    callback();
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

  constructor() {
    super();
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.buffer += chunk.toString('utf8');
    this.processBuffer();
    // 将chunk传递给下一个stream
    this.push(chunk);
    callback();
  }

  _flush(callback: (error?: Error | null) => void) {
    // 处理剩余的buffer
    if (this.buffer.trim()) {
      this.processBuffer();
    }
    // 刷新最后一个事件
    this.flushEvent();
    callback();
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

    const raw = this.currentEvent.rawLines.join('\n');
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
   * 从events中提取usage信息
   */
  extractUsage(): { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | null {
    for (const event of this.events) {
      if (!event.data) continue;

      try {
        const data = JSON.parse(event.data);

        // 尝试从不同的位置提取usage
        // 1. message_delta事件中的usage
        if (event.event === 'message_delta' && data.usage) {
          return data.usage;
        }

        // 2. 直接在data中的usage
        if (data.usage) {
          return data.usage;
        }

        // 3. OpenAI格式: choices数组中最后一个元素的usage
        if (Array.isArray(data.choices) && data.choices.length > 0) {
          const lastChoice = data.choices[data.choices.length - 1];
          if (lastChoice?.usage) {
            return lastChoice.usage;
          }
        }

        // 4. 直接在顶级的usage字段
        if (data.input_tokens !== undefined || data.output_tokens !== undefined ||
            data.prompt_tokens !== undefined || data.completion_tokens !== undefined) {
          return data;
        }
      } catch {
        // JSON解析失败,跳过
      }
    }

    return null;
  }
}
