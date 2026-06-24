import type { ManagedFieldPath } from '../types';

/**
 * Claude Code settings.json 管理字段定义
 */
export const CLAUDE_SETTINGS_MANAGED_FIELDS: ManagedFieldPath[] = [
  { path: ['env', 'ANTHROPIC_AUTH_TOKEN'] },
  { path: ['env', 'ANTHROPIC_API_KEY'], optional: true },
  { path: ['env', 'ANTHROPIC_BASE_URL'] },
  { path: ['env', 'API_TIMEOUT_MS'] },
  { path: ['env', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] },
  { path: ['env', 'CLAUDE_CODE_MAX_RETRIES'] },
  { path: ['env', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'], optional: true },
  { path: ['env', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'], optional: true },
  { path: ['env', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'], optional: true },
  { path: ['env', 'ANTHROPIC_DEFAULT_SONNET_MODEL'], optional: true },
  { path: ['env', 'ANTHROPIC_DEFAULT_OPUS_MODEL'], optional: true },
  { path: ['permissions', 'defaultMode'], optional: true },
  { path: ['skipDangerousModePermissionPrompt'], optional: true },
  { path: ['effortLevel'], optional: true },
  { path: ['model'], optional: true },
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
  { path: ['mcp_servers'], isSection: true, optional: true },
  { path: ['features'], isSection: true, optional: true },
  { path: ['memories'], isSection: true, optional: true },
];

/**
 * Codex auth.json 管理字段定义
 */
export const CODEX_AUTH_MANAGED_FIELDS: ManagedFieldPath[] = [
  { path: ['OPENAI_API_KEY'] },
];

/**
 * OpenCode opencode.json 管理字段定义
 *
 * OpenCode 配置为纯 JSON，使用自定义 provider 指向本代理。
 * 托管整个 `provider.aicodeswitch` section（npm/name/options/models）
 * 以及 `model` / `small_model` 两个模型选择字段。其余字段（其它 provider、
 * agent、command、mcp、theme 等）一律保留给用户。
 */
export const OPENCODE_CONFIG_MANAGED_FIELDS: ManagedFieldPath[] = [
  { path: ['provider', 'aicodeswitch'], isSection: true },
  { path: ['model'] },
  { path: ['small_model'], optional: true },
  { path: ['mcp'], isSection: true, optional: true },
];

/**
 * 根据配置类型和文件路径获取管理字段列表
 */
export const getManagedFields = (
  configType: 'claude' | 'codex' | 'opencode',
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
  } else if (configType === 'opencode') {
    if (filePath.endsWith('opencode.json')) {
      return OPENCODE_CONFIG_MANAGED_FIELDS;
    }
  }
  return [];
};
