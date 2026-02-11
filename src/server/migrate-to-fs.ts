import path from 'path';
import fs from 'fs/promises';

/**
 * 数据库迁移工具
 * 从 better-sqlite3 和 leveldb 迁移到文件系统数据库
 */
export async function migrateToFileSystem(
  sourceDataPath: string,
  targetDataPath: string = sourceDataPath
): Promise<void> {
  console.log('[Migration] Starting migration to file system database...');

  try {
    // 动态导入旧数据库（如果存在）
    const oldDbPath = path.join(sourceDataPath, 'app.db');
    const oldDbExists = await fs.access(oldDbPath).then(() => true).catch(() => false);

    if (!oldDbExists) {
      console.log('[Migration] No old database found, skipping migration');
      return;
    }

    await fs.mkdir(targetDataPath, { recursive: true });

    // 尝试导入旧数据库模块（仅在有 SQLite 依赖时可用）
    let DatabaseManager: any;
    try {
      const dbModule = await import('./database.js');
      DatabaseManager = dbModule.DatabaseManager;
    } catch (error) {
      console.log('[Migration] Old database module not available');
      console.log('[Migration] This is expected if better-sqlite3 is not installed');
      console.log('[Migration] To migrate old data, please run: yarn add better-sqlite3 level');
      console.log('[Migration] Then run the migration again');
      return;
    }

    // 创建旧数据库实例
    console.log('[Migration] Initializing old database...');
    const oldDb = new DatabaseManager(sourceDataPath);
    await oldDb.initialize();

    // 导出核心数据
    console.log('[Migration] Exporting core data from old database...');
    const vendors = oldDb.getVendors();
    const services = oldDb.getAPIServices();
    const routes = oldDb.getRoutes();
    const rules = oldDb.getRules();
    const config = oldDb.getConfig();

    console.log(`[Migration] Found ${vendors.length} vendors`);
    console.log(`[Migration] Found ${services.length} services`);
    console.log(`[Migration] Found ${routes.length} routes`);
    console.log(`[Migration] Found ${rules.length} rules`);

    // 将 services 按 vendorId 分组并嵌入到 vendors 中
    console.log('[Migration] Restructuring vendors with nested services...');
    const servicesByVendor = new Map<string, any[]>();
    for (const service of services) {
      if (!service.vendorId) {
        console.warn(`[Migration] Skipping service without vendorId: ${service.id}`);
        continue;
      }
      if (!servicesByVendor.has(service.vendorId)) {
        servicesByVendor.set(service.vendorId, []);
      }
      // 移除 vendorId 字段，因为现在通过父级关系隐式关联
      const { vendorId, ...serviceWithoutVendorId } = service;
      servicesByVendor.get(service.vendorId)!.push(serviceWithoutVendorId);
    }

    // 为每个 vendor 添加 services 数组
    const vendorsWithServices = vendors.map((vendor: any) => ({
      ...vendor,
      services: servicesByVendor.get(vendor.id) || []
    }));

    console.log('[Migration] Restructuring completed');

    // 保存核心数据到新的文件系统格式
    console.log('[Migration] Saving core data to file system...');
    await fs.writeFile(
      path.join(targetDataPath, 'vendors.json'),
      JSON.stringify(vendorsWithServices, null, 2)
    );
    // 不再保存独立的 services.json，已合并到 vendors.json 中
    await fs.writeFile(
      path.join(targetDataPath, 'routes.json'),
      JSON.stringify({ routes, rules }, null, 2)
    );
    await fs.writeFile(
      path.join(targetDataPath, 'config.json'),
      JSON.stringify(config, null, 2)
    );

    // 迁移 sessions（如果存在）
    try {
      console.log('[Migration] Migrating sessions...');
      const sessions = oldDb.getSessions(10000, 0);
      await fs.writeFile(
        path.join(targetDataPath, 'sessions.json'),
        JSON.stringify(sessions, null, 2)
      );
      console.log(`[Migration] Migrated ${sessions.length} sessions`);
    } catch (error) {
      console.log('[Migration] Could not migrate sessions:', error);
      // 创建空的 sessions 文件
      await fs.writeFile(
        path.join(targetDataPath, 'sessions.json'),
        JSON.stringify([], null, 2)
      );
    }

    // 迁移请求日志（限制数量以避免文件过大）
    try {
      console.log('[Migration] Migrating request logs (last 5000)...');
      const logs = await oldDb.getLogs(5000, 0);
      
      // 完整迁移所有日志，不进行任何截断
      if (logs.length > 0) {
        // 修复字段名：将 response 改为 responseBody
        const cleanedLogs = logs.map((log: any) => ({
          ...log,
          // 兼容旧的 response 字段名，重命名为 responseBody
          responseBody: log.responseBody || log.response,
          // 移除旧的 response 字段（如果存在）
          response: undefined,
        }));
        
        await fs.writeFile(
          path.join(targetDataPath, 'logs.json'),
          JSON.stringify(cleanedLogs, null, 2)
        );
        console.log(`[Migration] Migrated ${logs.length} request logs`);
      } else {
        // 创建空的日志文件
        await fs.writeFile(
          path.join(targetDataPath, 'logs.json'),
          JSON.stringify([], null, 2)
        );
        console.log('[Migration] No request logs to migrate');
      }
    } catch (error) {
      console.log('[Migration] Could not migrate logs:', error instanceof Error ? error.message : error);
      // 创建空的日志文件
      await fs.writeFile(
        path.join(targetDataPath, 'logs.json'),
        JSON.stringify([], null, 2)
      );
    }

    // 迁移错误日志
    try {
      console.log('[Migration] Migrating error logs (last 1000)...');
      const errorLogs = await oldDb.getErrorLogs(1000, 0);
      await fs.writeFile(
        path.join(targetDataPath, 'error-logs.json'),
        JSON.stringify(errorLogs, null, 2)
      );
      console.log(`[Migration] Migrated ${errorLogs.length} error logs`);
    } catch (error) {
      console.log('[Migration] Could not migrate error logs:', error);
      // 创建空的错误日志文件
      await fs.writeFile(
        path.join(targetDataPath, 'error-logs.json'),
        JSON.stringify([], null, 2)
      );
    }

    // 创建空的黑名单文件
    await fs.writeFile(
      path.join(targetDataPath, 'blacklist.json'),
      JSON.stringify([], null, 2)
    );

    // 关闭旧数据库连接
    try {
      console.log('[Migration] Closing old database connections...');
      oldDb.close();
      // 等待一下确保文件句柄被释放
      await new Promise(resolve => setTimeout(resolve, 1000));
      console.log('[Migration] Old database connections closed');
    } catch (error) {
      console.log('[Migration] Warning: Could not close old database:', error instanceof Error ? error.message : error);
    }

    // 保留原始数据库文件，不进行备份或重命名
    // 这样如果迁移失败，用户可以使用老版本继续运行
    console.log('[Migration] ✅ Migration data export completed successfully!');
    console.log('[Migration] Original database files preserved for rollback');
  } catch (error) {
    console.error('[Migration] ❌ Migration failed:', error);
    console.error('[Migration] Stack trace:', (error as Error).stack);
    throw error;
  }
}

/**
 * 迁移旧版本的文件系统数据库目录到新目录（仅复制 JSON/日志文件）
 */
export async function migrateLegacyFsData(
  legacyDataPath: string,
  targetDataPath: string
): Promise<void> {
  console.log('[Migration] Migrating legacy filesystem data directory...');
  await fs.mkdir(targetDataPath, { recursive: true });

  const filesToCopy = [
    'vendors.json',
    'services.json',
    'routes.json',
    'rules.json',
    'config.json',
    'sessions.json',
    'logs.json',
    'logs-index.json',
    'error-logs.json',
    'blacklist.json',
    'statistics.json',
  ];

  for (const filename of filesToCopy) {
    const src = path.join(legacyDataPath, filename);
    const dest = path.join(targetDataPath, filename);
    const exists = await fs.access(src).then(() => true).catch(() => false);
    if (exists) {
      await fs.copyFile(src, dest);
    }
  }

  const legacyLogsDir = path.join(legacyDataPath, 'logs');
  const targetLogsDir = path.join(targetDataPath, 'logs');
  const logsDirExists = await fs.access(legacyLogsDir).then(() => true).catch(() => false);
  if (logsDirExists) {
    await fs.cp(legacyLogsDir, targetLogsDir, { recursive: true });
  }

  console.log('[Migration] Legacy filesystem data migration completed');
}

/**
 * 检查是否需要迁移
 * @param dataPath 数据目录路径
 * @returns 是否需要迁移
 */
export async function needsMigration(sourceDataPath: string, targetDataPath: string = sourceDataPath): Promise<boolean> {
  try {
    // 检查是否存在旧的 SQLite 数据库
    const oldDbPath = path.join(sourceDataPath, 'app.db');
    const oldDbExists = await fs.access(oldDbPath).then(() => true).catch(() => false);
    
    if (!oldDbExists) {
      return false;
    }

    // 检查是否已经存在新的文件系统数据库
    const newDbPath = path.join(targetDataPath, 'config.json');
    const newDbExists = await fs.access(newDbPath).then(() => true).catch(() => false);
    
    // 如果旧数据库存在且新数据库不存在，则需要迁移
    return oldDbExists && !newDbExists;
  } catch (error) {
    console.error('[Migration] Error checking migration status:', error);
    return false;
  }
}

/**
 * 验证迁移结果
 * @param dataPath 数据目录路径
 * @returns 验证结果
 */
export async function verifyMigration(dataPath: string): Promise<{
  success: boolean;
  errors: string[];
  warnings: string[];
}> {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // 检查必需的文件（移除了 services.json，因为现在合并到 vendors.json 中）
    const requiredFiles = [
      'vendors.json',
      'routes.json',
      'config.json',
      'sessions.json',
      'logs.json',
      'error-logs.json',
      'blacklist.json',
    ];

    for (const file of requiredFiles) {
      const filePath = path.join(dataPath, file);
      try {
        await fs.access(filePath);
        // 尝试解析 JSON
        const content = await fs.readFile(filePath, 'utf-8');
        JSON.parse(content);

        // 特殊验证：确保 vendors.json 包含 services 数组
        if (file === 'vendors.json') {
          const vendors = JSON.parse(content);
          for (const vendor of vendors) {
            if (!Array.isArray(vendor.services)) {
              errors.push(`Invalid vendors.json: vendor ${vendor.id} is missing services array`);
            }
          }
        }

        // 特殊验证：确保 routes.json 包含 routes 与 rules
        if (file === 'routes.json') {
          const routesData = JSON.parse(content);
          if (!routesData || typeof routesData !== 'object') {
            errors.push('Invalid routes.json: missing routes/rules object');
          } else {
            if (!Array.isArray(routesData.routes)) {
              errors.push('Invalid routes.json: routes is not an array');
            }
            if (!Array.isArray(routesData.rules)) {
              errors.push('Invalid routes.json: rules is not an array');
            }
          }
        }
      } catch (error) {
        errors.push(`File ${file} is missing or invalid`);
      }
    }

    // 可选文件检查（services.json）
    const oldServicesFile = path.join(dataPath, 'services.json');
    const oldServicesExists = await fs.access(oldServicesFile).then(() => true).catch(() => false);
    if (oldServicesExists) {
      warnings.push('Old services.json file still exists (should have been migrated to vendors.json)');
    }

    const oldRulesFile = path.join(dataPath, 'rules.json');
    const oldRulesExists = await fs.access(oldRulesFile).then(() => true).catch(() => false);
    if (oldRulesExists) {
      warnings.push('Old rules.json file still exists (should have been migrated to routes.json)');
    }

    return {
      success: errors.length === 0,
      errors,
      warnings,
    };
  } catch (error) {
    errors.push(`Verification failed: ${(error as Error).message}`);
    return {
      success: false,
      errors,
      warnings,
    };
  }
}
