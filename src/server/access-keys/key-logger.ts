/**
 * Key 级日志管理器
 * 每个 AccessKey 有独立的日志空间（namespace = key:{keyId}），与主库日志隔离。
 *
 * 重构后：底层存取委托给共享 LogStore（追加写 NDJSON + 字节偏移索引），
 * 不再维护独立的分片 JSON / 索引 / 写锁 —— 顺带补齐了 session 倒排、定时清理、
 * 统一日期格式与紧凑序列化。
 */
import type { AccessKeyRequestLog, RequestLog } from '../../types';
import type { LogStore, Namespace } from '../log-store';

const LOG_RETENTION_DAYS = 30;

export class KeyLogger {
  private logStore: LogStore;

  constructor(_dataPath: string, logStore: LogStore) {
    this.logStore = logStore;
  }

  /** 初始化（存储由 LogStore 统一管理，此处保留为兼容空方法） */
  async initialize(): Promise<void> {
    // no-op
  }

  private ns(keyId: string): Namespace {
    return `key:${keyId}`;
  }

  /** 写入一条日志（追加写，O(单条)） */
  async addLog(keyId: string, keyName: string, logData: Omit<RequestLog, 'id'>): Promise<void> {
    const log: AccessKeyRequestLog = {
      ...(logData as RequestLog),
      keyId,
      keyName,
    } as AccessKeyRequestLog;
    // 保留原 id（如有）或由 LogStore 生成
    if (!log.id) {
      (log as any).id = undefined; // 让 LogStore.append 生成 UUID
    }
    await this.logStore.append(this.ns(keyId), log);
  }

  /** 获取 Key 的日志列表（分页 + 日期/类型/搜索过滤） */
  async getLogs(
    keyId: string,
    options: { page: number; pageSize: number; startDate?: string; endDate?: string; contentType?: string; search?: string }
  ): Promise<{ data: AccessKeyRequestLog[]; total: number }> {
    const offset = (options.page - 1) * options.pageSize;
    const limit = options.pageSize;

    const since = options.startDate ? Date.parse(options.startDate) : undefined;
    const until = options.endDate ? Date.parse(options.endDate) + 86_400_000 - 1 : undefined;
    const contentType = options.contentType;
    const searchLower = options.search?.toLowerCase();

    const match = (log: RequestLog): boolean => {
      if (contentType && log.contentType !== contentType) return false;
      if (searchLower) {
        const p = (log.path || '').toLowerCase();
        const m = (log.requestModel || log.targetModel || '').toLowerCase();
        const e = (log.error || '').toLowerCase();
        if (!p.includes(searchLower) && !m.includes(searchLower) && !e.includes(searchLower)) return false;
      }
      return true;
    };

    const needFilter = !!(contentType || searchLower);
    if (!needFilter && since == null && until == null) {
      // 纯分页：用 getRecent + count
      const [data, total] = await Promise.all([
        this.logStore.getRecent(this.ns(keyId), { limit, offset }),
        this.logStore.count(this.ns(keyId)),
      ]);
      return { data: data as AccessKeyRequestLog[], total };
    }

    const { data, total } = await this.logStore.getFiltered(this.ns(keyId), {
      since: Number.isFinite(since) ? since as number : undefined,
      until: Number.isFinite(until) ? until as number : undefined,
      match: needFilter ? match : undefined,
      limit,
      offset,
    });
    return { data: data as AccessKeyRequestLog[], total };
  }

  /** 按 sessionId 过滤日志（用于密钥会话的日志查询，字节偏移随机读） */
  async getLogsBySessionId(keyId: string, sessionId: string, limit: number = 10000): Promise<AccessKeyRequestLog[]> {
    const logs = await this.logStore.getBySession(this.ns(keyId), sessionId, { limit });
    // 按 timestamp 正序（对话视图所需）
    return (logs as AccessKeyRequestLog[]).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }

  /** 获取 Key 的日志总数 */
  async getLogsCount(keyId: string): Promise<number> {
    return this.logStore.count(this.ns(keyId));
  }

  /** 清理所有 AccessKey 的过期日志（30 天，整文件删除） */
  async cleanupOldLogs(): Promise<void> {
    for (const nsName of this.logStore.listNamespaces()) {
      if (!nsName.startsWith('key:')) continue;
      try {
        await this.logStore.retain(nsName, LOG_RETENTION_DAYS);
      } catch {
        // 忽略单个 key 失败
      }
    }
  }
}
