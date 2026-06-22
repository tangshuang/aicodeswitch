/**
 * LogStore 类型定义
 *
 * LogStore 以「追加写 NDJSON + 字节偏移索引」存储请求日志：
 * - 写入 O(单条)：只 append 一行，不解析已有数据。
 * - 查询流式：按行读取，内存只持单行 + 结果页。
 * - 会话索引用字节偏移定位（追加写下偏移永远稳定），按会话取日志 = 按字节范围随机读。
 */
import type { RequestLog } from '../../types';

/**
 * 命名空间：
 * - 'global'：主库（普通路由）日志
 * - 'key:{keyId}'：AccessKey 每密钥独立日志
 */
export type Namespace = 'global' | `key:${string}`;

/** 分片（文件）元信息 */
export interface ShardMeta {
  /** 文件名（相对 namespace 目录），如 "2026-06-22.ndjson" / "2026-06-22.1.ndjson" */
  filename: string;
  /** 日期 YYYY-MM-DD（UTC） */
  date: string;
  /** 分片内最早日志时间戳 */
  startTime: number;
  /** 分片内最晚日志时间戳 */
  endTime: number;
  /** 已写入日志条数 */
  count: number;
  /** 当前文件字节数 */
  size: number;
}

/**
 * 会话→日志 的单条引用。追加写下 {file, offset, length} 永远稳定，
 * 无需像「数组下标」那样在分片重写时修正。
 */
export interface SessionRef {
  /** 文件名（namespace 内） */
  file: string;
  /** 行起始字节偏移 */
  offset: number;
  /** 行字节长度（不含结尾 \n） */
  length: number;
  /** 日志时间戳 */
  timestamp: number;
  /** 日志 id（UUID），用于 tombstone 过滤与精确删除 */
  logId: string;
}

export interface LogStoreQueryOpts {
  limit?: number;
  offset?: number;
  since?: number;
}

/** append 返回的定位信息，供调用方记录 */
export interface AppendResult {
  id: string;
  namespace: Namespace;
  file: string;
  offset: number;
  length: number;
}

/** 按 id 数组删除日志（tombstone）。返回实际加入 tombstone 的 id 数。 */
export interface DeleteByIdsResult {
  deleted: number;
}

export type { RequestLog };
