/**
 * Key 级日志管理器
 * 每个 AccessKey 有独立的日志空间，完全与现有日志系统隔离
 */
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import type { AccessKeyRequestLog, RequestLog } from '../../types';

interface LogShardIndex {
  filename: string;
  date: string;
  startTime: number;
  endTime: number;
  count: number;
}

export class KeyLogger {
  private dataPath: string;
  private readonly MAX_SHARD_SIZE = 10 * 1024 * 1024; // 10MB
  private readonly LOG_RETENTION_DAYS = 30;
  /** 分片索引缓存 keyId → LogShardIndex[] */
  private shardIndexCache: Map<string, LogShardIndex[]> = new Map();
  /** 分片写入锁 */
  private shardWriteLocks: Map<string, Promise<void>> = new Map();

  constructor(dataPath: string) {
    this.dataPath = dataPath;
  }

  /** 初始化 */
  async initialize(): Promise<void> {
    const logsDir = path.join(this.dataPath, 'key-logs');
    await fs.mkdir(logsDir, { recursive: true });
  }

  /** 写入一条日志 */
  async addLog(keyId: string, keyName: string, logData: Omit<RequestLog, 'id'>): Promise<void> {
    const log: AccessKeyRequestLog = {
      ...logData,
      id: crypto.randomUUID(),
      keyId,
      keyName,
    };

    const keyDir = this.getKeyLogDir(keyId);
    await fs.mkdir(keyDir, { recursive: true });

    const index = await this.getShardIndex(keyId);
    const now = new Date();
    const dateStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;

    // 找到或创建当前分片
    let targetShard: LogShardIndex | null = null;
    for (const shard of index) {
      if (shard.date === dateStr && shard.count < 1000) {
        // 检查文件大小
        try {
          const stat = await fs.stat(path.join(keyDir, shard.filename));
          if (stat.size < this.MAX_SHARD_SIZE) {
            targetShard = shard;
            break;
          }
        } catch {
          targetShard = shard;
          break;
        }
      }
    }

    if (!targetShard) {
      // 创建新分片
      const seq = index.filter(s => s.date === dateStr).length + 1;
      targetShard = {
        filename: seq === 1 ? `logs-${dateStr}.json` : `logs-${dateStr}-${String(seq).padStart(3, '0')}.json`,
        date: dateStr,
        startTime: Date.now(),
        endTime: Date.now(),
        count: 0,
      };
      index.push(targetShard);
    }

    // 写入日志（带锁）
    await this.writeToShard(keyId, targetShard, log);

    // 更新索引
    targetShard.count += 1;
    targetShard.endTime = Date.now();
    await this.saveShardIndex(keyId, index);
  }

  /** 获取 Key 的日志列表（分页 + 过滤） */
  async getLogs(keyId: string, options: { page: number; pageSize: number; startDate?: string; endDate?: string; contentType?: string; search?: string }): Promise<{ data: AccessKeyRequestLog[]; total: number }> {
    const index = await this.getShardIndex(keyId);
    let filteredShards = index;

    if (options.startDate) {
      filteredShards = filteredShards.filter(s => s.date >= options.startDate!);
    }
    if (options.endDate) {
      filteredShards = filteredShards.filter(s => s.date <= options.endDate!);
    }

    const needsFilter = !!(options.contentType || options.search);
    const searchLower = options.search?.toLowerCase();

    // 计算分页偏移
    const offset = (options.page - 1) * options.pageSize;
    const limit = options.pageSize;

    // 如果不需要细粒度过滤，使用快速分片级分页
    if (!needsFilter) {
      const total = filteredShards.reduce((sum, s) => sum + s.count, 0);
      const allLogs: AccessKeyRequestLog[] = [];
      let skipped = 0;
      let collected = 0;

      for (let i = filteredShards.length - 1; i >= 0 && collected < limit; i++) {
        const shard = filteredShards[i];
        const logs = await this.readShardFile(keyId, shard.filename);
        const reversed = logs.reverse();

        for (const log of reversed) {
          if (skipped < offset) { skipped++; continue; }
          allLogs.push(log);
          collected++;
          if (collected >= limit) break;
        }
      }

      return { data: allLogs, total };
    }

    // 需要细粒度过滤：先收集所有匹配日志，再分页
    const matchedLogs: AccessKeyRequestLog[] = [];
    for (let i = filteredShards.length - 1; i >= 0; i--) {
      const shard = filteredShards[i];
      const logs = await this.readShardFile(keyId, shard.filename);
      const reversed = logs.reverse();

      for (const log of reversed) {
        // 类型过滤
        if (options.contentType && log.contentType !== options.contentType) continue;
        // 搜索过滤（匹配路径、模型）
        if (searchLower) {
          const path = (log.path || '').toLowerCase();
          const model = (log.requestModel || log.targetModel || '').toLowerCase();
          const error = (log.error || '').toLowerCase();
          if (!path.includes(searchLower) && !model.includes(searchLower) && !error.includes(searchLower)) continue;
        }
        matchedLogs.push(log);
      }
    }

    const total = matchedLogs.length;
    const data = matchedLogs.slice(offset, offset + limit);
    return { data, total };
  }

  /** 清理过期日志 */
  async cleanupOldLogs(): Promise<void> {
    const logsDir = path.join(this.dataPath, 'key-logs');
    let keyDirs: string[];
    try {
      keyDirs = await fs.readdir(logsDir);
    } catch {
      return;
    }

    const cutoffTime = Date.now() - this.LOG_RETENTION_DAYS * 24 * 3600 * 1000;

    for (const keyId of keyDirs) {
      const keyDir = path.join(logsDir, keyId);
      const stat = await fs.stat(keyDir);
      if (!stat.isDirectory()) continue;

      const index = await this.getShardIndex(keyId);
      let changed = false;

      for (let i = index.length - 1; i >= 0; i--) {
        if (index[i].endTime < cutoffTime) {
          // 删除过期分片文件
          try {
            await fs.unlink(path.join(keyDir, index[i].filename));
          } catch { /* ignore */ }
          index.splice(i, 1);
          changed = true;
        }
      }

      if (changed) {
        await this.saveShardIndex(keyId, index);
      }
    }
  }

  /** 获取 Key 的日志总数 */
  async getLogsCount(keyId: string): Promise<number> {
    const index = await this.getShardIndex(keyId);
    return index.reduce((sum, s) => sum + s.count, 0);
  }

  /** 按 sessionId 过滤日志（用于密钥会话的日志查询） */
  async getLogsBySessionId(keyId: string, sessionId: string, limit: number = 10000): Promise<AccessKeyRequestLog[]> {
    const index = await this.getShardIndex(keyId);
    const allLogs: AccessKeyRequestLog[] = [];

    // 从最新的分片开始扫描
    for (let i = index.length - 1; i >= 0 && allLogs.length < limit; i--) {
      const shard = index[i];
      const logs = await this.readShardFile(keyId, shard.filename);

      for (let j = logs.length - 1; j >= 0 && allLogs.length < limit; j--) {
        if (this.logBelongsToSession(logs[j], sessionId)) {
          allLogs.push(logs[j]);
        }
      }
    }

    // 按时间正序排列（用于对话视图）
    return allLogs.sort((a, b) => a.timestamp - b.timestamp);
  }

  /** 判断日志是否属于指定会话 */
  private logBelongsToSession(log: AccessKeyRequestLog, sessionId: string): boolean {
    // Codex: 检查 headers 中的 session-id
    const headers = log.headers as Record<string, string | string[] | undefined> | undefined;
    if (headers) {
      const sid = headers['session-id'] || headers['session_id'];
      if (typeof sid === 'string' && sid === sessionId) return true;
      if (Array.isArray(sid) && sid[0] === sessionId) return true;
    }

    // Claude Code: 检查 body.metadata.user_id
    if (log.body) {
      try {
        const body = typeof log.body === 'string' ? JSON.parse(log.body) : log.body;
        const rawUserId = body?.metadata?.user_id;
        if (rawUserId) {
          // 复用 ProxyServer 的 session ID 提取逻辑
          let extractedId: string | null = null;
          try {
            const parsed = JSON.parse(rawUserId);
            if (parsed && typeof parsed === 'object' && parsed.session_id) {
              extractedId = parsed.session_id;
            }
          } catch {
            extractedId = rawUserId;
          }
          if (extractedId === sessionId) return true;
        }
      } catch { /* ignore */ }
    }

    return false;
  }

  // ---- helpers ----

  private getKeyLogDir(keyId: string): string {
    return path.join(this.dataPath, 'key-logs', keyId);
  }

  private getShardIndexPath(keyId: string): string {
    return path.join(this.getKeyLogDir(keyId), 'logs-index.json');
  }

  private async getShardIndex(keyId: string): Promise<LogShardIndex[]> {
    if (this.shardIndexCache.has(keyId)) {
      return this.shardIndexCache.get(keyId)!;
    }

    try {
      const data = await fs.readFile(this.getShardIndexPath(keyId), 'utf-8');
      const parsed = JSON.parse(data);
      // 防御性过滤：确保返回有效数组，剔除 null/undefined 或缺少 filename 的条目
      const index: LogShardIndex[] = Array.isArray(parsed)
        ? parsed.filter((s: unknown) => s != null && typeof s === 'object' && 'filename' in (s as Record<string, unknown>))
        : [];
      this.shardIndexCache.set(keyId, index);
      return index;
    } catch {
      const index: LogShardIndex[] = [];
      this.shardIndexCache.set(keyId, index);
      return index;
    }
  }

  private async saveShardIndex(keyId: string, index: LogShardIndex[]): Promise<void> {
    this.shardIndexCache.set(keyId, index);
    const filePath = this.getShardIndexPath(keyId);
    const tmpPath = filePath + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(index, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  }

  private async writeToShard(keyId: string, shard: LogShardIndex, log: AccessKeyRequestLog): Promise<void> {
    const lockKey = `${keyId}:${shard.filename}`;

    // 等待现有写入完成
    while (this.shardWriteLocks.has(lockKey)) {
      await this.shardWriteLocks.get(lockKey);
    }

    const writePromise = (async () => {
      try {
        const keyDir = this.getKeyLogDir(keyId);
        const shardPath = path.join(keyDir, shard.filename);

        let logs: AccessKeyRequestLog[] = [];
        try {
          const data = await fs.readFile(shardPath, 'utf-8');
          logs = JSON.parse(data);
        } catch {
          // 新文件
        }

        logs.push(log);

        const tmpPath = shardPath + '.tmp';
        await fs.writeFile(tmpPath, JSON.stringify(logs), 'utf-8');
        await fs.rename(tmpPath, shardPath);
      } finally {
        this.shardWriteLocks.delete(lockKey);
      }
    })();

    this.shardWriteLocks.set(lockKey, writePromise);
    await writePromise;
  }

  private async readShardFile(keyId: string, filename: string): Promise<AccessKeyRequestLog[]> {
    const shardPath = path.join(this.getKeyLogDir(keyId), filename);
    try {
      const data = await fs.readFile(shardPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }
}
