import type { ManagedFieldPath } from '../types';

/**
 * Claude Code settings.json 管理字段定义
 */
export const CLAUDE_SETTINGS_MANAGED_FIELDS: ManagedFieldPath[] = [
  { path: ['env', 'ANTHROPIC_AUTH_TOKEN'] },
  { path: ['env', 'ANTHROPIC_BASE_URL'] },
  { path: ['env', 'API_TIMEOUT_MS'] },
  { path: ['env', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] },
  { path: ['env', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'], optional: true },
  { path: ['env', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'], optional: true },
  { path: ['env', 'ANTHROPIC_DEFAULT_SONNET_MODEL'], optional: true },
  { path: ['env', 'ANTHROPIC_DEFAULT_OPUS_MODEL'], optional: true },
  { path: ['permissions'], optional: true },
  { path: ['skipDangerousModePermissionPrompt'], optional: true },
  { path: ['effortLevel'], optional: true },
];

/**
 * Claude Code .claude.json 管理字段定义
 */
export const CLAUDE_JSON_MANAGED_FIELDS: ManagedFieldPath[] = [
  { path: ['hasCompletedOnboarding'] },
  { path: ['mcpServers'], optional: true },
];

/**
 * Codex config.toml 管理字段定义
 */
export const CODEX_CONFIG_MANAGED_FIELDS: ManagedFieldPath[] = [
  { path: ['model_provider'] },
  { path: ['model'] },
  { path: ['model_reasoning_effort'] },
  { path: ['disable_response_storage'] },
  { path: ['preferred_auth_method'] },
  { path: ['requires_openai_auth'] },
  { path: ['enableRouteSelection'] },
  { path: ['model_providers', 'aicodeswitch'], isSection: true },
];

/**
 * Codex auth.json 管理字段定义
 */
export const CODEX_AUTH_MANAGED_FIELDS: ManagedFieldPath[] = [
  { path: ['OPENAI_API_KEY'] },
];

/**
 * 根据配置类型和文件路径获取管理字段列表
 */
export const getManagedFields = (
  configType: 'claude' | 'codex',
  filePath: string
): ManagedFieldPath[] => {
  if (configType === 'claude') {
    if (filePath.endsWith('settings.json')) {
      return CLAUDE_SETTINGS_MANAGED_FIELDS;
    } else if (filePath.endsWith('.claude.json')) {
      return CLAUDE_JSON_MANAGED_FIELDS;
    }
  } else if (configType === 'codex') {
    if (filePath.endsWith('config.toml')) {
      return CODEX_CONFIG_MANAGED_FIELDS;
    } else if (filePath.endsWith('auth.json')) {
      return CODEX_AUTH_MANAGED_FIELDS;
    }
  }
  return [];
};
