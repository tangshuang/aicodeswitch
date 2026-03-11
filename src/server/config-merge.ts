import fs from 'fs';
import path from 'path';
import toml from '@iarna/toml';
import type { ManagedFieldPath, FieldPath } from '../types';

/**
 * 判断字段路径是否匹配
 * @param fieldPath 要检查的字段路径
 * @param managedPath 管理字段路径定义
 * @returns 是否匹配
 */
const pathMatches = (fieldPath: FieldPath, managedPath: FieldPath): boolean => {
  if (fieldPath.length < managedPath.length) {
    return false;
  }

  for (let i = 0; i < managedPath.length; i++) {
    const fieldKey = fieldPath[i];
    const managedKey = managedPath[i];

    // 如果管理字段是通配符（数字索引），则匹配任何数字
    if (typeof managedKey === 'number') {
      if (typeof fieldKey !== 'number') {
        return false;
      }
    } else if (fieldKey !== managedKey) {
      return false;
    }
  }

  return true;
};

/**
 * 判断字段是否被管理
 * @param fieldPath 字段路径
 * @param managedFields 管理字段列表
 * @returns 是否被管理
 */
export const isFieldManaged = (
  fieldPath: FieldPath,
  managedFields: ManagedFieldPath[]
): boolean => {
  for (const managed of managedFields) {
    if (pathMatches(fieldPath, managed.path)) {
      return true;
    }
  }
  return false;
};

/**
 * 递归遍历对象，收集叶子字段路径
 * @param obj 要遍历的对象
 * @param currentPath 当前路径
 * @param allPaths 收集所有路径的数组
 */
const collectPaths = (
  obj: any,
  currentPath: FieldPath,
  allPaths: FieldPath[]
): void => {
  // 基础类型/null：当前路径即叶子
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    if (currentPath.length > 0) {
      allPaths.push(currentPath);
    }
    return;
  }

  // 数组：递归收集元素叶子；空数组本身视为叶子
  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      if (currentPath.length > 0) {
        allPaths.push(currentPath);
      }
      return;
    }

    obj.forEach((item, index) => {
      collectPaths(item, [...currentPath, index], allPaths);
    });
    return;
  }

  // 对象：递归收集子字段；空对象本身视为叶子
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    if (currentPath.length > 0) {
      allPaths.push(currentPath);
    }
    return;
  }

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      collectPaths(obj[key], [...currentPath, key], allPaths);
    }
  }
};

/**
 * 深度获取对象的值
 * @param obj 目标对象
 * @param path 字段路径
 * @returns 字段值
 */
const deepGet = (obj: any, path: FieldPath): any => {
  let current = obj;
  for (const key of path) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[key];
  }
  return current;
};

/**
 * 深度设置对象的值
 * @param obj 目标对象
 * @param path 字段路径
 * @param value 要设置的值
 */
const deepSet = (obj: any, path: FieldPath, value: any): void => {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (current[key] === undefined || current[key] === null || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }
  current[path[path.length - 1]] = value;
};

/**
 * 合并 JSON 配置
 * @param source 源配置（包含管理字段）
 * @param other 其他配置（包含非管理字段）
 * @param managedFields 管理字段列表
 * @returns 合并后的配置
 */
export const mergeJsonConfig = (
  source: Record<string, any>,
  other: Record<string, any>,
  managedFields: ManagedFieldPath[]
): Record<string, any> => {
  // 复制源配置作为基础
  const result: Record<string, any> = JSON.parse(JSON.stringify(source));

  // 收集 other 中所有的字段路径
  const allPaths: FieldPath[] = [];
  collectPaths(other, [], allPaths);

  // 对于每个路径，如果不是管理字段，则从 other 中复制到 result
  for (const fieldPath of allPaths) {
    if (!isFieldManaged(fieldPath, managedFields)) {
      const value = deepGet(other, fieldPath);
      deepSet(result, fieldPath, value);
    }
  }

  return result;
};

/**
 * 解析 TOML 配置文件
 * @param content TOML 内容
 * @returns 解析后的对象
 */
export const parseToml = (content: string): Record<string, any> => {
  try {
    return toml.parse(content);
  } catch (error) {
    throw new Error(`Failed to parse TOML: ${error}`);
  }
};

/**
 * 序列化对象为 TOML 格式
 * @param obj 要序列化的对象
 * @returns TOML 字符串
 */
export const stringifyToml = (obj: Record<string, any>): string => {
  // 使用 @iarna/toml 库的 stringify 方法
  try {
    return toml.stringify(obj);
  } catch (error) {
    throw new Error(`Failed to stringify TOML: ${error}`);
  }
};

/**
 * 合并 TOML 配置
 * @param source 源配置（包含管理字段）
 * @param other 其他配置（包含非管理字段）
 * @param managedFields 管理字段列表
 * @returns 合并后的配置
 */
export const mergeTomlConfig = (
  source: Record<string, any>,
  other: Record<string, any>,
  managedFields: ManagedFieldPath[]
): Record<string, any> => {
  // 复制源配置作为基础
  const result: Record<string, any> = JSON.parse(JSON.stringify(source));

  // 收集 other 中所有的字段路径
  const allPaths: FieldPath[] = [];
  collectPaths(other, [], allPaths);

  // 对于每个路径，如果不是管理字段，则从 other 中复制到 result
  for (const fieldPath of allPaths) {
    if (!isFieldManaged(fieldPath, managedFields)) {
      const value = deepGet(other, fieldPath);
      deepSet(result, fieldPath, value);
    }
  }

  return result;
};

/**
 * 原子性写入文件
 * 先写入临时文件，然后重命名，确保写入失败时不会损坏原文件
 * @param filePath 目标文件路径
 * @param content 要写入的内容
 */
export const atomicWriteFile = (filePath: string, content: string): void => {
  const dir = path.dirname(filePath);
  const tempFile = path.join(dir, `.tmp_${path.basename(filePath)}`);

  try {
    // 确保目录存在
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 写入临时文件
    fs.writeFileSync(tempFile, content, 'utf-8');

    // 原子性重命名
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    // 清理临时文件
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    throw error;
  }
};

/**
 * 带回退的安全写入
 * 如果写入失败，恢复原文件
 * @param filePath 目标文件路径
 * @param content 要写入的内容
 * @returns 是否成功
 */
export const safeWriteConfig = (
  filePath: string,
  content: string
): boolean => {
  let originalContent: string | null = null;

  try {
    // 如果原文件存在，读取其内容
    if (fs.existsSync(filePath)) {
      originalContent = fs.readFileSync(filePath, 'utf-8');
    }

    // 原子性写入新内容
    atomicWriteFile(filePath, content);

    return true;
  } catch (error) {
    console.error(`Failed to write ${filePath}:`, error);

    // 如果写入失败且原文件存在，恢复原文件
    if (originalContent !== null && !fs.existsSync(filePath)) {
      try {
        fs.writeFileSync(filePath, originalContent, 'utf-8');
        console.log(`Restored ${filePath} from backup`);
      } catch (restoreError) {
        console.error(`Failed to restore ${filePath}:`, restoreError);
      }
    }

    return false;
  }
};
