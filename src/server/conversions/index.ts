/**
 * AICodingBus Unified Format Conversion System
 *
 * Provides conversion between 4 API formats:
 * 1. Claude Messages API
 * 2. OpenAI Responses API
 * 3. OpenAI Chat Completions API
 * 4. Gemini GenerateContent API
 *
 * 12 unidirectional pairs cover all client→upstream combinations.
 * Naming: pairs/{client}-{upstream}/ — left=client, right=upstream.
 *
 * Provider-specific post-processing (thinking params, reasoning history fix)
 * is driven by the ReasoningConfig passed through TransformRequestOptions.
 */

import type { TransformResult, StreamConverter, TransformRequestOptions, TransformResponseOptions, StreamConverterOptions } from './types.js';
export type { Format, TransformResult, StreamConverter, SSEEvent, TransformRequestOptions, TransformResponseOptions, StreamConverterOptions, ReasoningConfig, ServerToolConfig } from './types.js';

export { detectRequestFormat, isOfficialOpenAiApi } from './detector.js';
export { getReasoningConfig } from './thinking/providers.js';
import { applyReasoningConfig } from './thinking/providers.js';
export { getServerToolSupport } from './server-tool/providers.js';
import { convertServerToolUseToToolUse } from './server-tool/mapper.js';

// --- Body sanitizer ---
export { sanitizeRequestBody } from './body-sanitizer.js';
export type { SanitizeResult } from './body-sanitizer.js';

// --- Compact API ---
export {
  extractConversationText,
  extractMessageContent,
  isClaudeCompactRequest,
  isLastClaudeMessageCompact,
  isCodexCompactRequest,
  COMPACTION_SYSTEM_PROMPT,
  buildCompactionPrompt,
  buildCompactUpstreamRequest,
  extractSummaryFromResponse,
  buildCompactedResponse,
  // Unified high-level API
  prepareCompactRequest,
  processCompactResponse,
} from './compact.js';
export type { CompactRequestOptions, CompactRequestResult } from './compact.js';

// --- claude client → * upstream ---
import { claudeToCompletions } from './pairs/claude-completions/request.js';
import { completionsResponseToClaude } from './pairs/claude-completions/response.js';
import { CompletionsToClaudeConverter } from './pairs/claude-completions/streaming.js';

import { claudeToResponses } from './pairs/claude-responses/request.js';
import { responsesToClaudeResponse } from './pairs/claude-responses/response.js';
import { ResponsesToClaudeConverter } from './pairs/claude-responses/streaming.js';

import { claudeToGemini } from './pairs/claude-gemini/request.js';
import { geminiToClaudeResponse } from './pairs/claude-gemini/response.js';
import { GeminiToClaudeConverter } from './pairs/claude-gemini/streaming.js';

// --- completions client → * upstream ---
import { completionsToClaude } from './pairs/completions-claude/request.js';
import { claudeResponseToCompletions } from './pairs/completions-claude/response.js';
import { ClaudeToCompletionsConverter } from './pairs/completions-claude/streaming.js';

import { completionsToResponses } from './pairs/completions-responses/request.js';
import { responsesToCompletionsResponse } from './pairs/completions-responses/response.js';
import { ResponsesToCompletionsConverter } from './pairs/completions-responses/streaming.js';

import { completionsToGemini } from './pairs/completions-gemini/request.js';
import { geminiToCompletionsResponse } from './pairs/completions-gemini/response.js';
import { GeminiToCompletionsConverter } from './pairs/completions-gemini/streaming.js';

// --- responses client → * upstream ---
import { responsesToClaude } from './pairs/responses-claude/request.js';
import { claudeToResponsesResponse } from './pairs/responses-claude/response.js';
import { ClaudeToResponsesConverter } from './pairs/responses-claude/streaming.js';

import { responsesToCompletions } from './pairs/responses-completions/request.js';
import { completionsToResponsesResponse } from './pairs/responses-completions/response.js';
import { CompletionsToResponsesConverter } from './pairs/responses-completions/streaming.js';

import { responsesToGeminiRequest } from './pairs/responses-gemini/request.js';
import { geminiToResponsesResponse } from './pairs/responses-gemini/response.js';
import { GeminiToResponsesConverter } from './pairs/responses-gemini/streaming.js';

// --- responses → responses (同格式降级兼容) ---
import { downgradeResponsesRequest } from './pairs/responses-responses/request.js';

// --- gemini client → * upstream ---
import { geminiToClaude } from './pairs/gemini-claude/request.js';
import { claudeToGeminiResponse } from './pairs/gemini-claude/response.js';
import { ClaudeToGeminiConverter } from './pairs/gemini-claude/streaming.js';

import { geminiToCompletions } from './pairs/gemini-completions/request.js';
import { completionsToGeminiResponse } from './pairs/gemini-completions/response.js';
import { CompletionsToGeminiConverter } from './pairs/gemini-completions/streaming.js';

import { geminiToResponsesRequest } from './pairs/gemini-responses/request.js';
import { responsesToGeminiResponse } from './pairs/gemini-responses/response.js';
import { ResponsesToGeminiConverter } from './pairs/gemini-responses/streaming.js';

// --- Provider-driven post-processing ---
import { fixThinkingHistory, convertRedactedThinkingForProvider } from './thinking/mapper.js';
import { ensureToolResultIds } from './utils/tool-result.js';
import { claudeThinkingToReasoningEffort } from './thinking/effort.js';

// ============================================================
// Public API: Request Transformation
// ============================================================

/**
 * Transform a request body from one format to another.
 */
export function transformRequest(options: TransformRequestOptions): TransformResult {
  const { fromFormat, toFormat, body, sanitizeBody, providerConfig } = options;

  const targetBody = buildTargetBody({ fromFormat, toFormat, body, sanitizeBody, providerConfig });

  return { body: targetBody, headers: {} };
}

// ============================================================
// Public API: Response Transformation
// ============================================================

/**
 * Transform a response body from upstream format back to client format.
 */
export function transformResponse(options: TransformResponseOptions): any {
  const { fromFormat, toFormat, response } = options;

  // Passthrough: same format
  if (fromFormat === toFormat) {
    return response;
  }

  const key = `${fromFormat}->${toFormat}`;

  switch (key) {
    // --- upstream claude → client * ---
    case 'claude->completions':
      return claudeResponseToCompletions(response);
    case 'claude->responses':
      return claudeToResponsesResponse(response);
    case 'claude->gemini':
      return claudeToGeminiResponse(response);

    // --- upstream responses → client * ---
    case 'responses->claude':
      return responsesToClaudeResponse(response);
    case 'responses->completions':
      return responsesToCompletionsResponse(response);
    case 'responses->gemini':
      return responsesToGeminiResponse(response);

    // --- upstream completions → client * ---
    case 'completions->claude':
      return completionsResponseToClaude(response);
    case 'completions->responses':
      return completionsToResponsesResponse(response);
    case 'completions->gemini':
      return completionsToGeminiResponse(response);

    // --- upstream gemini → client * ---
    case 'gemini->claude':
      return geminiToClaudeResponse(response);
    case 'gemini->completions':
      return geminiToCompletionsResponse(response);
    case 'gemini->responses':
      return geminiToResponsesResponse(response);

    default:
      return response;
  }
}

// ============================================================
// Public API: Stream Converter Factory
// ============================================================

/**
 * Create a streaming converter for the given format pair.
 */
export function createStreamConverter(options: StreamConverterOptions): StreamConverter {
  const { fromFormat, toFormat } = options;

  // Passthrough: same format
  if (fromFormat === toFormat) {
    return new PassthroughConverter();
  }

  const key = `${fromFormat}->${toFormat}`;

  switch (key) {
    // --- upstream → claude client ---
    case 'completions->claude':
      return new CompletionsToClaudeConverter();
    case 'gemini->claude':
      return new GeminiToClaudeConverter();
    case 'responses->claude':
      return new ResponsesToClaudeConverter();

    // --- upstream → responses client ---
    case 'completions->responses':
      return new CompletionsToResponsesConverter();
    case 'gemini->responses':
      return new GeminiToResponsesConverter();
    case 'claude->responses':
      return new ClaudeToResponsesConverter();

    // --- upstream → completions client ---
    case 'claude->completions':
      return new ClaudeToCompletionsConverter();
    case 'gemini->completions':
      return new GeminiToCompletionsConverter();
    case 'responses->completions':
      return new ResponsesToCompletionsConverter();

    // --- upstream → gemini client ---
    case 'claude->gemini':
      return new ClaudeToGeminiConverter();
    case 'completions->gemini':
      return new CompletionsToGeminiConverter();
    case 'responses->gemini':
      return new ResponsesToGeminiConverter();

    default:
      return new PassthroughConverter();
  }
}

// ============================================================
// Helpers
// ============================================================


/**
 * Transform a request body from one format to another,
 * with provider-driven post-processing for completions targets.
 */
export function buildTargetBody(options: Pick<TransformRequestOptions, 'fromFormat' | 'toFormat' | 'body' | 'sanitizeBody' | 'providerConfig' | 'serverToolConfig'>): any {
  const { fromFormat, toFormat, sanitizeBody, providerConfig, serverToolConfig } = options;

  // Pre-processing: convert server_tool_use → tool_use when upstream doesn't support it.
  // Must happen before format conversion so all pair transformers handle the blocks correctly.
  let processedBody = options.body;
  if (fromFormat === 'claude' && !serverToolConfig?.supportsServerToolUse) {
    processedBody = convertServerToolUseToToolUse(processedBody);
  }

  // Dispatch to the correct conversion pair
  const key = `${fromFormat}->${toFormat}`;

  let result: any;

  switch (key) {
    // --- claude → * ---
    case 'claude->completions':
      result = claudeToCompletions(processedBody);
      break;
    case 'claude->responses':
      result = claudeToResponses(processedBody);
      break;
    case 'claude->gemini':
      result = claudeToGemini(processedBody);
      break;

    // --- responses → * ---
    case 'responses->completions':
      result = responsesToCompletions(processedBody);
      break;
    case 'responses->claude':
      result = responsesToClaude(processedBody);
      break;
    case 'responses->gemini':
      result = responsesToGeminiRequest(processedBody);
      break;
    case 'responses->responses': {
      if (sanitizeBody) {
        // Responses 格式降级兼容：委托给 responses-responses pair 处理
        result = downgradeResponsesRequest(processedBody);
      } else {
        result = processedBody;
      }
      break;
    }

    // --- completions → * ---
    case 'completions->claude':
      result = completionsToClaude(processedBody);
      break;
    case 'completions->responses':
      result = completionsToResponses(processedBody);
      break;
    case 'completions->gemini':
      result = completionsToGemini(processedBody);
      break;

    // --- gemini → * ---
    case 'gemini->claude':
      result = geminiToClaude(processedBody);
      break;
    case 'gemini->completions':
      result = geminiToCompletions(processedBody);
      break;
    case 'gemini->responses':
      result = geminiToResponsesRequest(processedBody);
      break;

    default:
      result = processedBody;
  }

  // --- Provider-driven post-processing for completions targets ---
  if (toFormat === 'completions' && providerConfig) {
    const isReasoningContentCompletion = providerConfig.outputFormat === 'reasoning_content';

    if (isReasoningContentCompletion) {
      // 修复历史：确保 assistant + tool_calls 消息有 reasoning_content
      if (result.messages) {
        result.messages = fixThinkingHistory(result.messages, 'completions');
      }
      // 剥离 stream_options（reasoning_content 提供商通常不支持）
      delete result.stream_options;
    }

    // 注入 thinking 参数（如 thinking: { type: 'enabled' }）和 effort 参数
    if (providerConfig.supportsThinking || providerConfig.supportsEffort) {
      const effort = processedBody.thinking ? claudeThinkingToReasoningEffort(processedBody.thinking) : null;
      result = applyReasoningConfig(result, providerConfig, effort);
    }
  }

  // --- Provider-driven: convert redacted_thinking → thinking for providers that don't support redacted_thinking ---
  // DeepSeek 等 provider 的 Anthropic 端点不识别 redacted_thinking，需要转换为 thinking 块
  if (toFormat === 'claude' && providerConfig?.supportsThinking && result.messages) {
    result.messages = convertRedactedThinkingForProvider(result.messages);
  }

  // --- Safety net for Claude upstream: ensure thinking blocks alongside tool_use ---
  // When thinking mode is enabled, Claude requires thinking blocks in assistant messages with tool_use
  if (toFormat === 'claude' && result.thinking && result.messages) {
    result.messages = fixThinkingHistory(result.messages, 'claude');
  }

  // --- Ensure tool_result blocks have id for Claude-compatible providers ---
  // Some providers (e.g. GLM) require an id field on tool_result content blocks,
  // but standard Claude API tool_result blocks only have tool_use_id without id.
  if (toFormat === 'claude' && result.messages) {
    const { messages: patchedMessages } = ensureToolResultIds(result.messages);
    result.messages = patchedMessages;
  }

  return result;
}

/** Identity converter that passes events through unchanged */
class PassthroughConverter implements StreamConverter {
  convertEvent(event: import('./types.js').SSEEvent): import('./types.js').SSEEvent[] {
    return [event];
  }
  flush(): import('./types.js').SSEEvent[] {
    return [];
  }
}
