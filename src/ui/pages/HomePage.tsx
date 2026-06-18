import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { api } from '../api/client';
import { useConfirm } from '../components/Confirm';
import type { AtoChatMessage, AtoLeaderToolEvent, AtoLeaderSession } from '../../types';

dayjs.extend(relativeTime);

function ToolChip({ tool }: { tool: AtoLeaderToolEvent }) {
  const [open, setOpen] = useState(false);
  const label = tool.kind === 'tool_use' ? `${tool.name || 'tool'}` : `result`;
  const detail = tool.kind === 'tool_use' ? tool.input : tool.content;
  return (
    <div style={{ margin: '6px 0', maxWidth: 680 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          fontSize: 12, padding: '2px 10px', borderRadius: 10,
          border: '1px solid var(--border-color)', background: 'var(--bg-secondary)',
          cursor: 'pointer', color: 'var(--text-secondary)',
        }}
      >
        {open ? '▾' : '▸'} 🛠 {label}
      </button>
      {open && (
        <pre style={{
          margin: '4px 0 0', padding: 8, fontSize: 12, maxHeight: 200, overflow: 'auto',
          background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 6,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}
        </pre>
      )}
    </div>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

function PanelToggleIcon({ open, side }: { open: boolean; side: 'left' | 'right' }) {
  // open 时显示收起（chevron 朝向对应侧），收起时显示展开（带侧栏的 panel 图标）
  if (open) {
    const points = side === 'left' ? '15 18 9 12 15 6' : '9 6 15 12 9 18';
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}>
        <polyline points={points} />
      </svg>
    );
  }
  const barX = side === 'left' ? 9 : 15;
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <line x1={barX} y1="5" x2={barX} y2="19" />
    </svg>
  );
}

export default function HomePage() {
  const [messages, setMessages] = useState<AtoChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamingTools, setStreamingTools] = useState<AtoLeaderToolEvent[]>([]);
  const [status, setStatus] = useState('');
  const [leaderTool, setLeaderTool] = useState<'claude-code' | 'codex'>('claude-code');
  const [toolAvailable, setToolAvailable] = useState<boolean | null>(null);
  const [pendingPerms, setPendingPerms] = useState<Array<{ id: string; toolName: string; input: unknown; risk: string; reason?: string; createdAt: number }>>([]);
  const [showDebug, setShowDebug] = useState(false);
  const [debugAnimating, setDebugAnimating] = useState(false);
  const [debugLines, setDebugLines] = useState<string[]>([]);

  // 会话管理
  const [sessions, setSessions] = useState<AtoLeaderSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState<boolean>(
    () => localStorage.getItem('leader-panel-open') === '1'
  );
  const [panelAnimating, setPanelAnimating] = useState(false);
  const { confirm } = useConfirm();

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const data = await api.atoLeaderListSessions();
      setSessions(data.sessions);
      setCurrentSessionId(data.currentSessionId);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void api.atoLeaderHistory().then(setMessages).catch(() => { /* ignore */ });
    void refreshSessions();
    void api.atoLeaderGetConfig().then((c) => {
      setLeaderTool(c.leaderTool);
      setToolAvailable(c.available);
    }).catch(() => { /* ignore */ });
    void api.atoPermissionPending().then(setPendingPerms).catch(() => { /* ignore */ });

    // 订阅权限事件（pending / resolved）
    const token = localStorage.getItem('auth_token') || '';
    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/orchestrator/leader/permissions/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`);
      es.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (d.type === 'heartbeat') return;
          if (d.kind === 'pending' && d.pending) {
            setPendingPerms((prev) => [...prev.filter((p) => p.id !== d.pending.id), d.pending]);
          } else if (d.kind === 'resolved' && d.id) {
            setPendingPerms((prev) => prev.filter((p) => p.id !== d.id));
          }
        } catch { /* ignore */ }
      };
    } catch { /* ignore */ }
    return () => { es?.close(); };
  }, [refreshSessions]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streamingText, sending]);

  const handleToolChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const tool = e.target.value as 'claude-code' | 'codex';
    try {
      const res = await api.atoLeaderSetConfig(tool);
      setLeaderTool(res.leaderTool);
      const cfg = await api.atoLeaderGetConfig();
      setToolAvailable(cfg.available);
    } catch { /* ignore */ }
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    setMessages((prev) => [...prev, { ts: Date.now(), role: 'user', content: text }]);
    setSending(true);
    setStreamingText('');
    setStreamingTools([]);
    setStatus('思考中…');

    try {
      const full = await api.atoLeaderMessage(text, {
        onText: (delta) => setStreamingText((prev) => prev + delta),
        onTool: (e) => setStreamingTools((prev) => [...prev, e]),
        onStatus: (s) => setStatus(s),
        onDebug: (entry) => {
          setDebugLines((prev) => {
            const next = [...prev, `[${entry.kind}] ${entry.message}`];
            if (next.length > 2000) return next.slice(-2000);
            return next;
          });
        },
        onError: (msg) => {
          setShowDebug(true);
          setDebugLines((prev) => {
            const next = [...prev, `[error] ${msg}`];
            return next.length > 2000 ? next.slice(-2000) : next;
          });
        },
      });
      setMessages((prev) => [
        ...prev,
        {
          ts: Date.now(),
          role: 'assistant',
          content: full || '(主 Agent 未返回内容)',
          tools: streamingTools.length > 0 ? streamingTools : undefined,
        },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessages((prev) => [...prev, { ts: Date.now(), role: 'assistant', content: `⚠️ ${msg}` }]);
    } finally {
      setSending(false);
      setStreamingText('');
      setStreamingTools([]);
      setStatus('');
      // 同步会话列表（title/updatedAt 可能变化，或首条消息触发懒建会话）
      void refreshSessions();
    }
  };

  const handleNew = async () => {
    if (sending) return;
    try {
      await api.atoLeaderCreateSession();
      setMessages([]);
      setStreamingText('');
      setStreamingTools([]);
      await refreshSessions();
    } catch { /* ignore */ }
  };

  const handleActivate = async (id: string) => {
    if (sending || id === currentSessionId) return;
    try {
      await api.atoLeaderActivateSession(id);
      setCurrentSessionId(id);
      const msgs = await api.atoLeaderHistory();
      setMessages(msgs);
      setStreamingText('');
      setStreamingTools([]);
    } catch { /* ignore */ }
  };

  const handleDelete = async (id: string, title: string) => {
    if (sending) return;
    const ok = await confirm({
      title: '删除会话',
      message: `确定删除「${title}」吗？\n\n该操作会一并删除关联的 Claude Code / Codex 本地会话文件，且不可恢复。`,
      type: 'danger',
      confirmText: '删除',
    });
    if (!ok) return;
    const wasCurrent = id === currentSessionId;
    try {
      await api.atoLeaderDeleteSession(id);
      await refreshSessions();
      // 若删的是当前会话，后端会切换到最近剩余或空态，重新加载历史
      if (wasCurrent) {
        const msgs = await api.atoLeaderHistory();
        setMessages(msgs);
        setStreamingText('');
        setStreamingTools([]);
      }
    } catch { /* ignore */ }
  };

  const togglePanel = () => {
    setPanelOpen((v) => {
      const next = !v;
      localStorage.setItem('leader-panel-open', next ? '1' : '0');
      return next;
    });
    setPanelAnimating(true);
  };

  const toggleDebug = () => {
    setShowDebug((v) => !v);
    setDebugAnimating(true);
  };

  const closeDebug = () => {
    setShowDebug(false);
    setDebugAnimating(true);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const autoGrow = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  const handlePermResolve = async (id: string, behavior: 'allow' | 'deny') => {
    try {
      await api.atoPermissionResolve(id, behavior);
      setPendingPerms((prev) => prev.filter((p) => p.id !== id));
    } catch { /* ignore */ }
  };

  const renderPending = () => {
    if (pendingPerms.length === 0) return null;
    return (
      <div style={{ maxWidth: 720, margin: '0 auto 12px' }}>
        {pendingPerms.map((p) => (
          <div key={p.id} style={{
            padding: 12, marginBottom: 8, borderRadius: 12,
            border: '1px solid var(--border-color)', background: 'var(--bg-primary)',
            borderLeft: `3px solid ${p.risk === 'high' ? 'var(--accent-danger)' : p.risk === 'medium' ? '#d97706' : 'var(--accent-primary)'}`,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong style={{ fontSize: 14 }}>🛡 {p.toolName} <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>· 风险 {p.risk}</span></strong>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>等待你确认</span>
            </div>
            <pre style={{ margin: '0 0 8px', padding: 8, fontSize: 12, maxHeight: 160, overflow: 'auto', background: 'var(--bg-secondary)', borderRadius: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {typeof p.input === 'string' ? p.input : JSON.stringify(p.input, null, 2)}
            </pre>
            {p.reason && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>{p.reason}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" onClick={() => handlePermResolve(p.id, 'allow')}>放行</button>
              <button className="btn btn-secondary" onClick={() => handlePermResolve(p.id, 'deny')}>拒绝</button>
            </div>
          </div>
        ))}
      </div>
    );
  };

  const renderInput = () => (
    <div className="leader-input-box">
      <textarea
        ref={textareaRef}
        value={input}
        onChange={autoGrow}
        onKeyDown={onKeyDown}
        placeholder="随心输入，或描述一个任务…"
        rows={1}
        disabled={sending}
      />
      <div className="leader-input-bar">
        <select
          className="leader-tool-select"
          value={leaderTool}
          onChange={handleToolChange}
          disabled={sending}
          title="选择主 Agent"
        >
          <option value="claude-code">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
        <button
          className="leader-send-btn"
          onClick={handleSend}
          disabled={sending || !input.trim()}
          title="发送（Enter）"
        >
          <SendIcon />
        </button>
      </div>
    </div>
  );

  const renderMessage = (m: AtoChatMessage, i: number) => {
    if (m.role === 'user') {
      return (
        <div key={i} className="leader-msg leader-msg--user">
          <div className="leader-bubble">{m.content}</div>
        </div>
      );
    }
    return (
      <div key={i} className="leader-msg leader-msg--assistant">
        {m.tools && m.tools.length > 0 && (
          <div className="leader-tools-inline">
            {m.tools.map((t, j) => <ToolChip key={j} tool={t as AtoLeaderToolEvent} />)}
          </div>
        )}
        <div className="markdown-content"><ReactMarkdown>{m.content}</ReactMarkdown></div>
      </div>
    );
  };

  // 顶栏左侧：会话面板切换按钮
  const renderPanelToggle = () => (
    <button
      className="leader-debug-toggle"
      onClick={togglePanel}
      title={panelOpen ? '收起会话列表' : '展开会话列表'}
      aria-label="切换会话列表"
    >
      <PanelToggleIcon open={panelOpen} side="left" />
    </button>
  );

  // 调试面板展开按钮：浮动在聊天窗口右侧外部；面板展开后隐藏（用面板内的关闭按钮收起）
  const renderDebugToggle = () => {
    const visible = !showDebug && !debugAnimating;
    return (
      <button
        className="leader-debug-toggle leader-debug-toggle--float"
        onClick={toggleDebug}
        style={{ display: visible ? 'flex' : 'none' }}
        title="展开调试面板"
        aria-label="展开调试面板"
      >
        <PanelToggleIcon open={false} side="right" />
      </button>
    );
  };

  const renderSessionPanel = () => {
    // 收起态或动画中保持 overflow:hidden；完全展开后移除，避免裁切
    const clipped = !panelOpen || panelAnimating;
    const cls = [
      'leader-session-panel',
      panelOpen ? '' : 'is-collapsed',
      clipped ? 'is-clipped' : '',
    ].filter(Boolean).join(' ');
    return (
      <aside
        className={cls}
        onTransitionEnd={(e) => { if (e.propertyName === 'width') setPanelAnimating(false); }}
      >
        <div className="leader-session-panel-inner">
          <div className="leader-session-header">
            <span>会话</span>
            <button
              className="leader-session-new-btn"
              onClick={handleNew}
              disabled={sending}
              title="新建会话"
            >
              ＋
            </button>
          </div>
          <div className="leader-session-list">
            {sessions.length === 0 ? (
              <div className="leader-session-empty">暂无会话，点 ＋ 新建</div>
            ) : (
              sessions.map((s) => (
                <div
                  key={s.id}
                  className={`leader-session-item${s.id === currentSessionId ? ' leader-session-item--active' : ''}`}
                  onClick={() => handleActivate(s.id)}
                  title={s.title}
                >
                  <div className="leader-session-meta">
                    <div className="leader-session-title">{s.title || '未命名会话'}</div>
                    <div className="leader-session-time">{dayjs(s.updatedAt).fromNow()}</div>
                  </div>
                  <button
                    className="leader-session-del"
                    onClick={(e) => { e.stopPropagation(); void handleDelete(s.id, s.title || '未命名会话'); }}
                    title="删除会话"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </aside>
    );
  };

  const renderDebugPanel = () => {
    const clipped = !showDebug || debugAnimating;
    const cls = [
      'leader-debug-panel',
      showDebug ? '' : 'is-collapsed',
      clipped ? 'is-clipped' : '',
    ].filter(Boolean).join(' ');
    return (
      <aside
        className={cls}
        onTransitionEnd={(e) => { if (e.propertyName === 'width') setDebugAnimating(false); }}
      >
        <div className="leader-debug-panel-inner">
          <div className="leader-debug-header">
            <span>调试输出</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="btn btn-sm"
                onClick={() => setDebugLines([])}
                style={{ fontSize: 11, padding: '2px 8px' }}
              >
                清空
              </button>
              <button
                className="leader-debug-close"
                onClick={closeDebug}
                title="关闭"
              >
                ✕
              </button>
            </div>
          </div>
          <div className="leader-debug-output">
            {debugLines.length === 0 ? (
              <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>等待输出…</span>
            ) : (
              debugLines.map((line, i) => (
                <div key={i} className="leader-debug-line">
                  {line}
                </div>
              ))
            )}
          </div>
        </div>
      </aside>
    );
  };

  const renderChat = () => {
    const hasConversation = messages.length > 0 || sending;
    if (!hasConversation) {
      return (
        <>
          <div className="leader-empty">
            {renderInput()}
          </div>
          {toolAvailable === false && (
            <div className="leader-hint" style={{ color: 'var(--accent-danger)' }}>
              未检测到 {leaderTool === 'codex' ? 'Codex' : 'Claude Code'} CLI，请先安装或切换主 Agent
            </div>
          )}
        </>
      );
    }
    return (
      <div className="leader-chat">
        <div ref={scrollRef} className="leader-messages">
          {messages.map(renderMessage)}
          {sending && (
            <div className="leader-msg leader-msg--assistant">
              {streamingTools.length > 0 && (
                <div className="leader-tools-inline">
                  {streamingTools.map((t, j) => <ToolChip key={j} tool={t} />)}
                </div>
              )}
              {streamingText ? (
                <div className="markdown-content"><ReactMarkdown>{streamingText}</ReactMarkdown></div>
              ) : (
                <div className="leader-status">{status || '思考中…'}<span className="ato-cursor">▍</span></div>
              )}
            </div>
          )}
        </div>
        <div className="leader-input-wrap">
          {renderInput()}
        </div>
      </div>
    );
  };

  return (
    <div className="leader-home">
      {renderDebugToggle()}
      {renderSessionPanel()}
      <div className="leader-main">
        <div className="leader-top-left">{renderPanelToggle()}</div>
        {renderPending()}
        {renderChat()}
      </div>
      {renderDebugPanel()}
    </div>
  );
}
