import { Transform } from 'stream';

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
