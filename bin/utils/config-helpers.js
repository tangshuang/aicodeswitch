const fs = require('fs');
const path = require('path');
const toml = require('@iarna/toml');

/**
 * TOML 解析器
 */
const parseToml = (content) => {
  try {
    return toml.parse(content);
  } catch (error) {
    throw new Error(`Failed to parse TOML: ${error.message}`);
  }
};

/**
 * TOML 序列化器
 */
const stringifyToml = (obj) => {
  try {
    return toml.stringify(obj);
  } catch (error) {
    throw new Error(`Failed to stringify TOML: ${error.message}`);
  }
};

/**
 * 深拷贝
 */
const deepClone = (value) => JSON.parse(JSON.stringify(value));

/**
 * 判断字段路径是否被管理（支持前缀匹配）
 */
const isManagedPath = (fieldPath, managedFields) => {
  return managedFields.some((managedField) => {
    const managedPath = managedField.split('.');
    if (fieldPath.length < managedPath.length) {
      return false;
    }

    for (let i = 0; i < managedPath.length; i += 1) {
      if (String(fieldPath[i]) !== managedPath[i]) {
        return false;
      }
    }
    return true;
  });
};

/**
 * 深度获取对象值
 */
const deepGet = (obj, fieldPath) => {
  let current = obj;
  for (const segment of fieldPath) {
    if (current === undefined || current === null) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
};

/**
 * 深度设置对象值
 */
const deepSet = (obj, fieldPath, value) => {
  let current = obj;
  for (let i = 0; i < fieldPath.length - 1; i += 1) {
    const key = fieldPath[i];
    if (current[key] === undefined || current[key] === null || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }
  current[fieldPath[fieldPath.length - 1]] = value;
};

/**
 * 收集所有叶子字段路径（数组视为叶子）
 */
const collectPaths = (obj, currentPath = [], allPaths = []) => {
  if (obj === null || obj === undefined) {
    if (currentPath.length > 0) {
      allPaths.push(currentPath);
    }
    return allPaths;
  }

  if (Array.isArray(obj)) {
    if (currentPath.length > 0) {
      allPaths.push(currentPath);
    }
    return allPaths;
  }

  if (typeof obj !== 'object') {
    if (currentPath.length > 0) {
      allPaths.push(currentPath);
    }
    return allPaths;
  }

  const keys = Object.keys(obj);
  if (keys.length === 0) {
    if (currentPath.length > 0) {
      allPaths.push(currentPath);
    }
    return allPaths;
  }

  for (const key of keys) {
    collectPaths(obj[key], [...currentPath, key], allPaths);
  }

  return allPaths;
};

/**
 * JSON 合并函数
 * 以 source 为基础，合并 other 中的非管理字段
 */
const mergeJsonSettings = (source, other, managedFields) => {
  const result = deepClone(source);
  const allPaths = collectPaths(other);

  for (const fieldPath of allPaths) {
    if (isManagedPath(fieldPath, managedFields)) {
      continue;
    }

    const value = deepGet(other, fieldPath);
    if (value !== undefined) {
      deepSet(result, fieldPath, deepClone(value));
    }
  }

  return result;
};

/**
 * TOML 合并函数
 * 以 source 为基础，合并 other 中的非管理字段
 */
const mergeTomlSettings = (source, other, managedFields) => {
  const result = deepClone(source);
  const allPaths = collectPaths(other);

  for (const fieldPath of allPaths) {
    if (isManagedPath(fieldPath, managedFields)) {
      continue;
    }

    const value = deepGet(other, fieldPath);
    if (value !== undefined) {
      deepSet(result, fieldPath, deepClone(value));
    }
  }

  return result;
};

/**
 * 原子性写入函数
 * 先写入临时文件，然后原子性重命名
 */
const atomicWriteFile = (filePath, content) => {
  const tempFile = path.join(path.dirname(filePath), `.tmp_${path.basename(filePath)}`);

  try {
    // 确保目录存在
    const dir = path.dirname(filePath);
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

module.exports = {
  parseToml,
  stringifyToml,
  mergeJsonSettings,
  mergeTomlSettings,
  atomicWriteFile,
};
