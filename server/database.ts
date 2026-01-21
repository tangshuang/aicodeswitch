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
} from '../types';

export class DatabaseManager {
  private db: Database.Database;
  private logDb: Level<string, string>;
  private accessLogDb: Level<string, string>;
  private errorLogDb: Level<string, string>;

  constructor(dataPath: string) {
    this.db = new Database(path.join(dataPath, 'app.db'));
    this.logDb = new Level(path.join(dataPath, 'logs'), { valueEncoding: 'json' });
    this.accessLogDb = new Level(path.join(dataPath, 'access-logs'), { valueEncoding: 'json' });
    this.errorLogDb = new Level(path.join(dataPath, 'error-logs'), { valueEncoding: 'json' });
  }

  async initialize() {
    this.createTables();
    await this.ensureDefaultConfig();
  }

  private createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vendors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

       CREATE TABLE IF NOT EXISTS api_services (
         id TEXT PRIMARY KEY,
         vendor_id TEXT NOT NULL,
         name TEXT NOT NULL,
         api_url TEXT NOT NULL,
         api_key TEXT NOT NULL,
         timeout INTEGER,
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
        content_type TEXT NOT NULL CHECK(content_type IN ('default', 'background', 'thinking', 'long-context', 'image-understanding')),
        target_service_id TEXT NOT NULL,
        target_model TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
        FOREIGN KEY (target_service_id) REFERENCES api_services(id) ON DELETE CASCADE,
        UNIQUE(route_id, content_type)
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
        logRetentionDays: 7,
        maxLogSize: 1000,
        apiKey: '',
      };
      this.db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run(
        'app_config',
        JSON.stringify(defaultConfig)
      );
    }
  }

  // Vendor operations
  getVendors(): Vendor[] {
    const rows = this.db.prepare('SELECT * FROM vendors ORDER BY created_at DESC').all();
    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  createVendor(vendor: Omit<Vendor, 'id' | 'createdAt' | 'updatedAt'>): Vendor {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare('INSERT INTO vendors (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, vendor.name, vendor.description || null, now, now);
    return { ...vendor, id, createdAt: now, updatedAt: now };
  }

  updateVendor(id: string, vendor: Partial<Vendor>): boolean {
    const now = Date.now();
    const result = this.db
      .prepare('UPDATE vendors SET name = ?, description = ?, updated_at = ? WHERE id = ?')
      .run(vendor.name, vendor.description || null, now, id);
    return result.changes > 0;
  }

  deleteVendor(id: string): boolean {
    const result = this.db.prepare('DELETE FROM vendors WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // API Service operations
  getAPIServices(vendorId?: string): APIService[] {
    const query = vendorId
      ? 'SELECT * FROM api_services WHERE vendor_id = ? ORDER BY created_at DESC'
      : 'SELECT * FROM api_services ORDER BY created_at DESC';
    const stmt = vendorId ? this.db.prepare(query).bind(vendorId) : this.db.prepare(query);
    const rows = stmt.all();
    return rows.map((row: any) => ({
      id: row.id,
      vendorId: row.vendor_id,
      name: row.name,
      apiUrl: row.api_url,
      apiKey: row.api_key,

      timeout: row.timeout,
      sourceType: row.source_type,
      supportedModels: row.supported_models ? row.supported_models.split(',').map((model: string) => model.trim()).filter((model: string) => model.length > 0) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  createAPIService(service: Omit<APIService, 'id' | 'createdAt' | 'updatedAt'>): APIService {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO api_services (id, vendor_id, name, api_url, api_key, timeout, source_type, supported_models, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        service.vendorId,
        service.name,
        service.apiUrl,
        service.apiKey,
        service.timeout || null,
        service.sourceType || null,
        service.supportedModels ? service.supportedModels.join(',') : null,
        now,
        now
      );
    return { ...service, id, createdAt: now, updatedAt: now };
  }

  updateAPIService(id: string, service: Partial<APIService>): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(
        'UPDATE api_services SET name = ?, api_url = ?, api_key = ?, timeout = ?, source_type = ?, supported_models = ?, updated_at = ? WHERE id = ?'
      )
      .run(
        service.name,
        service.apiUrl,
        service.apiKey,
        service.timeout || null,
        service.sourceType || null,
        service.supportedModels ? service.supportedModels.join(',') : null,
        now,
        id
      );
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
      ? 'SELECT * FROM rules WHERE route_id = ? ORDER BY created_at DESC'
      : 'SELECT * FROM rules ORDER BY created_at DESC';
    const stmt = routeId ? this.db.prepare(query).bind(routeId) : this.db.prepare(query);
    const rows = stmt.all();
    return rows.map((row: any) => ({
      id: row.id,
      routeId: row.route_id,
      contentType: row.content_type,
      targetServiceId: row.target_service_id,
      targetModel: row.target_model,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  createRule(route: Omit<Rule, 'id' | 'createdAt' | 'updatedAt'>): Rule {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO rules (id, route_id, content_type, target_service_id, target_model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        route.routeId,
        route.contentType,
        route.targetServiceId,
        route.targetModel || null,
        now,
        now
      );
    return { ...route, id, createdAt: now, updatedAt: now };
  }

  updateRule(id: string, route: Partial<Rule>): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(
        'UPDATE rules SET content_type = ?, target_service_id = ?, target_model = ?, updated_at = ? WHERE id = ?'
      )
      .run(
        route.contentType,
        route.targetServiceId,
        route.targetModel || null,
        now,
        id
      );
    return result.changes > 0;
  }

  deleteRule(id: string): boolean {
    const result = this.db.prepare('DELETE FROM rules WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // Log operations
  async addLog(log: Omit<RequestLog, 'id'>): Promise<void> {
    const id = crypto.randomUUID();
    await this.logDb.put(id, JSON.stringify({ ...log, id }));
  }

  async getLogs(limit: number = 100, offset: number = 0): Promise<RequestLog[]> {
    const logs: RequestLog[] = [];
    let count = 0;
    for await (const [, value] of this.logDb.iterator({ reverse: true })) {
      if (count >= offset && logs.length < limit) {
        logs.push(JSON.parse(value));
      }
      count++;
      if (logs.length >= limit) break;
    }
    return logs;
  }

  async clearLogs(): Promise<void> {
    await this.logDb.clear();
  }

  // Access log operations
  async addAccessLog(log: Omit<AccessLog, 'id'>): Promise<string> {
    const id = crypto.randomUUID();
    await this.accessLogDb.put(id, JSON.stringify({ ...log, id }));
    return id;
  }

  async updateAccessLog(id: string, data: Partial<AccessLog>): Promise<void> {
    const log = await this.accessLogDb.get(id);
    const updatedLog = { ...JSON.parse(log), ...data };
    await this.accessLogDb.put(id, JSON.stringify(updatedLog));
  }

  async getAccessLogs(limit: number = 100, offset: number = 0): Promise<AccessLog[]> {
    const logs: AccessLog[] = [];
    let count = 0;
    for await (const [, value] of this.accessLogDb.iterator({ reverse: true })) {
      if (count >= offset && logs.length < limit) {
        logs.push(JSON.parse(value));
      }
      count++;
      if (logs.length >= limit) break;
    }
    return logs;
  }

  async clearAccessLogs(): Promise<void> {
    await this.accessLogDb.clear();
  }

  // Error log operations
  async addErrorLog(log: Omit<ErrorLog, 'id'>): Promise<void> {
    const id = crypto.randomUUID();
    await this.errorLogDb.put(id, JSON.stringify({ ...log, id }));
  }

  async getErrorLogs(limit: number = 100, offset: number = 0): Promise<ErrorLog[]> {
    const logs: ErrorLog[] = [];
    let count = 0;
    for await (const [, value] of this.errorLogDb.iterator({ reverse: true })) {
      if (count >= offset && logs.length < limit) {
        logs.push(JSON.parse(value));
      }
      count++;
      if (logs.length >= limit) break;
    }
    return logs;
  }

  async clearErrorLogs(): Promise<void> {
    await this.errorLogDb.clear();
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
          .prepare('INSERT INTO vendors (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(vendor.id, vendor.name, vendor.description || null, vendor.createdAt, vendor.updatedAt);
      }

       // Import API services
       for (const service of importData.apiServices) {
         this.db
           .prepare(
             'INSERT INTO api_services (id, vendor_id, name, api_url, api_key, timeout, source_type, supported_models, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
           )
           .run(
             service.id,
             service.vendorId,
             service.name,
             service.apiUrl,
             service.apiKey,
             service.timeout || null,
             service.sourceType || null,
             service.supportedModels ? service.supportedModels.join(',') : null,
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
            'INSERT INTO rules (id, route_id, content_type, target_service_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(
            rule.id,
            rule.routeId,
            rule.contentType || 'default',
            rule.targetServiceId,
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

  close() {
    this.db.close();
    this.logDb.close();
  }
}
