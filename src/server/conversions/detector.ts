import { Format } from './types.js';

/**
 * Detect the format of the incoming request based on path and body structure.
 * Enhanced version that distinguishes between Chat Completions and Responses API.
 */
export function detectRequestFormat(path: string, body: any): Format {
  // Path-based detection (highest priority)
  if (path.includes('/v1/messages') || path.includes('/messages')) {
    return 'claude';
  }
  if (path.includes('/v1/chat/completions') || path.includes('/chat/completions')) {
    return 'completions';
  }
  // Responses API: /v1/responses but NOT /v1/responses/compact
  if (path.includes('/v1/responses') || path.includes('/responses')) {
    if (!path.includes('/responses/compact') && !path.includes('/responses/compact')) {
      return 'responses';
    }
  }

  // Body-based detection
  if (body) {
    // Claude Messages format: messages array with content blocks
    if (body.messages && Array.isArray(body.messages)) {
      const firstMsg = body.messages[0];
      if (firstMsg && typeof firstMsg.content === 'object' && Array.isArray(firstMsg.content)) {
        return 'claude';
      }
    }

    // Responses API: has 'input' field (string or array) and optionally 'instructions'
    if (body.input !== undefined && body.model) {
      // Has 'input' field → Responses API
      if (typeof body.input === 'string' || Array.isArray(body.input)) {
        return 'responses';
      }
    }

    // OpenAI Chat Completions: has 'messages' + 'model'
    if (body.messages && body.model) {
      return 'completions';
    }

    // Fallback: if has 'input' without 'messages', assume responses
    if (body.input !== undefined && !body.messages) {
      return 'responses';
    }
  }

  // Default to completions
  return 'completions';
}

/**
 * 判断上游 URL 是否为 OpenAI 官方（含 Azure OpenAI）端点。
 *
 * 官方端点完整支持 Responses API 的私有扩展（custom 自定义工具、
 * tool_search/web_search 等内置工具、reasoning.effort、text.verbosity 等），
 * 因此 responses→responses 直连时无需降级兼容。其余第三方 Responses 提供商
 * （火山方舟/豆包等）不支持这些扩展，需要走 downgradeResponsesRequest。
 */
export function isOfficialOpenAiApi(apiUrl: string): boolean {
  const u = (apiUrl || '').toLowerCase();
  return u.includes('api.openai.com') || u.includes('.openai.azure.com');
}
