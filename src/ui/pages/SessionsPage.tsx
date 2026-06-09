import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';
import type { RequestLog, Session } from '../../types';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { Pagination } from '../components/Pagination';
import { toast } from '../components/Toast';
import { SessionMigrationModal } from '../components/SessionMigrationModal';
import { SessionRouteBindingModal } from '../components/SessionRouteBindingModal';
import LogDetailModal from '../components/LogDetailModal';
import { parseSSEChunks, assembleStreamText } from '../utils/log-utils';

dayjs.extend(relativeTime);

interface ChatMessageItem {
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
function extractChatItemsFromMessage(msg: any, timestamp: number, model?: string, toolNameMap?: Map<string, string>): ChatMessageItem[] {
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
function extractAssistantMessagesFromLog(log: RequestLog): ChatMessageItem[] {
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
function extractChatMessagesFromLogs(logs: RequestLog[]): ChatMessageItem[] {
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
function deduplicateChatMessages(messages: ChatMessageItem[]): ChatMessageItem[] {
  const result: ChatMessageItem[] = [];

  for (const msg of messages) {
    // 仅对 assistant 消息做去重，user 消息（含 tool_result）保持原样
    if (msg.role !== 'assistant') {
      result.push(msg);
      continue;
    }

    // 在已有的结果中查找相同内容的 assistant 消息
    const dupIndex = result.findIndex(existing =>
      existing.role === 'assistant' &&
      existing.type === msg.type &&
      existing.content === msg.content
    );

    if (dupIndex === -1) {
      // 无重复，直接添加
      result.push(msg);
    } else {
      // 存在重复，保留有 token 信息的版本
      const existing = result[dupIndex];
      const msgHasTokens = !!msg.tokens;
      const existingHasTokens = !!existing.tokens;

      if (msgHasTokens && !existingHasTokens) {
        // 当前消息有 token，替换已有的
        result[dupIndex] = msg;
      }
      // 否则保留已有的（已有 token 信息，或是先出现的）
    }
  }

  return result;
}

/**
 * 清理会话标题中的 XML 标签
 */
function cleanSessionTitle(title?: string): string {
  return (title || '').replace('<session>', '').replace('</session>', '').trim() || '(无标题)';
}

/**
 * 可折叠的消息内容
 */
function CollapsibleChatContent({ content, header, forceCollapsible, hideContentWhenCollapsed }: { content: string; header?: string; forceCollapsible?: boolean; hideContentWhenCollapsed?: boolean }) {
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

interface ChatViewFromSessionLogsProps {
  logs: RequestLog[];
}

function ChatViewFromSessionLogs({ logs, onFetchNew }: ChatViewFromSessionLogsProps & { onFetchNew?: () => Promise<RequestLog[]> }) {
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

/**
 * 会话页面
 */
function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsTotal, setSessionsTotal] = useState(0);
  const [sessionsPage, setSessionsPage] = useState(1);
  const [sessionsPageSize, setSessionsPageSize] = useState(20);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [selectedSessionLogs, setSelectedSessionLogs] = useState<RequestLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [chatViewMode, setChatViewMode] = useState<'logs' | 'chat'>('logs');

  // 搜索和筛选
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTargetType, setFilterTargetType] = useState('');

  // 自动刷新
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [countdown, setCountdown] = useState(10);
  const [migrationSession, setMigrationSession] = useState<Session | null>(null);
  const [routeBindingSession, setRouteBindingSession] = useState<Session | null>(null);
  const [detailLog, setDetailLog] = useState<RequestLog | null>(null);

  useEffect(() => {
    loadSessions();
  }, [sessionsPage, sessionsPageSize]);

  // 自动刷新倒计时逻辑
  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null;
    let countdownId: NodeJS.Timeout | null = null;

    if (autoRefresh) {
      countdownId = setInterval(() => {
        setCountdown(prev => {
          if (prev <= 1) return 10;
          return prev - 1;
        });
      }, 1000);

      intervalId = setInterval(() => {
        loadSessions();
      }, 10000);
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
      if (countdownId) clearInterval(countdownId);
    };
  }, [autoRefresh, sessionsPage, sessionsPageSize]);

  // 客户端筛选
  const filteredSessions = sessions.filter(session => {
    if (filterTargetType && session.targetType !== filterTargetType) return false;
    if (searchQuery.trim()) {
      const query = searchQuery.trim().toLowerCase();
      const title = (session.title || '').toLowerCase();
      const id = session.id.toLowerCase();
      if (!title.includes(query) && !id.includes(query)) return false;
    }
    return true;
  });

  const loadSessions = async () => {
    try {
      const offset = (sessionsPage - 1) * sessionsPageSize;
      const [data, count] = await Promise.all([
        api.getSessions(sessionsPageSize, offset),
        api.getSessionsCount()
      ]);
      setSessions(data);
      setSessionsTotal(count.count);
    } catch (error) {
      console.error('Failed to load sessions:', error);
    }
  };

  const handleSessionClick = async (session: Session, openChatView = false) => {
    setSelectedSession(session);
    setChatViewMode(openChatView ? 'chat' : 'logs');
    setLogsLoading(true);
    try {
      const logs = await api.getSessionLogs(session.id, 10000);
      setSelectedSessionLogs(logs);
    } catch (error) {
      console.error('Failed to load session logs:', error);
    } finally {
      setLogsLoading(false);
    }
  };

  const formatDuration = (startTime: number, endTime: number) => {
    const duration = endTime - startTime;
    if (duration < 60000) return `${Math.floor(duration / 1000)}秒`;
    else if (duration < 3600000) return `${Math.floor(duration / 60000)}分钟`;
    else return `${Math.floor(duration / 3600000)}小时`;
  };

  const getTargetTypeBadge = (targetType: string) => {
    if (targetType === 'claude-code') return <span className="badge badge-claude-code">Claude Code</span>;
    else if (targetType === 'codex') return <span className="badge badge-codex">Codex</span>;
    return <span className="badge">{targetType}</span>;
  };

  const exportSessionAsJson = () => {
    if (!selectedSession) return;
    const s = selectedSession;

    // 对话模式：导出对话数据
    if (chatViewMode === 'chat') {
      const chatMessages = extractChatMessagesFromLogs(selectedSessionLogs);
      const messages = chatMessages.map((msg, index) => ({
        index: index + 1,
        role: msg.role,
        type: msg.type || null,
        header: msg.header || null,
        content: msg.content,
        thinking: msg.thinking || null,
        timestamp: dayjs(msg.timestamp).format('YYYY-MM-DD HH:mm:ss'),
        model: msg.model || null,
        tokens: msg.tokens || null,
      }));

      const data = {
        session: {
          id: s.id,
          title: cleanSessionTitle(s.title),
          targetType: s.targetType,
          requestCount: s.requestCount,
          totalTokens: s.totalTokens,
          firstRequestAt: dayjs(s.firstRequestAt).format('YYYY-MM-DD HH:mm:ss'),
          lastRequestAt: dayjs(s.lastRequestAt).format('YYYY-MM-DD HH:mm:ss'),
          duration: formatDuration(s.firstRequestAt, s.lastRequestAt),
        },
        messages,
        exportedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      };

      const content = JSON.stringify(data, null, 2);
      const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeTitle = (cleanSessionTitle(s.title) || s.id.slice(0, 8)).replace(/[\\/:*?"<>|]/g, '_');
      a.download = `${safeTitle}_对话.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success('对话数据已导出');
      return;
    }

    // 日志模式：导出完整数据
    const logs = selectedSessionLogs.map((log, index) => {
      const messages = log.body?.messages || [];
      let responseText = '';
      const sourceText = log.downstreamResponseBody;
      if (typeof sourceText === 'string' && (sourceText.includes('event:') || sourceText.includes('data:'))) {
        const events = parseSSEChunks(sourceText);
        const { text, thinking } = assembleStreamText(events);
        const parts: string[] = [];
        if (thinking) parts.push(`<details><summary>思考过程</summary>\n\n${thinking}\n\n</details>`);
        if (text) parts.push(text);
        responseText = parts.join('\n\n');
      }
      if (!responseText && log.responseBody) {
        try {
          const parsed = typeof log.responseBody === 'string' ? JSON.parse(log.responseBody) : log.responseBody;
          if (parsed.content) {
            if (Array.isArray(parsed.content)) {
              const parts: string[] = [];
              for (const block of parsed.content) {
                if (block.type === 'text' && block.text) parts.push(block.text);
                else if (block.type === 'thinking' && block.thinking) parts.push(`<details><summary>思考过程</summary>\n\n${block.thinking}\n\n</details>`);
              }
              responseText = parts.join('\n\n');
            }
            if (typeof parsed.content === 'string') responseText = parsed.content;
          }
          if (!responseText && parsed.choices?.[0]?.message?.content) responseText = parsed.choices[0].message.content;
        } catch { /* ignore */ }
      }
      return {
        index: index + 1,
        timestamp: dayjs(log.timestamp).format('YYYY-MM-DD HH:mm:ss'),
        statusCode: log.statusCode || null,
        responseTime: log.responseTime || null,
        requestModel: log.requestModel || null,
        targetModel: log.targetModel || null,
        vendorName: log.vendorName || null,
        serviceName: log.targetServiceName || null,
        contentType: log.contentType || null,
        tags: log.tags || [],
        usage: log.usage || null,
        messages,
        response: responseText || null,
      };
    });

    const data = {
      session: {
        id: s.id,
        title: s.title || null,
        targetType: s.targetType,
        requestCount: s.requestCount,
        totalTokens: s.totalTokens,
        model: s.model || null,
        vendorName: s.vendorName || null,
        serviceName: s.serviceName || null,
        firstRequestAt: dayjs(s.firstRequestAt).format('YYYY-MM-DD HH:mm:ss'),
        lastRequestAt: dayjs(s.lastRequestAt).format('YYYY-MM-DD HH:mm:ss'),
        duration: formatDuration(s.firstRequestAt, s.lastRequestAt),
      },
      logs,
      exportedAt: dayjs().format('YYYY-MM-DD HH:mm:ss'),
    };

    const content = JSON.stringify(data, null, 2);
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeTitle = (cleanSessionTitle(s.title) || s.id.slice(0, 8)).replace(/[\\/:*?"<>|]/g, '_');
    a.download = `${safeTitle}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('导出成功');
  };

  const handleSessionsPageChange = (page: number) => setSessionsPage(page);
  const handleSessionsPageSizeChange = (size: number) => { setSessionsPageSize(size); setSessionsPage(1); };

  return (
    <div className="sessions-page">
      <div className="page-header">
        <div className="page-header-content">
          <div className="page-header-text">
            <h1>会话</h1>
            <p>查看和管理所有会话记录</p>
          </div>
        </div>
      </div>

      <div className="card">
        {/* 工具栏 */}
        <div className="toolbar">
          <h3>会话列表</h3>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            {/* 搜索框 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="text"
                placeholder="搜索标题或ID..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setSessionsPage(1);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') loadSessions();
                }}
                style={{
                  padding: '6px 12px',
                  border: '1px solid var(--border-primary)',
                  borderRadius: '6px',
                  fontSize: '14px',
                  width: '200px',
                  backgroundColor: 'var(--input-bg)',
                  color: 'var(--text-primary)'
                }}
              />
              {searchQuery && (
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => { setSearchQuery(''); setSessionsPage(1); }}
                >清除</button>
              )}
            </div>

            {/* 来源类型筛选 */}
            <select
              value={filterTargetType}
              onChange={(e) => {
                setFilterTargetType(e.target.value);
                setSessionsPage(1);
              }}
              style={{
                padding: '6px 12px',
                border: '1px solid var(--border-primary)',
                borderRadius: '6px',
                fontSize: '14px',
                backgroundColor: 'var(--input-bg)',
                color: 'var(--text-primary)'
              }}
            >
              <option value="">全部类型</option>
              <option value="claude-code">Claude Code</option>
              <option value="codex">Codex</option>
            </select>

            {/* 清除筛选 */}
            {(searchQuery || filterTargetType) && (
              <button
                className="btn btn-sm"
                style={{ backgroundColor: '#e67e22', color: 'white', border: 'none' }}
                onClick={() => {
                  setSearchQuery('');
                  setFilterTargetType('');
                  setSessionsPage(1);
                }}
              >清除筛选</button>
            )}

            {/* 自动刷新 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <input
                type="checkbox"
                id="auto-refresh"
                checked={autoRefresh}
                onChange={(e) => {
                  setAutoRefresh(e.target.checked);
                  setCountdown(10);
                }}
              />
              <label
                htmlFor="auto-refresh"
                style={{ cursor: 'pointer', fontSize: '14px', color: 'var(--text-primary)', userSelect: 'none' }}
              >
                自动刷新 {autoRefresh && `(⏱ ${countdown}s)`}
              </label>
            </div>

            <button className="btn btn-primary" onClick={() => { loadSessions(); setCountdown(10); }}>刷新</button>
          </div>
        </div>

        {sessions.length === 0 ? (
          <div className="empty-state"><p>暂无会话记录</p></div>
        ) : filteredSessions.length === 0 ? (
          <div className="empty-state"><p>没有匹配的会话</p></div>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>标题</th>
                  <th>客户端类型</th>
                  <th>请求数</th>
                  <th>Tokens</th>
                  <th>首次请求</th>
                  <th>最后请求</th>
                  <th>时长</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredSessions.map((session) => (
                  <tr
                    key={session.id}
                    onClick={() => handleSessionClick(session)}
                    style={{ cursor: 'pointer', backgroundColor: selectedSession?.id === session.id ? 'var(--bg-selected)' : undefined }}
                  >
                    <td style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {cleanSessionTitle(session.title) || session.id.slice(0, 8)}
                    </td>
                    <td>{getTargetTypeBadge(session.targetType)}</td>
                    <td>{session.requestCount}</td>
                    <td>{session.totalTokens.toLocaleString()}</td>
                    <td>{dayjs(session.firstRequestAt).format('MM-DD HH:mm')}</td>
                    <td>{dayjs(session.lastRequestAt).format('MM-DD HH:mm')}</td>
                    <td>{formatDuration(session.firstRequestAt, session.lastRequestAt)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          className="btn btn-sm btn-secondary"
                          onClick={(e) => { e.stopPropagation(); handleSessionClick(session, false); }}
                        >查看</button>
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={(e) => { e.stopPropagation(); handleSessionClick(session, true); }}
                        >对话</button>
                        <button
                          className="btn btn-sm"
                          style={{ backgroundColor: '#8e44ad', color: 'white', border: 'none' }}
                          onClick={(e) => { e.stopPropagation(); setMigrationSession(session); }}
                          title="迁移到另一个工具"
                        >迁移</button>
                        <button
                          className="btn btn-sm"
                          style={{
                            backgroundColor: session.routeId ? '#27ae60' : '#2980b9',
                            color: 'white',
                            border: 'none',
                            minWidth: session.routeId ? undefined : undefined,
                          }}
                          onClick={(e) => { e.stopPropagation(); setRouteBindingSession(session); }}
                          title={session.routeId ? `已绑定: ${session.routeName || session.routeId}` : '绑定路由'}
                        >
                          {session.routeName
                            ? (session.routeName.length > 8 ? session.routeName.slice(0, 8) + '…' : session.routeName)
                            : '路由'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination
              currentPage={sessionsPage}
              pageSize={sessionsPageSize}
              totalItems={sessionsTotal}
              onPageChange={handleSessionsPageChange}
              onPageSizeChange={handleSessionsPageSizeChange}
            />
          </>
        )}
      </div>

      {selectedSession && (
        <div className="modal-overlay">
          <button
            type="button"
            className="modal-close-btn"
            onClick={() => { setSelectedSession(null); setSelectedSessionLogs([]); }}
            aria-label="关闭"
          >×</button>
          <div className="modal modal--sticky-layout" style={{ width: '900px', maxWidth: '90vw' }}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h2>会话详情</h2>
                <button
                  className="session-refresh-btn"
                  onClick={async () => {
                    if (!selectedSession || logsLoading) return;
                    setLogsLoading(true);
                    try {
                      const logs = await api.getSessionLogs(selectedSession.id, 10000);
                      setSelectedSessionLogs(logs);
                    } catch (error) {
                      console.error('Failed to refresh session logs:', error);
                    } finally {
                      setLogsLoading(false);
                    }
                  }}
                  disabled={logsLoading}
                  title="刷新"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={logsLoading ? 'spin-icon' : ''}>
                    <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"/>
                  </svg>
                </button>
              </div>
              <div className="session-view-toggle">
                <button className={chatViewMode === 'logs' ? 'active' : ''} onClick={() => setChatViewMode('logs')}>日志</button>
                <button className={chatViewMode === 'chat' ? 'active' : ''} onClick={() => setChatViewMode('chat')}>对话</button>
              </div>
            </div>
            <div className="modal-body-scrollable">
              {chatViewMode === 'logs' ? (
                <>
                  <div className="form-group">
                    <label>会话ID</label>
                    <input type="text" value={selectedSession.id} readOnly />
                  </div>
                  <div className="form-group">
                    <label>标题</label>
                    <input type="text" value={cleanSessionTitle(selectedSession.title)} readOnly />
                  </div>
                  <div className="form-group">
                    <label>客户端类型</label>
                    <input type="text" value={selectedSession.targetType === 'claude-code' ? 'Claude Code' : 'Codex'} readOnly />
                  </div>
                  <div style={{ display: 'flex', gap: '15px' }}>
                    <div className="form-group" style={{ flex: 1 }}>
                      <label>请求数</label>
                      <input type="text" value={selectedSession.requestCount.toString()} readOnly />
                    </div>
                    <div className="form-group" style={{ flex: 1 }}>
                      <label>Tokens</label>
                      <input type="text" value={selectedSession.totalTokens.toLocaleString()} readOnly />
                    </div>
                    <div className="form-group" style={{ flex: 1 }}>
                      <label>时长</label>
                      <input type="text" value={formatDuration(selectedSession.firstRequestAt, selectedSession.lastRequestAt)} readOnly />
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '15px' }}>
                    <div className="form-group" style={{ flex: 1 }}>
                      <label>首次请求</label>
                      <input type="text" value={dayjs(selectedSession.firstRequestAt).format('YYYY-MM-DD HH:mm:ss')} readOnly />
                    </div>
                    <div className="form-group" style={{ flex: 1 }}>
                      <label>最后请求</label>
                      <input type="text" value={dayjs(selectedSession.lastRequestAt).format('YYYY-MM-DD HH:mm:ss')} readOnly />
                    </div>
                  </div>

                  <h3 style={{ marginTop: '20px', marginBottom: '10px' }}>会话日志 ({selectedSessionLogs.length})</h3>
                  {logsLoading ? (
                    <div style={{ textAlign: 'center', padding: '20px' }}>加载中...</div>
                  ) : selectedSessionLogs.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '20px', color: '#7f8c8d' }}>暂无日志</div>
                  ) : (
                    <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', overflow: 'hidden' }}>
                      <table style={{ fontSize: '14px' }}>
                        <thead>
                          <tr>
                            <th>时间</th>
                            <th>状态</th>
                            <th>响应时间</th>
                            <th>Tokens</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...selectedSessionLogs].sort((a, b) => a.timestamp - b.timestamp).map((log) => (
                            <tr key={log.id}>
                              <td>{dayjs(log.timestamp).format('HH:mm:ss')}</td>
                              <td>
                                <span className={`badge ${log.statusCode && log.statusCode >= 200 && log.statusCode < 300 ? 'badge-success' : log.statusCode && log.statusCode >= 400 ? 'badge-danger' : 'badge-warning'}`}>
                                  {log.statusCode || 'Error'}
                                </span>
                              </td>
                              <td>{log.responseTime ? `${log.responseTime}ms` : '-'}</td>
                              <td>
                                {log.usage ? (
                                  <span>{log.usage.totalTokens || log.usage.inputTokens + log.usage.outputTokens}</span>
                                ) : '-'}
                              </td>
                              <td>
                                <button className="btn btn-sm btn-secondary" onClick={() => {
                                  setDetailLog(log);
                                }}>详情</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              ) : (
                <>
                  {logsLoading ? (
                    <div style={{ textAlign: 'center', padding: '20px' }}>加载中...</div>
                  ) : (
                    <ChatViewFromSessionLogs
                      logs={selectedSessionLogs}
                      onFetchNew={async () => {
                        if (!selectedSession) return [];
                        const freshLogs = await api.getSessionLogs(selectedSession.id, 10000);
                        setSelectedSessionLogs(freshLogs);
                        return freshLogs;
                      }}
                    />
                  )}
                </>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={exportSessionAsJson} disabled={selectedSessionLogs.length === 0}>导出</button>
              <button className="btn btn-secondary" onClick={() => { setSelectedSession(null); setSelectedSessionLogs([]); }}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* Migration Modal */}
      {migrationSession && (
        <SessionMigrationModal
          session={migrationSession}
          onClose={() => setMigrationSession(null)}
        />
      )}

      {/* Route Binding Modal */}
      {routeBindingSession && (
        <SessionRouteBindingModal
          session={routeBindingSession}
          onClose={() => setRouteBindingSession(null)}
          onBound={() => {
            loadSessions();
          }}
        />
      )}

      {/* Log Detail Modal */}
      {detailLog && (
        <LogDetailModal log={detailLog} onClose={() => setDetailLog(null)} />
      )}
    </div>
  );
}

export default SessionsPage;
