/**
 * 管理字段定义（CLI 侧）
 * 必须与 src/server/config-managed-fields.ts 保持同步
 */

/**
 * Claude Code settings.json 管理字段列表
 */
const CLAUDE_SETTINGS_MANAGED_FIELDS = [
  'env.ANTHROPIC_AUTH_TOKEN',
  'env.ANTHROPIC_API_KEY',
  'env.ANTHROPIC_BASE_URL',
  'env.API_TIMEOUT_MS',
  'env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'env.CLAUDE_CODE_MAX_RETRIES',
  'env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  'env.ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'env.ANTHROPIC_DEFAULT_SONNET_MODEL',
  'env.ANTHROPIC_DEFAULT_OPUS_MODEL',
  'permissions.defaultMode',
  'skipDangerousModePermissionPrompt',
  'effortLevel',
  'model',
];

/**
 * Claude Code .claude.json 管理字段列表
 */
const CLAUDE_JSON_MANAGED_FIELDS = [
  'hasCompletedOnboarding',
  'mcpServers',
];

/**
 * Codex config.toml 管理字段列表
 */
const CODEX_CONFIG_MANAGED_FIELDS = [
  'model_provider',
  'model',
  'model_reasoning_effort',
  'disable_response_storage',
  'preferred_auth_method',
  'requires_openai_auth',
  'enableRouteSelection',
  'model_providers.aicodeswitch',
  'mcp_servers',
  'features',
  'memories',
];

/**
 * Codex auth.json 管理字段列表
 */
const CODEX_AUTH_MANAGED_FIELDS = [
  'OPENAI_API_KEY',
];

/**
 * OpenCode opencode.json 管理字段列表
 * 托管整个 provider.aicodeswitch 段与 model/small_model/mcp
 */
const OPENCODE_CONFIG_MANAGED_FIELDS = [
  'provider.aicodeswitch',
  'model',
  'small_model',
  'mcp',
];

module.exports = {
  CLAUDE_SETTINGS_MANAGED_FIELDS,
  CLAUDE_JSON_MANAGED_FIELDS,
  CODEX_CONFIG_MANAGED_FIELDS,
  CODEX_AUTH_MANAGED_FIELDS,
  OPENCODE_CONFIG_MANAGED_FIELDS,
};
