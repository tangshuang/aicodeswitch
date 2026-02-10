import path from 'path';
import fs from 'fs/promises';

/**
 * 数据库迁移工具
 * 从 better-sqlite3 和 leveldb 迁移到文件系统数据库
 */
export async function migrateToFileSystem(dataPath: string): Promise<void> {
  console.log('[Migration] Starting migration to file system database...');

  try {
    // 动态导入旧数据库（如果存在）
    const oldDbPath = path.join(dataPath, 'app.db');
    const oldDbExists = await fs.access(oldDbPath).then(() => true).catch(() => false);

    if (!oldDbExists) {
      console.log('[Migration] No old database found, skipping migration');
      return;
    }

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
    const oldDb = new DatabaseManager(dataPath);
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

    // 保存核心数据到新的文件系统格式
    console.log('[Migration] Saving core data to file system...');
    await fs.writeFile(
      path.join(dataPath, 'vendors.json'),
      JSON.stringify(vendors, null, 2)
    );
    await fs.writeFile(
      path.join(dataPath, 'services.json'),
      JSON.stringify(services, null, 2)
    );
    await fs.writeFile(
      path.join(dataPath, 'routes.json'),
      JSON.stringify(routes, null, 2)
    );
    await fs.writeFile(
      path.join(dataPath, 'rules.json'),
      JSON.stringify(rules, null, 2)
    );
    await fs.writeFile(
      path.join(dataPath, 'config.json'),
      JSON.stringify(config, null, 2)
    );

    // 迁移 sessions（如果存在）
    try {
      console.log('[Migration] Migrating sessions...');
      const sessions = oldDb.getSessions(10000, 0);
      await fs.writeFile(
        path.join(dataPath, 'sessions.json'),
        JSON.stringify(sessions, null, 2)
      );
      console.log(`[Migration] Migrated ${sessions.length} sessions`);
    } catch (error) {
      console.log('[Migration] Could not migrate sessions:', error);
      // 创建空的 sessions 文件
      await fs.writeFile(
        path.join(dataPath, 'sessions.json'),
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
          path.join(dataPath, 'logs.json'),
          JSON.stringify(cleanedLogs, null, 2)
        );
        console.log(`[Migration] Migrated ${logs.length} request logs`);
      } else {
        // 创建空的日志文件
        await fs.writeFile(
          path.join(dataPath, 'logs.json'),
          JSON.stringify([], null, 2)
        );
        console.log('[Migration] No request logs to migrate');
      }
    } catch (error) {
      console.log('[Migration] Could not migrate logs:', error instanceof Error ? error.message : error);
      // 创建空的日志文件
      await fs.writeFile(
        path.join(dataPath, 'logs.json'),
        JSON.stringify([], null, 2)
      );
    }

    // 迁移错误日志
    try {
      console.log('[Migration] Migrating error logs (last 1000)...');
      const errorLogs = await oldDb.getErrorLogs(1000, 0);
      await fs.writeFile(
        path.join(dataPath, 'error-logs.json'),
        JSON.stringify(errorLogs, null, 2)
      );
      console.log(`[Migration] Migrated ${errorLogs.length} error logs`);
    } catch (error) {
      console.log('[Migration] Could not migrate error logs:', error);
      // 创建空的错误日志文件
      await fs.writeFile(
        path.join(dataPath, 'error-logs.json'),
        JSON.stringify([], null, 2)
      );
    }

    // 创建空的黑名单文件
    await fs.writeFile(
      path.join(dataPath, 'blacklist.json'),
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
 * 检查是否需要迁移
 * @param dataPath 数据目录路径
 * @returns 是否需要迁移
 */
export async function needsMigration(dataPath: string): Promise<boolean> {
  try {
    // 检查是否存在旧的 SQLite 数据库
    const oldDbPath = path.join(dataPath, 'app.db');
    const oldDbExists = await fs.access(oldDbPath).then(() => true).catch(() => false);
    
    if (!oldDbExists) {
      return false;
    }

    // 检查是否已经存在新的文件系统数据库
    const newDbPath = path.join(dataPath, 'config.json');
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
    // 检查必需的文件
    const requiredFiles = [
      'vendors.json',
      'services.json',
      'routes.json',
      'rules.json',
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
      } catch (error) {
        errors.push(`File ${file} is missing or invalid`);
      }
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
