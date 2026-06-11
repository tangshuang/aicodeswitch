/**
 * 会话聊天工具函数
 * 从 SessionsPage.tsx 提取，供 SessionsPage 和 AccessKeyDetailPage 共用
 */
import { useState, useEffect, useRef } from 'react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { RequestLog } from '../../types';
import { parseSSEChunks, assembleStreamText } from './log-utils';

dayjs.extend(relativeTime);

export interface ChatMessageItem {
  role: 'user' | 'assistant';
  type?: 'tool_result' | 'tool_use';
  header?: string;
  content: string;
  thinking?: string;
  timestamp: number;
  model?: string;
  tokens?: number;
}

/**
 * 从单条消息对象中提取 ChatMessageItem
 */
export function extractChatItemsFromMessage(msg: any, timestamp: number, model?: string, toolNameMap?: Map<string, string>): ChatMessageItem[] {
  if (!msg) return [];
  const items: ChatMessageItem[] = [];

  if (msg.role === 'user') {
    const content = msg.content;
    if (typeof content === 'string') {
      items.push({ role: 'user', content, timestamp, model });
    } else if (Array.isArray(content)) {
      let textParts: string[] = [];
      const flushText = () => {
        if (textParts.length > 0) {
          items.push({ role: 'user', content: textParts.join('\n'), timestamp, model });
          textParts = [];
        }
      };
      for (const block of content) {
        if (block?.type === 'text' && block?.text) {
          textParts.push(block.text);
        } else if (block?.type === 'image' || block?.type === 'image_url') {
          textParts.push('[图片]');
        } else if (block?.type === 'tool_result') {
          flushText();
          let resultText = '';
          if (block.content) {
            if (typeof block.content === 'string') {
              resultText = block.content;
            } else if (Array.isArray(block.content)) {
              resultText = block.content.map((c: any) => {
                if (typeof c === 'string') return c;
                if (c?.type === 'text' && c?.text) return c.text;
                if (c?.type === 'image') return '[图片]';
                if (c?.type === 'image_url') return '[图片]';
                return JSON.stringify(c);
              }).join('\n');
            } else {
              resultText = JSON.stringify(block.content);
            }
          }
          const resolvedName = (block.tool_use_id && toolNameMap?.get(block.tool_use_id)) || block.name || '';
          const shortId = block.tool_use_id ? block.tool_use_id.slice(-8) : '';
          const headerText = resolvedName
            ? `[工具结果: ${resolvedName}${shortId ? ` · ...${shortId}` : ''}]`
            : (shortId ? `[工具结果: ...${shortId}]` : '[工具结果]');
          items.push({ role: 'user', type: 'tool_result', header: headerText, content: resultText || headerText, timestamp, model });
        }
      }
      flushText();
    }
  } else if (msg.role === 'assistant') {
    const content = msg.content;
    if (typeof content === 'string') {
      if (content) items.push({ role: 'assistant', content, timestamp, model });
    } else if (Array.isArray(content)) {
      let text = '';
      let thinking = '';
      for (const block of content) {
        if (block.type === 'text' && block.text) text += block.text;
        if (block.type === 'thinking' && block.thinking) thinking += block.thinking;
        if (block.type === 'tool_use') {
          if (text || thinking) {
            items.push({ role: 'assistant', content: text, thinking: thinking || undefined, timestamp, model });
            text = '';
            thinking = '';
          }
          const toolName = block.name || '';
          const toolId = block.id ? block.id.slice(-8) : '';
          const headerLabel = toolName + (toolId ? ` · ...${toolId}` : '');
          const input = block.input ? JSON.stringify(block.input, null, 2) : '';
          items.push({ role: 'assistant', type: 'tool_use', header: `[工具调用: ${headerLabel}]`, content: input || `[工具调用: ${headerLabel}]`, timestamp, model });
        }
      }
      if (text || thinking) {
        items.push({ role: 'assistant', content: text || '', thinking: thinking || undefined, timestamp, model });
      }
    }
  }

  return items;
}

/**
 * 从日志中提取助手回复 — 拆分为多条消息
 */
export function extractAssistantMessagesFromLog(log: RequestLog): ChatMessageItem[] {
  const items: ChatMessageItem[] = [];
  const baseMeta = {
    timestamp: log.timestamp,
    model: log.targetModel,
    tokens: log.usage?.totalTokens || (log.usage ? log.usage.inputTokens + log.usage.outputTokens : undefined),
  };

  const sourceText = log.downstreamResponseBody;
  if (typeof sourceText === 'string' &&
      (sourceText.includes('event:') || sourceText.includes('data:'))) {
    const events = parseSSEChunks(sourceText);
    const { text, thinking } = assembleStreamText(events);
    if (text || thinking) {
      items.push({ role: 'assistant', content: text || '', thinking: thinking || undefined, ...baseMeta });
      return items;
    }
  }

  if (log.responseBody) {
    try {
      const parsed = typeof log.responseBody === 'string' ? JSON.parse(log.responseBody) : log.responseBody;

      if (parsed.content && Array.isArray(parsed.content)) {
        let text = '';
        let thinking = '';
        for (const block of parsed.content) {
          if (block.type === 'text' && block.text) text += block.text;
          if (block.type === 'thinking' && block.thinking) thinking += block.thinking;
          if (block.type === 'tool_use') {
            if (text || thinking) {
              items.push({ role: 'assistant', content: text, thinking: thinking || undefined, ...baseMeta });
              text = '';
              thinking = '';
            }
            const toolName = block.name || '';
            const toolId = block.id ? block.id.slice(-8) : '';
            const headerLabel = toolName + (toolId ? ` · ...${toolId}` : '');
            const input = block.input ? JSON.stringify(block.input, null, 2) : '';
            items.push({ role: 'assistant', type: 'tool_use', header: `[工具调用: ${headerLabel}]`, content: input || `[工具调用: ${headerLabel}]`, ...baseMeta });
          }
        }
        if (text || thinking) {
          items.push({ role: 'assistant', content: text || '', thinking: thinking || undefined, ...baseMeta });
        }
        if (items.length > 0) return items;
      }

      if (parsed.choices?.[0]?.message) {
        const msg = parsed.choices[0].message;
        if (msg.content) items.push({ role: 'assistant', content: msg.content, ...baseMeta });
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            const toolName = tc.function?.name || '';
            const toolId = tc.id ? tc.id.slice(-8) : '';
            const headerLabel = toolName + (toolId ? ` · ...${toolId}` : '');
            const args = tc.function?.arguments || '';
            items.push({ role: 'assistant', type: 'tool_use', header: `[工具调用: ${headerLabel}]`, content: args || `[工具调用: ${headerLabel}]`, ...baseMeta });
          }
        }
        if (items.length > 0) return items;
      }

      if (parsed.output) {
        let text = '';
        const outputs = Array.isArray(parsed.output) ? parsed.output : [parsed.output];
        for (const item of outputs) {
          if (item.type === 'message' && item.content) {
            const contents = Array.isArray(item.content) ? item.content : [item.content];
            for (const c of contents) {
              if (c.type === 'output_text' && c.text) text += c.text;
              else if (typeof c === 'string') text += c;
            }
          }
          if (item.type === 'function_call') {
            if (text) { items.push({ role: 'assistant', content: text, ...baseMeta }); text = ''; }
            const toolName = item.name || '';
            const toolId = item.call_id ? item.call_id.slice(-8) : '';
            const headerLabel = toolName + (toolId ? ` · ...${toolId}` : '');
            const args = item.arguments || '';
            items.push({ role: 'assistant', type: 'tool_use', header: `[工具调用: ${headerLabel}]`, content: args || `[工具调用: ${headerLabel}]`, ...baseMeta });
          }
        }
        if (text) items.push({ role: 'assistant', content: text, ...baseMeta });
        if (items.length > 0) return items;
      }
    } catch { /* ignore */ }
  }

  return items;
}

/**
 * 增量对比提取聊天消息
 */
export function extractChatMessagesFromLogs(logs: RequestLog[]): ChatMessageItem[] {
  const messages: ChatMessageItem[] = [];
  let prevMsgCount = 0;

  const toolNameMap = new Map<string, string>();
  for (const log of logs) {
    const allMessages = log.body?.messages || [];
    for (const msg of allMessages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use' && block.id && block.name) {
            toolNameMap.set(block.id, block.name);
          }
        }
      }
    }
  }

  for (const log of logs) {
    const allMessages = log.body?.messages || [];
    const newMessages = allMessages.slice(prevMsgCount);
    prevMsgCount = allMessages.length;

    for (const msg of newMessages) {
      const items = extractChatItemsFromMessage(msg, log.timestamp, log.requestModel, toolNameMap);
      messages.push(...items);
    }

    const assistantItems = extractAssistantMessagesFromLog(log);
    messages.push(...assistantItems);
  }

  return deduplicateChatMessages(messages);
}

/**
 * 对聊天消息去重：当连续出现的 assistant 消息内容相同时，
 * 保留有 token 消耗信息的那条，移除无 token 信息的重复条目。
 */
export function deduplicateChatMessages(messages: ChatMessageItem[]): ChatMessageItem[] {
  const result: ChatMessageItem[] = [];

  for (const msg of messages) {
    if (msg.role !== 'assistant') {
      result.push(msg);
      continue;
    }

    const dupIndex = result.findIndex(existing =>
      existing.role === 'assistant' &&
      existing.type === msg.type &&
      existing.content === msg.content
    );

    if (dupIndex === -1) {
      result.push(msg);
    } else {
      const existing = result[dupIndex];
      const msgHasTokens = !!msg.tokens;
      const existingHasTokens = !!existing.tokens;

      if (msgHasTokens && !existingHasTokens) {
        result[dupIndex] = msg;
      }
    }
  }

  return result;
}

/**
 * 清理会话标题中的 XML 标签
 */
export function cleanSessionTitle(title?: string): string {
  return (title || '').replace('<session>', '').replace('</session>', '').trim() || '(无标题)';
}

/**
 * 可折叠的消息内容
 */
export function CollapsibleChatContent({ content, header, forceCollapsible, hideContentWhenCollapsed }: { content: string; header?: string; forceCollapsible?: boolean; hideContentWhenCollapsed?: boolean }) {
  const lines = content.split('\n');
  const COLLAPSE_THRESHOLD = 10;
  const TOOL_COLLAPSE_LINES = 3;
  const wrapperRef = useRef<HTMLDivElement>(null);

  const isTool = !!forceCollapsible;
  const shouldCollapse = forceCollapsible || lines.length > COLLAPSE_THRESHOLD;
  const collapsedLines = isTool ? TOOL_COLLAPSE_LINES : COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!shouldCollapse);

  const handleToggle = () => {
    if (expanded) {
      requestAnimationFrame(() => {
        const wrapper = wrapperRef.current;
        const scrollContainer = wrapper?.closest('.modal-body-scrollable');
        if (wrapper && scrollContainer) {
          const wrapperRect = wrapper.getBoundingClientRect();
          const containerRect = scrollContainer.getBoundingClientRect();
          if (wrapperRect.top < containerRect.top || wrapperRect.top > containerRect.bottom) {
            wrapper.scrollIntoView({ block: 'start' });
          }
        }
      });
      setExpanded(false);
    } else {
      setExpanded(true);
    }
  };

  if (!shouldCollapse) {
    return (
      <>
        {header && <div className="chat-tool-header">{header}</div>}
        <div className="chat-content-text">{content}</div>
      </>
    );
  }

  if (!expanded && hideContentWhenCollapsed) {
    return (
      <div className="chat-collapsible-wrapper" ref={wrapperRef} style={{ width: '400px' }}>
        <div className="chat-collapse-top-bar">
          {header && <div className="chat-tool-header">{header}</div>}
          <div className="chat-collapse-btn-sticky">
            <button className="chat-collapse-btn" onClick={handleToggle}>
              展开 ({lines.length} 行)
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-collapsible-wrapper" ref={wrapperRef} style={!expanded && isTool ? { width: '400px' } : undefined}>
      <div className="chat-collapse-top-bar">
        {header && <div className="chat-tool-header">{header}</div>}
        <div className="chat-collapse-btn-sticky">
          <button className="chat-collapse-btn" onClick={handleToggle}>
            {expanded ? '收起' : `展开全部 (${lines.length} 行)`}
          </button>
        </div>
      </div>
      <div className="chat-content-text">
        {expanded ? content : lines.slice(0, collapsedLines).join('\n')}
      </div>
      {!expanded && (
        <div className="chat-collapse-fade" onClick={handleToggle}>
          <span className="chat-collapse-fade-btn">展开全部 ({lines.length} 行)</span>
        </div>
      )}
    </div>
  );
}

/**
 * 聊天视图组件（从日志中提取对话）
 */
export function ChatViewFromSessionLogs({ logs, onFetchNew }: { logs: RequestLog[]; onFetchNew?: () => Promise<RequestLog[]> }) {
  const sortedLogs = [...logs].sort((a, b) => a.timestamp - b.timestamp);
  const [localLogs, setLocalLogs] = useState<RequestLog[]>(sortedLogs);
  const chatMessages = extractChatMessagesFromLogs(localLogs);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(false);
  const [fetchingNew, setFetchingNew] = useState(false);

  useEffect(() => {
    setLocalLogs([...logs].sort((a, b) => a.timestamp - b.timestamp));
  }, [logs]);

  useEffect(() => {
    const scrollEl = containerRef.current?.parentElement;
    if (!scrollEl) return;
    const onScroll = () => {
      const atBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 60;
      setIsAtBottom(atBottom);
    };
    scrollEl.addEventListener('scroll', onScroll);
    onScroll();
    return () => scrollEl.removeEventListener('scroll', onScroll);
  }, [localLogs]);

  const scrollToBottom = () => {
    const el = containerRef.current?.parentElement;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const handleBtnClick = async () => {
    if (isAtBottom && onFetchNew) {
      setFetchingNew(true);
      try {
        const newLogs = await onFetchNew();
        const existingIds = new Set(localLogs.map(l => l.id));
        const freshSorted = [...newLogs].sort((a, b) => a.timestamp - b.timestamp);
        const appended = freshSorted.filter(l => !existingIds.has(l.id));
        if (appended.length > 0) {
          setLocalLogs(prev => [...prev, ...appended]);
          requestAnimationFrame(() => scrollToBottom());
        }
      } finally {
        setFetchingNew(false);
      }
    } else {
      scrollToBottom();
    }
  };

  if (chatMessages.length === 0) {
    return <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-tertiary)' }}>暂无对话内容</div>;
  }

  return (
    <div className="chat-view-container" ref={containerRef}>
      {chatMessages.map((msg, index) => (
        <div key={index} className={`chat-message chat-message--${msg.role}${msg.type ? ` chat-message--${msg.type}` : ''}`}>
          <div className="chat-bubble">
            {msg.role === 'assistant' && msg.thinking && (
              <details className="chat-thinking">
                <summary>思考内容 ({msg.thinking.length} 字符)</summary>
                <pre>{msg.thinking}</pre>
              </details>
            )}
            {msg.content && (
              <CollapsibleChatContent content={msg.content} header={msg.header} forceCollapsible={!!msg.type} hideContentWhenCollapsed={msg.type === 'tool_use'} />
            )}
          </div>
          {!msg.type && (
          <div className="chat-meta">
            {dayjs(msg.timestamp).format('HH:mm:ss')}
            {msg.model && ` · ${msg.model}`}
            {msg.tokens && ` · ${msg.tokens.toLocaleString()} tokens`}
          </div>
          )}
        </div>
      ))}
      <div className="chat-scroll-bottom">
        <button className="chat-scroll-bottom-btn" onClick={handleBtnClick} disabled={fetchingNew}>
          {fetchingNew ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="spin-icon">
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"/>
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12l7 7 7-7"/>
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
