import Database from 'better-sqlite3';
import { Level } from 'level';
import path from 'path';
import crypto from 'crypto';
import CryptoJS from 'crypto-js';
import type {
  Vendor,
  APIService,
  Route,
  Rule,
  RequestLog,
  AccessLog,
  ErrorLog,
  AppConfig,
  ExportData,
  Statistics,
  ContentType,
  ServiceBlacklistEntry,
} from '../types';

export class DatabaseManager {
  private db: Database.Database;
  private logDb: Level<string, string>;
  private accessLogDb: Level<string, string>;
  private errorLogDb: Level<string, string>;
  private blacklistDb: Level<string, string>;

  // 缓存机制：总数查询缓存
  private logsCountCache: { count: number; timestamp: number } | null = null;
  private accessLogsCountCache: { count: number; timestamp: number } | null = null;
  private errorLogsCountCache: { count: number; timestamp: number } | null = null;
  private readonly CACHE_TTL = 1000; // 1秒缓存TTL

  constructor(dataPath: string) {
    this.db = new Database(path.join(dataPath, 'app.db'));

    // 启用外键约束（SQLite 默认禁用，必须手动启用才能使 ON DELETE CASCADE 生效）
    this.db.pragma('foreign_keys = ON');

    // 配置数据库以确保实时读取最新数据
    // WAL 模式 + normal 同步模式: 提供最佳的并发性和实时性
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    // 确保读取操作不会看到旧的数据快照
    // 在 WAL 模式下,默认情况下读取操作不会阻塞写入操作
    // 设置 read_uncommitted = 0 确保读取最新提交的数据
    this.db.pragma('read_uncommitted = 0');

    this.logDb = new Level(path.join(dataPath, 'logs'), { valueEncoding: 'json' });
    this.accessLogDb = new Level(path.join(dataPath, 'access-logs'), { valueEncoding: 'json' });
    this.errorLogDb = new Level(path.join(dataPath, 'error-logs'), { valueEncoding: 'json' });
    this.blacklistDb = new Level(path.join(dataPath, 'service-blacklist'), { valueEncoding: 'json' });
  }

  async initialize() {
    this.createTables();
    await this.runMigrations();
    await this.ensureDefaultConfig();
  }

  private async runMigrations() {
    const columns = this.db.pragma('table_info(api_services)') as any[];

    // 检查是否有旧的 max_output_tokens 字段（单值版本）
    const hasOldMaxOutputTokens = columns.some((col: any) => col.name === 'max_output_tokens');
    // 检查是否已经有新的 model_limits 字段（JSON 版本）
    const hasModelLimits = columns.some((col: any) => col.name === 'model_limits');

    if (!hasModelLimits) {
      if (hasOldMaxOutputTokens) {
        // 如果有旧字段，先删除旧字段（SQLite 不支持 ALTER TABLE DROP COLUMN，需要重建表）
        console.log('[DB] Running migration: Replacing max_output_tokens with model_limits');
        await this.migrateMaxOutputTokensToModelLimits();
      } else {
        // 直接添加新字段
        console.log('[DB] Running migration: Adding model_limits column to api_services table');
        this.db.exec('ALTER TABLE api_services ADD COLUMN model_limits TEXT;');
        console.log('[DB] Migration completed: model_limits column added');
      }
    }

    // 检查vendors表是否有sort_order字段
    const vendorsColumns = this.db.pragma('table_info(vendors)') as any[];
    const hasSortOrder = vendorsColumns.some((col: any) => col.name === 'sort_order');
    if (!hasSortOrder) {
      console.log('[DB] Running migration: Adding sort_order column to vendors table');
      this.db.exec('ALTER TABLE vendors ADD COLUMN sort_order INTEGER DEFAULT 0;');
      console.log('[DB] Migration completed: sort_order column added to vendors');
    }

    // 检查rules表是否有token相关字段
    const rulesColumns = this.db.pragma('table_info(rules)') as any[];
    const hasTokenLimit = rulesColumns.some((col: any) => col.name === 'token_limit');
    const hasTotalTokensUsed = rulesColumns.some((col: any) => col.name === 'total_tokens_used');
    const hasResetInterval = rulesColumns.some((col: any) => col.name === 'reset_interval');
    const hasLastResetAt = rulesColumns.some((col: any) => col.name === 'last_reset_at');

    if (!hasTokenLimit) {
      console.log('[DB] Running migration: Adding token_limit column to rules table');
      this.db.exec('ALTER TABLE rules ADD COLUMN token_limit INTEGER;');
      console.log('[DB] Migration completed: token_limit column added');
    }

    if (!hasTotalTokensUsed) {
      console.log('[DB] Running migration: Adding total_tokens_used column to rules table');
      this.db.exec('ALTER TABLE rules ADD COLUMN total_tokens_used INTEGER DEFAULT 0;');
      console.log('[DB] Migration completed: total_tokens_used column added');
    }

    if (!hasResetInterval) {
      console.log('[DB] Running migration: Adding reset_interval column to rules table');
      this.db.exec('ALTER TABLE rules ADD COLUMN reset_interval INTEGER;');
      console.log('[DB] Migration completed: reset_interval column added');
    }

    if (!hasLastResetAt) {
      console.log('[DB] Running migration: Adding last_reset_at column to rules table');
      this.db.exec('ALTER TABLE rules ADD COLUMN last_reset_at INTEGER;');
      console.log('[DB] Migration completed: last_reset_at column added');
    }

    // 检查rules表是否有timeout字段
    const hasRuleTimeout = rulesColumns.some((col: any) => col.name === 'timeout');
    if (!hasRuleTimeout) {
      console.log('[DB] Running migration: Adding timeout column to rules table');
      this.db.exec('ALTER TABLE rules ADD COLUMN timeout INTEGER;');
      console.log('[DB] Migration completed: timeout column added to rules');
    }

    // 检查api_services表是否有timeout字段，如果有则移除
    const hasServiceTimeout = columns.some((col: any) => col.name === 'timeout');
    if (hasServiceTimeout) {
      console.log('[DB] Running migration: Removing timeout column from api_services table');
      await this.migrateRemoveServiceTimeout();
      console.log('[DB] Migration completed: timeout column removed from api_services');
    }
  }

  private async migrateMaxOutputTokensToModelLimits() {
    // SQLite 不支持直接删除列，需要重建表
    // 先临时禁用外键约束
    this.db.pragma('foreign_keys = OFF');

    this.db.exec(`
      CREATE TABLE api_services_new (
        id TEXT PRIMARY KEY,
        vendor_id TEXT NOT NULL,
        name TEXT NOT NULL,
        api_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        timeout INTEGER,
        source_type TEXT,
        supported_models TEXT,
        model_limits TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
      );

      INSERT INTO api_services_new
      SELECT
        id, vendor_id, name, api_url, api_key, timeout, source_type, supported_models,
        NULL, -- model_limits 设为 NULL，旧数据需要手动配置
        created_at, updated_at
      FROM api_services;

      DROP TABLE api_services;
      ALTER TABLE api_services_new RENAME TO api_services;
    `);

    // 重新启用外键约束
    this.db.pragma('foreign_keys = ON');

    console.log('[DB] Migration completed: Replaced max_output_tokens with model_limits');
  }

  private async migrateRemoveServiceTimeout() {
    // SQLite 不支持直接删除列，需要重建表
    this.db.pragma('foreign_keys = OFF');

    this.db.exec(`
      CREATE TABLE api_services_new (
        id TEXT PRIMARY KEY,
        vendor_id TEXT NOT NULL,
        name TEXT NOT NULL,
        api_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        source_type TEXT,
        supported_models TEXT,
        model_limits TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
      );

      INSERT INTO api_services_new (id, vendor_id, name, api_url, api_key, source_type, supported_models, model_limits, created_at, updated_at)
      SELECT id, vendor_id, name, api_url, api_key, source_type, supported_models, model_limits, created_at, updated_at
      FROM api_services;

      DROP TABLE api_services;
      ALTER TABLE api_services_new RENAME TO api_services;
    `);

    this.db.pragma('foreign_keys = ON');
  }

  private createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vendors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

       CREATE TABLE IF NOT EXISTS api_services (
         id TEXT PRIMARY KEY,
         vendor_id TEXT NOT NULL,
         name TEXT NOT NULL,
         api_url TEXT NOT NULL,
         api_key TEXT NOT NULL,
         source_type TEXT,
         supported_models TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
       );

       CREATE TABLE IF NOT EXISTS routes (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         description TEXT,
         target_type TEXT NOT NULL CHECK(target_type IN ('claude-code', 'codex')),
         is_active INTEGER DEFAULT 0,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       );

      CREATE TABLE IF NOT EXISTS rules (
        id TEXT PRIMARY KEY,
        route_id TEXT NOT NULL,
        content_type TEXT NOT NULL CHECK(content_type IN ('default', 'background', 'thinking', 'long-context', 'image-understanding', 'model-mapping')),
        target_service_id TEXT NOT NULL,
        target_model TEXT,
        replaced_model TEXT,
        sort_order INTEGER DEFAULT 0,
        timeout INTEGER,
        token_limit INTEGER,
        total_tokens_used INTEGER DEFAULT 0,
        reset_interval INTEGER,
        last_reset_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
        FOREIGN KEY (target_service_id) REFERENCES api_services(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private async ensureDefaultConfig() {
    const config = this.db.prepare('SELECT * FROM config WHERE key = ?').get('app_config');
    if (!config) {
      const defaultConfig: AppConfig = {
        enableLogging: true,
        logRetentionDays: 30,
        maxLogSize: 1000,
        apiKey: '',
        enableFailover: true,  // 默认启用智能故障切换
      };
      this.db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run(
        'app_config',
        JSON.stringify(defaultConfig)
      );
    }
  }

  // Vendor operations
  getVendors(): Vendor[] {
    const rows = this.db.prepare('SELECT * FROM vendors ORDER BY sort_order DESC, created_at DESC').all();
    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  createVendor(vendor: Omit<Vendor, 'id' | 'createdAt' | 'updatedAt'>): Vendor {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare('INSERT INTO vendors (id, name, description, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, vendor.name, vendor.description || null, vendor.sortOrder || 0, now, now);
    return { ...vendor, id, createdAt: now, updatedAt: now };
  }

  updateVendor(id: string, vendor: Partial<Vendor>): boolean {
    const now = Date.now();
    const result = this.db
      .prepare('UPDATE vendors SET name = ?, description = ?, sort_order = ?, updated_at = ? WHERE id = ?')
      .run(vendor.name, vendor.description || null, vendor.sortOrder !== undefined ? vendor.sortOrder : 0, now, id);
    return result.changes > 0;
  }

  deleteVendor(id: string): boolean {
    const result = this.db.prepare('DELETE FROM vendors WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // API Service operations
  getAPIServices(vendorId?: string): APIService[] {
    // 每次都重新准备语句以确保获取最新数据
    const query = vendorId
      ? 'SELECT * FROM api_services WHERE vendor_id = ? ORDER BY created_at DESC'
      : 'SELECT * FROM api_services ORDER BY created_at DESC';

    // 不缓存 prepared statement,每次重新创建以确保读取最新数据
    const stmt = this.db.prepare(query);
    const rows = vendorId ? stmt.all(vendorId) : stmt.all();

    const services = rows.map((row: any) => ({
      id: row.id,
      vendorId: row.vendor_id,
      name: row.name,
      apiUrl: row.api_url,
      apiKey: row.api_key,
      sourceType: row.source_type,
      supportedModels: row.supported_models ? row.supported_models.split(',').map((model: string) => model.trim()).filter((model: string) => model.length > 0) : undefined,
      modelLimits: row.model_limits ? JSON.parse(row.model_limits) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    // 调试日志: 记录读取的服务信息
    if (process.env.NODE_ENV === 'development' && services.length > 0) {
      console.log(`[DB] Read ${services.length} services from database, first service: ${services[0].name} -> ${services[0].apiUrl}`);
    }

    return services;
  }

  createAPIService(service: Omit<APIService, 'id' | 'createdAt' | 'updatedAt'>): APIService {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO api_services (id, vendor_id, name, api_url, api_key, source_type, supported_models, model_limits, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        service.vendorId,
        service.name,
        service.apiUrl,
        service.apiKey,
        service.sourceType || null,
        service.supportedModels ? service.supportedModels.join(',') : null,
        service.modelLimits ? JSON.stringify(service.modelLimits) : null,
        now,
        now
      );
    return { ...service, id, createdAt: now, updatedAt: now };
  }

  updateAPIService(id: string, service: Partial<APIService>): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(
        'UPDATE api_services SET name = ?, api_url = ?, api_key = ?, source_type = ?, supported_models = ?, model_limits = ?, updated_at = ? WHERE id = ?'
      )
      .run(
        service.name,
        service.apiUrl,
        service.apiKey,
        service.sourceType || null,
        service.supportedModels ? service.supportedModels.join(',') : null,
        service.modelLimits ? JSON.stringify(service.modelLimits) : null,
        now,
        id
      );

    // 调试日志: 记录更新操作
    if (result.changes > 0 && process.env.NODE_ENV === 'development') {
      console.log(`[DB] Updated service ${id}: ${service.name} -> ${service.apiUrl}`);
    }

    return result.changes > 0;
  }

  deleteAPIService(id: string): boolean {
    const result = this.db.prepare('DELETE FROM api_services WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // Route operations
  getRoutes(): Route[] {
    const rows = this.db.prepare('SELECT * FROM routes ORDER BY created_at DESC').all();
    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      targetType: row.target_type,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  createRoute(route: Omit<Route, 'id' | 'createdAt' | 'updatedAt'>): Route {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare('INSERT INTO routes (id, name, description, target_type, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, route.name, route.description || null, route.targetType, route.isActive ? 1 : 0, now, now);
    return { ...route, id, createdAt: now, updatedAt: now };
  }

  updateRoute(id: string, route: Partial<Route>): boolean {
    const now = Date.now();
    const result = this.db
      .prepare('UPDATE routes SET name = ?, description = ?, target_type = ?, updated_at = ? WHERE id = ?')
      .run(route.name, route.description || null, route.targetType, now, id);
    return result.changes > 0;
  }

  deleteRoute(id: string): boolean {
    const result = this.db.prepare('DELETE FROM routes WHERE id = ?').run(id);
    return result.changes > 0;
  }

  activateRoute(id: string): boolean {
    const route = this.getRoutes().find(r => r.id === id);
    if (route) {
      this.db.prepare('UPDATE routes SET is_active = 0 WHERE target_type = ?').run(route.targetType);
      const result = this.db.prepare('UPDATE routes SET is_active = 1 WHERE id = ?').run(id);
      return result.changes > 0;
    }
    return false;
  }

  deactivateRoute(id: string): boolean {
    const result = this.db.prepare('UPDATE routes SET is_active = 0 WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // Rule operations
  getRules(routeId?: string): Rule[] {
    const query = routeId
      ? 'SELECT * FROM rules WHERE route_id = ? ORDER BY sort_order DESC, created_at DESC'
      : 'SELECT * FROM rules ORDER BY sort_order DESC, created_at DESC';
    const stmt = routeId ? this.db.prepare(query).bind(routeId) : this.db.prepare(query);
    const rows = stmt.all();
    return rows.map((row: any) => ({
      id: row.id,
      routeId: row.route_id,
      contentType: row.content_type,
      targetServiceId: row.target_service_id,
      targetModel: row.target_model,
      replacedModel: row.replaced_model,
      sortOrder: row.sort_order,
      timeout: row.timeout,
      tokenLimit: row.token_limit,
      totalTokensUsed: row.total_tokens_used,
      resetInterval: row.reset_interval,
      lastResetAt: row.last_reset_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  createRule(route: Omit<Rule, 'id' | 'createdAt' | 'updatedAt'>): Rule {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO rules (id, route_id, content_type, target_service_id, target_model, replaced_model, sort_order, timeout, token_limit, total_tokens_used, reset_interval, last_reset_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        route.routeId,
        route.contentType,
        route.targetServiceId,
        route.targetModel || null,
        route.replacedModel || null,
        route.sortOrder || 0,
        route.timeout || null,
        route.tokenLimit || null,
        route.totalTokensUsed || 0,
        route.resetInterval || null,
        route.lastResetAt || null,
        now,
        now
      );
    return { ...route, id, createdAt: now, updatedAt: now };
  }

  updateRule(id: string, route: Partial<Rule>): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(
        'UPDATE rules SET content_type = ?, target_service_id = ?, target_model = ?, replaced_model = ?, sort_order = ?, timeout = ?, token_limit = ?, reset_interval = ?, updated_at = ? WHERE id = ?'
      )
      .run(
        route.contentType,
        route.targetServiceId,
        route.targetModel || null,
        route.replacedModel || null,
        route.sortOrder || 0,
        route.timeout !== undefined ? route.timeout : null,
        route.tokenLimit !== undefined ? route.tokenLimit : null,
        route.resetInterval !== undefined ? route.resetInterval : null,
        now,
        id
      );
    return result.changes > 0;
  }

  deleteRule(id: string): boolean {
    const result = this.db.prepare('DELETE FROM rules WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /**
   * 增加规则的token使用量
   * @param ruleId 规则ID
   * @param tokensUsed 使用的token数量
   * @returns 是否成功
   */
  incrementRuleTokenUsage(ruleId: string, tokensUsed: number): boolean {
    const result = this.db
      .prepare('UPDATE rules SET total_tokens_used = total_tokens_used + ? WHERE id = ?')
      .run(tokensUsed, ruleId);
    return result.changes > 0;
  }

  /**
   * 重置规则的token使用量
   * @param ruleId 规则ID
   * @returns 是否成功
   */
  resetRuleTokenUsage(ruleId: string): boolean {
    const now = Date.now();
    const result = this.db
      .prepare('UPDATE rules SET total_tokens_used = 0, last_reset_at = ? WHERE id = ?')
      .run(now, ruleId);
    return result.changes > 0;
  }

  /**
   * 检查并重置到期的规则
   * 如果规则设置了reset_interval且已经到了重置时间，则自动重置token使用量
   * @param ruleId 规则ID
   * @returns 是否进行了重置
   */
  checkAndResetRuleIfNeeded(ruleId: string): boolean {
    const rule = this.db
      .prepare('SELECT reset_interval, last_reset_at FROM rules WHERE id = ?')
      .get(ruleId) as { reset_interval: number | null; last_reset_at: number | null } | undefined;

    if (!rule || !rule.reset_interval) {
      return false; // 没有设置重置间隔
    }

    const now = Date.now();
    const resetIntervalMs = rule.reset_interval * 60 * 60 * 1000; // 小时转毫秒
    const lastResetAt = rule.last_reset_at || 0;

    // 检查是否已经到了重置时间
    if (now - lastResetAt >= resetIntervalMs) {
      this.resetRuleTokenUsage(ruleId);
      return true;
    }

    return false;
  }

  // Log operations
  async addLog(log: Omit<RequestLog, 'id'>): Promise<void> {
    const { path } = log;
    if (!path.startsWith('/v1/')) {
      return;
    }
    const id = crypto.randomUUID();
    await this.logDb.put(id, JSON.stringify({ ...log, id }));
    // 清除缓存
    this.logsCountCache = null;
  }

  async getLogs(limit: number = 100, offset: number = 0): Promise<RequestLog[]> {
    const allLogs: RequestLog[] = [];
    for await (const [, value] of this.logDb.iterator()) {
      allLogs.push(JSON.parse(value));
    }
    // Sort by timestamp in descending order (newest first)
    allLogs.sort((a, b) => b.timestamp - a.timestamp);
    // Apply offset and limit
    return allLogs.slice(offset, offset + limit);
  }

  async clearLogs(): Promise<void> {
    await this.logDb.clear();
    // 清除缓存
    this.logsCountCache = null;
  }

  // Access log operations
  async addAccessLog(log: Omit<AccessLog, 'id'>): Promise<string> {
    const id = crypto.randomUUID();
    await this.accessLogDb.put(id, JSON.stringify({ ...log, id }));
    // 清除缓存
    this.accessLogsCountCache = null;
    return id;
  }

  async updateAccessLog(id: string, data: Partial<AccessLog>): Promise<void> {
    const log = await this.accessLogDb.get(id);
    const updatedLog = { ...JSON.parse(log), ...data };
    await this.accessLogDb.put(id, JSON.stringify(updatedLog));
  }

  async getAccessLogs(limit: number = 100, offset: number = 0): Promise<AccessLog[]> {
    const allLogs: AccessLog[] = [];
    for await (const [, value] of this.accessLogDb.iterator()) {
      allLogs.push(JSON.parse(value));
    }
    // Sort by timestamp in descending order (newest first)
    allLogs.sort((a, b) => b.timestamp - a.timestamp);
    // Apply offset and limit
    return allLogs.slice(offset, offset + limit);
  }

  async clearAccessLogs(): Promise<void> {
    await this.accessLogDb.clear();
    // 清除缓存
    this.accessLogsCountCache = null;
  }

  // Error log operations
  async addErrorLog(log: Omit<ErrorLog, 'id'>): Promise<void> {
    const id = crypto.randomUUID();
    await this.errorLogDb.put(id, JSON.stringify({ ...log, id }));
    // 清除缓存
    this.errorLogsCountCache = null;
  }

  async getErrorLogs(limit: number = 100, offset: number = 0): Promise<ErrorLog[]> {
    const allLogs: ErrorLog[] = [];
    for await (const [, value] of this.errorLogDb.iterator()) {
      allLogs.push(JSON.parse(value));
    }
    // Sort by timestamp in descending order (newest first)
    allLogs.sort((a, b) => b.timestamp - a.timestamp);
    // Apply offset and limit
    return allLogs.slice(offset, offset + limit);
  }

  async clearErrorLogs(): Promise<void> {
    await this.errorLogDb.clear();
    // 清除缓存
    this.errorLogsCountCache = null;
  }

  /**
   * 获取请求日志总数（带缓存）
   */
  async getLogsCount(): Promise<number> {
    const now = Date.now();
    if (this.logsCountCache && now - this.logsCountCache.timestamp < this.CACHE_TTL) {
      return this.logsCountCache.count;
    }

    let count = 0;
    for await (const _ of this.logDb.iterator()) {
      count++;
    }

    this.logsCountCache = { count, timestamp: now };
    return count;
  }

  /**
   * 获取访问日志总数（带缓存）
   */
  async getAccessLogsCount(): Promise<number> {
    const now = Date.now();
    if (this.accessLogsCountCache && now - this.accessLogsCountCache.timestamp < this.CACHE_TTL) {
      return this.accessLogsCountCache.count;
    }

    let count = 0;
    for await (const _ of this.accessLogDb.iterator()) {
      count++;
    }

    this.accessLogsCountCache = { count, timestamp: now };
    return count;
  }

  /**
   * 获取错误日志总数（带缓存）
   */
  async getErrorLogsCount(): Promise<number> {
    const now = Date.now();
    if (this.errorLogsCountCache && now - this.errorLogsCountCache.timestamp < this.CACHE_TTL) {
      return this.errorLogsCountCache.count;
    }

    let count = 0;
    for await (const _ of this.errorLogDb.iterator()) {
      count++;
    }

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
    try {
      const value = await this.blacklistDb.get(key);
      const entry: ServiceBlacklistEntry = JSON.parse(value);

      // 检查是否过期
      if (Date.now() > entry.expiresAt) {
        // 已过期,删除记录
        await this.blacklistDb.del(key);
        return false;
      }

      return true;
    } catch (error: any) {
      if (error.code === 'LEVEL_NOT_FOUND') {
        return false;
      }
      throw error;
    }
  }

  async addToBlacklist(
    serviceId: string,
    routeId: string,
    contentType: ContentType,
    errorMessage?: string,
    statusCode?: number
  ): Promise<void> {
    const key = `${routeId}:${contentType}:${serviceId}`;
    const now = Date.now();

    try {
      // 尝试读取现有记录
      const existing = await this.blacklistDb.get(key);
      const entry: ServiceBlacklistEntry = JSON.parse(existing);

      // 更新现有记录
      entry.blacklistedAt = now;
      entry.expiresAt = now + 10 * 60 * 1000; // 10分钟
      entry.errorCount++;
      entry.lastError = errorMessage;
      entry.lastStatusCode = statusCode;

      await this.blacklistDb.put(key, JSON.stringify(entry));
    } catch (error: any) {
      if (error.code === 'LEVEL_NOT_FOUND') {
        // 创建新记录
        const entry: ServiceBlacklistEntry = {
          serviceId,
          routeId,
          contentType,
          blacklistedAt: now,
          expiresAt: now + 10 * 60 * 1000,
          errorCount: 1,
          lastError: errorMessage,
          lastStatusCode: statusCode,
        };

        await this.blacklistDb.put(key, JSON.stringify(entry));
      } else {
        throw error;
      }
    }
  }

  async cleanupExpiredBlacklist(): Promise<number> {
    const now = Date.now();
    let count = 0;

    for await (const [key, value] of this.blacklistDb.iterator()) {
      const entry: ServiceBlacklistEntry = JSON.parse(value);
      if (now > entry.expiresAt) {
        await this.blacklistDb.del(key);
        count++;
      }
    }

    return count;
  }

  // Config operations
  getConfig(): AppConfig {
    const row: any = this.db.prepare('SELECT value FROM config WHERE key = ?').get('app_config');
    return row ? JSON.parse(row.value) : null as any;
  }

  updateConfig(config: AppConfig): boolean {
    const result = this.db
      .prepare('UPDATE config SET value = ? WHERE key = ?')
      .run(JSON.stringify(config), 'app_config');
    return result.changes > 0;
  }

  // Export/Import operations
  async exportData(password: string): Promise<string> {
    const exportData: ExportData = {
      version: '1.0.0',
      exportDate: Date.now(),
      vendors: this.getVendors(),
      apiServices: this.getAPIServices(),
      routes: this.getRoutes(),
      rules: this.getRules(),
      config: this.getConfig(),
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

      // Clear existing data
      this.db.prepare('DELETE FROM rules').run();
      this.db.prepare('DELETE FROM routes').run();
      this.db.prepare('DELETE FROM api_services').run();
      this.db.prepare('DELETE FROM vendors').run();

      // Import vendors
      for (const vendor of importData.vendors) {
        this.db
          .prepare('INSERT INTO vendors (id, name, description, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(vendor.id, vendor.name, vendor.description || null, (vendor as any).sortOrder || 0, vendor.createdAt, vendor.updatedAt);
      }

       // Import API services
       for (const service of importData.apiServices) {
         this.db
           .prepare(
             'INSERT INTO api_services (id, vendor_id, name, api_url, api_key, source_type, supported_models, model_limits, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
           )
           .run(
             service.id,
             service.vendorId,
             service.name,
             service.apiUrl,
             service.apiKey,
             service.sourceType || null,
             service.supportedModels ? service.supportedModels.join(',') : null,
             service.modelLimits ? JSON.stringify(service.modelLimits) : null,
             service.createdAt,
             service.updatedAt
           );
       }

       // Import routes
       for (const route of importData.routes) {
         this.db
           .prepare('INSERT INTO routes (id, name, description, target_type, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
           .run(route.id, route.name, route.description || null, route.targetType, route.isActive ? 1 : 0, route.createdAt, route.updatedAt);
       }

      // Import rules
      for (const rule of importData.rules) {
        this.db
          .prepare(
            'INSERT INTO rules (id, route_id, content_type, target_service_id, target_model, replaced_model, sort_order, timeout, token_limit, total_tokens_used, reset_interval, last_reset_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          )
          .run(
            rule.id,
            rule.routeId,
            rule.contentType || 'default',
            rule.targetServiceId,
            rule.targetModel || null,
            rule.replacedModel || null,
            rule.sortOrder || 0,
            rule.timeout || null,
            rule.tokenLimit || null,
            rule.totalTokensUsed || 0,
            rule.resetInterval || null,
            rule.lastResetAt || null,
            rule.createdAt,
            rule.updatedAt
          );
      }

      // Update config
      this.updateConfig(importData.config);

      return true;
    } catch (error) {
      console.error('Import error:', error);
      return false;
    }
  }

  // Statistics operations
  async getStatistics(days: number = 30): Promise<Statistics> {
    const now = Date.now();
    const startTime = now - days * 24 * 60 * 60 * 1000;

    // Get all logs within the time period
    const allLogs: RequestLog[] = [];
    for await (const [, value] of this.logDb.iterator()) {
      const log = JSON.parse(value) as RequestLog;
      if (log.timestamp >= startTime) {
        allLogs.push(log);
      }
    }

    // Get all error logs
    const errorLogs: ErrorLog[] = [];
    const recentErrorLogs: ErrorLog[] = [];
    const recentTime = now - 24 * 60 * 60 * 1000; // 24 hours ago
    for await (const [, value] of this.errorLogDb.iterator()) {
      const log = JSON.parse(value) as ErrorLog;
      errorLogs.push(log);
      if (log.timestamp >= recentTime) {
        recentErrorLogs.push(log);
      }
    }

    // Get vendors and services for mapping
    const vendors = this.getVendors();
    const vendorMap = new Map(vendors.map(v => [v.id, v.name]));
    const services = this.getAPIServices();
    const serviceMap = new Map(services.map(s => [s.id, { name: s.name, vendorId: s.vendorId }]));

    // Calculate overview
    const totalRequests = allLogs.length;
    const successRequests = allLogs.filter(log => log.statusCode && log.statusCode >= 200 && log.statusCode < 400).length;
    const totalInputTokens = allLogs.reduce((sum, log) => sum + (log.usage?.inputTokens || 0), 0);
    const totalOutputTokens = allLogs.reduce((sum, log) => sum + (log.usage?.outputTokens || 0), 0);
    const totalCacheReadTokens = allLogs.reduce((sum, log) => sum + (log.usage?.cacheReadInputTokens || 0), 0);
    const totalTokens = allLogs.reduce((sum, log) => {
      if (log.usage?.totalTokens) return sum + log.usage.totalTokens;
      return sum + (log.usage?.inputTokens || 0) + (log.usage?.outputTokens || 0);
    }, 0);
    const avgResponseTime = allLogs.length > 0
      ? allLogs.reduce((sum, log) => sum + (log.responseTime || 0), 0) / allLogs.length
      : 0;
    const successRate = totalRequests > 0 ? (successRequests / totalRequests) * 100 : 0;

    // Calculate coding time (estimate based on tokens and requests)
    // Assume average reading speed: 250 tokens/minute, coding speed: 100 tokens/minute
    const totalCodingTime = Math.round(totalInputTokens / 250 + totalOutputTokens / 100);

    // Group by target type
    const byTargetTypeMap = new Map<string, { requests: number; tokens: number; responseTime: number }>();
    for (const log of allLogs) {
      const key = log.targetType || 'unknown';
      if (!byTargetTypeMap.has(key)) {
        byTargetTypeMap.set(key, { requests: 0, tokens: 0, responseTime: 0 });
      }
      const stats = byTargetTypeMap.get(key)!;
      stats.requests++;
      stats.tokens += log.usage?.totalTokens || (log.usage?.inputTokens || 0) + (log.usage?.outputTokens || 0);
      stats.responseTime += log.responseTime || 0;
    }

    const byTargetType = Array.from(byTargetTypeMap.entries()).map(([targetType, stats]) => ({
      targetType: targetType as any,
      totalRequests: stats.requests,
      totalTokens: stats.tokens,
      avgResponseTime: stats.requests > 0 ? Math.round(stats.responseTime / stats.requests) : 0,
    }));

    // Group by vendor
    const byVendorMap = new Map<string, { requests: number; tokens: number; responseTime: number }>();
    for (const log of allLogs) {
      const key = log.vendorId || 'unknown';
      if (!byVendorMap.has(key)) {
        byVendorMap.set(key, { requests: 0, tokens: 0, responseTime: 0 });
      }
      const stats = byVendorMap.get(key)!;
      stats.requests++;
      stats.tokens += log.usage?.totalTokens || (log.usage?.inputTokens || 0) + (log.usage?.outputTokens || 0);
      stats.responseTime += log.responseTime || 0;
    }

    const byVendor = Array.from(byVendorMap.entries()).map(([vendorId, stats]) => ({
      vendorId,
      vendorName: vendorMap.get(vendorId) || 'Unknown',
      totalRequests: stats.requests,
      totalTokens: stats.tokens,
      avgResponseTime: stats.requests > 0 ? Math.round(stats.responseTime / stats.requests) : 0,
    }));

    // Group by service
    const byServiceMap = new Map<string, { requests: number; tokens: number; responseTime: number }>();
    for (const log of allLogs) {
      const key = log.targetServiceId || 'unknown';
      if (!byServiceMap.has(key)) {
        byServiceMap.set(key, { requests: 0, tokens: 0, responseTime: 0 });
      }
      const stats = byServiceMap.get(key)!;
      stats.requests++;
      stats.tokens += log.usage?.totalTokens || (log.usage?.inputTokens || 0) + (log.usage?.outputTokens || 0);
      stats.responseTime += log.responseTime || 0;
    }

    const byService = Array.from(byServiceMap.entries()).map(([serviceId, stats]) => {
      const serviceInfo = serviceMap.get(serviceId);
      return {
        serviceId,
        serviceName: serviceInfo?.name || 'Unknown',
        vendorName: serviceInfo ? vendorMap.get(serviceInfo.vendorId) || 'Unknown' : 'Unknown',
        totalRequests: stats.requests,
        totalTokens: stats.tokens,
        avgResponseTime: stats.requests > 0 ? Math.round(stats.responseTime / stats.requests) : 0,
      };
    });

    // Group by model
    const byModelMap = new Map<string, { requests: number; tokens: number; responseTime: number }>();
    for (const log of allLogs) {
      const key = log.targetModel || 'unknown';
      if (!byModelMap.has(key)) {
        byModelMap.set(key, { requests: 0, tokens: 0, responseTime: 0 });
      }
      const stats = byModelMap.get(key)!;
      stats.requests++;
      stats.tokens += log.usage?.totalTokens || (log.usage?.inputTokens || 0) + (log.usage?.outputTokens || 0);
      stats.responseTime += log.responseTime || 0;
    }

    const byModel = Array.from(byModelMap.entries()).map(([modelName, stats]) => ({
      modelName,
      totalRequests: stats.requests,
      totalTokens: stats.tokens,
      avgResponseTime: stats.requests > 0 ? Math.round(stats.responseTime / stats.requests) : 0,
    }));

    // Timeline data (by day)
    const timelineMap = new Map<string, { requests: number; tokens: number; inputTokens: number; outputTokens: number }>();
    for (const log of allLogs) {
      const date = new Date(log.timestamp).toISOString().split('T')[0];
      if (!timelineMap.has(date)) {
        timelineMap.set(date, { requests: 0, tokens: 0, inputTokens: 0, outputTokens: 0 });
      }
      const stats = timelineMap.get(date)!;
      stats.requests++;
      stats.inputTokens += log.usage?.inputTokens || 0;
      stats.outputTokens += log.usage?.outputTokens || 0;
      stats.tokens += log.usage?.totalTokens || (log.usage?.inputTokens || 0) + (log.usage?.outputTokens || 0);
    }

    const timeline = Array.from(timelineMap.entries())
      .map(([date, stats]) => ({
        date,
        totalRequests: stats.requests,
        totalTokens: stats.tokens,
        totalInputTokens: stats.inputTokens,
        totalOutputTokens: stats.outputTokens,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Content type distribution (infer from request patterns)
    const contentTypeMap = new Map<string, number>();
    for (const log of allLogs) {
      // Infer content type from request characteristics
      let contentType = 'default';
      if (log.body && (log.body.includes('image') || log.body.includes('base64'))) {
        contentType = 'image-understanding';
      } else if (log.requestModel && log.requestModel.toLowerCase().includes('think')) {
        contentType = 'thinking';
      } else if (log.usage && log.usage.inputTokens > 12000) {
        contentType = 'long-context';
      }

      contentTypeMap.set(contentType, (contentTypeMap.get(contentType) || 0) + 1);
    }

    const contentTypeDistribution = Array.from(contentTypeMap.entries()).map(([contentType, count]) => ({
      contentType,
      count,
      percentage: totalRequests > 0 ? Math.round((count / totalRequests) * 100) : 0,
    }));

    return {
      overview: {
        totalRequests,
        totalTokens,
        totalInputTokens,
        totalOutputTokens,
        totalCacheReadTokens,
        totalVendors: vendors.length,
        totalServices: services.length,
        totalRoutes: this.getRoutes().length,
        totalRules: this.getRules().length,
        avgResponseTime: Math.round(avgResponseTime),
        successRate: Math.round(successRate * 10) / 10,
        totalCodingTime,
      },
      byTargetType,
      byVendor,
      byService,
      byModel,
      timeline,
      contentTypeDistribution,
      errors: {
        totalErrors: errorLogs.length,
        recentErrors: recentErrorLogs.length,
      },
    };
  }

  close() {
    this.db.close();
    this.logDb.close();
    this.accessLogDb.close();
    this.errorLogDb.close();
    this.blacklistDb.close();
  }
}
