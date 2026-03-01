import { SourceType } from '../types';

/**
 * 旧的数据源类型
 * 用于向下兼容老用户的数据
 */
export type LegacySourceType = 'openai-chat' | 'openai-responses' | 'claude-chat' | 'claude-code' | 'deepseek-reasoning-chat' | 'gemini' | 'gemini-chat';

/**
 * 旧类型 → 新类型映射表
 */
const SOURCE_TYPE_MIGRATION_MAP: Record<LegacySourceType, SourceType> = {
  'openai-chat': 'openai-chat',
  'openai-responses': 'openai',        // 重命名
  'claude-chat': 'claude-chat',
  'claude-code': 'claude',              // 重命名
  'deepseek-reasoning-chat': 'deepseek-reasoning-chat',
  'gemini': 'gemini',
  'gemini-chat': 'gemini-chat',
};

/**
 * 新类型 → 旧类型映射表
 * 用于向下兼容导出
 */
const SOURCE_TYPE_REVERSE_MAP: Record<SourceType, LegacySourceType> = {
  'openai-chat': 'openai-chat',
  'openai': 'openai-responses',
  'claude-chat': 'claude-chat',
  'claude': 'claude-code',
  'deepseek-reasoning-chat': 'deepseek-reasoning-chat',
  'gemini': 'gemini',
  'gemini-chat': 'gemini-chat',
};

/**
 * 将旧类型转换为新类型
 * @param legacyType 旧的数据源类型
 * @returns 新的数据源类型
 */
export function migrateSourceType(legacyType: LegacySourceType): SourceType {
  return SOURCE_TYPE_MIGRATION_MAP[legacyType];
}

/**
 * 将新类型转换为旧类型
 * 用于向下兼容导出
 * @param newType 新的数据源类型
 * @returns 旧的数据源类型
 */
export function downgradeSourceType(newType: SourceType): LegacySourceType {
  return SOURCE_TYPE_REVERSE_MAP[newType];
}

/**
 * 检查是否为旧类型
 * @param type 类型字符串
 * @returns 是否为旧类型
 */
export function isLegacySourceType(type: string): type is LegacySourceType {
  return type === 'openai-responses' || type === 'claude-code';
}

/**
 * 标准化类型
 * 自动处理新旧类型，将旧类型转换为新类型，新类型保持不变
 * @param type 类型字符串（可能是旧类型或新类型）
 * @returns 标准化后的新类型
 */
export function normalizeSourceType(type: string): SourceType {
  if (isLegacySourceType(type)) {
    return migrateSourceType(type);
  }
  return type as SourceType;
}
