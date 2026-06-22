import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import CryptoJS from 'crypto-js';
import { LogStore } from './log-store';
import type { LogQueryOpts, LogQueryResult } from './log-store/types';
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
  CodexReasoningEffort,
  ClaudeEffortLevel,
  ClaudePermissionDefaultMode,
  ApiPathBinding,
  ToolName,
  ToolBindings,
} from '../types';
import { migrateSourceType, isLegacySourceType, normalizeSourceType } from './type-migration';

const VALID_CODEX_REASONING_EFFORTS: CodexReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = 'high';
const DEFAULT_FAILOVER_RECOVERY_SECONDS = 30;

const VALID_CLAUDE_EFFORT_LEVELS: ClaudeEffortLevel[] = ['low', 'medium', 'high', 'max'];
const DEFAULT_CLAUDE_EFFORT_LEVEL: ClaudeEffortLevel = 'medium';

const VALID_CLAUDE_PERMISSION_DEFAULT_MODES: ClaudePermissionDefaultMode[] =
  ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const DEFAULT_CLAUDE_PERMISSION_DEFAULT_MODE: ClaudePermissionDefaultMode = 'default';

const isCodexReasoningEffort = (value: unknown): value is CodexReasoningEffort => {
  return typeof value === 'string' && VALID_CODEX_REASONING_EFFORTS.includes(value as CodexReasoningEffort);
};

const isClaudeEffortLevel = (value: unknown): value is ClaudeEffortLevel => {
  return typeof value === 'string' && VALID_CLAUDE_EFFORT_LEVELS.includes(value as ClaudeEffortLevel);
};

const isClaudePermissionDefaultMode = (value: unknown): value is ClaudePermissionDefaultMode => {
  return typeof value === 'string' && VALID_CLAUDE_PERMISSION_DEFAULT_MODES.includes(value as ClaudePermissionDefaultMode);
};

const isValidAutocompactPct = (v: unknown): v is number => {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100;
};

const normalizeFailoverRecoverySeconds = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_FAILOVER_RECOVERY_SECONDS;
  }
  return Math.floor(parsed);
};

/**
 * 基于文件系统的数据库管理器
 * 使用 JSON 文件存储数据，无需编译依赖
 */
export class FileSystemDatabaseManager {
  private dataPath: string;
  private logStore: LogStore | null = null;
  private vendors: Vendor[] = [];
  // 移除独立的 apiServices 存储，现在作为 vendor 的属性
  private routes: Route[] = [];
  private rules: Rule[] = [];
  private config: AppConfig | null = null;
  private sessions: Session[] = [];
  private errorLogs: ErrorLog[] = [];
  private blacklist: Map<string, ServiceBlacklistEntry> = new Map();
  private mcps: MCPServer[] = [];
  private apiPathBindingsData: ApiPathBinding[] = [];
  private apiPathModelsData = '';
  private toolBindings: ToolBindings = {
    'claude-code': { tool: 'claude-code', routeId: null },
    'codex': { tool: 'codex', routeId: null },
  };

  // 持久化统计数据
  private statistics: Statistics = this.createEmptyStatistics();
  private contentTypeDistributionInitialized = false;
  private contentTypeDistributionInitializing = false;

  // 缓存机制
  private logsCountCache: { count: number; timestamp: number } | null = null;
  private errorLogsCountCache: { count: number; timestamp: number } | null = null;
  private readonly CACHE_TTL = 1000;

  // 日志保留期（委托 LogStore.retain）
  private readonly MAX_ERROR_LOG_FIELD_SIZE = 256 * 1024; // 256KB 单个字段最大长度
  private readonly LOG_RETENTION_DAYS = 30;

  // 文件路径
  private get vendorsFile() { return path.join(this.dataPath, 'vendors.json'); }
  private get servicesFile() { return path.join(this.dataPath, 'services.json'); }
  private get routesFile() { return path.join(this.dataPath, 'routes.json'); }
  private get rulesFile() { return path.join(this.dataPath, 'rules.json'); } // legacy
  private get configFile() { return path.join(this.dataPath, 'config.json'); }
  private get sessionsFile() { return path.join(this.dataPath, 'sessions.json'); }
  private get errorLogsFile() { return path.join(this.dataPath, 'error-logs.json'); }
  private get blacklistFile() { return path.join(this.dataPath, 'blacklist.json'); }
  private get statisticsFile() { return path.join(this.dataPath, 'statistics.json'); }
  private get mcpFile() { return path.join(this.dataPath, 'mcps.json'); }
  private get toolBindingsFile() { return path.join(this.dataPath, 'tool-bindings.json'); }
  private get apiPathBindingsFile() { return path.join(this.dataPath, 'api-path-bindings.json'); }

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

  /** 注入共享 LogStore（由 main.ts 在启动时调用）。日志存取统一委托给它。 */
  setLogStore(ls: LogStore) {
    this.logStore = ls;
  }

  getLogStore(): LogStore | null {
    return this.logStore;
  }

  private requireLogStore(): LogStore {
    if (!this.logStore) {
      throw new Error('LogStore not initialized');
    }
    return this.logStore;
  }

  async initialize() {
    // 确保数据目录存在
    await fs.mkdir(this.dataPath, { recursive: true });

    // 加载所有数据
    await this.loadAllData();

    // 执行数据源类型迁移（在加载数据之后）
    await this.migrateSourceTypes();
    // 路由级工具配置迁移到全局配置（兼容旧版本）
    await this.migrateRouteToolSettingsToGlobalConfig();

    // 确保默认配置
    await this.ensureDefaultConfig();
  }

  /**
   * 执行延迟的维护任务（启动后异步执行，不阻塞服务启动）。
   * 旧数据迁移已在 main.ts 中 pre-listen 完成；这里只做保留期清理。
   */
  async deferredMaintenance(): Promise<void> {
    if (!this.logStore) return;
    try {
      await this.logStore.retain('global', this.LOG_RETENTION_DAYS);
      console.log('[Database] LogStore deferred maintenance completed');
    } catch (err) {
      console.error('[Database] LogStore deferred maintenance failed:', err);
    }
  }

  private async loadAllData() {
    await Promise.all([
      this.loadVendors(),  // loadVendors 内部会处理旧 services.json 的迁移
      // 删除: this.loadServices(),
      this.loadRoutes(),
      this.loadConfig(),
      this.loadSessions(),
      this.loadErrorLogs(),
      this.loadBlacklist(),
      this.loadStatistics(),
      this.loadMCPs(),
      this.loadApiPathBindings(),
      this.loadToolBindings(),
    ]);
    // 日志存取已委托给 LogStore，不再在此加载旧分片索引
  }

  private async loadVendors() {
    let needSave = false;
    try {
      const data = await fs.readFile(this.vendorsFile, 'utf-8');
      const parsed = JSON.parse(data);
      this.vendors = Array.isArray(parsed) ? parsed.map((vendor: Vendor) => {
        const normalizedServices = Array.isArray(vendor.services)
          ? vendor.services.map((service: APIService) => {
            const normalizedService: APIService = {
              ...service,
              apiKey: typeof service.apiKey === 'string' ? service.apiKey : '',
              inheritVendorApiKey: service.inheritVendorApiKey === true,
              inheritVendorApiBaseUrl: service.inheritVendorApiBaseUrl === true,
            };
            if (
              normalizedService.apiKey !== service.apiKey ||
              normalizedService.inheritVendorApiKey !== service.inheritVendorApiKey ||
              normalizedService.inheritVendorApiBaseUrl !== service.inheritVendorApiBaseUrl
            ) {
              needSave = true;
            }
            return normalizedService;
          })
          : [];

        const normalizedVendor: Vendor = {
          ...vendor,
          apiKey: typeof vendor.apiKey === 'string' ? vendor.apiKey : '',
          services: normalizedServices,
        };

        if (
          normalizedVendor.apiKey !== vendor.apiKey ||
          !Array.isArray(vendor.services)
        ) {
          needSave = true;
        }

        return normalizedVendor;
      }) : [];
    } catch {
      this.vendors = [];
    }

    // 兼容性检查：如果存在旧的 services.json，自动迁移
    await this.migrateServicesIfNeeded();
    if (needSave) {
      await this.saveVendors();
    }
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

  /**
   * 迁移数据源类型（在初始化时执行）
   * 处理 vendors.json 中的 services[].sourceType
   * 将旧类型 ('claude-code', 'openai-responses') 迁移为新类型 ('claude', 'openai')
   */
  private async migrateSourceTypes(): Promise<void> {
    console.log('[TypeMigration] Checking for source type migration...');

    let needsMigration = false;

    // 检查是否需要迁移
    for (const vendor of this.vendors) {
      if (vendor.services) {
        for (const service of vendor.services) {
          if (service.sourceType && isLegacySourceType(service.sourceType)) {
            needsMigration = true;
            break;
          }
        }
      }
      if (needsMigration) break;
    }

    if (!needsMigration) {
      console.log('[TypeMigration] No migration needed');
      return;
    }

    console.log('[TypeMigration] Starting source type migration...');

    // 备份当前数据到 ~/.aicodeswitch/backup/YYYY-MM-DD-HH-MM/
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}-${hours}-${minutes}`;

    const appDir = path.dirname(this.dataPath); // ~/.aicodeswitch/
    const backupBaseDir = path.join(appDir, 'backup');
    const backupDir = path.join(backupBaseDir, dateStr);
    await fs.mkdir(backupDir, { recursive: true });

    const vendorsBackupPath = path.join(backupDir, 'vendors.json');
    await fs.writeFile(vendorsBackupPath, JSON.stringify(this.vendors, null, 2));
    console.log(`[TypeMigration] Backup created: ${vendorsBackupPath}`);

    // 执行迁移
    let migratedCount = 0;
    for (const vendor of this.vendors) {
      if (vendor.services) {
        for (const service of vendor.services) {
          if (service.sourceType && isLegacySourceType(service.sourceType)) {
            const oldType = service.sourceType;
            service.sourceType = migrateSourceType(service.sourceType);
            console.log(`[TypeMigration] Migrated service "${service.name}": ${oldType} -> ${service.sourceType}`);
            migratedCount++;
          }
        }
      }
    }

    // 保存迁移后的数据
    await this.saveVendors();
    console.log(`[TypeMigration] Migration completed. Migrated ${migratedCount} services.`);
  }

  /**
   * 迁移导入数据中的类型
   * 用于导入功能，自动将旧类型转换为新类型
   */
  private migrateVendorsOnImport(vendors: Vendor[]): Vendor[] {
    return vendors.map(vendor => ({
      ...vendor,
      services: vendor.services?.map(service => {
        return {
          ...service,
          sourceType: service.sourceType ? normalizeSourceType(service.sourceType) : undefined
        };
      })
    }));
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

  private async loadToolBindings(): Promise<void> {
    try {
      const data = await fs.readFile(this.toolBindingsFile, 'utf-8');
      const parsed = JSON.parse(data);
      // Merge with defaults to handle new tools
      this.toolBindings = {
        'claude-code': parsed['claude-code'] || { tool: 'claude-code', routeId: null },
        'codex': parsed['codex'] || { tool: 'codex', routeId: null },
      };
    } catch {
      // File doesn't exist yet, use defaults
      this.toolBindings = {
        'claude-code': { tool: 'claude-code', routeId: null },
        'codex': { tool: 'codex', routeId: null },
      };
    }
  }

  private async saveToolBindings(): Promise<void> {
    await fs.writeFile(this.toolBindingsFile, JSON.stringify(this.toolBindings, null, 2));
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
    try {
      await fs.writeFile(this.errorLogsFile, JSON.stringify(this.errorLogs, null, 2));
    } catch (e) {
      console.error('[DB] Failed to save error logs, clearing to prevent crash:', e);
      this.errorLogs = [];
      await fs.writeFile(this.errorLogsFile, '[]');
    }
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

  private async loadApiPathBindings() {
    const defaults: ApiPathBinding[] = [
      { apiPath: '/v1/messages', routeId: null },
      { apiPath: '/v1/responses', routeId: null },
      { apiPath: '/v1/chat/completions', routeId: null },
      { apiPath: '/v1beta/models', routeId: null },
      { apiPath: '/v1/models', routeId: null },
    ];
    try {
      const data = await fs.readFile(this.apiPathBindingsFile, 'utf-8');
      const parsed = JSON.parse(data);
      this.apiPathBindingsData = parsed.bindings || defaults;
      this.apiPathModelsData = parsed.models || '';
    } catch {
      this.apiPathBindingsData = defaults;
      this.apiPathModelsData = '';
      await this.saveApiPathBindings();
    }
  }

  private async saveApiPathBindings() {
    await fs.writeFile(this.apiPathBindingsFile, JSON.stringify({
      bindings: this.apiPathBindingsData,
      models: this.apiPathModelsData,
    }, null, 2));
  }

  getApiPathBindings(): ApiPathBinding[] {
    return this.apiPathBindingsData;
  }

  getApiPathModels(): string {
    return this.apiPathModelsData;
  }

  async updateApiPathBindings(bindings: ApiPathBinding[], models?: string): Promise<void> {
    this.apiPathBindingsData = bindings;
    if (models !== undefined) {
      this.apiPathModelsData = models;
    }
    await this.saveApiPathBindings();
  }

  private async saveMCPs() {
    await fs.writeFile(this.mcpFile, JSON.stringify(this.mcps, null, 2));
  }

  private async ensureDefaultConfig() {
    const current = this.config;
    const defaults: AppConfig = {
      enableLogging: true,
      logRetentionDays: 30,
      maxLogSize: 100000,
      enableFailover: true,
      failoverRecoverySeconds: DEFAULT_FAILOVER_RECOVERY_SECONDS,
      ruleGlobalTimeout: undefined,
      enableAgentTeams: false,
      enableBypassPermissionsSupport: false,
      claudePermissionsDefaultMode: DEFAULT_CLAUDE_PERMISSION_DEFAULT_MODE,
      claudeEffortLevel: DEFAULT_CLAUDE_EFFORT_LEVEL,
      autocompactPctOverride: undefined,
      claudeDefaultModel: undefined,
      codexModelReasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
      codexDefaultModel: undefined,
      proxyEnabled: false,
      proxyUrl: '',
      proxyUsername: '',
      proxyPassword: '',
      enableLanDiscovery: false,
    };




    // spread: current 覆盖 defaults，未来新增字段自动保留
    this.config = { ...defaults, ...current };

    // 校验归一化（与 updateConfig 保持一致）
    if (!isCodexReasoningEffort(this.config.codexModelReasoningEffort)) {
      this.config.codexModelReasoningEffort = DEFAULT_CODEX_REASONING_EFFORT;
    }
    if (!isClaudeEffortLevel(this.config.claudeEffortLevel)) {
      this.config.claudeEffortLevel = DEFAULT_CLAUDE_EFFORT_LEVEL;
    }
    if (!isClaudePermissionDefaultMode(this.config.claudePermissionsDefaultMode)) {
      // 缺失或非法时，按旧 enableBypassPermissionsSupport 推导（迁移兼容）
      this.config.claudePermissionsDefaultMode = this.config.enableBypassPermissionsSupport === true
        ? 'bypassPermissions'
        : DEFAULT_CLAUDE_PERMISSION_DEFAULT_MODE;
    }
    if (typeof this.config.autocompactPctOverride !== 'undefined' && !isValidAutocompactPct(this.config.autocompactPctOverride)) {
      this.config.autocompactPctOverride = undefined;
    }
    this.config.failoverRecoverySeconds = normalizeFailoverRecoverySeconds(this.config.failoverRecoverySeconds);
    if (typeof this.config.ruleGlobalTimeout !== 'number' || this.config.ruleGlobalTimeout <= 0) {
      this.config.ruleGlobalTimeout = undefined;
    }

    // 仅在首次创建或存在字段补齐时落盘
    if (!current || JSON.stringify(current) !== JSON.stringify(this.config)) {
      await this.saveConfig();
    }
  }

  private async migrateRouteToolSettingsToGlobalConfig(): Promise<void> {
    const rawRoutes = this.routes as any[];

    // ---------------------------------------------------------------------------
    // Step 1: Migrate legacy route-level tool settings (enableAgentTeams, etc.)
    //         to global AppConfig — only if AppConfig doesn't already have them.
    // ---------------------------------------------------------------------------
    const hasGlobalToolConfig =
      !!this.config &&
      (
        Object.prototype.hasOwnProperty.call(this.config, 'enableAgentTeams') ||
        Object.prototype.hasOwnProperty.call(this.config, 'enableBypassPermissionsSupport') ||
        Object.prototype.hasOwnProperty.call(this.config, 'claudePermissionsDefaultMode') ||
        Object.prototype.hasOwnProperty.call(this.config, 'codexModelReasoningEffort')
      );

    if (!hasGlobalToolConfig) {
      const getPreferredRoute = (targetType: TargetType): any | undefined => {
        // Prefer isActive=true route, fall back to first match
        const active = rawRoutes.find(r => r.targetType === targetType && r.isActive === true);
        if (active) return active;
        return rawRoutes.find(r => r.targetType === targetType);
      };

      const preferredClaudeRoute = getPreferredRoute('claude-code');
      const preferredCodexRoute = getPreferredRoute('codex');
      const nextConfig: AppConfig = { ...(this.config || {}) };
      let configUpdated = false;

      if (typeof preferredClaudeRoute?.enableAgentTeams === 'boolean') {
        nextConfig.enableAgentTeams = preferredClaudeRoute.enableAgentTeams;
        configUpdated = true;
      }
      if (typeof preferredClaudeRoute?.enableBypassPermissionsSupport === 'boolean') {
        nextConfig.enableBypassPermissionsSupport = preferredClaudeRoute.enableBypassPermissionsSupport;
        configUpdated = true;
      }
      if (isCodexReasoningEffort(preferredCodexRoute?.codexModelReasoningEffort)) {
        nextConfig.codexModelReasoningEffort = preferredCodexRoute.codexModelReasoningEffort;
        configUpdated = true;
      }

      if (configUpdated) {
        this.config = nextConfig;
        await this.saveConfig();
        console.log('[Migration] Migrated route-level tool settings to global AppConfig');
      }
    }

    // ---------------------------------------------------------------------------
    // Step 2: Migrate route.targetType + route.isActive → tool-bindings
    //
    // This step is the core migration for the Route Activation UX Refactor.
    // It reads the old Route.isActive and Route.targetType fields from routes.json
    // and writes equivalent entries into tool-bindings.json.
    //
    // Idempotency:
    //   - If tool-bindings.json already has a non-null routeId for a tool, and
    //     the routes no longer carry isActive/targetType (already migrated), this
    //     step is a no-op.
    //   - If routes still carry the old fields (first run after upgrade), they
    //     are migrated and then cleaned.
    // ---------------------------------------------------------------------------
    const hasLegacyRouteFields = rawRoutes.some(r =>
      Object.prototype.hasOwnProperty.call(r, 'isActive') ||
      Object.prototype.hasOwnProperty.call(r, 'targetType')
    );

    if (hasLegacyRouteFields) {
      let toolBindingsUpdated = false;

      for (const route of rawRoutes) {
        // Only migrate routes that are explicitly active and have a targetType
        if (route.isActive === true && route.targetType) {
          const tool = route.targetType as ToolName;
          if (tool === 'claude-code' || tool === 'codex') {
            // Only write if tool-bindings doesn't already have a binding
            // (avoid overwriting user's newer tool-binding choices)
            if (!this.toolBindings[tool]?.routeId) {
              this.toolBindings[tool] = { tool, routeId: route.id };
              toolBindingsUpdated = true;
              console.log(`[Migration] Binding tool '${tool}' → route '${route.id}' (${route.name || 'unnamed'})`);
            }
          }
        }
      }

      if (toolBindingsUpdated) {
        await this.saveToolBindings();
        console.log('[Migration] Saved migrated tool-bindings to tool-bindings.json');
      }

      // Clean legacy fields from all route objects
      let routesUpdated = false;
      this.routes = rawRoutes.map((route: any) => {
        const hasLegacy =
          Object.prototype.hasOwnProperty.call(route, 'targetType') ||
          Object.prototype.hasOwnProperty.call(route, 'isActive') ||
          Object.prototype.hasOwnProperty.call(route, 'enableAgentTeams') ||
          Object.prototype.hasOwnProperty.call(route, 'enableBypassPermissionsSupport') ||
          Object.prototype.hasOwnProperty.call(route, 'codexModelReasoningEffort');

        if (!hasLegacy) return route;

        routesUpdated = true;
        const {
          targetType,
          isActive,
          enableAgentTeams,
          enableBypassPermissionsSupport,
          codexModelReasoningEffort,
          ...cleanedRoute
        } = route;
        return cleanedRoute as Route;
      });

      if (routesUpdated) {
        await this.saveRoutes();
        console.log('[Migration] Cleaned legacy fields (targetType, isActive, deprecated tool settings) from routes.json');
      }
    } else {
      // No legacy fields found — either already migrated or fresh install
      console.log('[Migration] No legacy route fields found, skipping tool-bindings migration');
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
      apiKey: typeof vendor.apiKey === 'string' ? vendor.apiKey : '',
      apiBaseUrl: typeof vendor.apiBaseUrl === 'string' ? vendor.apiBaseUrl : '',
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
      apiKey: typeof vendor.apiKey === 'string'
        ? vendor.apiKey
        : (this.vendors[index].apiKey || ''),
      apiBaseUrl: typeof vendor.apiBaseUrl === 'string'
        ? vendor.apiBaseUrl
        : (this.vendors[index].apiBaseUrl || ''),
      // 供应商服务应通过 create/update/deleteAPIService 单独维护，避免编辑供应商时误覆盖
      services: this.vendors[index].services,
      updatedAt: now,
    };
    await this.saveVendors();
    return true;
  }

  async deleteVendor(id: string): Promise<boolean> {
    const index = this.vendors.findIndex(v => v.id === id);
    if (index === -1) return false;

    // 级联删除：删除该供应商下服务关联的所有规则
    const vendor = this.vendors[index];
    const serviceIds = (vendor.services || []).map(s => s.id);
    if (serviceIds.length > 0) {
      const beforeCount = this.rules.length;
      this.rules = this.rules.filter(r => !serviceIds.includes(r.targetServiceId));
      if (this.rules.length !== beforeCount) {
        await this.saveRules();
      }
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
      apiKey: typeof serviceData.apiKey === 'string' ? serviceData.apiKey : '',
      inheritVendorApiKey: serviceData.inheritVendorApiKey === true,
      inheritVendorApiBaseUrl: serviceData.inheritVendorApiBaseUrl === true,
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
      apiKey: typeof service.apiKey === 'string' ? service.apiKey : (vendor.services![index].apiKey || ''),
      inheritVendorApiKey: service.inheritVendorApiKey !== undefined
        ? service.inheritVendorApiKey === true
        : vendor.services![index].inheritVendorApiKey === true,
      inheritVendorApiBaseUrl: service.inheritVendorApiBaseUrl !== undefined
        ? service.inheritVendorApiBaseUrl === true
        : vendor.services![index].inheritVendorApiBaseUrl === true,
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

    // 级联删除：删除使用该服务的所有规则
    const beforeCount = this.rules.length;
    this.rules = this.rules.filter(r => r.targetServiceId !== id);
    if (this.rules.length !== beforeCount) {
      await this.saveRules();
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
    const newRoute: Route = { name: route.name, description: route.description, id, createdAt: now, updatedAt: now };
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

    // 检查该路由是否被工具绑定
    if (this.isRouteBound(id)) {
      return false;
    }

    // 删除关联的规则
    this.rules = this.rules.filter(r => r.routeId !== id);
    await this.saveRules();

    this.routes.splice(index, 1);
    await this.saveRoutes();

    // 级联清理：清除绑定到该路由的会话的绑定关系
    let sessionChanged = false;
    for (const session of this.sessions) {
      if (session.routeId === id) {
        session.routeId = undefined;
        session.routeName = undefined;
        sessionChanged = true;
      }
    }
    if (sessionChanged) {
      await this.saveSessions();
    }

    return true;
  }

  getRoute(id: string): Route | undefined {
    return this.routes.find(r => r.id === id);
  }

  // ToolBindings operations
  getToolBindings(): ToolBindings {
    return this.toolBindings;
  }

  getActiveRouteIdForTool(tool: ToolName): string | null {
    return this.toolBindings[tool]?.routeId ?? null;
  }

  async activateToolRoute(tool: ToolName, routeId: string): Promise<boolean> {
    const route = this.routes.find(r => r.id === routeId);
    if (!route) return false;
    this.toolBindings[tool] = { tool, routeId };
    await this.saveToolBindings();
    return true;
  }

  async deactivateToolRoute(tool: ToolName): Promise<boolean> {
    this.toolBindings[tool] = { tool, routeId: null };
    await this.saveToolBindings();
    return true;
  }

  async deactivateAllToolRoutes(): Promise<number> {
    let count = 0;
    for (const tool of Object.keys(this.toolBindings) as ToolName[]) {
      if (this.toolBindings[tool].routeId) {
        this.toolBindings[tool] = { tool, routeId: null };
        count++;
      }
    }
    if (count > 0) {
      await this.saveToolBindings();
    }
    return count;
  }

  isRouteBound(routeId: string): boolean {
    for (const tool of Object.keys(this.toolBindings) as ToolName[]) {
      if (this.toolBindings[tool].routeId === routeId) return true;
    }
    return false;
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

  // Log operations —— 委托给 LogStore（追加写 NDJSON + 字节偏移索引）
  async addLog(log: Omit<RequestLog, 'id'>): Promise<void> {
    const id = crypto.randomUUID();
    const contentType = this.resolveLogContentType(log);
    const logWithId = { ...log, contentType, id } as RequestLog;

    // 追加写：O(单条)，不再 read-modify-write 整个分片
    await this.requireLogStore().append('global', logWithId);

    // 统计保持写时增量（现状）
    await this.updateStatistics(logWithId);

    // 清除计数缓存
    this.logsCountCache = null;
  }

  async getLogs(limit: number = 100, offset: number = 0): Promise<RequestLog[]> {
    return this.requireLogStore().getRecent('global', { limit, offset });
  }

  async clearLogs(): Promise<void> {
    await this.requireLogStore().clear('global');
    this.logsCountCache = null;
  }

  async getLogsCount(): Promise<number> {
    const now = Date.now();
    if (this.logsCountCache && now - this.logsCountCache.timestamp < this.CACHE_TTL) {
      return this.logsCountCache.count;
    }
    const count = await this.requireLogStore().count('global');
    this.logsCountCache = { count, timestamp: now };
    return count;
  }

  /**
   * 搜索请求日志内容（两阶段流式扫描，内存仅持描述符 + 当前页）
   */
  async searchLogs(query: string, limit: number = 100, offset: number = 0): Promise<RequestLog[]> {
    return this.requireLogStore().search('global', query, { limit, offset });
  }

  /**
   * 搜索请求日志内容数量（流式，不持正文）
   */
  async searchLogsCount(query: string): Promise<number> {
    return this.requireLogStore().searchCount('global', query);
  }

  /**
   * 统一日志查询：字段筛选 + 关键词 + 分页 + 全量命中总数。
   * 无关键词时走时间线索引（零扫描）；有关键词时回退扫描。
   */
  async queryLogs(opts: LogQueryOpts): Promise<LogQueryResult> {
    return this.requireLogStore().query('global', opts);
  }

  private truncateForErrorLog(value: any): string | undefined {
    if (value === undefined || value === null) return undefined;
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    if (!str || str.length <= this.MAX_ERROR_LOG_FIELD_SIZE) return str || undefined;
    return str.substring(0, this.MAX_ERROR_LOG_FIELD_SIZE) + `\n...[truncated, original size: ${str.length} chars]`;
  }

  // Error log operations
  async addErrorLog(log: Omit<ErrorLog, 'id'>): Promise<void> {
    const id = crypto.randomUUID();
    const truncatedLog = {
      ...log,
      requestBody: this.truncateForErrorLog(log.requestBody),
      responseBody: this.truncateForErrorLog(log.responseBody),
      errorStack: this.truncateForErrorLog(log.errorStack),
      upstreamRequest: log.upstreamRequest ? {
        ...log.upstreamRequest,
        body: this.truncateForErrorLog(log.upstreamRequest.body),
      } : undefined,
    };
    this.errorLogs.push({ ...truncatedLog, id });
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

  /**
   * 统一错误日志查询：字段筛选 + 关键词 + 分页 + 全量命中总数。
   * 错误日志常驻内存，纯内存过滤。
   */
  async queryErrorLogs(opts: {
    filters?: { targetType?: string; vendorId?: string; serviceId?: string; model?: string; routeId?: string };
    keyword?: string;
    limit: number;
    offset: number;
  }): Promise<{ data: ErrorLog[]; total: number }> {
    const filters = opts.filters;
    const keyword = (opts.keyword || '').toLowerCase().trim();
    const filtered = this.errorLogs.filter(log => {
      if (filters?.targetType && log.targetType !== filters.targetType) return false;
      if (filters?.vendorId && log.vendorId !== filters.vendorId) return false;
      if (filters?.serviceId && log.targetServiceId !== filters.serviceId) return false;
      if (filters?.model && log.targetModel !== filters.model) return false;
      if (filters?.routeId && log.routeId !== filters.routeId) return false;
      if (keyword && !this.errorLogMatchesQuery(log, keyword)) return false;
      return true;
    });
    const sorted = filtered.sort((a, b) => b.timestamp - a.timestamp);
    return {
      data: sorted.slice(opts.offset, opts.offset + opts.limit),
      total: filtered.length,
    };
  }

  /**
   * 搜索错误日志内容
   * @param query 搜索关键词
   * @param limit 返回数量限制
   * @param offset 偏移量
   * @returns 匹配的错误日志列表
   */
  async searchErrorLogs(query: string, limit: number = 100, offset: number = 0): Promise<ErrorLog[]> {
    const searchQuery = query.toLowerCase().trim();
    if (!searchQuery) {
      return this.getErrorLogs(limit, offset);
    }

    const matches = this.errorLogs.filter(log => this.errorLogMatchesQuery(log, searchQuery));
    return matches
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(offset, offset + limit);
  }

  /**
   * 搜索错误日志内容数量
   * @param query 搜索关键词
   * @returns 匹配的错误日志数量
   */
  async searchErrorLogsCount(query: string): Promise<number> {
    const searchQuery = query.toLowerCase().trim();
    if (!searchQuery) {
      return this.getErrorLogsCount();
    }

    return this.errorLogs.filter(log => this.errorLogMatchesQuery(log, searchQuery)).length;
  }

  /**
   * 检查错误日志是否匹配搜索查询
   */
  private errorLogMatchesQuery(log: ErrorLog, query: string): boolean {
    // 搜索错误信息
    if (log.errorMessage && log.errorMessage.toLowerCase().includes(query)) {
      return true;
    }

    // 搜索错误堆栈
    if (log.errorStack && log.errorStack.toLowerCase().includes(query)) {
      return true;
    }

    // 搜索请求体
    if (log.requestBody) {
      const bodyStr = typeof log.requestBody === 'string' ? log.requestBody : JSON.stringify(log.requestBody);
      if (bodyStr.toLowerCase().includes(query)) {
        return true;
      }
    }

    // 搜索响应体
    if (log.responseBody) {
      const bodyStr = typeof log.responseBody === 'string' ? log.responseBody : JSON.stringify(log.responseBody);
      if (bodyStr.toLowerCase().includes(query)) {
        return true;
      }
    }

    // 搜索路径
    if (log.path && log.path.toLowerCase().includes(query)) {
      return true;
    }

    // 搜索模型名称
    if (log.requestModel && log.requestModel.toLowerCase().includes(query)) {
      return true;
    }
    if (log.targetModel && log.targetModel.toLowerCase().includes(query)) {
      return true;
    }

    return false;
  }

  // Service blacklist operations

  // Service blacklist operations
  private getFailoverRecoveryMs(): number {
    const seconds = normalizeFailoverRecoverySeconds(this.config?.failoverRecoverySeconds);
    return seconds * 1000;
  }

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
    const recoveryMs = this.getFailoverRecoveryMs();
    const existing = this.blacklist.get(key);

    if (existing) {
      existing.blacklistedAt = now;
      existing.expiresAt = now + recoveryMs;
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
        expiresAt: now + recoveryMs,
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
    const merged: AppConfig = {
      ...(this.config || {}),
      ...config,
    };

    // 校验归一化（与 ensureDefaultConfig 保持一致）
    if (!isCodexReasoningEffort(merged.codexModelReasoningEffort)) {
      merged.codexModelReasoningEffort = DEFAULT_CODEX_REASONING_EFFORT;
    }
    if (!isClaudeEffortLevel(merged.claudeEffortLevel)) {
      merged.claudeEffortLevel = DEFAULT_CLAUDE_EFFORT_LEVEL;
    }
    if (!isClaudePermissionDefaultMode(merged.claudePermissionsDefaultMode)) {
      merged.claudePermissionsDefaultMode = merged.enableBypassPermissionsSupport === true
        ? 'bypassPermissions'
        : DEFAULT_CLAUDE_PERMISSION_DEFAULT_MODE;
    }
    if (typeof merged.autocompactPctOverride !== 'undefined' && !isValidAutocompactPct(merged.autocompactPctOverride)) {
      merged.autocompactPctOverride = undefined;
    }
    merged.failoverRecoverySeconds = normalizeFailoverRecoverySeconds(merged.failoverRecoverySeconds);
    if (typeof merged.ruleGlobalTimeout !== 'number' || merged.ruleGlobalTimeout <= 0) {
      merged.ruleGlobalTimeout = undefined;
    }

    this.config = merged;
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
    if (vendor.apiKey !== undefined && typeof vendor.apiKey !== 'string') {
      return { valid: false, error: `供应商[${index}](${vendor.id}) 的 apiKey 必须是字符串` };
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
        if (service.inheritVendorApiBaseUrl !== true) {
          return { valid: false, error: `供应商[${index}](${vendor.id}) 的服务[${i}] 缺少有效的 apiUrl 字段` };
        }
      }
      if (!service.apiKey || typeof service.apiKey !== 'string') {
        if (service.inheritVendorApiKey !== true) {
          return { valid: false, error: `供应商[${index}](${vendor.id}) 的服务[${i}] 缺少有效的 apiKey 字段` };
        }
      }
      if (service.inheritVendorApiKey !== undefined && typeof service.inheritVendorApiKey !== 'boolean') {
        return { valid: false, error: `供应商[${index}](${vendor.id}) 的服务[${i}] inheritVendorApiKey 必须是布尔值` };
      }
      if (service.inheritVendorApiBaseUrl !== undefined && typeof service.inheritVendorApiBaseUrl !== 'boolean') {
        return { valid: false, error: `供应商[${index}](${vendor.id}) 的服务[${i}] inheritVendorApiBaseUrl 必须是布尔值` };
      }
      if (service.inheritVendorAuthType !== undefined && typeof service.inheritVendorAuthType !== 'boolean') {
        return { valid: false, error: `供应商[${index}](${vendor.id}) 的服务[${i}] inheritVendorAuthType 必须是布尔值` };
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
    // targetType and isActive are no longer part of Route (migrated to tool-bindings)
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
    const validContentTypes = ['default', 'background', 'thinking', 'long-context', 'image-understanding', 'model-mapping', 'high-iq', 'compact'];
    if (!rule.contentType || !validContentTypes.includes(rule.contentType)) {
      return { valid: false, error: `规则[${index}](${rule.id}) 的 contentType 无效` };
    }

    // 如果使用MCP（仅对图像理解类型有效），则不需要验证targetServiceId
    if (rule.useMCP === true && rule.contentType === 'image-understanding') {
      if (!rule.mcpId || typeof rule.mcpId !== 'string') {
        return { valid: false, error: `规则[${index}](${rule.id}) 使用MCP时缺少有效的 mcpId 字段` };
      }
    } else {
      // 不使用MCP时，必须验证targetServiceId
      if (!rule.targetServiceId || typeof rule.targetServiceId !== 'string') {
        return { valid: false, error: `规则[${index}](${rule.id}) 缺少有效的 targetServiceId 字段` };
      }
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

      // 自动迁移导入数据中的旧类型
      if (importData.vendors) {
        importData.vendors = this.migrateVendorsOnImport(importData.vendors);
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
        failoverRecoverySeconds: normalizeFailoverRecoverySeconds(importData.config?.failoverRecoverySeconds),
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
      if (!this.logStore) {
        this.contentTypeDistributionInitialized = true;
        return;
      }

      const counts = new Map<ContentType, number>();
      let totalRequests = 0;

      // 从 LogStore 流式扫描全部日志，按 contentType 计数（仅首次/老数据触发）
      for await (const log of this.logStore.streamAll('global')) {
        totalRequests++;
        const contentType = this.resolveLogContentType(log);
        counts.set(contentType, (counts.get(contentType) || 0) + 1);
      }
      if (totalRequests === 0) {
        this.contentTypeDistributionInitialized = true;
        return;
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
   * 从 AccessKey 请求同步全局统计数据（不写入日志，仅更新统计）
   */
  async syncStatisticsFromAccessKey(logData: Omit<RequestLog, 'id'>): Promise<void> {
    // 构造一个带有 id 的 RequestLog 以复用 updateStatistics
    const log = { ...logData, id: `ak-sync-${Date.now()}` } as RequestLog;
    await this.updateStatistics(log);
  }

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

    // 更新 byModel（按实际转发的模型统计，优先 targetModel 而非客户端提交的 requestModel）
    if (log.targetModel || log.requestModel) {
      const modelName = log.targetModel || log.requestModel || 'Unknown';
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
      highIqMode?: boolean;
      highIqRuleId?: string;
      highIqEnabledAt?: number;
      routeId?: string;
      routeName?: string;
    }
  ): Promise<boolean> {
    const session = this.sessions.find(s => s.id === sessionId);
    if (!session) return false;

    Object.assign(session, updates);
    await this.saveSessions();
    return true;
  }

  /**
   * 查询会话列表。支持字段筛选（targetType/vendorId/serviceId/model/routeId）
   * 与关键词搜索（命中 title/id）。会话常驻内存，筛选为纯内存过滤。
   * 兼容旧调用：第一个参数传 undefined 等价于无筛选。
   */
  async getSessions(
    opts?: {
      targetType?: string;
      keyword?: string;
      vendorId?: string;
      serviceId?: string;
      model?: string;
      routeId?: string;
    },
    limit: number = 100,
    offset: number = 0
  ): Promise<Session[]> {
    const filtered = this.applySessionFilters(this.sessions, opts)
      .sort((a, b) => b.lastRequestAt - a.lastRequestAt);
    return filtered.slice(offset, offset + limit);
  }

  async getSessionsCount(opts?: {
    targetType?: string;
    keyword?: string;
    vendorId?: string;
    serviceId?: string;
    model?: string;
    routeId?: string;
  }): Promise<number> {
    return this.applySessionFilters(this.sessions, opts).length;
  }

  private applySessionFilters(
    sessions: Session[],
    opts?: {
      targetType?: string;
      keyword?: string;
      vendorId?: string;
      serviceId?: string;
      model?: string;
      routeId?: string;
    }
  ): Session[] {
    if (!opts) return [...sessions];
    const keyword = opts.keyword?.trim().toLowerCase();
    return sessions.filter(s => {
      if (opts.targetType && s.targetType !== opts.targetType) return false;
      if (opts.vendorId && s.vendorId !== opts.vendorId) return false;
      if (opts.serviceId && s.serviceId !== opts.serviceId) return false;
      if (opts.model && s.model !== opts.model) return false;
      if (opts.routeId && s.routeId !== opts.routeId) return false;
      if (keyword) {
        const title = (s.title || '').toLowerCase();
        const id = (s.id || '').toLowerCase();
        if (!title.includes(keyword) && !id.includes(keyword)) return false;
      }
      return true;
    });
  }

  /**
   * 按 refs 回填日志正文。按 filename 分组，每个分片只 loadLogShard 一次，
   * 处理完即释放分片引用，避免大量分片正文同时驻留内存。
   * 供 getLogsBySessionId / searchLogs / getClientClosedLogs 复用。
   */
  /** 按会话取日志（字节偏移随机读，since 下推到索引层）。委托 LogStore。 */
  async getLogsBySessionId(sessionId: string, limit: number = 100, since?: number): Promise<RequestLog[]> {
    return this.requireLogStore().getBySession('global', sessionId, { limit, since });
  }

  /**
   * 批量回填多个会话的近期日志（跨会话合并文件读取），委托 LogStore。
   * 用于 Agent Map 启动重建。
   */
  async getRecentLogsBySessions(
    sessionIds: string[],
    opts: { since?: number; perSessionLimit?: number } = {}
  ): Promise<Map<string, RequestLog[]>> {
    return this.requireLogStore().getBySessionsBatch('global', sessionIds, opts);
  }

  // sessionId 提取已移至 LogStore 内部（extractSessionId），fs-database 不再维护会话日志索引

  async deleteSession(sessionId: string): Promise<boolean> {
    const index = this.sessions.findIndex(s => s.id === sessionId);
    if (index === -1) return false;

    this.sessions.splice(index, 1);
    await this.saveSessions();
    // 关联日志删除走 LogStore tombstone
    try {
      await this.requireLogStore().deleteLogsBySession('global', sessionId);
    } catch (err) {
      console.error('[Database] deleteLogsBySession failed:', err);
    }
    return true;
  }

  async clearSessions(): Promise<void> {
    this.sessions = [];
    await this.saveSessions();
  }

  /**
   * 批量清理过期会话
   * 以最后请求时间为基准，清理 lastRequestAt 早于 beforeTimestamp 的会话。
   * @param beforeTimestamp 时间阈值（毫秒），最后请求时间严格早于此值的会话将被处理
   * @param options.onlyLogs 仅清空关联日志，保留会话本身
   * @returns 受影响会话数 / 删除的日志数
   */
  async cleanupSessionsByAge(
    beforeTimestamp: number,
    options: { onlyLogs?: boolean } = {}
  ): Promise<{ sessionsAffected: number; logsDeleted: number }> {
    const targetSessions = this.sessions.filter(s => s.lastRequestAt < beforeTimestamp);
    if (targetSessions.length === 0) {
      return { sessionsAffected: 0, logsDeleted: 0 };
    }

    const targetIds = new Set(targetSessions.map(s => s.id));
    const { logsDeleted } = await this.deleteLogsBySessionIds(targetIds);

    if (!options.onlyLogs) {
      this.sessions = this.sessions.filter(s => !targetIds.has(s.id));
      await this.saveSessions();
    }

    return { sessionsAffected: targetSessions.length, logsDeleted };
  }

  /**
   * 删除指定会话集合关联的所有日志条目（tombstone，追加写无需重写文件）。
   * 委托 LogStore。
   */
  private async deleteLogsBySessionIds(sessionIds: Set<string>): Promise<{ logsDeleted: number }> {
    if (sessionIds.size === 0) return { logsDeleted: 0 };
    const ls = this.requireLogStore();
    let logsDeleted = 0;
    for (const sid of sessionIds) {
      logsDeleted += await ls.deleteLogsBySession('global', sid);
    }
    this.logsCountCache = null;
    return { logsDeleted };
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
      if (session.vendorId !== undefined) existing.vendorId = session.vendorId;
      if (session.vendorName !== undefined) existing.vendorName = session.vendorName;
      if (session.serviceId !== undefined) existing.serviceId = session.serviceId;
      if (session.serviceName !== undefined) existing.serviceName = session.serviceName;
      if (session.model !== undefined) existing.model = session.model;
      if (session.highIqMode !== undefined) existing.highIqMode = session.highIqMode;
      if (Object.prototype.hasOwnProperty.call(session, 'highIqRuleId')) existing.highIqRuleId = session.highIqRuleId;
      if (Object.prototype.hasOwnProperty.call(session, 'highIqEnabledAt')) existing.highIqEnabledAt = session.highIqEnabledAt;
      // 保留已有的路由绑定（不传入时不覆盖）
      if (session.routeId !== undefined) existing.routeId = session.routeId;
      if (session.routeName !== undefined) existing.routeName = session.routeName;
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
        highIqMode: session.highIqMode,
        highIqRuleId: session.highIqRuleId,
        highIqEnabledAt: session.highIqEnabledAt,
        routeId: session.routeId,
        routeName: session.routeName,
      });
    }

    // 异步保存（不阻塞）
    this.saveSessions().catch(console.error);
  }

  /**
   * 绑定会话到路由
   */
  async bindSessionRoute(sessionId: string, routeId: string): Promise<Session | null> {
    const session = this.sessions.find(s => s.id === sessionId);
    if (!session) return null;

    const route = this.routes.find(r => r.id === routeId);
    if (!route) return null;

    session.routeId = routeId;
    session.routeName = route.name;
    await this.saveSessions();
    return session;
  }

  /**
   * 解绑会话路由
   */
  async unbindSessionRoute(sessionId: string): Promise<boolean> {
    const session = this.sessions.find(s => s.id === sessionId);
    if (!session) return false;

    session.routeId = undefined;
    session.routeName = undefined;
    await this.saveSessions();
    return true;
  }

  /**
   * 获取绑定到指定路由的所有会话
   */
  getBoundSessions(routeId: string): Session[] {
    return this.sessions
      .filter(s => s.routeId === routeId)
      .sort((a, b) => b.lastRequestAt - a.lastRequestAt);
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
    // 日志索引落盘由 LogStore.close() 负责（main.ts 在 shutdown 时调用）
  }
}
