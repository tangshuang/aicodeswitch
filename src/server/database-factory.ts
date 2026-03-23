import { FileSystemDatabaseManager } from './fs-database';

/**
 * 数据库工厂
 * 创建文件系统数据库实例
 */
export class DatabaseFactory {
  /**
   * 创建数据库实例
   * @param dataPath 数据存储路径
   */
  static async create(dataPath: string): Promise<FileSystemDatabaseManager> {
    const db = new FileSystemDatabaseManager(dataPath);
    await db.initialize();
    return db;
  }

  /**
   * 自动创建数据库实例（兼容旧 API）
   * @param dataPath 数据存储路径
   * @param _legacyDataPath 已弃用，不再使用
   */
  static async createAuto(
    dataPath: string,
    _legacyDataPath?: string
  ): Promise<FileSystemDatabaseManager> {
    return this.create(dataPath);
  }
}
