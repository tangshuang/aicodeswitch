import path from 'path';
import { FileSystemDatabaseManager } from './fs-database';
import * as migrateToFs from './migrate-to-fs';

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

    // 检查迁移完成标记文件
    const migrationMarkerPath = path.join(dataPath, '.migration-completed');
    const hasMigrationMarker = await fs.access(migrationMarkerPath)
      .then(() => true)
      .catch(() => false);

    // 检查是否存在文件系统数据库
    const fsDbExists = await fs.access(path.join(dataPath, 'config.json'))
      .then(() => true)
      .catch(() => false);

    // 如果存在迁移标记且文件系统数据库存在，使用文件系统数据库
    if (hasMigrationMarker && fsDbExists) {
      console.log('[Database] Migration marker found, using filesystem database');
      return this.create(dataPath, 'filesystem');
    }

    // 如果不存在迁移标记但存在文件系统数据库，可能是用户手动删除了标记
    // 这种情况下仍然使用文件系统数据库（避免数据丢失）
    if (fsDbExists) {
      console.log('[Database] Using existing filesystem database (no migration marker)');
      return this.create(dataPath, 'filesystem');
    }

    // 检查是否存在旧的 SQLite 数据库
    const sqliteDbExists = await fs.access(path.join(dataPath, 'app.db'))
      .then(() => true)
      .catch(() => false);

    if (sqliteDbExists) {
      console.log('[Database] Found old SQLite database, migrating to filesystem...');
      try {
        // 执行迁移
        await migrateToFs.migrateToFileSystem(dataPath);

        // 验证迁移结果
        console.log('[Database] Verifying migration...');
        const verification = await migrateToFs.verifyMigration(dataPath);

        if (verification.success) {
          console.log('[Database] ✅ Migration verified successfully');
          if (verification.warnings.length > 0) {
            console.log('[Database] Warnings:', verification.warnings);
          }

          // 只有在验证成功后才创建标记文件
          const migrationMarkerPath = path.join(dataPath, '.migration-completed');
          await fs.writeFile(migrationMarkerPath, new Date().toISOString(), 'utf-8');
          console.log('[Database] Migration marker file created:', migrationMarkerPath);
        } else {
          console.error('[Database] ❌ Migration verification failed');
          console.error('[Database] Errors:', verification.errors);
          throw new Error('Migration verification failed');
        }

        console.log('[Database] Migration completed, using filesystem database');
      } catch (error) {
        console.error('[Database] Migration failed:', error);
        console.log('[Database] Creating new filesystem database');
        // 迁移失败时，原始数据库文件保持不变
        // 用户可以使用老版本继续运行，或手动重新配置
      }
    } else {
      console.log('[Database] No existing database found, creating new filesystem database');
    }

    return this.create(dataPath, 'filesystem');
  }
}
