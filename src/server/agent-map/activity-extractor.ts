/**
 * Agent Map 活动事件解析器
 *
 * 从单条代理请求的"输入侧 + 响应侧"抽取细粒度 ActivityEvent，
 * 用于实时广播、节点副标、活动路径子图与全局活动流。
 *
 * 设计要点：
 * - 纯函数，不依赖 dbManager；只读取 RequestLog 形状的字段
 * - 兼容 Claude / OpenAI Chat / OpenAI Responses / Gemini 四种格式 + 流式 / 非流式
 * - 复用前端 session-chat-utils 的解析思路（服务端实现一份，避免跨进程共享 .tsx）
 */
import type { ActivityEvent } from '../../types';

/** 解析输入参数 */
export interface ExtractInput {
  sessionId: string;
  agent: 'claude-code' | 'codex';
  timestamp: number;
  source?: 'global' | 'access-key';
  keyId?: string;
  keyName?: string;
  /** 请求体（含 messages） */
  body?: any;
  /** 实际发给客户端的响应（流式为 SSE 文本，非流式为对象/字符串） */
  downstreamResponseBody?: any;
  /** 非流式响应体（兜底） */
  responseBody?: any;
  statusCode?: number;
  /** 本轮 token 增量 */
  tokensDelta?: number;
}

const MAX_SUMMARY_LEN = 120;

function summarizeText(text: string): string {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= MAX_SUMMARY_LEN) return clean;
  return clean.slice(0, MAX_SUMMARY_LEN) + '…';
}

/** 提取一条 user 消息里的真实文本（忽略 tool_result / image 等非文本块）；无文本返回空串 */
function summarizeUserText(content: any): string {
  if (typeof content === 'string') return content.trim() ? summarizeText(content) : '';
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (block?.type === 'text' && block.text) texts.push(block.text);
      else if (typeof block === 'string') texts.push(block);
      // tool_result / image 等不计入
    }
    return texts.length ? summarizeText(texts.join('\n')) : '';
  }
  return '';
}

/**
 * 仅当「本轮请求的末条消息是一条新的用户文本提问」时返回其摘要；否则返回空串。
 *
 * 关键：Claude Code / Codex 每轮会把完整历史重发，工具调用后续轮的末条 user 消息是
 * tool_result（无文本）。若像以前那样向前回溯找「最近一条含文本的 user」，会反复命中
 * 同一条原始提问 → 活动流/路径出现大量重复用户消息。改为只认末条，从根上消除重复。
 */
function extractPromptSummary(body: any): string {
  const messages = body?.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') return summarizeUserText(last.content);
    return ''; // 末条非 user（assistant / tool_result 续轮）→ 不是新一轮提问
  }
  // OpenAI Responses / 简单 input
  const input = body?.input;
  if (typeof input === 'string') return summarizeText(input);
  if (Array.isArray(input) && input.length > 0) {
    const last = input[input.length - 1];
    if (last && last.role === 'user') return summarizeUserText(last.content);
  }
  return '';
}

/** 从 assistant content 数组（Claude 风格）抽取 tool_use 块 */
function pushClaudeToolUses(content: any[], out: Partial<ActivityEvent>[]) {
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_use' && block.name) {
      out.push({
        kind: 'tool_use',
        toolName: block.name,
        summary: summarizeToolInput(block.name, block.input),
      });
    }
  }
}

/** 美化工具调用的关键入参为一行摘要 */
function summarizeToolInput(name: string, input: any): string {
  if (!input || typeof input !== 'object') return name;
  try {
    if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
      return `${name}(${input.file_path || input.filePath || '?'})`;
    }
    if (name === 'Read') return `Read(${input.file_path || input.filePath || '?'})`;
    if (name === 'Bash' || name === 'BashOutput' || name === 'KillShell') {
      const cmd = input.command || input.cmd || '';
      return `Bash(${summarizeText(String(cmd))})`;
    }
    if (name === 'Grep' || name === 'Glob') {
      return `${name}(${input.pattern || input.query || '?'})`;
    }
    if (name === 'WebFetch' || name === 'WebSearch') {
      return `${name}(${input.url || input.query || '?'})`;
    }
    if (name === 'Agent' || name === 'Task') {
      return `${name}(${input.description || input.subagent_type || '?'})`;
    }
    // 兜底：取第一个字符串值
    const firstStr = Object.values(input).find(v => typeof v === 'string') as string | undefined;
    return firstStr ? `${name}(${summarizeText(firstStr)})` : name;
  } catch {
    return name;
  }
}

/**
 * 从响应侧解析出本轮产生的活动（tool_use / response / error）。
 * 流式优先（downstreamResponseBody 含 SSE），其次 responseBody 对象。
 */
function extractResponseActivities(input: ExtractInput): Partial<ActivityEvent>[] {
  const out: Partial<ActivityEvent>[] = [];
  const { downstreamResponseBody, responseBody } = input;

  // 1) 流式：尝试解析 SSE，收集 tool_use 与末尾文本
  if (typeof downstreamResponseBody === 'string' &&
      (downstreamResponseBody.includes('event:') || downstreamResponseBody.includes('data:'))) {
    const collected = collectFromSSE(downstreamResponseBody);
    for (const tu of collected.toolUses) out.push({ kind: 'tool_use', toolName: tu.name, summary: tu.summary });
    if (collected.text) out.push({ kind: 'response', summary: summarizeText(collected.text) });
    if (collected.thinking) out.push({ kind: 'thinking', summary: '[思考]' });
    if (out.length > 0) return out;
  }

  // 2) 非流式对象
  const parsed = parseJSONObject(downstreamResponseBody) ?? parseJSONObject(responseBody);
  if (parsed) {
    // Claude 风格 content 数组
    if (Array.isArray(parsed.content)) {
      pushClaudeToolUses(parsed.content, out);
      let text = '';
      for (const block of parsed.content) {
        if (block?.type === 'text' && block.text) text += block.text;
      }
      if (text) out.push({ kind: 'response', summary: summarizeText(text) });
      if (out.length > 0) return out;
    }
    // OpenAI Chat choices
    if (parsed.choices?.[0]?.message) {
      const msg = parsed.choices[0].message;
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const name = tc.function?.name || '';
          out.push({ kind: 'tool_use', toolName: name, summary: summarizeToolInput(name, safeParseJSON(tc.function?.arguments)) });
        }
      }
      if (msg.content) out.push({ kind: 'response', summary: summarizeText(String(msg.content)) });
      if (out.length > 0) return out;
    }
    // OpenAI Responses output
    if (parsed.output) {
      const outputs = Array.isArray(parsed.output) ? parsed.output : [parsed.output];
      let text = '';
      for (const item of outputs) {
        if (item?.type === 'function_call') {
          const name = item.name || '';
          out.push({ kind: 'tool_use', toolName: name, summary: summarizeToolInput(name, safeParseJSON(item.arguments)) });
        } else if (item?.type === 'message' && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c?.type === 'output_text' && c.text) text += c.text;
          }
        }
      }
      if (text) out.push({ kind: 'response', summary: summarizeText(text) });
      if (out.length > 0) return out;
    }
  }

  return out;
}

function parseJSONObject(v: any): any | null {
  if (!v) return null;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return null; }
  }
  return null;
}

function safeParseJSON(v: any): any {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

/** 从 SSE 文本中粗略收集 tool_use 名称与拼接文本（兼容 Anthropic / OpenAI 事件） */
function collectFromSSE(raw: string): { toolUses: { name: string; summary: string }[]; text: string; thinking: string } {
  const toolUses: { name: string; summary: string }[] = [];
  let text = '';
  let thinking = '';
  const seenToolIds = new Set<string>();

  // 按 "data: " 分块
  const blocks = raw.split(/\r?\n/);
  let buffer: any = null;
  for (const line of blocks) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { buffer = JSON.parse(payload); } catch { continue; }
    if (!buffer) continue;

    // Anthropic content_block_delta / content_block_start
    if (buffer.type === 'content_block_start' && buffer.content_block) {
      const cb = buffer.content_block;
      if (cb.type === 'tool_use' && cb.name) {
        const id = buffer.index != null ? String(buffer.index) : cb.id || Math.random().toString();
        if (!seenToolIds.has(id)) {
          seenToolIds.add(id);
          toolUses.push({ name: cb.name, summary: cb.name });
        }
      }
    } else if (buffer.type === 'content_block_delta' && buffer.delta) {
      const d = buffer.delta;
      if (d.type === 'text_delta' && d.text) text += d.text;
      else if (d.type === 'thinking_delta' && d.thinking) thinking += d.thinking;
      else if (d.type === 'input_json_delta' && d.partial_json) {
        // 工具入参增量，尝试补全 summary（best-effort，最后一条 tool_use）
        const last = toolUses[toolUses.length - 1];
        if (last && last.summary === last.name) {
          // 不做完整拼接，保持工具名即可
        }
      }
    }
    // OpenAI Chat 流式 choices
    else if (buffer.choices?.[0]?.delta) {
      const d = buffer.choices[0].delta;
      if (d.content) text += typeof d.content === 'string' ? d.content : '';
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const name = tc.function?.name;
          if (name) {
            const id = tc.id || name + (tc.index ?? '');
            if (!seenToolIds.has(id)) {
              seenToolIds.add(id);
              toolUses.push({ name, summary: name });
            }
          }
        }
      }
    }
    // OpenAI Responses 流式
    else if (buffer.type === 'response.output_item.added' && buffer.item) {
      if (buffer.item.type === 'function_call' && buffer.item.name) {
        toolUses.push({ name: buffer.item.name, summary: buffer.item.name });
      }
    } else if (buffer.type === 'response.output_text.delta' && buffer.delta) {
      text += buffer.delta;
    } else if (buffer.type === 'response.function_call_arguments.delta') {
      // ignore
    }
  }

  return { toolUses, text, thinking };
}

let eventCounter = 0;
function nextId(ts: number): string {
  eventCounter = (eventCounter + 1) % 1_000_000;
  return `evt_${ts}_${eventCounter}`;
}

/**
 * 检测本轮响应是否表示「一轮工作结束」（turn end），比 60s 空闲延时更精确、即时。
 *
 * 这正是官方 SDK 用来判定一轮完成的语义（Claude Agent SDK 的 query() 迭代器结束、
 * Codex SDK 的 thread.run() resolve）在响应里的具体字段：
 * - Claude（Messages）：响应 stop_reason。`tool_use` = 还要继续调工具（未结束）；
 *   `end_turn` / `stop_sequence` / `max_tokens` / `refusal` 等 = 本轮结束、交回用户。
 * - Codex（Responses）：本轮若含 function_call = 还要继续；否则仅 message/output_text 且
 *   有 response.completed = 本轮结束。
 *
 * 返回：true=本轮结束；false=仍将继续；null=无法判定（回退到时间窗启发式）。
 * 解析下游响应（downstreamResponseBody，已是客户端协议格式）；兼容流式 SSE 文本与非流式 JSON。
 */
export function detectTurnEnd(
  agent: 'claude-code' | 'codex',
  downstream: any,
  responseBody?: any,
): boolean | null {
  const downRaw = typeof downstream === 'string' ? downstream : (downstream ? JSON.stringify(downstream) : '');
  const bodyRaw = typeof responseBody === 'string' ? responseBody : (responseBody ? JSON.stringify(responseBody) : '');
  const raw = downRaw || bodyRaw;
  if (!raw) return null;

  if (agent === 'codex') {
    // Responses：含 function_call → 还要继续；否则有完成态 → 本轮结束
    if (/"type"\s*:\s*"function_call"/.test(raw)) return false;
    if (/"type"\s*:\s*"response\.completed"/.test(raw) || /"status"\s*:\s*"completed"/.test(raw)) return true;
    return null;
  }
  // Claude：看 stop_reason（流式 message_delta 或非流式 JSON 都带该字段）
  const m = raw.match(/"stop_reason"\s*:\s*"([a-z_]+)"/);
  const stopReason = m ? m[1] : null;
  if (stopReason === 'tool_use') return false;
  if (stopReason) return true; // end_turn / stop_sequence / max_tokens / refusal / ...
  return null;
}

/**
 * 从一次代理请求抽取本轮 ActivityEvent 列表。
 * 顺序：[prompt?]? → [thinking]? → tool_use* → response? → error?
 * 末尾按需追加 error 事件（statusCode >= 400）。
 */
export function extractActivityEvents(input: ExtractInput): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const base = {
    id: '',
    ts: input.timestamp,
    sessionId: input.sessionId,
    agent: input.agent,
    source: input.source,
    keyId: input.keyId,
    keyName: input.keyName,
    tokensDelta: input.tokensDelta,
    statusCode: input.statusCode,
  };

  // 用户提问（仅当能提取到文本）
  const promptSummary = extractPromptSummary(input.body);
  if (promptSummary) {
    events.push({ ...base, id: nextId(input.timestamp), kind: 'prompt', summary: promptSummary });
  }

  // 响应侧活动
  const respActs = extractResponseActivities(input);
  for (const a of respActs) {
    events.push({ ...base, id: nextId(input.timestamp), ...a } as ActivityEvent);
  }

  // 错误
  if (input.statusCode && input.statusCode >= 400) {
    events.push({ ...base, id: nextId(input.timestamp), kind: 'error', summary: `请求失败 (${input.statusCode})` });
  }

  return events;
}

/**
 * 从本轮活动里取一个"最近活动摘要"用于节点副标 + 最近工具名。
 */
export function deriveLastActivity(events: ActivityEvent[]): { summary?: string; toolName?: string } {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'tool_use' && e.toolName) {
      return { summary: e.summary, toolName: e.toolName };
    }
  }
  // 没有工具调用，取最后一条非 prompt 事件
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'response' || e.kind === 'error') {
      return { summary: e.summary };
    }
  }
  // 兜底取 prompt
  const prompt = events.find(e => e.kind === 'prompt');
  return prompt ? { summary: prompt.summary } : {};
}
