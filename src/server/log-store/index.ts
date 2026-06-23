/**
 * LogStore 模块入口
 *
 * 追加写 NDJSON 日志存储，替代 fs-database 中「分片 JSON 数组 read-modify-write」模式。
 * 主库（global）与 AccessKey（key:{keyId}）共用同一存储引擎。
 */
import path from 'path';
export { LogStore } from './log-store';
export type {
  Namespace,
  ShardMeta,
  SessionRef,
  LogStoreQueryOpts,
  AppendResult,
  DeleteByIdsResult,
} from './types';

import { LogStore } from './log-store';

/** 工厂：以 {dataPath}/log-store 为根目录创建单例 */
export function createLogStore(dataPath: string): LogStore {
  return new LogStore(path.join(dataPath, 'log-store'));
}

