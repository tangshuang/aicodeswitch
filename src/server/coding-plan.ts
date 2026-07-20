/**
 * 编程套餐限制检测工具
 *
 * 从 AITokenBus 的 isCodingToolRequest 逻辑移植而来。
 * 用于判断当前请求是否来自编程工具（Claude Code / Codex / Cursor 等），
 * 配合 APIService.enableCodingPlan 实现编程套餐限制。
 */

import type { Format } from './conversions/types';

export interface CodingCheckResult {
  isCoding: boolean;
  reason: string;
}

/**
 * 检测请求是否来自编程工具
 *
 * 检测策略（三层）：
 * 1. HTTP Headers —— 识别已知的编程工具 User-Agent / 特征 Header
 * 2. 请求体 —— Claude Messages / OpenAI Responses / OpenAI Chat Completions 格式中的 tool_use / tool_calls 等标记
 * 3. 都不匹配 —— 判定为非编程请求
 *
 * @param body       请求体（已解析为对象）
 * @param format     客户端请求格式（claude / completions / responses / gemini）
 * @param headers    请求头（小写 key）
 */
export function isCodingToolRequest(
  body: any,
  format: Format,
  headers?: Record<string, string | undefined>
): CodingCheckResult {
  const reasons: string[] = [];

  // ── Layer 1: HTTP Headers ──────────────────────────────────────────
  if (headers) {
    const ua = (headers['user-agent'] || '').toLowerCase();
    // Claude Code: user-agent 包含 "claude-cli" 或 "claude-vscode"
    if (ua.includes('claude-cli') || ua.includes('claude-vscode')) return { isCoding: true, reason: '' };
    // Claude Code: 特征 header
    if (headers['x-claude-code-session-id']) return { isCoding: true, reason: '' };
    // Codex: user-agent 包含 "codex"
    if (ua.includes('codex')) return { isCoding: true, reason: '' };
    // Codex: originator header
    if ((headers['originator'] || '').toLowerCase().includes('codex')) return { isCoding: true, reason: '' };
    // OpenCode: user-agent 包含 "opencode"
    if (ua.includes('opencode')) return { isCoding: true, reason: '' };
  }

  // ── Layer 2: Claude Messages API ───────────────────────────────────
  if (format === 'claude' && Array.isArray(body?.messages)) {
    for (const msg of body.messages) {
      const contents = Array.isArray(msg.content) ? msg.content : [];
      for (const block of contents) {
        if (block.type === 'tool_use' || block.type === 'tool_result') return { isCoding: true, reason: '' };
      }
    }
    if (Array.isArray(body.tools) && body.tools.length > 0) return { isCoding: true, reason: '' };
    reasons.push('claude messages: no tool_use/tool_result blocks, no tools array');
  }

  // ── Layer 2: OpenAI Responses API (Codex) ──────────────────────────
  if (Array.isArray(body?.input)) {
    for (const item of body.input) {
      if (item.type === 'message' && item.role === 'developer') return { isCoding: true, reason: '' };
      if (item.type === 'function_call' || item.type === 'function_call_output') return { isCoding: true, reason: '' };
    }
    reasons.push('responses input: no developer role message, no function_call/function_call_output');
  }

  // ── Layer 2: OpenAI Chat Completions ───────────────────────────────
  if (format === 'completions' && Array.isArray(body?.messages)) {
    for (const msg of body.messages) {
      if (msg.role === 'tool') return { isCoding: true, reason: '' };
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return { isCoding: true, reason: '' };
    }
    if (Array.isArray(body.tools) && body.tools.length > 0) return { isCoding: true, reason: '' };
    reasons.push('openai messages: no tool role, no tool_calls, no tools array');
  }

  // ── Layer 2: Gemini ────────────────────────────────────────────────
  if (format === 'gemini' && body?.contents) {
    const contents = Array.isArray(body.contents) ? body.contents : [];
    for (const part of contents) {
      const parts = Array.isArray(part.parts) ? part.parts : [];
      for (const p of parts) {
        if (p.functionCall || p.functionResponse) return { isCoding: true, reason: '' };
      }
    }
    if (Array.isArray(body.tools) && body.tools.length > 0) return { isCoding: true, reason: '' };
    reasons.push('gemini: no functionCall/functionResponse, no tools array');
  }

  if (reasons.length === 0) {
    reasons.push(`no matching format checked (format=${format}, hasMessages=${!!body?.messages}, hasInput=${!!body?.input})`);
  }

  return { isCoding: false, reason: reasons.join('; ') };
}
