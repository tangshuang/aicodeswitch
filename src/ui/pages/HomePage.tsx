import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { api } from '../api/client';
import type { AtoChatMessage, AtoLeaderToolEvent } from '../../types';

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

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void api.atoLeaderHistory().then(setMessages).catch(() => { /* ignore */ });
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
  }, []);

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
        onError: () => { /* handled via final message */ },
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
    }
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

  const hasConversation = messages.length > 0 || sending;

  if (!hasConversation) {
    return (
      <div className="leader-home">
        {renderPending()}
        <div className="leader-empty">
          {renderInput()}
        </div>
        {toolAvailable === false && (
          <div className="leader-hint" style={{ color: 'var(--accent-danger)' }}>
            未检测到 {leaderTool === 'codex' ? 'Codex' : 'Claude Code'} CLI，请先安装或切换主 Agent
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="leader-home">
      {renderPending()}
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
    </div>
  );
}
