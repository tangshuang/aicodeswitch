/**
 * Server tool use (server_tool_use) provider support detection.
 *
 * server_tool_use is a Claude-specific content block type used by built-in
 * server-side tools (e.g. webReader). Most third-party Claude-compatible APIs
 * do not accept this type in request messages. This module detects whether the
 * upstream provider supports it natively, following the same pattern as
 * thinking/providers.ts.
 */

export interface ServerToolConfig {
  supportsServerToolUse: boolean;
}

/**
 * Providers known to support server_tool_use content blocks in request messages.
 * Detection is based on URL / provider name substring matching.
 */
const SUPPORTED_PATTERNS: string[] = [
  'api.anthropic.com',
  'anthropic',
];

const SUPPORTED_CONFIG: ServerToolConfig = { supportsServerToolUse: true };
const DEFAULT_CONFIG: ServerToolConfig = { supportsServerToolUse: false };

/**
 * Detect whether the upstream provider supports server_tool_use content blocks.
 *
 * @param providerName  Service name (e.g. "Anthropic", "OpenRouter")
 * @param baseUrl       Service API URL
 */
export function getServerToolSupport(providerName: string, baseUrl: string): ServerToolConfig {
  const haystack = `${providerName} ${baseUrl}`.toLowerCase();
  for (const pattern of SUPPORTED_PATTERNS) {
    if (haystack.includes(pattern)) {
      return SUPPORTED_CONFIG;
    }
  }
  return DEFAULT_CONFIG;
}

export { DEFAULT_CONFIG, SUPPORTED_CONFIG };
