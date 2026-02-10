import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import CryptoJS from 'crypto-js';
import type {
  Vendor,
  APIService,
  Route,
  Rule,
  RequestLog,
  ErrorLog,
  AppConfig,
  ExportData,
  Statistics,
  ContentType,
  ServiceBlacklistEntry,
  Session,
} from '../types';

interface LogShardIndex {
  filename: string;
  date: string;
  startTime: number;
  endTime: number;
  count: number;
}

/**
 * 基于文件系统的数据库管理器
 * 使用 JSON 文件存储数据，无需编译依赖
 */
export class FileSystemDatabaseManager {
  private dataPath: string;
  private vendors: Vendor[] = [];
  private apiServices: APIService[] = [];
  private routes: Route[] = [];
  private rules: Rule[] = [];
  private config: AppConfig | null = null;
  private sessions: Session[] = [];
  private logShardsIndex: LogShardIndex[] = [];
  private errorLogs: ErrorLog[] = [];
  private blacklist: Map<string, ServiceBlacklistEntry> = new Map();

  // 持久化统计数据
  private statistics: Statistics = this.createEmptyStatistics();

  // 缓存机制
  private logsCountCache: { count: number; timestamp: number } | null = null;
  private errorLogsCountCache: { count: number; timestamp: number } | null = null;
  private readonly CACHE_TTL = 1000;

  // 日志分片配置
  private readonly MAX_SHARD_SIZE = 10 * 1024 * 1024; // 10MB
  private readonly LOG_RETENTION_DAYS = 30;

  // 文件路径
  private get vendorsFile() { return path.join(this.dataPath, 'vendors.json'); }
  private get servicesFile() { return path.join(this.dataPath, 'services.json'); }
  private get routesFile() { return path.join(this.dataPath, 'routes.json'); }
  private get rulesFile() { return path.join(this.dataPath, 'rules.json'); }
  private get configFile() { return path.join(this.dataPath, 'config.json'); }
  private get sessionsFile() { return path.join(this.dataPath, 'sessions.json'); }
  private get logsDir() { return path.join(this.dataPath, 'logs'); }
  private get logsIndexFile() { return path.join(this.dataPath, 'logs-index.json'); }
  private get errorLogsFile() { return path.join(this.dataPath, 'error-logs.json'); }
  private get blacklistFile() { return path.join(this.dataPath, 'blacklist.json'); }
  private get statisticsFile() { return path.join(this.dataPath, 'statistics.json'); }

  // 创建空的统计数据结构
  private createEmptyStatistics(): Statistics {
    return {
      overview: {
        totalRequests: 0,
        totalTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalVendors: 0,
        totalServices: 0,
        totalRoutes: 0,
        totalRules: 0,
        avgResponseTime: 0,
        successRate: 100,
        totalCodingTime: 0,
      },
      byTargetType: [],
      byVendor: [],
      byService: [],
      byModel: [],
      timeline: [],
      contentTypeDistribution: [],
      errors: {
        totalErrors: 0,
        recentErrors: 0,
      },
    };
  }

  constructor(dataPath: string) {
    this.dataPath = dataPath;
  }

  async initialize() {
    // 确保数据目录存在
    await fs.mkdir(this.dataPath, { recursive: true });

    // 加载所有数据
    await this.loadAllData();
    
    // 确保默认配置
    await this.ensureDefaultConfig();
  }

  private async loadAllData() {
    await Promise.all([
      this.loadVendors(),
      this.loadServices(),
      this.loadRoutes(),
      this.loadRules(),
      this.loadConfig(),
      this.loadSessions(),
      this.loadLogsIndex(),
      this.loadErrorLogs(),
      this.loadBlacklist(),
      this.loadStatistics(),
    ]);
  }

  private async loadVendors() {
    try {
      const data = await fs.readFile(this.vendorsFile, 'utf-8');
      this.vendors = JSON.parse(data);
    } catch {
      this.vendors = [];
    }
  }

  private async saveVendors() {
    await fs.writeFile(this.vendorsFile, JSON.stringify(this.vendors, null, 2));
  }

  private async loadServices() {
    try {
      const data = await fs.readFile(this.servicesFile, 'utf-8');
      this.apiServices = JSON.parse(data);
    } catch {
      this.apiServices = [];
    }
  }

  private async saveServices() {
    await fs.writeFile(this.servicesFile, JSON.stringify(this.apiServices, null, 2));
  }

  private async loadRoutes() {
    try {
      const data = await fs.readFile(this.routesFile, 'utf-8');
      this.routes = JSON.parse(data);
    } catch {
      this.routes = [];
    }
  }

  private async saveRoutes() {
    await fs.writeFile(this.routesFile, JSON.stringify(this.routes, null, 2));
  }

  private async loadRules() {
    try {
      const data = await fs.readFile(this.rulesFile, 'utf-8');
      this.rules = JSON.parse(data);
    } catch {
      this.rules = [];
    }
  }

  private async saveRules() {
    await fs.writeFile(this.rulesFile, JSON.stringify(this.rules, null, 2));
  }

  private async loadConfig() {
    try {
      const data = await fs.readFile(this.configFile, 'utf-8');
      this.config = JSON.parse(data);
    } catch {
      this.config = null;
    }
  }

  private async saveConfig() {
    await fs.writeFile(this.configFile, JSON.stringify(this.config, null, 2));
  }

  private async loadSessions() {
    try {
      const data = await fs.readFile(this.sessionsFile, 'utf-8');
      this.sessions = JSON.parse(data);
    } catch {
      this.sessions = [];
      // 创建空文件
      await this.saveSessions();
    }
  }

  private async saveSessions() {
    await fs.writeFile(this.sessionsFile, JSON.stringify(this.sessions, null, 2));
  }

  private async loadLogsIndex(): Promise<void> {
    try {
      const data = await fs.readFile(this.logsIndexFile, 'utf-8');
      this.logShardsIndex = JSON.parse(data);
    } catch {
      this.logShardsIndex = [];
      await this.saveLogsIndex();
    }

    // 检查并迁移旧的 logs.json 文件
    await this.migrateOldLogsIfNeeded();

    // 清理旧日志分片
    await this.cleanupOldLogShards();
  }

  private async saveLogsIndex(): Promise<void> {
    await fs.writeFile(this.logsIndexFile, JSON.stringify(this.logShardsIndex, null, 2));
  }

  /**
   * 迁移旧的 logs.json 文件到新的分片格式
   */
  private async migrateOldLogsIfNeeded(): Promise<void> {
    const oldLogsFile = path.join(this.dataPath, 'logs.json');

    try {
      // 检查旧日志文件是否存在
      await fs.access(oldLogsFile);

      console.log('[Database] Found old logs.json file, migrating to shard format...');

      // 读取旧日志
      const data = await fs.readFile(oldLogsFile, 'utf-8');
      const oldLogs: RequestLog[] = JSON.parse(data);

      if (oldLogs.length === 0) {
        console.log('[Database] Old logs.json is empty, skipping migration');
        await fs.unlink(oldLogsFile); // 删除空文件
        return;
      }

      console.log(`[Database] Migrating ${oldLogs.length} log entries...`);

      // 按日期分组日志
      const logsByDate = new Map<string, RequestLog[]>();
      for (const log of oldLogs) {
        const date = new Date(log.timestamp).toISOString().split('T')[0];
        if (!logsByDate.has(date)) {
          logsByDate.set(date, []);
        }
        logsByDate.get(date)!.push(log);
      }

      // 为每个日期创建分片
      let migratedCount = 0;
      for (const [date, logs] of logsByDate.entries()) {
        // 如果单日日志超过大小限制，需要进一步分片
        let currentShardLogs: RequestLog[] = [];
        let currentShardSize = 0;
        let shardIndex = 0;

        for (const log of logs) {
          const logSize = JSON.stringify(log).length;

          // 检查是否需要创建新分片
          if (currentShardSize + logSize > this.MAX_SHARD_SIZE && currentShardLogs.length > 0) {
            // 保存当前分片
            const filename = shardIndex === 0 ? `logs-${date}.json` : `logs-${date}-${shardIndex}.json`;
            await this.saveLogShard(filename, currentShardLogs);

            // 更新索引
            const timestamps = currentShardLogs.map(l => l.timestamp);
            this.logShardsIndex.push({
              filename,
              date,
              startTime: Math.min(...timestamps),
              endTime: Math.max(...timestamps),
              count: currentShardLogs.length
            });

            migratedCount += currentShardLogs.length;
            currentShardLogs = [];
            currentShardSize = 0;
            shardIndex++;
          }

          currentShardLogs.push(log);
          currentShardSize += logSize;
        }

        // 保存最后一个分片
        if (currentShardLogs.length > 0) {
          const filename = shardIndex === 0 ? `logs-${date}.json` : `logs-${date}-${shardIndex}.json`;
          await this.saveLogShard(filename, currentShardLogs);

          const timestamps = currentShardLogs.map(l => l.timestamp);
          this.logShardsIndex.push({
            filename,
            date,
            startTime: Math.min(...timestamps),
            endTime: Math.max(...timestamps),
            count: currentShardLogs.length
          });

          migratedCount += currentShardLogs.length;
        }
      }

      // 保存索引
      await this.saveLogsIndex();

      console.log(`[Database] Successfully migrated ${migratedCount} log entries to ${this.logShardsIndex.length} shard(s)`);

      // 备份旧文件
      const backupFile = path.join(this.dataPath, 'logs.json.backup');
      await fs.rename(oldLogsFile, backupFile);
      console.log(`[Database] Old logs.json backed up to ${backupFile}`);

    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // 旧文件不存在，这是正常的
        return;
      }
      console.error('[Database] Error migrating old logs:', err);
    }
  }

  private async cleanupOldLogShards(): Promise<void> {
    const now = Date.now();
    const cutoffTime = now - this.LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    // 找出需要删除的分片
    const toDelete: string[] = [];
    for (const shard of this.logShardsIndex) {
      if (shard.endTime < cutoffTime) {
        toDelete.push(shard.filename);
      }
    }

    // 删除旧分片文件
    for (const filename of toDelete) {
      try {
        const filepath = path.join(this.logsDir, filename);
        await fs.unlink(filepath);
      } catch (err) {
        console.error(`Failed to delete old log shard ${filename}:`, err);
      }
    }

    // 更新索引
    this.logShardsIndex = this.logShardsIndex.filter(s => !toDelete.includes(s.filename));
    if (toDelete.length > 0) {
      await this.saveLogsIndex();
    }
  }

  private async getLogShardFilename(timestamp: number): Promise<string> {
    const date = new Date(timestamp);
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD

    // 查找当天的现有分片
    const existingShards = this.logShardsIndex.filter(s => s.date === dateStr);

    // 检查最后一个分片的大小
    for (const shard of existingShards.reverse()) {
      const filepath = path.join(this.logsDir, shard.filename);
      try {
        const stats = await fs.stat(filepath);
        if (stats.size < this.MAX_SHARD_SIZE) {
          return shard.filename;
        }
      } catch {
        // 文件不存在，继续查找
        continue;
      }
    }

    // 创建新分片
    const shardIndex = existingShards.length;
    const filename = shardIndex === 0 ? `logs-${dateStr}.json` : `logs-${dateStr}-${shardIndex}.json`;

    return filename;
  }

  private async loadLogShard(filename: string): Promise<RequestLog[]> {
    const filepath = path.join(this.logsDir, filename);
    try {
      const data = await fs.readFile(filepath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  private async saveLogShard(filename: string, logs: RequestLog[]): Promise<void> {
    const filepath = path.join(this.logsDir, filename);
    await fs.mkdir(this.logsDir, { recursive: true });
    await fs.writeFile(filepath, JSON.stringify(logs, null, 2));
  }

  private async loadErrorLogs() {
    try {
      const data = await fs.readFile(this.errorLogsFile, 'utf-8');
      this.errorLogs = JSON.parse(data);
      // 兼容旧的 response 字段名，迁移到 responseBody
      let needsSave = false;
      for (const log of this.errorLogs) {
        if ((log as any).response !== undefined && !log.responseBody) {
          log.responseBody = (log as any).response;
          delete (log as any).response;
          needsSave = true;
        }
      }
      if (needsSave) {
        await this.saveErrorLogs();
      }
    } catch {
      this.errorLogs = [];
      // 创建空文件
      await this.saveErrorLogs();
    }
  }

  private async saveErrorLogs() {
    await fs.writeFile(this.errorLogsFile, JSON.stringify(this.errorLogs, null, 2));
    this.errorLogsCountCache = null;
  }

  private async loadBlacklist() {
    try {
      const data = await fs.readFile(this.blacklistFile, 'utf-8');
      const entries: ServiceBlacklistEntry[] = JSON.parse(data);
      this.blacklist = new Map(entries.map(e => [
        `${e.routeId}:${e.contentType}:${e.serviceId}`,
        e
      ]));
    } catch {
      this.blacklist = new Map();
      // 创建空文件
      await this.saveBlacklist();
    }
  }

  private async saveBlacklist() {
    const entries = Array.from(this.blacklist.values());
    await fs.writeFile(this.blacklistFile, JSON.stringify(entries, null, 2));
  }

  private async loadStatistics() {
    try {
      const data = await fs.readFile(this.statisticsFile, 'utf-8');
      this.statistics = JSON.parse(data);
    } catch {
      this.statistics = this.createEmptyStatistics();
      // 创建空文件
      await this.saveStatistics();
    }
  }

  private async saveStatistics() {
    await fs.writeFile(this.statisticsFile, JSON.stringify(this.statistics, null, 2));
  }

  private async ensureDefaultConfig() {
    if (!this.config) {
      this.config = {
        enableLogging: true,
        logRetentionDays: 30,
        maxLogSize: 100000,
        apiKey: '',
        enableFailover: true,
        proxyEnabled: false,
        proxyUrl: '',
        proxyUsername: '',
        proxyPassword: '',
      };
      await this.saveConfig();
    }
  }

  // Vendor operations
  getVendors(): Vendor[] {
    return [...this.vendors].sort((a, b) => {
      if (b.sortOrder !== a.sortOrder) {
        return (b.sortOrder || 0) - (a.sortOrder || 0);
      }
      return b.createdAt - a.createdAt;
    });
  }

  async createVendor(vendor: Omit<Vendor, 'id' | 'createdAt' | 'updatedAt'>): Promise<Vendor> {
    console.log('[数据库] 创建供应商，输入数据:', JSON.stringify(vendor, null, 2));
    const id = crypto.randomUUID();
    const now = Date.now();
    const newVendor: Vendor = { ...vendor, id, createdAt: now, updatedAt: now };
    console.log('[数据库] 创建供应商，返回数据:', JSON.stringify(newVendor, null, 2));
    this.vendors.push(newVendor);
    await this.saveVendors();
    return newVendor;
  }

  async updateVendor(id: string, vendor: Partial<Vendor>): Promise<boolean> {
    const index = this.vendors.findIndex(v => v.id === id);
    if (index === -1) return false;
    
    const now = Date.now();
    this.vendors[index] = {
      ...this.vendors[index],
      ...vendor,
      id,
      updatedAt: now,
    };
    await this.saveVendors();
    return true;
  }

  async deleteVendor(id: string): Promise<boolean> {
    const index = this.vendors.findIndex(v => v.id === id);
    if (index === -1) return false;
    
    // 删除关联的服务
    this.apiServices = this.apiServices.filter(s => s.vendorId !== id);
    await this.saveServices();
    
    this.vendors.splice(index, 1);
    await this.saveVendors();
    return true;
  }

  // API Service operations
  getAPIServices(vendorId?: string): APIService[] {
    const services = vendorId
      ? this.apiServices.filter(s => s.vendorId === vendorId)
      : this.apiServices;
    
    return services.sort((a, b) => b.createdAt - a.createdAt);
  }

  async createAPIService(service: Omit<APIService, 'id' | 'createdAt' | 'updatedAt'>): Promise<APIService> {
    console.log('[数据库] 创建服务，输入数据:', JSON.stringify(service, null, 2));
    const id = crypto.randomUUID();
    const now = Date.now();
    const newService: APIService = { ...service, id, createdAt: now, updatedAt: now };
    console.log('[数据库] 创建服务，最终数据:', JSON.stringify(newService, null, 2));
    this.apiServices.push(newService);
    await this.saveServices();
    console.log('[数据库] 服务已保存，当前总数:', this.apiServices.length);
    return newService;
  }

  async updateAPIService(id: string, service: Partial<APIService>): Promise<boolean> {
    const index = this.apiServices.findIndex(s => s.id === id);
    if (index === -1) return false;
    
    const now = Date.now();
    this.apiServices[index] = {
      ...this.apiServices[index],
      ...service,
      id,
      updatedAt: now,
    };
    await this.saveServices();
    
    // 同步规则的超量限制
    await this.syncRulesWithServiceLimits(id, service);
    
    return true;
  }

  async deleteAPIService(id: string): Promise<boolean> {
    const index = this.apiServices.findIndex(s => s.id === id);
    if (index === -1) return false;
    
    // 删除关联的规则
    this.rules = this.rules.filter(r => r.targetServiceId !== id);
    await this.saveRules();
    
    this.apiServices.splice(index, 1);
    await this.saveServices();
    return true;
  }

  private async syncRulesWithServiceLimits(serviceId: string, _service: Partial<APIService>): Promise<void> {
    const relatedRules = this.rules.filter(r => r.targetServiceId === serviceId);
    if (relatedRules.length === 0) return;

    const now = Date.now();
    const currentService = this.apiServices.find(s => s.id === serviceId);
    if (!currentService) return;

    let updated = false;

    // Token超量限制同步
    if (currentService.enableTokenLimit) {
      for (const rule of relatedRules) {
        rule.tokenLimit = currentService.tokenLimit;
        rule.resetInterval = currentService.tokenResetInterval;
        rule.tokenResetBaseTime = currentService.tokenResetBaseTime;
        rule.updatedAt = now;
        updated = true;
      }
    }

    // 请求次数超量限制同步
    if (currentService.enableRequestLimit) {
      for (const rule of relatedRules) {
        rule.requestCountLimit = currentService.requestCountLimit;
        rule.requestResetInterval = currentService.requestResetInterval;
        rule.requestResetBaseTime = currentService.requestResetBaseTime;
        rule.updatedAt = now;
        updated = true;
      }
    }

    if (updated) {
      await this.saveRules();
    }
  }

  // Route operations
  getRoutes(): Route[] {
    return this.routes.sort((a, b) => b.createdAt - a.createdAt);
  }

  async createRoute(route: Omit<Route, 'id' | 'createdAt' | 'updatedAt'>): Promise<Route> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const newRoute: Route = { ...route, id, createdAt: now, updatedAt: now };
    this.routes.push(newRoute);
    await this.saveRoutes();
    return newRoute;
  }

  async updateRoute(id: string, route: Partial<Route>): Promise<boolean> {
    const index = this.routes.findIndex(r => r.id === id);
    if (index === -1) return false;
    
    const now = Date.now();
    this.routes[index] = {
      ...this.routes[index],
      ...route,
      id,
      updatedAt: now,
    };
    await this.saveRoutes();
    return true;
  }

  async deleteRoute(id: string): Promise<boolean> {
    const index = this.routes.findIndex(r => r.id === id);
    if (index === -1) return false;
    
    // 删除关联的规则
    this.rules = this.rules.filter(r => r.routeId !== id);
    await this.saveRules();
    
    this.routes.splice(index, 1);
    await this.saveRoutes();
    return true;
  }

  async activateRoute(id: string): Promise<boolean> {
    const route = this.routes.find(r => r.id === id);
    if (!route) return false;
    
    // 停用同类型的其他路由
    for (const r of this.routes) {
      if (r.targetType === route.targetType) {
        r.isActive = r.id === id;
      }
    }
    
    await this.saveRoutes();
    return true;
  }

  async deactivateRoute(id: string): Promise<boolean> {
    const route = this.routes.find(r => r.id === id);
    if (!route) return false;
    
    route.isActive = false;
    await this.saveRoutes();
    return true;
  }

  async deactivateAllRoutes(): Promise<number> {
    let count = 0;
    for (const route of this.routes) {
      if (route.isActive) {
        route.isActive = false;
        count++;
      }
    }
    if (count > 0) {
      await this.saveRoutes();
    }
    return count;
  }

  // Rule operations
  getRules(routeId?: string): Rule[] {
    const rules = routeId
      ? this.rules.filter(r => r.routeId === routeId)
      : this.rules;
    
    return rules.sort((a, b) => {
      if (b.sortOrder !== a.sortOrder) {
        return (b.sortOrder || 0) - (a.sortOrder || 0);
      }
      return b.createdAt - a.createdAt;
    });
  }

  getRule(id: string): Rule | undefined {
    return this.rules.find(r => r.id === id);
  }

  async createRule(rule: Omit<Rule, 'id' | 'createdAt' | 'updatedAt'>): Promise<Rule> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const newRule: Rule = {
      ...rule,
      id,
      totalTokensUsed: rule.totalTokensUsed || 0,
      totalRequestsUsed: rule.totalRequestsUsed || 0,
      isDisabled: rule.isDisabled || false,
      createdAt: now,
      updatedAt: now,
    };
    this.rules.push(newRule);
    await this.saveRules();
    return newRule;
  }

  async updateRule(id: string, rule: Partial<Rule>): Promise<boolean> {
    const index = this.rules.findIndex(r => r.id === id);
    if (index === -1) return false;
    
    const now = Date.now();
    this.rules[index] = {
      ...this.rules[index],
      ...rule,
      id,
      updatedAt: now,
    };
    await this.saveRules();
    return true;
  }

  async deleteRule(id: string): Promise<boolean> {
    const index = this.rules.findIndex(r => r.id === id);
    if (index === -1) return false;
    
    this.rules.splice(index, 1);
    await this.saveRules();
    return true;
  }

  async toggleRuleDisabled(ruleId: string): Promise<{ success: boolean; isDisabled: boolean }> {
    const rule = this.rules.find(r => r.id === ruleId);
    if (!rule) {
      return { success: false, isDisabled: false };
    }

    rule.isDisabled = !rule.isDisabled;
    rule.updatedAt = Date.now();
    await this.saveRules();

    return {
      success: true,
      isDisabled: rule.isDisabled
    };
  }

  async incrementRuleTokenUsage(ruleId: string, tokensUsed: number): Promise<boolean> {
    const rule = this.rules.find(r => r.id === ruleId);
    if (!rule) return false;

    rule.totalTokensUsed = (rule.totalTokensUsed || 0) + tokensUsed;
    await this.saveRules();
    return true;
  }

  async resetRuleTokenUsage(ruleId: string): Promise<boolean> {
    const rule = this.rules.find(r => r.id === ruleId);
    if (!rule) return false;

    rule.totalTokensUsed = 0;
    rule.lastResetAt = Date.now();
    await this.saveRules();
    return true;
  }

  async checkAndResetRuleIfNeeded(ruleId: string): Promise<boolean> {
    const rule = this.rules.find(r => r.id === ruleId);
    if (!rule || !rule.resetInterval) return false;

    const now = Date.now();
    const resetIntervalMs = rule.resetInterval * 60 * 60 * 1000;
    const baseTime = rule.tokenResetBaseTime;
    const lastResetAt = rule.lastResetAt || 0;

    if (baseTime) {
      if (now >= baseTime) {
        await this.resetRuleTokenUsageWithBaseTime(ruleId, baseTime);
        return true;
      }
      return false;
    }

    if (now - lastResetAt >= resetIntervalMs) {
      await this.resetRuleTokenUsage(ruleId);
      return true;
    }

    return false;
  }

  async resetRuleTokenUsageWithBaseTime(ruleId: string, currentBaseTime: number): Promise<boolean> {
    const rule = this.rules.find(r => r.id === ruleId);
    if (!rule || !rule.resetInterval) return false;

    const now = Date.now();
    const resetIntervalMs = rule.resetInterval * 60 * 60 * 1000;

    let nextBaseTime = currentBaseTime;
    while (nextBaseTime <= now) {
      nextBaseTime += resetIntervalMs;
    }

    rule.totalTokensUsed = 0;
    rule.lastResetAt = now;
    rule.tokenResetBaseTime = nextBaseTime;
    await this.saveRules();
    return true;
  }

  async incrementRuleRequestCount(ruleId: string, count: number): Promise<boolean> {
    const rule = this.rules.find(r => r.id === ruleId);
    if (!rule) return false;

    rule.totalRequestsUsed = (rule.totalRequestsUsed || 0) + count;
    await this.saveRules();
    return true;
  }

  async resetRuleRequestCount(ruleId: string): Promise<boolean> {
    const rule = this.rules.find(r => r.id === ruleId);
    if (!rule) return false;

    rule.totalRequestsUsed = 0;
    rule.requestLastResetAt = Date.now();
    await this.saveRules();
    return true;
  }

  async checkAndResetRequestCountIfNeeded(ruleId: string): Promise<boolean> {
    const rule = this.rules.find(r => r.id === ruleId);
    if (!rule || !rule.requestResetInterval) return false;

    const now = Date.now();
    const resetIntervalMs = rule.requestResetInterval * 60 * 60 * 1000;
    const baseTime = rule.requestResetBaseTime;
    const lastResetAt = rule.requestLastResetAt || 0;

    if (baseTime) {
      if (now >= baseTime) {
        await this.resetRuleRequestCountWithBaseTime(ruleId, baseTime);
        return true;
      }
      return false;
    }

    if (now - lastResetAt >= resetIntervalMs) {
      await this.resetRuleRequestCount(ruleId);
      return true;
    }

    return false;
  }

  async resetRuleRequestCountWithBaseTime(ruleId: string, currentBaseTime: number): Promise<boolean> {
    const rule = this.rules.find(r => r.id === ruleId);
    if (!rule || !rule.requestResetInterval) return false;

    const now = Date.now();
    const resetIntervalMs = rule.requestResetInterval * 60 * 60 * 1000;

    let nextBaseTime = currentBaseTime;
    while (nextBaseTime <= now) {
      nextBaseTime += resetIntervalMs;
    }

    rule.totalRequestsUsed = 0;
    rule.requestLastResetAt = now;
    rule.requestResetBaseTime = nextBaseTime;
    await this.saveRules();
    return true;
  }

  // Log operations
  async addLog(log: Omit<RequestLog, 'id'>): Promise<void> {
    const id = crypto.randomUUID();
    const logWithId = { ...log, id };

    // 获取目标分片文件名
    const filename = await this.getLogShardFilename(logWithId.timestamp);

    // 加载现有分片数据
    let shardLogs = await this.loadLogShard(filename);

    // 添加新日志
    shardLogs.push(logWithId);

    // 保存分片
    await this.saveLogShard(filename, shardLogs);

    // 更新索引
    const date = new Date(logWithId.timestamp).toISOString().split('T')[0];
    let shardIndex = this.logShardsIndex.find(s => s.filename === filename);

    if (shardIndex) {
      shardIndex.count = shardLogs.length;
      shardIndex.endTime = Math.max(shardIndex.endTime, logWithId.timestamp);
    } else {
      this.logShardsIndex.push({
        filename,
        date,
        startTime: logWithId.timestamp,
        endTime: logWithId.timestamp,
        count: 1
      });
    }

    await this.saveLogsIndex();

    // 同时更新统计数据
    await this.updateStatistics(logWithId);

    // 清除计数缓存
    this.logsCountCache = null;
  }

  async getLogs(limit: number = 100, offset: number = 0): Promise<RequestLog[]> {
    // 按分片索引倒序排列（最新的在前）
    const sortedShards = [...this.logShardsIndex].sort((a, b) => b.endTime - a.endTime);

    const allLogs: RequestLog[] = [];
    let currentOffset = 0;

    // 遍历分片直到收集足够的日志
    for (const shard of sortedShards) {
      if (currentOffset + shard.count <= offset) {
        // 跳过整个分片
        currentOffset += shard.count;
        continue;
      }

      const shardLogs = await this.loadLogShard(shard.filename);

      // 计算需要从该分片取出的日志范围
      let startIndex = 0;
      if (currentOffset < offset) {
        startIndex = offset - currentOffset;
      }

      const remainingCount = limit - allLogs.length;
      const endIndex = Math.min(startIndex + remainingCount, shardLogs.length);

      // 添加日志到结果
      allLogs.push(...shardLogs.slice(startIndex, endIndex));

      currentOffset += shard.count;

      if (allLogs.length >= limit) {
        break;
      }
    }

    // 按时间戳倒序排序
    return allLogs.sort((a, b) => b.timestamp - a.timestamp);
  }

  async clearLogs(): Promise<void> {
    // 删除所有日志分片文件
    for (const shard of this.logShardsIndex) {
      try {
        const filepath = path.join(this.logsDir, shard.filename);
        await fs.unlink(filepath);
      } catch (err) {
        console.error(`Failed to delete log shard ${shard.filename}:`, err);
      }
    }

    // 清空索引
    this.logShardsIndex = [];
    await this.saveLogsIndex();

    // 清除计数缓存
    this.logsCountCache = null;
  }

  async getLogsCount(): Promise<number> {
    const now = Date.now();
    if (this.logsCountCache && now - this.logsCountCache.timestamp < this.CACHE_TTL) {
      return this.logsCountCache.count;
    }

    const count = this.logShardsIndex.reduce((sum, shard) => sum + shard.count, 0);
    this.logsCountCache = { count, timestamp: now };
    return count;
  }

  // Error log operations
  async addErrorLog(log: Omit<ErrorLog, 'id'>): Promise<void> {
    const id = crypto.randomUUID();
    this.errorLogs.push({ ...log, id });
    await this.saveErrorLogs();
  }

  async getErrorLogs(limit: number = 100, offset: number = 0): Promise<ErrorLog[]> {
    const sorted = [...this.errorLogs].sort((a, b) => b.timestamp - a.timestamp);
    return sorted.slice(offset, offset + limit);
  }

  async clearErrorLogs(): Promise<void> {
    this.errorLogs = [];
    await this.saveErrorLogs();
  }

  async getErrorLogsCount(): Promise<number> {
    const now = Date.now();
    if (this.errorLogsCountCache && now - this.errorLogsCountCache.timestamp < this.CACHE_TTL) {
      return this.errorLogsCountCache.count;
    }

    const count = this.errorLogs.length;
    this.errorLogsCountCache = { count, timestamp: now };
    return count;
  }

  // Service blacklist operations
  async isServiceBlacklisted(
    serviceId: string,
    routeId: string,
    contentType: ContentType
  ): Promise<boolean> {
    const key = `${routeId}:${contentType}:${serviceId}`;
    const entry = this.blacklist.get(key);

    if (!entry) return false;

    if (Date.now() > entry.expiresAt) {
      this.blacklist.delete(key);
      await this.saveBlacklist();
      return false;
    }

    return true;
  }

  async addToBlacklist(
    serviceId: string,
    routeId: string,
    contentType: ContentType,
    errorMessage?: string,
    statusCode?: number,
    errorType?: 'http' | 'timeout' | 'unknown'
  ): Promise<void> {
    const key = `${routeId}:${contentType}:${serviceId}`;
    const now = Date.now();
    const existing = this.blacklist.get(key);

    if (existing) {
      existing.blacklistedAt = now;
      existing.expiresAt = now + 10 * 60 * 1000;
      existing.errorCount++;
      existing.lastError = errorMessage;
      existing.lastStatusCode = statusCode;
      existing.errorType = errorType;
    } else {
      this.blacklist.set(key, {
        serviceId,
        routeId,
        contentType,
        blacklistedAt: now,
        expiresAt: now + 10 * 60 * 1000,
        errorCount: 1,
        lastError: errorMessage,
        lastStatusCode: statusCode,
        errorType,
      });
    }

    await this.saveBlacklist();
  }

  async removeFromBlacklist(
    serviceId: string,
    routeId: string,
    contentType: ContentType
  ): Promise<void> {
    const key = `${routeId}:${contentType}:${serviceId}`;
    this.blacklist.delete(key);
    await this.saveBlacklist();
  }

  async cleanupExpiredBlacklist(): Promise<number> {
    const now = Date.now();
    let count = 0;

    for (const [key, entry] of this.blacklist.entries()) {
      if (now > entry.expiresAt) {
        this.blacklist.delete(key);
        count++;
      }
    }

    if (count > 0) {
      await this.saveBlacklist();
    }

    return count;
  }

  // Config operations
  getConfig(): AppConfig {
    return this.config!;
  }

  async updateConfig(config: AppConfig): Promise<boolean> {
    this.config = config;
    await this.saveConfig();
    return true;
  }

  // Export/Import operations
  async exportData(password: string): Promise<string> {
    const exportData: ExportData = {
      version: '1.0.0',
      exportDate: Date.now(),
      vendors: this.vendors,
      apiServices: this.apiServices,
      routes: this.routes,
      rules: this.rules,
      config: this.config!,
    };

    const jsonData = JSON.stringify(exportData);
    const encrypted = CryptoJS.AES.encrypt(jsonData, password).toString();
    return encrypted;
  }

  async importData(encryptedData: string, password: string): Promise<boolean> {
    try {
      const decrypted = CryptoJS.AES.decrypt(encryptedData, password);
      const jsonData = decrypted.toString(CryptoJS.enc.Utf8);
      const importData: ExportData = JSON.parse(jsonData);

      this.vendors = importData.vendors;
      this.apiServices = importData.apiServices;
      this.routes = importData.routes;
      this.rules = importData.rules;
      this.config = importData.config;

      await Promise.all([
        this.saveVendors(),
        this.saveServices(),
        this.saveRoutes(),
        this.saveRules(),
        this.saveConfig(),
      ]);

      return true;
    } catch (error) {
      console.error('Import error:', error);
      return false;
    }
  }

  // Statistics operations
  /**
   * 更新统计数据 - 在每次添加日志时调用
   */
  private async updateStatistics(log: RequestLog): Promise<void> {
    const vendors = this.getVendors();
    const services = this.getAPIServices();

    // 更新 overview 数据
    this.statistics.overview.totalRequests++;
    this.statistics.overview.totalVendors = vendors.length;
    this.statistics.overview.totalServices = services.length;
    this.statistics.overview.totalRoutes = this.getRoutes().length;
    this.statistics.overview.totalRules = this.getRules().length;

    // 更新 tokens 统计
    const inputTokens = log.usage?.inputTokens || 0;
    const outputTokens = log.usage?.outputTokens || 0;
    const cacheTokens = log.usage?.cacheReadInputTokens || 0;
    const totalTokens = log.usage?.totalTokens || (inputTokens + outputTokens);

    this.statistics.overview.totalInputTokens += inputTokens;
    this.statistics.overview.totalOutputTokens += outputTokens;
    this.statistics.overview.totalCacheReadTokens += cacheTokens;
    this.statistics.overview.totalTokens += totalTokens;

    // 更新平均响应时间
    const currentAvg = this.statistics.overview.avgResponseTime;
    const responseTime = log.responseTime || 0;
    this.statistics.overview.avgResponseTime =
      (currentAvg * (this.statistics.overview.totalRequests - 1) + responseTime) / this.statistics.overview.totalRequests;

    // 更新成功率
    if (log.statusCode && log.statusCode >= 400) {
      const successCount = Math.round(this.statistics.overview.totalRequests * this.statistics.overview.successRate / 100);
      this.statistics.overview.successRate = ((successCount) / this.statistics.overview.totalRequests) * 100;
    }

    // 更新编程时长
    this.statistics.overview.totalCodingTime = Math.round(
      this.statistics.overview.totalInputTokens / 250 +
      this.statistics.overview.totalOutputTokens / 100
    );

    // 更新 byTargetType
    if (log.targetType) {
      let targetTypeStats = this.statistics.byTargetType.find(s => s.targetType === log.targetType);
      if (!targetTypeStats) {
        targetTypeStats = { targetType: log.targetType, totalRequests: 0, totalTokens: 0, avgResponseTime: 0 };
        this.statistics.byTargetType.push(targetTypeStats);
      }
      targetTypeStats.totalRequests++;
      targetTypeStats.totalTokens += totalTokens;
      targetTypeStats.avgResponseTime =
        (targetTypeStats.avgResponseTime * (targetTypeStats.totalRequests - 1) + responseTime) / targetTypeStats.totalRequests;
    }

    // 更新 byVendor
    if (log.vendorId) {
      let vendorStats = this.statistics.byVendor.find(s => s.vendorId === log.vendorId);
      if (!vendorStats) {
        vendorStats = {
          vendorId: log.vendorId,
          vendorName: log.vendorName || 'Unknown',
          totalRequests: 0,
          totalTokens: 0,
          avgResponseTime: 0
        };
        this.statistics.byVendor.push(vendorStats);
      }
      vendorStats.totalRequests++;
      vendorStats.totalTokens += totalTokens;
      vendorStats.avgResponseTime =
        (vendorStats.avgResponseTime * (vendorStats.totalRequests - 1) + responseTime) / vendorStats.totalRequests;
    }

    // 更新 byService
    if (log.targetServiceId) {
      let serviceStats = this.statistics.byService.find(s => s.serviceId === log.targetServiceId);
      if (!serviceStats) {
        serviceStats = {
          serviceId: log.targetServiceId,
          serviceName: log.targetServiceName || 'Unknown',
          vendorName: log.vendorName || 'Unknown',
          totalRequests: 0,
          totalTokens: 0,
          avgResponseTime: 0
        };
        this.statistics.byService.push(serviceStats);
      }
      serviceStats.totalRequests++;
      serviceStats.totalTokens += totalTokens;
      serviceStats.avgResponseTime =
        (serviceStats.avgResponseTime * (serviceStats.totalRequests - 1) + responseTime) / serviceStats.totalRequests;
    }

    // 更新 byModel
    if (log.requestModel || log.targetModel) {
      const modelName = log.requestModel || log.targetModel || 'Unknown';
      let modelStats = this.statistics.byModel.find(s => s.modelName === modelName);
      if (!modelStats) {
        modelStats = { modelName, totalRequests: 0, totalTokens: 0, avgResponseTime: 0 };
        this.statistics.byModel.push(modelStats);
      }
      modelStats.totalRequests++;
      modelStats.totalTokens += totalTokens;
      modelStats.avgResponseTime =
        (modelStats.avgResponseTime * (modelStats.totalRequests - 1) + responseTime) / modelStats.totalRequests;
    }

    // 更新 timeline
    const date = new Date(log.timestamp).toISOString().split('T')[0];
    let timelineStats = this.statistics.timeline.find(t => t.date === date);
    if (!timelineStats) {
      timelineStats = {
        date,
        totalRequests: 0,
        totalTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0
      };
      this.statistics.timeline.push(timelineStats);
    }
    timelineStats.totalRequests++;
    timelineStats.totalTokens += totalTokens;
    timelineStats.totalInputTokens += inputTokens;
    timelineStats.totalOutputTokens += outputTokens;

    // 保存统计数据
    await this.saveStatistics();
  }

  /**
   * 获取统计数据 - 从持久化的统计数据中读取
   * @param days - 用于过滤 timeline 数据的天数
   */
  async getStatistics(days: number = 30): Promise<Statistics> {
    const now = Date.now();
    const startTime = now - days * 24 * 60 * 60 * 1000;

    // 过滤 timeline 数据
    const filteredTimeline = this.statistics.timeline.filter(t => {
      const timelineDate = new Date(t.date).getTime();
      return timelineDate >= startTime;
    });

    // 计算最近24小时的错误数
    const recentErrors = this.errorLogs.filter(log => log.timestamp >= now - 24 * 60 * 60 * 1000).length;

    return {
      ...this.statistics,
      timeline: filteredTimeline,
      errors: {
        totalErrors: this.errorLogs.length,
        recentErrors,
      },
    };
  }

  /**
   * 清空统计数据 - 重置所有统计数据为初始状态
   */
  async resetStatistics(): Promise<void> {
    this.statistics = this.createEmptyStatistics();
    await this.saveStatistics();
  }

  // Session operations
  async getOrCreateSession(
    sessionId: string,
    targetType: 'claude-code' | 'codex',
    title?: string
  ): Promise<Session> {
    let session = this.sessions.find(s => s.id === sessionId);

    if (!session) {
      const now = Date.now();
      session = {
        id: sessionId,
        targetType,
        title,
        firstRequestAt: now,
        lastRequestAt: now,
        requestCount: 1,
        totalTokens: 0,
      };
      this.sessions.push(session);
      await this.saveSessions();
    }

    return session;
  }

  async updateSession(
    sessionId: string,
    updates: {
      title?: string;
      lastRequestAt?: number;
      requestCount?: number;
      totalTokens?: number;
      vendorId?: string;
      vendorName?: string;
      serviceId?: string;
      serviceName?: string;
      model?: string;
    }
  ): Promise<boolean> {
    const session = this.sessions.find(s => s.id === sessionId);
    if (!session) return false;

    Object.assign(session, updates);
    await this.saveSessions();
    return true;
  }

  async getSessions(
    targetType?: 'claude-code' | 'codex',
    limit: number = 100,
    offset: number = 0
  ): Promise<Session[]> {
    let filtered = targetType
      ? this.sessions.filter(s => s.targetType === targetType)
      : this.sessions;

    filtered = filtered.sort((a, b) => b.lastRequestAt - a.lastRequestAt);
    return filtered.slice(offset, offset + limit);
  }

  async getSessionsCount(targetType?: 'claude-code' | 'codex'): Promise<number> {
    if (targetType) {
      return this.sessions.filter(s => s.targetType === targetType).length;
    }
    return this.sessions.length;
  }

  async getLogsBySessionId(sessionId: string, limit: number = 100): Promise<RequestLog[]> {
    const allLogs: RequestLog[] = [];

    // 遍历所有分片
    for (const shard of this.logShardsIndex) {
      const shardLogs = await this.loadLogShard(shard.filename);
      const filtered = shardLogs.filter(log => this.isLogBelongsToSession(log, sessionId));
      allLogs.push(...filtered);
    }

    return allLogs.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  /**
   * 检查日志是否属于指定 session
   */
  private isLogBelongsToSession(log: RequestLog, sessionId: string): boolean {
    // 检查 headers 中的 session_id（Codex）
    if (log.headers?.['session_id'] === sessionId) {
      return true;
    }
    // 检查 body 中的 metadata.user_id（Claude Code）
    if (log.body) {
      try {
        const body = JSON.parse(log.body);
        if (body.metadata?.user_id === sessionId) {
          return true;
        }
      } catch {
        // 忽略解析错误
      }
    }
    return false;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const index = this.sessions.findIndex(s => s.id === sessionId);
    if (index === -1) return false;

    this.sessions.splice(index, 1);
    await this.saveSessions();
    return true;
  }

  async clearSessions(): Promise<void> {
    this.sessions = [];
    await this.saveSessions();
  }

  // 新增方法：获取单个 session
  getSession(id: string): Session | null {
    return this.sessions.find(s => s.id === id) || null;
  }

  // 新增方法：创建或更新 session
  upsertSession(session: Omit<Session, 'requestCount' | 'totalTokens'> & { requestCount?: number; totalTokens?: number }): void {
    const now = Date.now();
    const existing = this.sessions.find(s => s.id === session.id);

    if (existing) {
      // 更新现有 session
      existing.lastRequestAt = now;
      existing.requestCount++;
      existing.totalTokens += session.totalTokens || 0;
      existing.vendorId = session.vendorId;
      existing.vendorName = session.vendorName;
      existing.serviceId = session.serviceId;
      existing.serviceName = session.serviceName;
      existing.model = session.model;
    } else {
      // 创建新 session
      this.sessions.push({
        id: session.id,
        targetType: session.targetType,
        title: session.title,
        firstRequestAt: session.firstRequestAt,
        lastRequestAt: now,
        requestCount: 1,
        totalTokens: session.totalTokens || 0,
        vendorId: session.vendorId,
        vendorName: session.vendorName,
        serviceId: session.serviceId,
        serviceName: session.serviceName,
        model: session.model,
      });
    }

    // 异步保存（不阻塞）
    this.saveSessions().catch(console.error);
  }

  // 新增方法：获取规则黑名单状态
  async getRuleBlacklistStatus(
    serviceId: string,
    routeId: string,
    contentType: ContentType
  ): Promise<ServiceBlacklistEntry | null> {
    const key = `${routeId}:${contentType}:${serviceId}`;
    const entry = this.blacklist.get(key);

    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.blacklist.delete(key);
      await this.saveBlacklist();
      return null;
    }

    return entry;
  }

  // Close method for compatibility (no-op for filesystem database)
  close(): void {
    // 文件系统数据库不需要关闭连接
    // 所有数据已经持久化到文件
  }
}
