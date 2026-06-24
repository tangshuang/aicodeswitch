import type { FileSystemDatabaseManager } from './fs-database';
import type {
  MigrationOptions,
  MigrationContent,
  MigrationRound,
  MigrationPreview,
  MigrationResult,
  RequestLog,
  ToolType,
} from '../types';

// ─── SSE 解析（后端复用 SessionsPage 中的逻辑） ───

interface ParsedSSEEvent {
  event?: string;
  data?: any;
  raw: string;
}

function parseSSEChunks(sourceText: string): ParsedSSEEvent[] {
  const chunks = sourceText.split('\n').map(item => item.trim()).join('\n')
    .split('\n\n').filter(s => s.trim());
  const events: ParsedSSEEvent[] = [];

  for (const chunk of chunks) {
    let event: string = '';
    let dataLines: string[] = [];
    let dataInsert = 0;
    const lines = chunk.split('\n');
    lines.forEach((line) => {
      if (/^[a-z]+:/.test(line)) {
        const at = line.indexOf(':');
        const type = line.slice(0, at).trim();
        const content = line.slice(at + 1).trim();
        if (type === 'event') {
          event = content;
        }
        else if (type === 'data') {
          dataLines.push(content);
          dataInsert = 1;
        }
        else if (dataLines.length) {
          dataInsert = -1;
        }
      }
      else if (dataInsert === 1) {
        dataLines.push(line);
      }
    });
    if (dataLines.length) {
      const raw = dataLines.join('\n');
      let parsed = raw as any;
      try {
        parsed = JSON.parse(raw);
      } catch { /* keep raw string */ }
      events.push({ event, data: parsed, raw });
    }
  }
  return events;
}

function assembleStreamText(events: ParsedSSEEvent[]): { text: string; thinking: string } {
  let text = '', thinking = '';
  let inTextBlock = false, inThinkingBlock = false;
  let reasoningAccumulated = false;

  for (const ev of events) {
    const data = ev.data;
    if (!data) continue;

    // Claude format
    if (typeof data === 'object' && data.type) {
      if (data.type === 'content_block_start') {
        if (data.content_block?.type === 'text') inTextBlock = true;
        else if (data.content_block?.type === 'thinking') inThinkingBlock = true;
      }
      if (data.type === 'content_block_delta') {
        if (data.delta?.type === 'text_delta' && inTextBlock) text += data.delta.text || '';
        if (data.delta?.type === 'thinking_delta' && inThinkingBlock) thinking += data.delta.thinking || '';
      }
      if (data.type === 'content_block_stop') {
        inTextBlock = false;
        inThinkingBlock = false;
      }
    }

    // Responses API format
    if (typeof data === 'object' && data.type) {
      if (data.type === 'response.reasoning_text.delta') {
        thinking += data.delta || '';
        reasoningAccumulated = true;
      }
      if (data.type === 'response.content_part.done') {
        if (data.part?.type === 'output_text' && data.part?.text) {
          text += data.part.text;
        }
        if (data.part?.type === 'reasoning_text' && data.part?.text && !reasoningAccumulated) {
          thinking += data.part.text;
        }
      }
    }

    // OpenAI Chat format
    if (typeof data === 'object' && data.choices?.[0]?.delta) {
      const delta = data.choices[0].delta;
      if (delta.content) text += delta.content;
      if (delta.thinking?.content) thinking += delta.thinking.content;
    }

    // DeepSeek direct format
    if (typeof data === 'object' && (data.reasoning_content || data.thinking)) {
      thinking += data.reasoning_content || data.thinking;
    }
  }

  return { text, thinking };
}

// ─── 工具调用摘要化 ───

const TOOL_SUMMARIES: Record<string, (input: any) => string> = {
  Bash: (i) => `🔧 执行命令: \`${i.command || i.cmd || ''}\``,
  Read: (i) => `📖 读取文件: ${i.file_path || ''}`,
  Write: (i) => `📝 写入文件: ${i.file_path || ''}`,
  Edit: (i) => `✏️ 编辑文件: ${i.file_path || i.target_file || ''}`,
  Glob: (i) => `🔍 搜索文件: ${i.pattern || ''}`,
  Grep: (i) => `🔍 搜索内容: ${i.pattern || ''}`,
  TodoWrite: () => `📋 更新任务列表`,
  Agent: () => `🤖 启动子代理`,
  TaskOutput: () => `📤 获取任务输出`,
  SendMessage: () => `💬 发送消息`,
  shell: (i) => `🔧 执行命令: \`${i.command || ''}\``,
  apply_diff: (_i) => `✏️ 应用代码变更`,
  create_file: (_i) => `📝 创建文件`,
};

function summarizeToolCall(toolName: string, input: any): string {
  const summarizer = TOOL_SUMMARIES[toolName];
  if (summarizer) {
    try {
      return summarizer(input);
    } catch {
      return `🔧 调用工具: ${toolName}`;
    }
  }
  return `🔧 调用工具: ${toolName}`;
}

// ─── 内容提取 ───

interface LogMessage {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, any>>;
  [key: string]: any;
}

function extractUserTextFromClaudeMessages(messages: Array<LogMessage>): string {
  const userMsgs = messages.filter(m => m.role === 'user');
  if (!userMsgs.length) return '';
  const lastMsg = userMsgs[userMsgs.length - 1];
  if (typeof lastMsg.content === 'string') return lastMsg.content;
  if (Array.isArray(lastMsg.content)) {
    return lastMsg.content
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text)
      .join('\n');
  }
  return '';
}

function extractToolCallsFromClaudeMessage(msg: LogMessage): string[] {
  if (!Array.isArray(msg.content)) return [];
  return msg.content
    .filter(b => b.type === 'tool_use')
    .map(b => summarizeToolCall(b.name || 'unknown', b.input || {}));
}

function extractUserTextFromCodexInput(inputArr: Array<any>): string {
  const userItems = inputArr.filter(i => i.type === 'message' && i.role === 'user');
  if (!userItems.length) return '';
  const lastItem = userItems[userItems.length - 1];
  if (typeof lastItem.content === 'string') return lastItem.content;
  if (Array.isArray(lastItem.content)) {
    return lastItem.content
      .filter((b: any) => b.type === 'input_text' && b.text)
      .map((b: any) => b.text)
      .join('\n');
  }
  return '';
}

function extractToolCallsFromCodexInput(inputArr: Array<any>): string[] {
  return inputArr
    .filter(i => i.type === 'function_call')
    .map(i => summarizeToolCall(i.name || 'unknown', typeof i.arguments === 'string' ? JSON.parse(i.arguments || '{}') : (i.arguments || {})));
}

function extractAssistantResponseFromLog(log: RequestLog): { text: string; thinking: string } {
  let text = '', thinking = '';

  // 1. Try downstreamResponseBody (SSE)
  const sourceText = log.downstreamResponseBody;
  if (typeof sourceText === 'string' && (sourceText.includes('event:') || sourceText.includes('data:'))) {
    const events = parseSSEChunks(sourceText);
    const assembled = assembleStreamText(events);
    text = assembled.text;
    thinking = assembled.thinking;
  }

  // 2. Try responseBody (JSON)
  if (!text && !thinking && log.responseBody) {
    try {
      const parsed = typeof log.responseBody === 'string' ? JSON.parse(log.responseBody) : log.responseBody;
      if (parsed.content) {
        if (Array.isArray(parsed.content)) {
          const parts: string[] = [];
          for (const block of parsed.content) {
            if (block.type === 'text' && block.text) parts.push(block.text);
            else if (block.type === 'thinking' && block.thinking) thinking += block.thinking;
          }
          text = parts.join('\n\n');
        } else if (typeof parsed.content === 'string') {
          text = parsed.content;
        }
      }
      if (!text && parsed.choices?.[0]?.message?.content) {
        text = parsed.choices[0].message.content;
      }
      if (!text && parsed.output) {
        const parts: string[] = [];
        for (const item of parsed.output) {
          if (item.type === 'message') {
            if (Array.isArray(item.content)) {
              for (const c of item.content) {
                if (c.type === 'output_text' && c.text) parts.push(c.text);
              }
            }
          }
        }
        text = parts.join('\n\n');
      }
    } catch { /* ignore parse errors */ }
  }

  // 3. Try streamChunks
  if (!text && Array.isArray(log.streamChunks)) {
    const chunksText = log.streamChunks.join('');
    if (chunksText.includes('event:') || chunksText.includes('data:')) {
      const events = parseSSEChunks(chunksText);
      const assembled = assembleStreamText(events);
      text = assembled.text;
      thinking = assembled.thinking;
    }
  }

  return { text: text.trim(), thinking: thinking.trim() };
}

function isClaudeCodeBody(body: any): boolean {
  return body?.messages && Array.isArray(body.messages);
}

function isCodexBody(body: any): boolean {
  return body?.input && Array.isArray(body.input);
}

// ─── Token 估算 ───

function estimateTokens(text: string): number {
  let cjk = 0, other = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0x20000 && code <= 0x2A6DF) ||
      (code >= 0xF900 && code <= 0xFAFF)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk + other * 0.25);
}

// ─── 迁移 Prompt 生成 ───

function formatSessionTitle(title?: string): string {
  if (!title) return '(无标题)';
  return title.replace(/<\/?session>/g, '').trim() || '(无标题)';
}

function generateMigrationPrompt(content: MigrationContent, targetTool: ToolType): string {
  const toolLabels: Record<ToolType, string> = {
    'claude-code': 'Claude Code',
    'codex': 'Codex',
    'opencode': 'OpenCode',
  };
  const sourceLabel = toolLabels[content.sourceTool];
  const targetLabel = toolLabels[targetTool];

  const lines: string[] = [];
  lines.push(`# 会话迁移上下文`);
  lines.push('');
  lines.push(`> 以下内容从 ${sourceLabel} 会话「${formatSessionTitle(content.sessionTitle)}」迁移而来`);
  lines.push(`> 目标工具：${targetLabel}`);
  lines.push(`> 迁移时间：${new Date().toISOString()}`);
  lines.push(`> 原始会话共 ${content.totalRounds} 轮对话，此处包含最近 ${content.extractedRounds} 轮`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 对话历史');
  lines.push('');

  for (const round of content.rounds) {
    lines.push(`### 👤 用户`);
    lines.push(round.userMessage || '(无文本内容)');
    lines.push('');

    if (round.toolCallSummaries.length > 0) {
      for (const summary of round.toolCallSummaries) {
        lines.push(`> ${summary}`);
      }
      lines.push('');
    }

    lines.push(`### 🤖 助手`);
    lines.push(round.assistantResponse || '(无文本内容)');
    lines.push('');

    if (round.thinking) {
      lines.push('<details>');
      lines.push('<summary>思考过程</summary>');
      lines.push('');
      lines.push(round.thinking);
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  lines.push(`> ⚠️ 注意：以上对话历史和工具操作仅为上下文摘要，实际的文件修改和工具执行结果不会在目标工具中生效。`);
  lines.push(`> 请基于以上上下文继续工作。`);

  return lines.join('\n');
}

// ─── 主要导出 ───

export async function extractSessionContent(
  dbManager: FileSystemDatabaseManager,
  sessionId: string,
  options: MigrationOptions
): Promise<MigrationContent> {
  const logs = await dbManager.getLogsBySessionId(sessionId, 10000);
  const session = dbManager.getSession(sessionId);

  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const sortedLogs = logs.sort((a, b) => a.timestamp - b.timestamp);
  const rounds: MigrationRound[] = [];

  for (let i = 0; i < sortedLogs.length; i++) {
    const log = sortedLogs[i];
    const body = log.body
      ? (typeof log.body === 'string' ? JSON.parse(log.body as string) : log.body)
      : null;

    if (!body) continue;

    // Extract user message
    let userMessage = '';
    let toolCallSummaries: string[] = [];

    if (isClaudeCodeBody(body)) {
      userMessage = extractUserTextFromClaudeMessages(body.messages);
      // Extract tool calls from assistant messages
      if (options.includeToolCalls !== false && body.messages) {
        for (const msg of body.messages) {
          if (msg.role === 'assistant') {
            toolCallSummaries.push(...extractToolCallsFromClaudeMessage(msg));
          }
        }
      }
    } else if (isCodexBody(body)) {
      userMessage = extractUserTextFromCodexInput(body.input);
      if (options.includeToolCalls !== false) {
        toolCallSummaries = extractToolCallsFromCodexInput(body.input);
      }
    }

    if (!userMessage && !toolCallSummaries.length) continue;

    // Extract assistant response
    const { text, thinking } = extractAssistantResponseFromLog(log);

    rounds.push({
      index: rounds.length + 1,
      userMessage,
      assistantResponse: text,
      toolCallSummaries,
      thinking: options.includeThinking ? (thinking || undefined) : undefined,
      timestamp: log.timestamp,
    });
  }

  const maxRounds = options.maxRounds || 0;
  const extractedRounds = maxRounds > 0 ? rounds.slice(-maxRounds) : rounds;

  return {
    sessionId,
    sessionTitle: session.title || '',
    sourceTool: session.targetType,
    rounds: extractedRounds,
    totalRounds: sortedLogs.length,
    extractedRounds: extractedRounds.length,
  };
}

export function previewMigration(
  content: MigrationContent,
  targetTool: ToolType
): MigrationPreview {
  const warnings: string[] = [];
  const prompt = generateMigrationPrompt(content, targetTool);
  const estimatedTokens = estimateTokens(prompt);

  if (content.totalRounds > content.extractedRounds && content.extractedRounds > 0) {
    warnings.push(`会话较长（${content.totalRounds} 轮），已截断到最近 ${content.extractedRounds} 轮对话`);
  }

  if (estimatedTokens > 100000) {
    warnings.push(`迁移 Prompt 约 ${estimatedTokens.toLocaleString()} tokens，可能超过目标模型的上下文窗口`);
  }

  if (content.totalRounds === 0) {
    warnings.push('该会话没有可提取的对话内容');
  }

  return {
    content,
    generatedPrompt: prompt,
    estimatedTokens,
    warnings,
  };
}

export function migrateSession(
  content: MigrationContent,
  targetTool: ToolType,
  editedPrompt?: string
): MigrationResult {
  const prompt = editedPrompt || generateMigrationPrompt(content, targetTool);
  const estimatedTokens = estimateTokens(prompt);
  const warnings: string[] = [];

  if (estimatedTokens > 100000) {
    warnings.push(`迁移 Prompt 约 ${estimatedTokens.toLocaleString()} tokens，可能超过目标模型的上下文窗口`);
  }

  return {
    success: true,
    prompt,
    format: 'markdown',
    estimatedTokens,
    warnings,
  };
}
