import { Transform } from 'stream';

/**
 * StreamTimingTransform - 流式打点 Transform（服务性能统计专用）
 *
 * 透传所有数据（对象模式 / Buffer / string 均可），仅记录：
 *   - firstEventAt：首个被解析出的 SSE 事件流经本 Transform 的时刻（≈ 首 Token 返回时刻）
 *   - lastEventAt：最后一个事件流经的时刻（≈ 整个返回结束时刻）
 *
 * 由调用方在转发开始前注入 startTime（请求发起时刻），即可派生：
 *   - ttftMs       = firstEventAt - startTime
 *   - generationMs = lastEventAt - firstEventAt
 *
 * 该 Transform 仅做时间记录，不修改任何数据内容，对转发链路零影响。
 */
export class StreamTimingTransform extends Transform {
  /** 请求发起时刻（由外部注入） */
  readonly startTime: number;
  /** 首个事件到达时刻（未收到则为 0） */
  firstEventAt = 0;
  /** 最后一个事件到达时刻 */
  lastEventAt = 0;

  constructor(startTime: number) {
    super({ writableObjectMode: true, readableObjectMode: true });
    this.startTime = startTime;
  }

  _transform(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    try {
      const now = Date.now();
      if (this.firstEventAt === 0) {
        this.firstEventAt = now;
      }
      this.lastEventAt = now;
      this.push(chunk);
    } catch (error) {
      console.error('[StreamTimingTransform] Error in _transform:', error);
    }
    callback();
  }

  /** 是否采集到至少一个事件（用于判定精确口径可用性） */
  hasTiming(): boolean {
    return this.firstEventAt > 0 && this.lastEventAt > 0;
  }
}
