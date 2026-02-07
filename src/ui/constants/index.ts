import { SourceType, AuthType } from '../../types';

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
export const AUTH_TYPE: Record<AuthType, string> = {
  [AuthType.AUTO]: '自动',
  [AuthType.AUTH_TOKEN]: 'AUTH_TOKEN',
  [AuthType.API_KEY]: 'API_KEY',
};

export const AUTH_TYPE_MESSAGE: Record<AuthType, string> = {
  [AuthType.AUTO]: '根据数据源类型自动判断：Claude 相关类型使用 x-api-key header，OpenAI 相关类型使用 Authorization: Bearer header',
  [AuthType.AUTH_TOKEN]: '使用 Authorization: Bearer <token> 进行认证（对应 Claude Code 的 ANTHROPIC_AUTH_TOKEN，以及OpenAI的所有请求）',
  [AuthType.API_KEY]: '使用 x-api-key: <token> 进行认证（对应 Claude Code 的 ANTHROPIC_API_KEY）',
};

/** 默认请求超时时间 */
export const TIMEOUT_MS = 3000000; // 300秒
