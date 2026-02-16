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
  ImportResult,
  ImportPreview,
  MCPServer,
  TargetType,
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
  // 移除独立的 apiServices 存储，现在作为 vendor 的属性
  private routes: Route[] = [];
  private rules: Rule[] = [];
  private config: AppConfig | null = null;
  private sessions: Session[] = [];
  private logShardsIndex: LogShardIndex[] = [];
  private errorLogs: ErrorLog[] = [];
  private blacklist: Map<string, ServiceBlacklistEntry> = new Map();
  private mcps: MCPServer[] = [];

  // 持久化统计数据
  private statistics: Statistics = this.createEmptyStatistics();
  private contentTypeDistributionInitialized = false;
  private contentTypeDistributionInitializing = false;

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
  private get rulesFile() { return path.join(this.dataPath, 'rules.json'); } // legacy
  private get configFile() { return path.join(this.dataPath, 'config.json'); }
  private get sessionsFile() { return path.join(this.dataPath, 'sessions.json'); }
  private get logsDir() { return path.join(this.dataPath, 'logs'); }
  private get logsIndexFile() { return path.join(this.dataPath, 'logs-index.json'); }
  private get errorLogsFile() { return path.join(this.dataPath, 'error-logs.json'); }
  private get blacklistFile() { return path.join(this.dataPath, 'blacklist.json'); }
  private get statisticsFile() { return path.join(this.dataPath, 'statistics.json'); }
  private get mcpFile() { return path.join(this.dataPath, 'mcps.json'); }

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
      this.loadVendors(),  // loadVendors 内部会处理旧 services.json 的迁移
      // 删除: this.loadServices(),
      this.loadRoutes(),
      this.loadConfig(),
      this.loadSessions(),
      this.loadLogsIndex(),
      this.loadErrorLogs(),
      this.loadBlacklist(),
      this.loadStatistics(),
      this.loadMCPs(),
    ]);
  }

  private async loadVendors() {
    try {
      const data = await fs.readFile(this.vendorsFile, 'utf-8');
      this.vendors = JSON.parse(data);
    } catch {
      this.vendors = [];
    }

    // 兼容性检查：如果存在旧的 services.json，自动迁移
    await this.migrateServicesIfNeeded();
  }

  /**
   * 检测并迁移旧的 services.json 到新结构
   * 旧格式：vendors.json 和 services.json 分离
   * 新格式：vendors.json 包含嵌套的 services 数组
   */
  private async migrateServicesIfNeeded(): Promise<void> {
    const oldServicesFile = this.servicesFile;

    try {
      await fs.access(oldServicesFile);
      console.log('[Database] 发现旧的 services.json 文件，开始迁移到新结构...');

      // 读取旧服务数据
      const servicesData = await fs.readFile(oldServicesFile, 'utf-8');
      const oldServices: APIService[] = JSON.parse(servicesData);

      console.log(`[Database] 准备迁移 ${oldServices.length} 个服务...`);

      // 按 vendorId 分组
      const servicesByVendor = new Map<string, APIService[]>();
      for (const service of oldServices) {
        if (!service.vendorId) {
          console.warn(`[Database] 跳过没有 vendorId 的服务: ${service.id}`);
          continue;
        }
        if (!servicesByVendor.has(service.vendorId)) {
          servicesByVendor.set(service.vendorId, []);
        }
        // 移除 vendorId 字段，因为现在通过父级关系隐式关联
        const { vendorId, ...serviceWithoutVendorId } = service;
        servicesByVendor.get(service.vendorId)!.push(serviceWithoutVendorId as APIService);
      }

      // 合并到 vendors 数组
      let migratedCount = 0;
      for (const vendor of this.vendors) {
        const services = servicesByVendor.get(vendor.id);
        if (services) {
          vendor.services = services;
          migratedCount += services.length;
        } else {
          vendor.services = [];
        }
      }

      // 保存新的 vendors.json
      await this.saveVendors();

      console.log(`[Database] 迁移完成：${migratedCount} 个服务已迁移`);

    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // 旧文件不存在，这是正常的（新安装或已迁移）
        return;
      }
      console.error('[Database] 迁移 services 时出错:', err);
    }
  }

  private async saveVendors() {
    // 确保每个供应商都有 services 数组
    const normalizedVendors = this.vendors.map(v => ({
      ...v,
      services: v.services || []
    }));
    await fs.writeFile(this.vendorsFile, JSON.stringify(normalizedVendors, null, 2));
  }

  // loadServices 和 saveServices 已移除
  // 服务现在作为供应商的属性存储在 vendors.json 中
  // 迁移逻辑见 migrateServicesIfNeeded() 方法

  private async loadRoutes() {
    let routesFileFormat: 'missing' | 'array' | 'combined' | 'unknown' = 'missing';
    let routesFromFile: Route[] = [];
    let rulesFromFile: Rule[] = [];
    let hasRulesInRoutesFile = false;

    try {
      const data = await fs.readFile(this.routesFile, 'utf-8');
      const parsed = JSON.parse(data);

      if (Array.isArray(parsed)) {
        routesFileFormat = 'array';
        routesFromFile = parsed;
      } else if (parsed && typeof parsed === 'object') {
        routesFileFormat = 'combined';
        routesFromFile = Array.isArray(parsed.routes) ? parsed.routes : [];
        if (Array.isArray(parsed.rules)) {
          rulesFromFile = parsed.rules;
          hasRulesInRoutesFile = true;
        }
      } else {
        routesFileFormat = 'unknown';
      }
    } catch {
      routesFileFormat = 'missing';
    }

    this.routes = routesFromFile;
    this.rules = rulesFromFile;

    // 兼容旧的 rules.json 文件（迁移到 routes.json 的 rules 属性）
    await this.migrateRulesIfNeeded(routesFileFormat, hasRulesInRoutesFile);
  }

  private async saveRoutesData() {
    const payload = {
      routes: this.routes,
      rules: this.rules,
    };
    await fs.writeFile(this.routesFile, JSON.stringify(payload, null, 2));
  }

  private async saveRoutes() {
    await this.saveRoutesData();
  }

  private async saveRules() {
    await this.saveRoutesData();
  }

  /**
   * 检测并迁移旧的 rules.json 到 routes.json 的 rules 属性
   * 旧格式：routes.json + rules.json 分离
   * 新格式：routes.json 内包含 { routes, rules }
   */
  private async migrateRulesIfNeeded(
    routesFileFormat: 'missing' | 'array' | 'combined' | 'unknown',
    hasRulesInRoutesFile: boolean
  ): Promise<void> {
    const oldRulesFile = this.rulesFile;

    const oldRulesExists = await fs.access(oldRulesFile)
      .then(() => true)
      .catch(() => false);

    let merged = false;

    if (oldRulesExists) {
      try {
        const data = await fs.readFile(oldRulesFile, 'utf-8');
        const oldRules = JSON.parse(data);

        if (Array.isArray(oldRules)) {
          if (this.rules.length > 0) {
            const mergedMap = new Map<string, Rule>();
            oldRules.forEach((rule, index) => {
              const key = rule?.id || `legacy-${index}`;
              if (!mergedMap.has(key)) {
                mergedMap.set(key, rule);
              }
            });
            this.rules.forEach((rule, index) => {
              const key = rule?.id || `current-${index}`;
              mergedMap.set(key, rule);
            });
            this.rules = Array.from(mergedMap.values());
          } else {
            this.rules = oldRules;
          }
          merged = true;
        }
      } catch (error) {
        console.error('[Database] 迁移 rules.json 时出错:', error);
      }
    }

    // 如果 routes.json 还是旧格式/缺失，或从旧 rules.json 合并过数据，或缺少 rules 字段，则写入新格式
    if (routesFileFormat !== 'combined' || merged || (routesFileFormat === 'combined' && !hasRulesInRoutesFile)) {
      await this.saveRoutesData();
    }
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
      this.contentTypeDistributionInitialized = this.statistics.contentTypeDistribution.length > 0;
    } catch {
      this.statistics = this.createEmptyStatistics();
      this.contentTypeDistributionInitialized = false;
      // 创建空文件
      await this.saveStatistics();
    }
  }

  private async saveStatistics() {
    await fs.writeFile(this.statisticsFile, JSON.stringify(this.statistics, null, 2));
  }

  private async loadMCPs() {
    try {
      const data = await fs.readFile(this.mcpFile, 'utf-8');
      this.mcps = JSON.parse(data);
    } catch {
      this.mcps = [];
    }
  }

  private async saveMCPs() {
    await fs.writeFile(this.mcpFile, JSON.stringify(this.mcps, null, 2));
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

  // 新增：获取单个供应商（带服务）
  getVendor(id: string): Vendor | undefined {
    return this.vendors.find(v => v.id === id);
  }

  async createVendor(vendor: Omit<Vendor, 'id' | 'createdAt' | 'updatedAt'>): Promise<Vendor> {
    console.log('[数据库] 创建供应商，输入数据:', JSON.stringify(vendor, null, 2));
    const id = crypto.randomUUID();
    const now = Date.now();
    const newVendor: Vendor = {
      ...vendor,
      id,
      services: vendor.services || [],  // 确保 services 字段存在
      createdAt: now,
      updatedAt: now
    };
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
      services: vendor.services !== undefined ? vendor.services : this.vendors[index].services,
      updatedAt: now,
    };
    await this.saveVendors();
    return true;
  }

  async deleteVendor(id: string): Promise<boolean> {
    const index = this.vendors.findIndex(v => v.id === id);
    if (index === -1) return false;

    // 检查是否有服务被规则使用
    const vendor = this.vendors[index];
    const serviceIds = (vendor.services || []).map(s => s.id);
    const rulesUsingServices = this.rules.filter(r => serviceIds.includes(r.targetServiceId));

    if (rulesUsingServices.length > 0) {
      throw new Error(`无法删除供应商：有 ${rulesUsingServices.length} 个路由规则正在使用该供应商的服务`);
    }

    this.vendors.splice(index, 1);
    await this.saveVendors();
    return true;
  }

  // API Service operations
  getAPIServices(vendorId?: string): APIService[] {
    if (vendorId) {
      const vendor = this.vendors.find(v => v.id === vendorId);
      if (!vendor) return [];

      // 返回指定供应商的服务，并添加 vendorId
      return (vendor.services || []).map(service => ({
        ...service,
        vendorId: vendor.id  // 添加 vendorId 以便前端使用
      }));
    }

    // 返回所有供应商的所有服务（扁平化），并添加 vendorId
    const allServices: APIService[] = [];
    for (const vendor of this.vendors) {
      if (vendor.services) {
        const servicesWithVendorId = vendor.services.map(service => ({
          ...service,
          vendorId: vendor.id  // 添加 vendorId 以便前端使用
        }));
        allServices.push(...servicesWithVendorId);
      }
    }

    return allServices.sort((a, b) => b.createdAt - a.createdAt);
  }

  // 新增：通过 ID 获取服务
  getAPIService(id: string): APIService | undefined {
    for (const vendor of this.vendors) {
      const service = vendor.services?.find(s => s.id === id);
      if (service) {
        return service;
      }
    }
    return undefined;
  }

  // 新增：获取服务所属的供应商
  getVendorByServiceId(serviceId: string): Vendor | undefined {
    for (const vendor of this.vendors) {
      if (vendor.services?.some(s => s.id === serviceId)) {
        return vendor;
      }
    }
    return undefined;
  }

  async createAPIService(service: Omit<APIService, 'id' | 'createdAt' | 'updatedAt'>): Promise<APIService> {
    console.log('[数据库] 创建服务，输入数据:', JSON.stringify(service, null, 2));

    // 从 vendorId 找到供应商
    const vendorId = (service as any).vendorId;
    if (!vendorId) {
      throw new Error('创建服务时必须提供 vendorId');
    }

    const vendor = this.vendors.find(v => v.id === vendorId);
    if (!vendor) {
      throw new Error(`供应商不存在: ${vendorId}`);
    }

    // 移除 vendorId 字段（数据存储时不需要）
    const { vendorId: _, ...serviceData } = service as any;

    const id = crypto.randomUUID();
    const now = Date.now();
    const newService: APIService = {
      ...serviceData,
      id,
      createdAt: now,
      updatedAt: now
    };

    console.log('[数据库] 创建服务，最终数据:', JSON.stringify(newService, null, 2));

    if (!vendor.services) {
      vendor.services = [];
    }
    vendor.services.push(newService);

    // 更新供应商的 updatedAt 时间
    vendor.updatedAt = now;

    await this.saveVendors();
    console.log('[数据库] 服务已保存，当前总数:', vendor.services.length);
    return {
      ...newService,
      vendorId,
    };
  }

  async updateAPIService(id: string, service: Partial<APIService>): Promise<boolean> {
    // 查找服务所属的供应商
    const vendor = this.getVendorByServiceId(id);
    if (!vendor) return false;

    const index = vendor.services!.findIndex(s => s.id === id);
    if (index === -1) return false;

    const now = Date.now();
    vendor.services![index] = {
      ...vendor.services![index],
      ...service,
      id,
      updatedAt: now,
    };

    // 更新供应商的 updatedAt 时间
    vendor.updatedAt = now;

    await this.saveVendors();

    // 同步规则的超量限制
    await this.syncRulesWithServiceLimits(id, service);

    return true;
  }

  async deleteAPIService(id: string): Promise<boolean> {
    // 查找服务所属的供应商
    const vendor = this.getVendorByServiceId(id);
    if (!vendor) return false;

    const index = vendor.services!.findIndex(s => s.id === id);
    if (index === -1) return false;

    // 检查是否有规则正在使用此服务
    const rulesUsingService = this.rules.filter(r => r.targetServiceId === id);
    if (rulesUsingService.length > 0) {
      throw new Error(`无法删除服务：有 ${rulesUsingService.length} 个路由规则正在使用此服务`);
    }

    vendor.services!.splice(index, 1);

    // 更新供应商的 updatedAt 时间
    vendor.updatedAt = Date.now();

    await this.saveVendors();
    return true;
  }

  private async syncRulesWithServiceLimits(serviceId: string, _service: Partial<APIService>): Promise<void> {
    const relatedRules = this.rules.filter(r => r.targetServiceId === serviceId);
    if (relatedRules.length === 0) return;

    const now = Date.now();
    const currentService = this.getAPIService(serviceId);
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
    const contentType = this.resolveLogContentType(log);
    const logWithId = { ...log, contentType, id };

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

  /**
   * 当前支持的导出数据版本
   */
  private readonly CURRENT_EXPORT_VERSION = '3.0.0';

  /**
   * 验证供应商数据格式
   */
  private validateVendor(vendor: any, index: number): { valid: boolean; error?: string } {
    if (!vendor || typeof vendor !== 'object') {
      return { valid: false, error: `供应商[${index}] 不是有效的对象` };
    }
    if (!vendor.id || typeof vendor.id !== 'string') {
      return { valid: false, error: `供应商[${index}] 缺少有效的 id 字段` };
    }
    if (!vendor.name || typeof vendor.name !== 'string') {
      return { valid: false, error: `供应商[${index}](${vendor.id}) 缺少有效的 name 字段` };
    }
    if (!Array.isArray(vendor.services)) {
      return { valid: false, error: `供应商[${index}](${vendor.id}) 的 services 不是数组` };
    }
    for (let i = 0; i < vendor.services.length; i++) {
      const service = vendor.services[i];
      if (!service || typeof service !== 'object') {
        return { valid: false, error: `供应商[${index}](${vendor.id}) 的服务[${i}] 不是有效的对象` };
      }
      if (!service.id || typeof service.id !== 'string') {
        return { valid: false, error: `供应商[${index}](${vendor.id}) 的服务[${i}] 缺少有效的 id 字段` };
      }
      if (!service.name || typeof service.name !== 'string') {
        return { valid: false, error: `供应商[${index}](${vendor.id}) 的服务[${i}] 缺少有效的 name 字段` };
      }
      if (!service.apiUrl || typeof service.apiUrl !== 'string') {
        return { valid: false, error: `供应商[${index}](${vendor.id}) 的服务[${i}] 缺少有效的 apiUrl 字段` };
      }
      if (!service.apiKey || typeof service.apiKey !== 'string') {
        return { valid: false, error: `供应商[${index}](${vendor.id}) 的服务[${i}] 缺少有效的 apiKey 字段` };
      }
    }
    return { valid: true };
  }

  /**
   * 验证路由数据格式
   */
  private validateRoute(route: any, index: number): { valid: boolean; error?: string } {
    if (!route || typeof route !== 'object') {
      return { valid: false, error: `路由[${index}] 不是有效的对象` };
    }
    if (!route.id || typeof route.id !== 'string') {
      return { valid: false, error: `路由[${index}] 缺少有效的 id 字段` };
    }
    if (!route.name || typeof route.name !== 'string') {
      return { valid: false, error: `路由[${index}](${route.id}) 缺少有效的 name 字段` };
    }
    if (!route.targetType || !['claude-code', 'codex'].includes(route.targetType)) {
      return { valid: false, error: `路由[${index}](${route.id}) 的 targetType 必须是 'claude-code' 或 'codex'` };
    }
    if (typeof route.isActive !== 'boolean') {
      return { valid: false, error: `路由[${index}](${route.id}) 的 isActive 必须是布尔值` };
    }
    return { valid: true };
  }

  /**
   * 验证规则数据格式
   */
  private validateRule(rule: any, index: number): { valid: boolean; error?: string } {
    if (!rule || typeof rule !== 'object') {
      return { valid: false, error: `规则[${index}] 不是有效的对象` };
    }
    if (!rule.id || typeof rule.id !== 'string') {
      return { valid: false, error: `规则[${index}] 缺少有效的 id 字段` };
    }
    if (!rule.routeId || typeof rule.routeId !== 'string') {
      return { valid: false, error: `规则[${index}](${rule.id}) 缺少有效的 routeId 字段` };
    }
    if (!rule.targetServiceId || typeof rule.targetServiceId !== 'string') {
      return { valid: false, error: `规则[${index}](${rule.id}) 缺少有效的 targetServiceId 字段` };
    }
    const validContentTypes = ['default', 'background', 'thinking', 'long-context', 'image-understanding', 'model-mapping'];
    if (!rule.contentType || !validContentTypes.includes(rule.contentType)) {
      return { valid: false, error: `规则[${index}](${rule.id}) 的 contentType 无效` };
    }
    return { valid: true };
  }

  /**
   * 验证配置数据格式
   */
  private validateConfig(config: any): { valid: boolean; error?: string } {
    if (!config || typeof config !== 'object') {
      return { valid: false, error: 'config 不是有效的对象' };
    }
    return { valid: true };
  }

  /**
   * 验证导出数据格式（严格校验）
   */
  private validateExportData(data: any): { valid: boolean; error?: string } {
    if (!data || typeof data !== 'object') {
      return { valid: false, error: '数据不是有效的对象' };
    }

    // 检查必需字段是否存在
    if (!data.version || typeof data.version !== 'string') {
      return { valid: false, error: '缺少有效的 version 字段' };
    }

    // 检查版本是否匹配当前版本
    if (data.version !== this.CURRENT_EXPORT_VERSION) {
      return { valid: false, error: `数据版本 ${data.version} 与当前支持的版本 ${this.CURRENT_EXPORT_VERSION} 不匹配。请使用相同版本的系统导出数据。` };
    }

    if (!data.exportDate || typeof data.exportDate !== 'number') {
      return { valid: false, error: '缺少有效的 exportDate 字段' };
    }

    // 检查 vendors
    if (!Array.isArray(data.vendors)) {
      return { valid: false, error: 'vendors 不是数组' };
    }
    for (let i = 0; i < data.vendors.length; i++) {
      const result = this.validateVendor(data.vendors[i], i);
      if (!result.valid) return result;
    }

    // 检查 routes
    if (!Array.isArray(data.routes)) {
      return { valid: false, error: 'routes 不是数组' };
    }
    for (let i = 0; i < data.routes.length; i++) {
      const result = this.validateRoute(data.routes[i], i);
      if (!result.valid) return result;
    }

    // 检查 rules
    if (!Array.isArray(data.rules)) {
      return { valid: false, error: 'rules 不是数组' };
    }
    for (let i = 0; i < data.rules.length; i++) {
      const result = this.validateRule(data.rules[i], i);
      if (!result.valid) return result;
    }

    // 检查 config
    const configResult = this.validateConfig(data.config);
    if (!configResult.valid) return configResult;

    return { valid: true };
  }

  async exportData(password: string): Promise<string> {
    // 只导出当前格式，不再兼容旧格式
    const exportData: ExportData = {
      version: this.CURRENT_EXPORT_VERSION,
      exportDate: Date.now(),
      vendors: this.vendors,
      apiServices: [], // 保留字段以兼容类型定义，但内容为空
      routes: this.routes,
      rules: this.rules,
      config: this.config!,
    };

    const jsonData = JSON.stringify(exportData);
    const encrypted = CryptoJS.AES.encrypt(jsonData, password).toString();
    return encrypted;
  }

  /**
   * 预览导入数据
   */
  async previewImportData(encryptedData: string, password: string): Promise<ImportPreview> {
    try {
      // 解密
      let jsonData: string;
      try {
        const decrypted = CryptoJS.AES.decrypt(encryptedData, password);
        jsonData = decrypted.toString(CryptoJS.enc.Utf8);
        if (!jsonData) {
          return { success: false, message: '解密失败：密码错误或数据损坏' };
        }
      } catch (error) {
        return { success: false, message: '解密失败：密码错误或数据格式错误' };
      }

      // 解析 JSON
      let importData: any;
      try {
        importData = JSON.parse(jsonData);
      } catch (error) {
        return { success: false, message: '数据解析失败：不是有效的 JSON 格式' };
      }

      // 验证数据格式
      const validation = this.validateExportData(importData);
      if (!validation.valid) {
        return { success: false, message: `数据验证失败：${validation.error}` };
      }

      // 计算服务数量
      const servicesCount = importData.vendors.reduce((sum: number, v: Vendor) => sum + (v.services?.length || 0), 0);

      return {
        success: true,
        data: {
          vendors: importData.vendors.length,
          services: servicesCount,
          routes: importData.routes.length,
          rules: importData.rules.length,
          exportDate: importData.exportDate,
          version: importData.version,
        }
      };
    } catch (error) {
      console.error('Preview import error:', error);
      return { success: false, message: `预览失败：${error instanceof Error ? error.message : '未知错误'}` };
    }
  }

  async importData(encryptedData: string, password: string): Promise<ImportResult> {
    try {
      // 解密
      let jsonData: string;
      try {
        const decrypted = CryptoJS.AES.decrypt(encryptedData, password);
        jsonData = decrypted.toString(CryptoJS.enc.Utf8);
        if (!jsonData) {
          return { success: false, message: '导入失败', details: '解密失败：密码错误或数据损坏' };
        }
      } catch (error) {
        return { success: false, message: '导入失败', details: '解密失败：密码错误或数据格式错误' };
      }

      // 解析 JSON
      let importData: any;
      try {
        importData = JSON.parse(jsonData);
      } catch (error) {
        return { success: false, message: '导入失败', details: '数据解析失败：不是有效的 JSON 格式' };
      }

      // 验证数据格式
      const validation = this.validateExportData(importData);
      if (!validation.valid) {
        return { success: false, message: '导入失败', details: `数据验证失败：${validation.error}` };
      }

      // 导入数据（更新 updatedAt）
      const now = Date.now();
      this.vendors = importData.vendors.map((v: Vendor) => ({
        ...v,
        updatedAt: now
      }));
      this.routes = importData.routes.map((r: Route) => ({
        ...r,
        updatedAt: now
      }));
      this.rules = importData.rules.map((r: Rule) => ({
        ...r,
        updatedAt: now
      }));
      this.config = {
        ...importData.config,
        updatedAt: now
      };

      // 保存数据
      await Promise.all([
        this.saveVendors(),
        this.saveRoutes(),
        this.saveConfig(),
      ]);

      const servicesCount = this.vendors.reduce((sum, v) => sum + (v.services?.length || 0), 0);
      return {
        success: true,
        message: '导入成功',
        details: `已导入 ${this.vendors.length} 个供应商、${servicesCount} 个服务、${this.routes.length} 个路由、${this.rules.length} 个规则`
      };
    } catch (error) {
      console.error('Import error:', error);
      return {
        success: false,
        message: '导入失败',
        details: error instanceof Error ? error.message : '未知错误'
      };
    }
  }

  private inferContentTypeFromLog(log: Omit<RequestLog, 'id'>): ContentType {
    const requestModel = log.requestModel?.toLowerCase() || '';
    let bodyText = '';

    if (typeof log.body === 'string') {
      bodyText = log.body;
    } else if (log.body !== undefined) {
      try {
        bodyText = JSON.stringify(log.body);
      } catch {
        bodyText = '';
      }
    }

    const lowerBody = bodyText.toLowerCase();

    if (lowerBody.includes('image') || lowerBody.includes('base64')) {
      return 'image-understanding';
    }
    if (requestModel.includes('think')) {
      return 'thinking';
    }
    if ((log.usage?.inputTokens || 0) > 12000) {
      return 'long-context';
    }

    return 'default';
  }

  private resolveLogContentType(log: Omit<RequestLog, 'id'>): ContentType {
    if (log.contentType) {
      return log.contentType;
    }

    if (log.ruleId) {
      const rule = this.getRule(log.ruleId);
      if (rule?.contentType) {
        return rule.contentType;
      }
    }

    return this.inferContentTypeFromLog(log);
  }

  private async ensureContentTypeDistribution(): Promise<void> {
    if (this.contentTypeDistributionInitialized || this.contentTypeDistributionInitializing) {
      return;
    }

    this.contentTypeDistributionInitializing = true;
    try {
      if (this.logShardsIndex.length === 0) {
        this.contentTypeDistributionInitialized = true;
        return;
      }

      const counts = new Map<ContentType, number>();
      let totalRequests = 0;

      for (const shard of this.logShardsIndex) {
        const shardLogs = await this.loadLogShard(shard.filename);
        for (const log of shardLogs) {
          totalRequests++;
          const contentType = this.resolveLogContentType(log);
          counts.set(contentType, (counts.get(contentType) || 0) + 1);
        }
      }

      this.statistics.contentTypeDistribution = Array.from(counts.entries()).map(([contentType, count]) => ({
        contentType,
        count,
        percentage: totalRequests > 0 ? Math.round((count / totalRequests) * 100) : 0,
      }));

      this.contentTypeDistributionInitialized = true;
      await this.saveStatistics();
    } finally {
      this.contentTypeDistributionInitializing = false;
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

    // 更新 contentTypeDistribution
    const resolvedContentType = this.resolveLogContentType(log);
    let contentTypeStats = this.statistics.contentTypeDistribution.find(s => s.contentType === resolvedContentType);
    if (!contentTypeStats) {
      contentTypeStats = { contentType: resolvedContentType, count: 0, percentage: 0 };
      this.statistics.contentTypeDistribution.push(contentTypeStats);
    }
    contentTypeStats.count++;
    const totalRequests = this.statistics.overview.totalRequests;
    for (const entry of this.statistics.contentTypeDistribution) {
      entry.percentage = totalRequests > 0 ? Math.round((entry.count / totalRequests) * 100) : 0;
    }
    this.contentTypeDistributionInitialized = true;

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
    await this.ensureContentTypeDistribution();

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
        // body 可能是对象（已解析）或字符串（未解析）
        const body = typeof log.body === 'string' ? JSON.parse(log.body) : log.body;
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

  // MCP 工具相关操作
  getMCPs(): MCPServer[] {
    return this.mcps.sort((a, b) => b.createdAt - a.createdAt);
  }

  getMCP(id: string): MCPServer | undefined {
    return this.mcps.find(m => m.id === id);
  }

  getMCPsByTarget(targetType: TargetType): MCPServer[] {
    return this.mcps.filter(m => m.targets?.includes(targetType));
  }

  async createMCP(mcp: Omit<MCPServer, 'id' | 'createdAt' | 'updatedAt'>): Promise<MCPServer> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const newMCP: MCPServer = {
      ...mcp,
      id,
      createdAt: now,
      updatedAt: now,
    };
    this.mcps.push(newMCP);
    await this.saveMCPs();
    return newMCP;
  }

  async updateMCP(id: string, mcp: Partial<MCPServer>): Promise<boolean> {
    const index = this.mcps.findIndex(m => m.id === id);
    if (index === -1) return false;

    const now = Date.now();
    this.mcps[index] = {
      ...this.mcps[index],
      ...mcp,
      id,
      updatedAt: now,
    };
    await this.saveMCPs();
    return true;
  }

  async deleteMCP(id: string): Promise<boolean> {
    const index = this.mcps.findIndex(m => m.id === id);
    if (index === -1) return false;

    this.mcps.splice(index, 1);
    await this.saveMCPs();
    return true;
  }

  // Close method for compatibility (no-op for filesystem database)
  close(): void {
    // 文件系统数据库不需要关闭连接
    // 所有数据已经持久化到文件
  }
}
