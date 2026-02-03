import { SourceType } from '../../types';

/** 终端对象类型 */
export const TARGET_TYPE = {
  'claude-code': 'Claude Code',
  'codex': 'Codex',
};

/** 数据源类型 */
export const SOURCE_TYPE = {
  'claude-code': 'Claude Code',
  'claude-chat': 'Claude Chat',
  'openai-responses': 'OpenAI Responses',
  'openai-chat': 'OpenAI Chat',
  'deepseek-reasoning-chat': 'DeepSeek Reasoning Chat',
};

export const SOURCE_TYPE_MESSAGE: Record<SourceType, string> = {
  'openai-chat': '填写完整的接口地址，如：https://api.openai.com/v1/chat/completions',
  'openai-responses': '只填写 base 地址(含/v1），如：https://api.openai.com/v1',
  'claude-chat': '填写完整的接口地址，如：https://api.anthropic.com/v1/messages',
  'claude-code': '只填写 base 地址，如：https://api.anthropic.com',
  'deepseek-reasoning-chat': '推理类模型，填写完整的接口地址，如：https://api.deepseek.com/v1/chat/completions',
};

/** 认证方式类型 */
export const AUTH_TYPE = {
  'auto': '自动判断',
  'authorization': 'Authorization (Bearer Token)',
  'x-api-key': 'X-API-Key',
};

export const AUTH_TYPE_MESSAGE: Record<string, string> = {
  'auto': '根据数据源类型自动判断认证方式：claude-chat/claude-code 使用 x-api-key，其他类型使用 Authorization',
  'authorization': '使用 Authorization: Bearer <token> 进行认证（适用于大多数 OpenAI 兼容 API）',
  'x-api-key': '使用 x-api-key: <token> 进行认证（适用于 Claude API 及某些特殊的 OpenAI 兼容 API）',
};

/** 默认请求超时时间 */
export const TIMEOUT_MS = 3000000; // 300秒
