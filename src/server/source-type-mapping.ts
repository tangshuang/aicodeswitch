import type { Format } from './conversions/types';

/**
 * 将 SourceType 字符串映射为上游 API 的 Format 类型。
 *
 * 这是当前系统的适配映射（产品专有的 SourceType 词表 → 通用 Format 联合类型），
 * 非通用转换逻辑，因此从 conversions 模块迁出独立维护。
 */
export function sourceTypeToFormat(sourceType: string): Format {
  switch (sourceType) {
    case 'claude':
    case 'claude-chat':
      return 'claude';
    case 'openai':
      return 'responses';
    case 'openai-chat':
      return 'completions';
    case 'gemini':
    case 'gemini-chat':
      return 'gemini';
    default:
      return 'completions';
  }
}
