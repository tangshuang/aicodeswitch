/**
 * Conversation Compaction for the Responses API.
 *
 * Provides the core logic for `/v1/responses/compact`:
 * - Extract conversation text from Responses API `input` array
 * - Build compaction prompt
 * - Build upstream requests via the conversion system (transformRequest)
 * - Extract summary from upstream responses (transformResponse)
 * - Build the final Responses API compaction response
 *
 * Two usage levels:
 * - **High-level**: `prepareCompactRequest` + `processCompactResponse` — unified API
 * - **Low-level**: Individual functions for fine-grained control
 */

import crypto from 'crypto';
import type { Format } from './types.js';
import { transformRequest, transformResponse } from './index.js';

// ============================================================
// Conversation Text Extraction
// ============================================================

/**
 * Extract conversation text from a Responses API `input` array.
 * Converts each item (message, function_call, function_call_output) into
 * readable text suitable for a compaction prompt.
 * Compaction items are skipped (encrypted_content is opaque).
 */
export function extractConversationText(input: any[]): string {
  const parts: string[] = [];

  for (const item of input) {
    if (!item || typeof item !== 'object') {
      if (typeof item === 'string') parts.push(item);
      continue;
    }

    // Skip compaction items — their encrypted_content is not readable
    if (item.type === 'compaction') continue;

    // Skip item references
    if (item.type === 'item_reference') continue;

    // Message items (EasyInputMessage, ResponseOutputMessage, etc.)
    if (item.type === 'message' || item.role) {
      const role = item.role || 'unknown';
      const content = extractMessageContent(item.content);
      if (content) {
        parts.push(`[${role}]: ${content}`);
      }
    }

    // Function call items
    if (item.type === 'function_call') {
      const name = item.name || 'unknown';
      const args = item.arguments || item.input || '';
      const callId = item.call_id || '';
      parts.push(`[function_call${callId ? ` (${callId})` : ''} -> ${name}]: ${typeof args === 'string' ? args : JSON.stringify(args)}`);
    }

    // Function call output items
    if (item.type === 'function_call_output') {
      const callId = item.call_id || '';
      const output = item.output || '';
      parts.push(`[function_call_output${callId ? ` (${callId})` : ''}]: ${typeof output === 'string' ? output : JSON.stringify(output)}`);
    }
  }

  return parts.join('\n\n');
}

/**
 * Extract text content from a Responses API message's content field.
 * Handles string content, content arrays (input_text, output_text, text, etc.),
 * and nested structures.
 */
export function extractMessageContent(content: any): string {
  if (!content) return '';
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (!block || typeof block !== 'object') return String(block || '');
        if (typeof block === 'string') return block;
        // text, input_text, output_text
        if (block.text) return block.text;
        // input_image, input_file — skip
        if (block.type === 'input_image' || block.type === 'input_file') return '[media content]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return String(content);
}

// ============================================================
// Compact Request Detection
// ============================================================

/**
 * 检测消息是否为 Claude Code 的 compact 命令请求。
 *
 * 采用两级检测策略：
 * - 严格匹配：四个关键词全部命中（适配已知格式）
 * - 宽松匹配："TEXT ONLY" + "<summary>" 组合（覆盖 prompt 格式变化）
 *
 * Compact 命令触发时，Claude Code 会在 messages 末尾插入一条特殊指令：
 * - role 为 "user"
 * - content 为数组，包含一个 text 块
 * - text 内容包含 "CRITICAL: Respond with TEXT ONLY" 等标识
 * - 包含对话摘要生成指令，要求输出 <analysis> 和 <summary> 结构
 */
export function isClaudeCompactRequest(message: any): boolean {
  if (!message || message.role !== 'user') {
    return false;
  }

  const content = message.content;
  if (!Array.isArray(content)) {
    return false;
  }

  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      const text = block.text;
      const hasTextOnly = text.includes('TEXT ONLY');
      const hasSummary = text.includes('<summary>');
      const hasCritical = text.includes('CRITICAL: Respond with TEXT ONLY');
      const hasDetailedSummary = text.includes('create a detailed summary of the conversation');
      const hasAnalysis = text.includes('<analysis>');

      // 严格匹配：Claude Code 标准格式（四个关键词）
      if (hasCritical && hasDetailedSummary && hasAnalysis && hasSummary) {
        console.log('[COMPACT] Strict match: all 4 markers found');
        return true;
      }

      // 宽松匹配：覆盖 Claude Code prompt 格式变化
      // "TEXT ONLY" 是紧凑指令的核心标识，<summary> 是输出格式标签
      // 两者组合在非 compact 请求中几乎不可能同时出现
      if (hasTextOnly && hasSummary) {
        console.log(`[COMPACT] Loose match: CRITICAL=${hasCritical}, detailed_summary=${hasDetailedSummary}, <analysis>=${hasAnalysis}`);
        return true;
      }
    }
  }

  return false;
}

/**
 * 检测消息列表中是否包含 Claude Code compact 请求。
 *
 * 从最后一条消息开始往前搜索，最多检查 3 条，
 * 处理 compact 指令后面可能跟了 assistant 占位消息的边缘情况。
 */
export function isLastClaudeMessageCompact(messages: any[]): boolean {
  if (!Array.isArray(messages) || messages.length === 0) {
    return false;
  }
  const checkCount = Math.min(messages.length, 3);
  for (let i = messages.length - 1; i >= messages.length - checkCount; i--) {
    if (isClaudeCompactRequest(messages[i])) {
      return true;
    }
  }
  return false;
}

/**
 * 检测请求是否为 Codex 的 compact（压缩）请求。
 *
 * Codex 基于 OpenAI Responses API，compact 操作走独立端点：
 * - POST /v1/responses/compact
 */
export function isCodexCompactRequest(path?: string): boolean {
  if (!path || typeof path !== 'string') {
    return false;
  }
  const normalizedPath = path.split('?')[0];
  return /\/v1\/responses\/compact\/?$/.test(normalizedPath);
}

// ============================================================
// Claude Messages Sanitization
// ============================================================

/**
 * 判断内容块是否为工具调用类型（包括 tool_use 和 server_tool_use）。
 * Claude Code 的内置工具（如 webReader）使用 server_tool_use 类型，
 * 上游 Claude 兼容 API 同样要求其紧邻的下一条 user 消息包含对应的 tool_result。
 */
function isToolUseBlock(block: any): boolean {
  return (block?.type === 'tool_use' || block?.type === 'server_tool_use') && typeof block.id === 'string' && block.id;
}

/**
 * 清理 Claude Messages API 格式的 messages，确保所有 tool_use/server_tool_use 都有对应的 tool_result。
 * 对于没有对应 tool_result 的工具调用，添加合成的 tool_result 块。
 *
 * 这解决了 Claude Code compact 请求中 assistant 消息末尾有 tool_use/server_tool_use 但
 * 下一条 user 消息（compact 指令）不含对应 tool_result 导致上游 400 错误的问题。
 */
export function sanitizeClaudeMessagesForCompact(messages: any[]): any[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const result = [...messages];

  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    // 收集当前 assistant 消息中所有 tool_use/server_tool_use 的 id
    const toolUseIds = new Set<string>();
    for (const block of msg.content) {
      if (isToolUseBlock(block)) {
        toolUseIds.add(block.id);
      }
    }

    if (toolUseIds.size === 0) continue;

    // 检查下一条 user 消息中是否有对应的 tool_result
    const nextMsg = result[i + 1];
    if (!nextMsg || nextMsg.role !== 'user') {
      // 若下一条不是 user，直接插入一条合成 user(tool_result) 消息，
      // 强制满足 Claude 要求的“紧邻下一条消息必须含 tool_result”约束。
      result.splice(i + 1, 0, {
        role: 'user',
        content: [...toolUseIds].map(id => ({
          type: 'tool_result',
          tool_use_id: id,
          content: '[Result omitted for compaction]',
        })),
      });
      i += 1;
      continue;
    }

    const userContent = Array.isArray(nextMsg.content)
      ? [...nextMsg.content]
      : (typeof nextMsg.content === 'string' && nextMsg.content.trim())
        ? [{ type: 'text', text: nextMsg.content }]
        : [];

    const toolResultBlocks = userContent.filter(
      (block: any) => block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id
    );
    const providedResultIds = new Set<string>(toolResultBlocks.map((block: any) => block.tool_use_id));
    const nonToolResultBlocks = userContent.filter((block: any) => block?.type !== 'tool_result');

    // 找到未配对的 tool_use id
    const missingIds = [...toolUseIds].filter(id => !providedResultIds.has(id));

    // 为未配对的 tool_use 补充合成的 tool_result
    const syntheticResults = missingIds.map(id => ({
      type: 'tool_result',
      tool_use_id: id,
      content: '[Result omitted for compaction]',
    }));

    const orderedToolResults = [...toolResultBlocks, ...syntheticResults];

    // 某些 Claude 兼容实现要求 tool_result 独占“下一条消息”，
    // 不能与后续 compact 指令文本混在同一个 user message 中。
    if (nonToolResultBlocks.length > 0) {
      result.splice(i + 1, 1,
        {
          role: 'user',
          content: orderedToolResults,
        },
        {
          ...nextMsg,
          content: nonToolResultBlocks,
        }
      );
      i += 1;
      continue;
    }

    result[i + 1] = {
      ...nextMsg,
      content: orderedToolResults,
    };
  }

  return result;
}

/**
 * 将 Claude 历史中的 tool_use / tool_result 块降级为普通文本块。
 *
 * compact 请求的目标只是生成摘要，不需要保留严格的工具调用协议语义。
 * 对某些 Claude 兼容实现（如第三方 Claude 标准接口）而言，历史中出现
 * tool_use/tool_result 往往会触发比 Anthropic 官方更严格的校验。
 * 因此在 compact 场景下，将工具块平铺为文本是更稳妥的上游输入形式。
 */
export function flattenClaudeToolBlocksForCompact(messages: any[]): any[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  return messages.map((message: any) => {
    if (!Array.isArray(message?.content)) {
      return message;
    }

    const flattenedContent = message.content.map((block: any) => {
      if (block?.type === 'tool_use' || block?.type === 'server_tool_use') {
        const toolName = typeof block.name === 'string' && block.name ? block.name : 'tool';
        const toolInput = block.input ? JSON.stringify(block.input) : '';
        return {
          type: 'text',
          text: `[Tool use: ${toolName}${toolInput ? ` ${toolInput}` : ''}]`,
        };
      }

      if (block?.type === 'tool_result') {
        let resultText = '';
        if (typeof block.content === 'string') {
          resultText = block.content;
        } else if (Array.isArray(block.content)) {
          resultText = block.content
            .map((item: any) => {
              if (typeof item === 'string') return item;
              if (typeof item?.text === 'string') return item.text;
              return '';
            })
            .filter(Boolean)
            .join('\n');
        }
        return {
          type: 'text',
          text: `[Tool result${resultText ? `: ${resultText}` : ''}]`,
        };
      }

      return block;
    });

    return {
      ...message,
      content: flattenedContent,
    };
  });
}

/**
 * Normalize Claude compact request payload so the upstream model can only
 * produce a plain-text summary instead of reasoning/tool output.
 */
export function normalizeClaudeCompactRequestBody(body: any): any {
  if (!body || typeof body !== 'object') {
    return body;
  }

  const normalized = { ...body };

  delete normalized.thinking;
  delete normalized.tools;
  delete normalized.tool_choice;
  delete normalized.mcp_servers;

  return normalized;
}

/**
 * Strip non-text assistant content from Claude compact responses.
 * Claude Code compact expects a plain text summary, so thinking/tool blocks
 * should not be sent back downstream even if the upstream model produced them.
 */
export function stripClaudeCompactResponseContent(response: any): any {
  if (!response || typeof response !== 'object' || !Array.isArray(response.content)) {
    return response;
  }

  const filteredContent = response.content.filter((block: any) => block?.type === 'text');

  return {
    ...response,
    content: filteredContent,
    stop_reason: response.stop_reason === 'tool_use' ? 'end_turn' : response.stop_reason,
  };
}

export function countUnpairedClaudeToolUses(messages: any[]): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0;

  let unpairedCount = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    const toolUseIds = msg.content
      .filter((block: any) => isToolUseBlock(block))
      .map((block: any) => block.id);

    if (toolUseIds.length === 0) continue;

    const nextMsg = messages[i + 1];
    if (!nextMsg || nextMsg.role !== 'user') {
      unpairedCount += toolUseIds.length;
      continue;
    }

    const nextContent = Array.isArray(nextMsg.content) ? nextMsg.content : [];
    const isPureToolResultMessage = nextContent.length > 0 && nextContent.every(
      (block: any) => block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id
    );

    if (!isPureToolResultMessage) {
      unpairedCount += toolUseIds.length;
      continue;
    }

    const resultIds = new Set(nextContent.map((block: any) => block.tool_use_id));
    unpairedCount += toolUseIds.filter((id: string) => !resultIds.has(id)).length;
  }

  return unpairedCount;
}

export function summarizeClaudeMessagesForDebug(messages: any[], startIndex: number, endIndex: number): any[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const start = Math.max(0, startIndex);
  const end = Math.min(messages.length - 1, endIndex);
  const summary: any[] = [];

  for (let i = start; i <= end; i++) {
    const msg = messages[i];
    const content = Array.isArray(msg?.content)
      ? msg.content.map((block: any, blockIndex: number) => ({
          blockIndex,
          type: block?.type,
          id: typeof block?.id === 'string' ? block.id : undefined,
          tool_use_id: typeof block?.tool_use_id === 'string' ? block.tool_use_id : undefined,
          name: typeof block?.name === 'string' ? block.name : undefined,
          text: typeof block?.text === 'string' ? block.text.slice(0, 120) : undefined,
          content: typeof block?.content === 'string' ? block.content.slice(0, 120) : undefined,
        }))
      : msg?.content;

    summary.push({
      index: i,
      role: msg?.role,
      content,
    });
  }

  return summary;
}

export function collectCompactPayloadDebugInfo(body: any, targetCallId?: string): Record<string, any> {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const serialized = (() => {
    try {
      return JSON.stringify(body);
    } catch {
      return '';
    }
  })();

  return {
    messageCount: messages.length,
    hasToolUseLiteral: serialized.includes('"tool_use"'),
    hasToolResultLiteral: serialized.includes('"tool_result"'),
    hasTargetCallId: targetCallId ? serialized.includes(targetCallId) : false,
    window47to49: summarizeClaudeMessagesForDebug(messages, 47, 49),
  };
}

function summarizeClaudeMessageContent(content: any): string {
  if (!Array.isArray(content)) return typeof content;
  return content.map((block: any, index: number) => {
    const type = block?.type || 'unknown';
    const id = block?.id ? `#${block.id}` : '';
    const toolUseId = block?.tool_use_id ? `->${block.tool_use_id}` : '';
    const text = typeof block?.text === 'string'
      ? `:${block.text.slice(0, 40).replace(/\s+/g, ' ')}`
      : '';
    return `${index}:${type}${id}${toolUseId}${text}`;
  }).join(' | ');
}

export function collectClaudeToolUseDiagnostics(messages: any[]): string[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const diagnostics: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    const toolUseIds = msg.content
      .filter((block: any) => isToolUseBlock(block))
      .map((block: any) => block.id);

    if (toolUseIds.length === 0) continue;

    const nextMsg = messages[i + 1];
    diagnostics.push(
      `[${i}] assistant tool_use_ids=${toolUseIds.join(', ')} blocks=${summarizeClaudeMessageContent(msg.content)}`
    );
    diagnostics.push(
      `[${i + 1}] ${nextMsg?.role || 'missing'} blocks=${summarizeClaudeMessageContent(nextMsg?.content)}`
    );
  }

  return diagnostics;
}

// ============================================================
// Compaction Prompt
// ============================================================

/**
 * The system prompt used to instruct the upstream model to compact a conversation.
 */
export const COMPACTION_SYSTEM_PROMPT = `You are a conversation compaction assistant. Your task is to create a comprehensive but concise summary of the following programming conversation, preserving all essential context needed to continue the conversation without any loss of critical information.

The summary MUST include:
1. **Current Task/Goal**: What the user is trying to accomplish
2. **Decisions Made**: Key decisions and their rationale
3. **Code State**: Current state of relevant files, including file paths, function names, and recent changes
4. **Errors Encountered**: Any errors or issues and their resolution status
5. **Pending Items**: Tasks or actions that are still in progress or yet to be done
6. **Context Details**: Important variables, configurations, or technical details discussed

Output a well-structured summary that can fully replace the original conversation. Be thorough but concise. Use markdown formatting for clarity.`;

/**
 * Build the full compaction system prompt text.
 */
export function buildCompactionPrompt(instructions?: string): string {
  let prompt = COMPACTION_SYSTEM_PROMPT;
  if (instructions) {
    prompt += `\n\nAdditional instructions from the user:\n${instructions}`;
  }
  return prompt;
}

// ============================================================
// Upstream Request / Response
// ============================================================

/**
 * Build an upstream request for compaction using the conversion system.
 *
 * Instead of manually constructing requests for each format, this builds a
 * standard Responses API request body and uses `transformRequest()` to convert
 * it to the target upstream format.
 */
export function buildCompactUpstreamRequest(
  conversationText: string,
  instructions: string | undefined,
  toFormat: Format,
  model: string,
): { body: any } {
  const systemPrompt = buildCompactionPrompt(instructions);

  // Build a standard Responses API request that represents the compact task
  const responsesBody = {
    model,
    instructions: systemPrompt,
    input: [
      {
        type: 'message',
        role: 'user',
        content: conversationText,
      },
    ],
    max_output_tokens: 8192,
    stream: false,
  };

  const result = transformRequest({
    fromFormat: 'responses',
    toFormat,
    body: responsesBody,
  });

  return { body: result.body };
}

/**
 * Extract the summary text from an upstream response.
 *
 * Uses `transformResponse()` to convert the upstream response back to
 * Responses API format, then extracts the text content.
 */
export function extractSummaryFromResponse(response: any, fromFormat: Format): string {
  if (!response) return '';

  // If already in responses format, extract directly
  if (fromFormat === 'responses') {
    return extractSummaryFromResponsesFormat(response);
  }

  // Convert upstream response to responses format, then extract
  const responsesResponse = transformResponse({
    fromFormat,
    toFormat: 'responses',
    response,
  });

  return extractSummaryFromResponsesFormat(responsesResponse);
}

/**
 * Extract summary text from a Responses API format response.
 */
function extractSummaryFromResponsesFormat(response: any): string {
  if (!response) return '';

  // Responses API: output array with message items containing text
  if (Array.isArray(response.output)) {
    return response.output
      .flatMap((item: any) => {
        if (item.type === 'message' && Array.isArray(item.content)) {
          return item.content
            .filter((block: any) => block.type === 'output_text' || block.type === 'text')
            .map((block: any) => block.text || '');
        }
        return [];
      })
      .filter(Boolean)
      .join('\n');
  }

  // Fallback for raw string
  if (typeof response === 'string') return response;

  return '';
}

// ============================================================
// Compacted Response Builder
// ============================================================

/**
 * Build a CompactedResponse object in the OpenAI Responses API format.
 */
export function buildCompactedResponse(summary: string, _model: string, inputTokens: number = 0, outputTokens: number = 0): object {
  const randHex = () => crypto.randomUUID().replace(/-/g, '').substring(0, 24);
  return {
    id: `resp_compact_${randHex()}`,
    created_at: Math.floor(Date.now() / 1000),
    object: 'response.compaction',
    output: [
      {
        type: 'message',
        id: `msg_${randHex()}`,
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: summary,
          },
        ],
        status: 'completed',
      },
    ],
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: inputTokens + outputTokens,
    },
  };
}

// ============================================================
// Unified High-level API
// ============================================================

/** Options for preparing a compact upstream request */
export interface CompactRequestOptions {
  /** Codex 原始请求体（Responses API 格式） */
  body: any;
  /** 上游目标格式 */
  toFormat: Format;
  /** 目标模型名称 */
  model: string;
}

/** Result of preparing a compact upstream request */
export interface CompactRequestResult {
  /** 发送给上游的请求体 */
  body: any;
  /** 是否为透传模式（responses → responses） */
  isPassthrough: boolean;
}

/**
 * 构建 compact 上游请求（统一入口）。
 *
 * - 目标格式是 `responses` → 直接转发原始请求体（passthrough）
 * - 目标格式是其他格式 → 提取对话文本 → 构造压缩提示词 → 转换为目标格式
 *
 * 外部只需传入目标格式和模型名称即可，无需关心内部处理逻辑。
 */
export function prepareCompactRequest(options: CompactRequestOptions): CompactRequestResult {
  const { body, toFormat, model } = options;

  // 目标格式是 responses：直接转发原始请求
  if (toFormat === 'responses') {
    return { body, isPassthrough: true };
  }

  // 其他格式：提取对话文本 → 构造压缩提示词 → 转换
  const conversationText = extractConversationText(body.input);
  const { body: transformedBody } = buildCompactUpstreamRequest(
    conversationText,
    body.instructions,
    toFormat,
    model,
  );
  return { body: transformedBody, isPassthrough: false };
}

/**
 * 处理 compact 上游响应（统一入口）。
 *
 * - `isPassthrough: true` → 直接返回原始响应（上游已经是 Responses compact 格式）
 * - `isPassthrough: false` → 提取摘要 → 构建 Responses API compact 响应
 */
export function processCompactResponse(
  response: any,
  fromFormat: Format,
  model: string,
  isPassthrough: boolean,
  usage?: { inputTokens?: number; outputTokens?: number },
): any {
  // Passthrough：上游已经是 Responses compact 格式，直接返回
  if (isPassthrough) return response;

  // 非 passthrough：提取摘要 → 构建 compact 响应
  const summary = extractSummaryFromResponse(response, fromFormat);
  return buildCompactedResponse(summary, model, usage?.inputTokens, usage?.outputTokens);
}
