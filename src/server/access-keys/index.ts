/**
 * AccessKey 模块入口
 * 统一导出所有子模块，并提供模块级别的初始化和持久化方法
 */
import path from 'path';
import fs from 'fs/promises';
import type { AccessKey, Policy } from '../../types';
import { AccessKeyManager } from './manager';
import { PolicyManager } from './policy-manager';
import { QuotaChecker } from './quota-checker';
import { UsageTracker } from './usage-tracker';
import { KeyLogger } from './key-logger';
import { KeySessionTracker } from './key-session-tracker';
import { KeyResolver } from './key-resolver';

export class AccessKeyModule {
  readonly keyManager: AccessKeyManager;
  readonly policyManager: PolicyManager;
  readonly quotaChecker: QuotaChecker;
  readonly usageTracker: UsageTracker;
  readonly keyLogger: KeyLogger;
  readonly keySessionTracker: KeySessionTracker;
  readonly keyResolver: KeyResolver;

  private accessKeysFile: string;
  private policiesFile: string;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dataPath: string) {
    this.accessKeysFile = path.join(dataPath, 'access-keys.json');
    this.policiesFile = path.join(dataPath, 'policies.json');

    this.keyManager = new AccessKeyManager();
    this.policyManager = new PolicyManager();
    this.quotaChecker = new QuotaChecker();
    this.usageTracker = new UsageTracker(dataPath);
    this.keyLogger = new KeyLogger(dataPath);
    this.keySessionTracker = new KeySessionTracker(dataPath);
    this.keyResolver = new KeyResolver(this.keyManager, this.policyManager);
  }

  /** 初始化模块 */
  async initialize(): Promise<void> {
    // 加载持久化数据
    const [keys, policies] = await Promise.all([
      this.loadJsonFile<AccessKey[]>(this.accessKeysFile, []),
      this.loadJsonFile<Policy[]>(this.policiesFile, []),
    ]);

    this.keyManager.load(keys);
    this.policyManager.load(policies);

    // 初始化子模块
    await Promise.all([
      this.usageTracker.initialize(),
      this.keyLogger.initialize(),
      this.keySessionTracker.initialize(),
    ]);

    // 启动自动刷新
    this.usageTracker.startAutoFlush();
    this.startAutoSave();

    console.log(`[AccessKey] Module initialized: ${keys.length} keys, ${policies.length} policies`);
  }

  /** 保存所有数据到磁盘 */
  async save(): Promise<void> {
    await Promise.all([
      this.saveJsonFile(this.accessKeysFile, this.keyManager.dump()),
      this.saveJsonFile(this.policiesFile, this.policyManager.dump()),
      this.usageTracker.flush(),
    ]);
  }

  /** 关闭模块 */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.usageTracker.stopAutoFlush();
    await this.save();
    console.log('[AccessKey] Module shutdown completed');
  }

  /** 标记数据已修改，需要保存 */
  markDirty(): void {
    // 下一个自动保存周期会处理
  }

  private startAutoSave(): void {
    this.flushTimer = setInterval(() => {
      this.save().catch(err => console.error('[AccessKey] Auto save error:', err));
    }, 5000);
  }

  private async loadJsonFile<T>(filePath: string, defaultValue: T): Promise<T> {
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return defaultValue;
    }
  }

  private async saveJsonFile(filePath: string, data: any): Promise<void> {
    const tmpPath = filePath + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  }
}
