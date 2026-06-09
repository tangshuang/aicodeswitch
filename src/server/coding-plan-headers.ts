/**
 * 编程套餐 Headers 覆盖模块
 *
 * 当 APIService 启用 enableCodingPlan 时，将发送到上游的请求 Headers
 * 覆盖为对应编程工具（Claude Code / Codex）的标准 Headers，
 * 使供应商验证通过。
 */

import crypto from 'crypto';
import type { SourceType } from '../types';

/**
 * 代理已设置的需要保留的 Headers
 * 这些 Headers 由 buildUpstreamHeaders 设置，不能被覆盖删除
 */
const KEEP_HEADERS = new Set([
  'authorization',                // 认证头
  'x-api-key',                    // Claude 认证头
  'x-goog-api-key',               // Gemini 认证头
  'content-type',                 // 内容类型
  'accept',                       // 接受类型
  'accept-encoding',              // 编码
  'connection',                   // 连接
  'content-length',               // 内容长度
  'anthropic-version',            // Claude API 版本
]);

/**
 * 构建 Claude Code 标准请求 Headers
 */
function buildClaudeCodeHeaders(sessionId: string): Record<string, string> {
  return {
    'user-agent': 'claude-cli/2.1.168 (external, claude-vscode, agent-sdk/0.3.168)',
    'x-claude-code-session-id': sessionId,
    'x-stainless-arch': 'arm64',
    'x-stainless-lang': 'js',
    'x-stainless-os': 'MacOS',
    'x-stainless-package-version': '0.94.0',
    'x-stainless-retry-count': '0',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': 'v24.3.0',
    'x-stainless-timeout': '3000',
    'anthropic-beta': 'claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
  };
}

/**
 * 构建 Codex 标准请求 Headers
 */
function buildCodexHeaders(sessionId: string): Record<string, string> {
  return {
    'x-codex-beta-features': 'terminal_resize_reflow,remote_compaction_v2',
    'x-codex-turn-metadata': JSON.stringify({
      session_id: sessionId,
      thread_id: sessionId,
      thread_source: 'user',
      turn_id: crypto.randomUUID(),
      sandbox: 'none',
      workspace_kind: 'project',
      request_kind: 'turn',
    }),
    'x-codex-window-id': `${sessionId}:0`,
    'x-client-request-id': sessionId,
    'session-id': sessionId,
    'thread-id': sessionId,
    'originator': 'codex_vscode',
    'user-agent': 'codex_vscode/0.137.0-alpha.4 (Mac OS 26.5.0; arm64) unknown (VS Code; 26.602.40724)',
  };
}

/**
 * 判断 sourceType 是否为 Claude 源
 */
function isClaudeSourceType(sourceType: SourceType): boolean {
  return sourceType === 'claude' || sourceType === 'claude-chat';
}

/**
 * 判断 sourceType 是否为 OpenAI 源
 */
function isOpenAISourceType(sourceType: SourceType): boolean {
  return sourceType === 'openai' || sourceType === 'openai-chat';
}

/**
 * 应用编程工具 Headers 覆盖
 *
 * 当 service.enableCodingPlan 为 true 时调用。
 * 清除原始请求中无关的 Headers，注入对应编程工具的标准 Headers。
 *
 * - Claude 源（claude/claude-chat）→ 注入 Claude Code Headers
 * - OpenAI 源（openai/openai-chat）→ 注入 Codex Headers
 * - Gemini 源不处理，保持原样
 *
 * @param headers     当前已构建的上游 Headers（会被原地修改）
 * @param sourceType  上游服务的源类型
 */
export function applyCodingPlanHeaders(
  headers: Record<string, string>,
  sourceType: SourceType,
): void {
  const isClaude = isClaudeSourceType(sourceType);
  const isOpenAI = isOpenAISourceType(sourceType);

  // Gemini 源不需要 Headers 覆盖
  if (!isClaude && !isOpenAI) {
    return;
  }

  const sessionId = crypto.randomUUID();

  // 1. 删除不在保留列表中的 Headers
  for (const key of Object.keys(headers)) {
    if (!KEEP_HEADERS.has(key.toLowerCase())) {
      delete headers[key];
    }
  }

  // 2. 注入编程工具标准 Headers
  // 2. 注入编程工具标准 Headers
  const toolHeaders = isClaude
    ? buildClaudeCodeHeaders(sessionId)
    : buildCodexHeaders(sessionId);

  for (const [key, value] of Object.entries(toolHeaders)) {
    headers[key] = value;
  }

  console.log(`\x1b[36m[CodingPlan-Headers]\x1b[0m Applied ${isClaude ? 'Claude Code' : 'Codex'} header override for upstream sourceType=${sourceType}`);
}
