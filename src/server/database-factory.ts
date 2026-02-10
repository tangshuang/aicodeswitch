import path from 'path';
import { FileSystemDatabaseManager } from './fs-database';

/**
 * 数据库类型
 */
export type DatabaseType = 'filesystem' | 'sqlite';

/**
 * 数据库工厂
 * 根据配置创建相应的数据库实例
 */
export class DatabaseFactory {
  /**
   * 创建数据库实例
   * @param dataPath 数据存储路径
   * @param type 数据库类型，默认使用文件系统
   */
  static async create(dataPath: string, type: DatabaseType = 'filesystem') {
    if (type === 'filesystem') {
      const db = new FileSystemDatabaseManager(dataPath);
      await db.initialize();
      return db;
    }

    // 如果用户明确要求使用 SQLite，尝试加载
    if (type === 'sqlite') {
      try {
        const { DatabaseManager } = await import('./database.js');
        const db = new DatabaseManager(dataPath);
        await db.initialize();
        return db;
      } catch (error) {
        console.error('[Database] Failed to load SQLite database, falling back to filesystem:', error);
        console.log('[Database] Using filesystem database instead');
        const db = new FileSystemDatabaseManager(dataPath);
        await db.initialize();
        return db;
      }
    }

    throw new Error(`Unknown database type: ${type}`);
  }

  /**
   * 自动检测并创建数据库实例
   * 优先使用文件系统数据库，如果存在旧的 SQLite 数据库则自动迁移
   */
  static async createAuto(dataPath: string) {
    const fs = await import('fs/promises');
    
    // 检查是否存在文件系统数据库
    const fsDbExists = await fs.access(path.join(dataPath, 'config.json'))
      .then(() => true)
      .catch(() => false);

    if (fsDbExists) {
      console.log('[Database] Using existing filesystem database');
      return this.create(dataPath, 'filesystem');
    }

    // 检查是否存在旧的 SQLite 数据库
    const sqliteDbExists = await fs.access(path.join(dataPath, 'app.db'))
      .then(() => true)
      .catch(() => false);

    if (sqliteDbExists) {
      console.log('[Database] Found old SQLite database, migrating to filesystem...');
      try {
        const { migrateToFileSystem, verifyMigration } = await import('./migrate-to-fs.js');
        
        // 执行迁移
        await migrateToFileSystem(dataPath);
        
        // 验证迁移结果
        console.log('[Database] Verifying migration...');
        const verification = await verifyMigration(dataPath);
        
        if (verification.success) {
          console.log('[Database] ✅ Migration verified successfully');
          if (verification.warnings.length > 0) {
            console.log('[Database] Warnings:', verification.warnings);
          }
        } else {
          console.error('[Database] ❌ Migration verification failed');
          console.error('[Database] Errors:', verification.errors);
          throw new Error('Migration verification failed');
        }
        
        console.log('[Database] Migration completed, using filesystem database');
      } catch (error) {
        console.error('[Database] Migration failed:', error);
        console.log('[Database] Creating new filesystem database');
        // 即使迁移失败，也创建新的文件系统数据库
        // 用户可以手动恢复备份或重新配置
      }
    } else {
      console.log('[Database] No existing database found, creating new filesystem database');
    }

    return this.create(dataPath, 'filesystem');
  }
}
