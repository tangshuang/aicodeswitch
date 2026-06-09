import type { RequestLog, ErrorLog } from '../../types';
import dayjs from 'dayjs';
import { TARGET_TYPE } from '../constants';

/**
 * 解析SSE事件行
 */
export interface ParsedSSEEvent {
  event?: string;
  data?: any;
  raw: string;
}

/**
 * 解析原始SSE文本为结构化事件列表
 */
export function parseSSEChunks(sourceText: string): ParsedSSEEvent[] {
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

    const dataText = dataLines.length > 0
      ? dataLines.join('\n').trim()
      : undefined;
    let data;
    if (dataText) {
      try {
        data = JSON.parse(dataText);
      } catch {
        data = dataText;
      }
    }

    events.push({
      event,
      data,
      raw: chunk
    });
  }

  return events;
}

/**
 * 从解析的SSE事件中组装完整文本
 * 返回 { text, thinking } 结构
 */
export function assembleStreamText(events: ParsedSSEEvent[], _targetType?: string): { text: string; thinking: string } {
  let text = '';
  let thinking = '';
  let inThinkingBlock = false;
  let inTextBlock = false;
  let reasoningAccumulated = false; // 是否已通过 delta 累积了 reasoning

  for (const event of events) {
    const data = event.data;
    if (!data) continue;

    // ========== 处理 Claude 格式 (用于 claude-code 客户端) ==========
    if (event.event === 'content_block_start' && data.content_block) {
      const blockType = data.content_block.type;
      if (blockType === 'thinking') {
        inThinkingBlock = true;
      } else if (blockType === 'text') {
        inTextBlock = true;
      }
      continue;
    }

    if (event.event === 'content_block_stop') {
      inThinkingBlock = false;
      inTextBlock = false;
      continue;
    }

    if (event.event === 'content_block_delta' && data.delta) {
      if (data.delta.type === 'text_delta' && inTextBlock) {
        text += data.delta.text || '';
      } else if (data.delta.type === 'thinking_delta' && inThinkingBlock) {
        thinking += data.delta.thinking || '';
      }
      continue;
    }

    // ========== 处理 Responses API 格式 (用于 codex 客户端) ==========

    // response.reasoning_text.delta - reasoning 内容的增量
    if (event.event === 'response.reasoning_text.delta' && data.delta !== undefined) {
      thinking += data.delta || '';
      reasoningAccumulated = true;
      continue;
    }

    // response.content_part.done - 完整的 reasoning 或 output_text
    if (event.event === 'response.content_part.done' && data.part) {
      const part = data.part;
      if (part.type === 'reasoning_text' && part.text) {
        // 如果没有通过 delta 累积，使用完整文本
        if (!reasoningAccumulated) {
          thinking = part.text;
        }
      } else if (part.type === 'output_text' && part.text) {
        text += part.text;
      }
      continue;
    }

    // ========== 处理 OpenAI Chat 格式 (兼容性) ==========

    if (!event.event && data.choices) {
      const delta = data.choices?.[0]?.delta;
      if (delta) {
        if (typeof delta.content === 'string') {
          text += delta.content;
        }
        // 某些 OpenAI 兼容 API 可能使用 thinking 字段
        if (delta.thinking && typeof delta.thinking.content === 'string') {
          thinking += delta.thinking.content;
        }
      }
      continue;
    }

    // ========== 处理直接包含 thinking 的数据（DeepSeek 等） ==========

    if (data.reasoning_content || data.thinking) {
      thinking += data.reasoning_content || data.thinking || '';
    }
  }

  return { text, thinking };
}

/**
 * 从stream chunks组装完整文本
 */
export function assembleStreamTextFromChunks(sourceText: string | undefined, targetType?: string): { text: string; thinking: string } {
  if (!sourceText || sourceText.length === 0) {
    return { text: '', thinking: '' };
  }

  const events = parseSSEChunks(sourceText);
  return assembleStreamText(events, targetType);
}

/**
 * 从日志组装完整的响应体JSON
 */
export function assembleResponseBody(log: RequestLog): any | null {
  console.log('[assembleResponseBody] log:', {
    id: log.id,
    hasResponseBody: !!log.responseBody,
    responseBodyLength: log.responseBody?.length,
    hasStreamChunks: !!log.streamChunks,
    streamChunksLength: log.streamChunks?.length,
    targetType: log.targetType
  });

  // 如果有 responseBody，直接返回（非 stream 请求）
  if (log.responseBody) {
    try {
      const parsed = JSON.parse(log.responseBody);
      console.log('[assembleResponseBody] returning parsed responseBody');
      return parsed;
    } catch {
      console.log('[assembleResponseBody] returning raw responseBody (parse failed)');
      return log.responseBody;
    }
  }

  // 如果有 streamChunks，组装完整的响应体
  if (log.streamChunks && log.streamChunks.length > 0) {
    console.log('[assembleResponseBody] processing streamChunks:', log.streamChunks.length);
    const { text, thinking } = assembleStreamTextFromChunks(log.downstreamResponseBody, log.targetType);
    console.log('[assembleResponseBody] assembled text:', { textLength: text.length, thinkingLength: thinking.length });

    // 根据目标类型构建合适的响应体结构
    if (log.targetType === 'claude-code') {
      // Claude Code 格式
      const content: any[] = [];
      if (thinking) {
        content.push({ type: 'thinking', thinking: thinking });
      }
      if (text) {
        content.push({ type: 'text', text: text });
      }
      // 如果既没有 thinking 也没有 text，添加一个占位符
      if (content.length === 0) {
        content.push({ type: 'text', text: '(空内容 - 可能响应未完成或解析失败)' });
      }
      const result = {
        type: 'message',
        role: 'assistant',
        content,
        model: log.targetModel || log.requestModel,
        usage: log.usage
      };
      console.log('[assembleResponseBody] returning claude-code format with', content.length, 'content blocks');
      return result;
    } else if (log.targetType === 'codex') {
      // Codex (OpenAI) 格式
      const result = {
        id: log.id,
        object: 'chat.completion',
        created: Math.floor(log.timestamp / 1000),
        model: log.targetModel || log.requestModel,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: text || thinking || '(空内容 - 可能响应未完成或解析失败)'
          },
          finish_reason: 'stop'
        }],
        usage: log.usage
      };
      console.log('[assembleResponseBody] returning codex format');
      return result;
    }

    // 通用格式
    const result = {
      content: text || thinking || '(空内容 - 可能响应未完成或解析失败)',
      usage: log.usage
    };
    console.log('[assembleResponseBody] returning generic format');
    return result;
  }

  console.log('[assembleResponseBody] no responseBody or streamChunks, returning null');
  return null;
}

/**
 * 格式化请求日志为 Markdown
 */
export function formatRequestLogAsMarkdown(log: RequestLog): string {
  const lines: string[] = [];

  lines.push('# 请求日志详情\n');

  lines.push(`## 基本信息`);
  lines.push(`- **日志ID**: ${log.id}`);
  lines.push(`- **时间**: ${dayjs(log.timestamp).format('YYYY-MM-DD HH:mm:ss')}`);
  if (log.targetType) {
    lines.push(`- **客户端类型**: ${TARGET_TYPE[log.targetType] || '-'}`);
  }
  if (log.tags && log.tags.length > 0) {
    lines.push(`- **标签**: ${log.tags.join(', ')}`);
  }
  lines.push('');

  lines.push(`## 模型信息`);
  if (log.requestModel) {
    lines.push(`- **请求模型**: ${log.requestModel}`);
  }
  if (log.vendorName) {
    lines.push(`- **供应商**: ${log.vendorName}`);
  }
  if (log.targetServiceName) {
    lines.push(`- **供应商API服务**: ${log.targetServiceName}`);
  }
  if (log.targetModel) {
    lines.push(`- **供应商模型**: ${log.targetModel}`);
  }
  lines.push('');

  lines.push(`## 请求信息`);
  lines.push(`- **请求方法**: ${log.method}`);
  lines.push(`- **请求路径**: ${log.path}`);
  lines.push('');

  if (log.headers) {
    lines.push(`## 请求头`);
    lines.push('```json');
    lines.push(JSON.stringify(log.headers, null, 2));
    lines.push('```\n');
  }

  if (log.body) {
    lines.push(`## 请求体`);
    lines.push('```json');
    lines.push(JSON.stringify(log.body, null, 2));
    lines.push('```\n');
  }

  if (log.upstreamRequest) {
    lines.push(`## 实际转发的请求信息`);
    lines.push('```json');
    lines.push(JSON.stringify(log.upstreamRequest, null, 2));
    lines.push('```\n');
  }

  lines.push(`## 响应信息`);
  lines.push(`- **状态码**: ${log.statusCode || 'Error'}`);
  lines.push(`- **响应时间**: ${log.responseTime ? `${log.responseTime}ms` : '-'}`);
  lines.push('');

  if (log.responseHeaders) {
    lines.push(`## 响应头`);
    lines.push('```json');
    lines.push(JSON.stringify(log.responseHeaders, null, 2));
    lines.push('```\n');
  }

  const assembledBody = assembleResponseBody(log);
  if (assembledBody) {
    lines.push(`## 响应体`);
    lines.push('```json');
    lines.push(JSON.stringify(assembledBody, null, 2));
    lines.push('```\n');
  }

  if (log.usage) {
    lines.push(`## Token 使用`);
    lines.push(`- **输入**: ${log.usage.inputTokens}`);
    lines.push(`- **输出**: ${log.usage.outputTokens}`);
    if (log.usage.totalTokens !== undefined) {
      lines.push(`- **总计**: ${log.usage.totalTokens}`);
    }
    if (log.usage.cacheReadInputTokens !== undefined) {
      lines.push(`- **缓存读取**: ${log.usage.cacheReadInputTokens}`);
    }
    lines.push('');
  }

  if (log.error) {
    lines.push(`## 错误信息`);
    lines.push('```');
    lines.push(log.error);
    lines.push('```\n');
  }

  if (log.downstreamResponseBody) {
    lines.push(`## 实际转发的响应体`);
    lines.push('```json');
    lines.push(typeof log.downstreamResponseBody === 'string'
      ? log.downstreamResponseBody
      : JSON.stringify(log.downstreamResponseBody, null, 2));
    lines.push('```\n');

    // 检查是否为流式响应
    if (typeof log.downstreamResponseBody === 'string' &&
        (log.downstreamResponseBody.includes('event:') || log.downstreamResponseBody.includes('data:'))) {
      const events = parseSSEChunks(log.downstreamResponseBody);
      const { text, thinking } = assembleStreamText(events);

      if (thinking) {
        lines.push(`## 思考内容 (${thinking.length} 字符)`);
        lines.push('```');
        lines.push(thinking);
        lines.push('```\n');
      }

      if (text) {
        lines.push(`## 回复内容 (${text.length} 字符)`);
        lines.push('```');
        lines.push(text);
        lines.push('```\n');
      }
    }
  }

  return lines.join('\n');
}

/**
 * 格式化错误日志为 Markdown
 */
export function formatErrorLogAsMarkdown(log: ErrorLog): string {
  const lines: string[] = [];

  lines.push('# 错误日志详情\n');

  lines.push(`## 基本信息`);
  lines.push(`- **ID**: ${log.id}`);
  lines.push(`- **时间**: ${dayjs(log.timestamp).format('YYYY-MM-DD HH:mm:ss')}`);
  if (log.targetType) {
    lines.push(`- **客户端类型**: ${TARGET_TYPE[log.targetType] || '-'}`);
  }
  if (log.tags && log.tags.length > 0) {
    lines.push(`- **标签**: ${log.tags.join(', ')}`);
  }
  lines.push('');

  lines.push(`## 模型信息`);
  if (log.requestModel) {
    lines.push(`- **请求模型**: ${log.requestModel}`);
  }
  if (log.vendorName) {
    lines.push(`- **供应商**: ${log.vendorName}`);
  }
  if (log.targetServiceName) {
    lines.push(`- **供应商API服务**: ${log.targetServiceName}`);
  }
  if (log.targetModel) {
    lines.push(`- **供应商模型**: ${log.targetModel}`);
  }
  lines.push('');

  lines.push(`## 请求信息`);
  lines.push(`- **请求方法**: ${log.method}`);
  lines.push(`- **请求路径**: ${log.path}`);
  lines.push('');

  if (log.requestHeaders) {
    lines.push(`## 请求头`);
    lines.push('```json');
    lines.push(JSON.stringify(log.requestHeaders, null, 2));
    lines.push('```\n');
  }

  if (log.requestBody) {
    lines.push(`## 请求体`);
    lines.push('```json');
    lines.push(JSON.stringify(log.requestBody, null, 2));
    lines.push('```\n');
  }

  if (log.upstreamRequest) {
    lines.push(`## 实际转发的请求信息`);
    lines.push('```json');
    lines.push(JSON.stringify(log.upstreamRequest, null, 2));
    lines.push('```\n');
  }

  lines.push(`## 错误信息`);
  lines.push('```');
  lines.push(log.errorMessage);
  lines.push('```\n');

  if (log.errorStack) {
    lines.push(`## 错误堆栈`);
    lines.push('```');
    lines.push(log.errorStack);
    lines.push('```\n');
  }

  lines.push(`## 响应信息`);
  lines.push(`- **状态码**: ${log.statusCode || '-'}`);
  lines.push(`- **响应时间**: ${log.responseTime ? `${log.responseTime}ms` : '-'}`);
  lines.push('');

  if (log.responseHeaders) {
    lines.push(`## 响应头`);
    lines.push('```json');
    lines.push(JSON.stringify(log.responseHeaders, null, 2));
    lines.push('```\n');
  }

  if (log.responseBody) {
    lines.push(`## 响应体`);
    lines.push('```json');
    lines.push(JSON.stringify(log.responseBody, null, 2));
    lines.push('```\n');
  }

  return lines.join('\n');
}
