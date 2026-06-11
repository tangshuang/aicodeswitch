/**
 * Key 级会话追踪器
 * 每个 AccessKey 有独立的会话存储空间，与全局会话系统完全隔离
 */
import path from 'path';
import fs from 'fs/promises';
import type { AccessKeySession, ToolType } from '../../types';

export class KeySessionTracker {
  private dataPath: string;
  /** 内存缓存 keyId → AccessKeySession[] */
  private cache: Map<string, AccessKeySession[]> = new Map();
  /** 写入锁 */
  private writeLocks: Map<string, Promise<void>> = new Map();

  constructor(dataPath: string) {
    this.dataPath = dataPath;
  }

  /** 初始化 */
  async initialize(): Promise<void> {
    const sessionsDir = path.join(this.dataPath, 'key-sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
  }

  /** 创建或更新会话 */
  async upsertSession(keyId: string, session: {
    id: string;
    targetType: ToolType;
    title?: string;
    firstRequestAt: number;
    lastRequestAt: number;
    vendorId?: string;
    vendorName?: string;
    serviceId?: string;
    serviceName?: string;
    model?: string;
    totalTokens: number;
  }): Promise<void> {
    return this.withWriteLock(keyId, async () => {
      const sessions = await this.loadSessions(keyId);
      const existing = sessions.find(s => s.id === session.id);

      if (existing) {
        // 更新已有会话
        existing.requestCount += 1;
        existing.totalTokens += session.totalTokens;
        existing.lastRequestAt = session.lastRequestAt;
        // 更新供应商/服务/模型信息为最新
        if (session.vendorId) existing.vendorId = session.vendorId;
        if (session.vendorName) existing.vendorName = session.vendorName;
        if (session.serviceId) existing.serviceId = session.serviceId;
        if (session.serviceName) existing.serviceName = session.serviceName;
        if (session.model) existing.model = session.model;
        // 标题仅在新会话时设置（保留第一次的标题）
      } else {
        // 创建新会话
        sessions.push({
          id: session.id,
          targetType: session.targetType,
          title: session.title,
          firstRequestAt: session.firstRequestAt,
          lastRequestAt: session.lastRequestAt,
          requestCount: 1,
          totalTokens: session.totalTokens,
          vendorId: session.vendorId,
          vendorName: session.vendorName,
          serviceId: session.serviceId,
          serviceName: session.serviceName,
          model: session.model,
        });
      }

      await this.saveSessions(keyId, sessions);
    });
  }

  /** 获取密钥的会话列表（支持过滤+分页） */
  async getSessions(keyId: string, options: {
    page: number;
    pageSize: number;
    targetType?: string;
    search?: string;
  }): Promise<{ data: AccessKeySession[]; total: number }> {
    const sessions = await this.loadSessions(keyId);

    // 过滤
    let filtered = sessions;
    if (options.targetType) {
      filtered = filtered.filter(s => s.targetType === options.targetType);
    }
    if (options.search) {
      const q = options.search.toLowerCase();
      filtered = filtered.filter(s =>
        (s.title && s.title.toLowerCase().includes(q)) ||
        s.id.toLowerCase().includes(q)
      );
    }

    // 按 lastRequestAt 降序
    filtered.sort((a, b) => b.lastRequestAt - a.lastRequestAt);

    const total = filtered.length;
    const offset = (options.page - 1) * options.pageSize;
    const data = filtered.slice(offset, offset + options.pageSize);

    return { data, total };
  }

  /** 获取密钥的会话总数 */
  async getSessionsCount(keyId: string, targetType?: string): Promise<number> {
    const sessions = await this.loadSessions(keyId);
    if (!targetType) return sessions.length;
    return sessions.filter(s => s.targetType === targetType).length;
  }

  /** 获取单个会话 */
  async getSession(keyId: string, sessionId: string): Promise<AccessKeySession | null> {
    const sessions = await this.loadSessions(keyId);
    return sessions.find(s => s.id === sessionId) || null;
  }

  /** 删除单个会话 */
  async deleteSession(keyId: string, sessionId: string): Promise<boolean> {
    let deleted = false;
    await this.withWriteLock(keyId, async () => {
      const sessions = await this.loadSessions(keyId);
      const index = sessions.findIndex(s => s.id === sessionId);
      if (index === -1) return;
      sessions.splice(index, 1);
      deleted = true;
      await this.saveSessions(keyId, sessions);
    });
    return deleted;
  }

  /** 清空密钥的所有会话 */
  async clearSessions(keyId: string): Promise<void> {
    return this.withWriteLock(keyId, async () => {
      this.cache.set(keyId, []);
      await this.saveSessions(keyId, []);
    });
  }

  // ---- helpers ----

  private getKeySessionDir(keyId: string): string {
    return path.join(this.dataPath, 'key-sessions', keyId);
  }

  private getKeySessionFilePath(keyId: string): string {
    return path.join(this.getKeySessionDir(keyId), 'sessions.json');
  }

  private async loadSessions(keyId: string): Promise<AccessKeySession[]> {
    if (this.cache.has(keyId)) {
      return this.cache.get(keyId)!;
    }

    try {
      const filePath = this.getKeySessionFilePath(keyId);
      const data = await fs.readFile(filePath, 'utf-8');
      const sessions = JSON.parse(data) as AccessKeySession[];
      this.cache.set(keyId, sessions);
      return sessions;
    } catch {
      const sessions: AccessKeySession[] = [];
      this.cache.set(keyId, sessions);
      return sessions;
    }
  }

  private async saveSessions(keyId: string, sessions: AccessKeySession[]): Promise<void> {
    this.cache.set(keyId, sessions);
    const dir = this.getKeySessionDir(keyId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = this.getKeySessionFilePath(keyId);
    const tmpPath = filePath + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(sessions, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  }

  private async withWriteLock(keyId: string, fn: () => Promise<void>): Promise<void> {
    // 等待现有写入完成
    while (this.writeLocks.has(keyId)) {
      await this.writeLocks.get(keyId);
    }

    const writePromise = (async () => {
      try {
        await fn();
      } finally {
        this.writeLocks.delete(keyId);
      }
    })();

    this.writeLocks.set(keyId, writePromise);
    await writePromise;
  }
}
