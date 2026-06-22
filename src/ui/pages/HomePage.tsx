import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { api } from '../api/client';
import { useConfirm } from '../components/Confirm';
import type { AtoChatMessage, AtoLeaderToolEvent, AtoLeaderSession, LeaderCliEntry } from '../../types';

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
          border: '1px solid var(--border-primary)', background: 'var(--bg-secondary)',
          cursor: 'pointer', color: 'var(--text-secondary)',
        }}
      >
        {open ? '▾' : '▸'} 🛠 {label}
      </button>
      {open && (
        <pre style={{
          margin: '4px 0 0', padding: 8, fontSize: 12, maxHeight: 200, overflow: 'auto',
          background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', borderRadius: 6,
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

function TerminalIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
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

function AgentBadge({ tool }: { tool: 'claude-code' | 'codex' }) {
  return (
    <span className={`leader-agent-badge leader-agent-badge--${tool}`}>
      {tool === 'codex' ? 'Codex' : 'Claude Code'}
    </span>
  );
}

/** 每条 agent 消息内嵌的 CLI 输出区：等宽终端风格，stdout 普通色 / stderr 红，stdout 行 best-effort JSON 美化 */
function CliOutput({ entries, live }: { entries: LeaderCliEntry[]; live?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 流式时自动贴底
    if (live && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [entries.length, live]);
  if (!entries.length) {
    return <div className="leader-cli-output leader-cli-output--empty">（无 CLI 输出）</div>;
  }
  return (
    <div className="leader-cli-output" ref={ref}>
      {entries.map((e, i) => {
        let text = e.t;
        if (e.s === 'stdout') {
          // stdout 行若是 JSON（如 claude stream-json）则美化，便于阅读；否则原样
          const trimmed = e.t.trim();
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
              const parsed = JSON.parse(trimmed);
              if (parsed && typeof parsed === 'object') text = JSON.stringify(parsed, null, 2);
            } catch { /* keep raw */ }
          }
        }
        return (
          <div key={i} className={`leader-cli-line${e.s === 'stderr' ? ' leader-cli-line--stderr' : ''}`}>
            {text}
          </div>
        );
      })}
    </div>
  );
}

export default function HomePage() {
  const [messages, setMessages] = useState<AtoChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamingTools, setStreamingTools] = useState<AtoLeaderToolEvent[]>([]);
  const [streamingCli, setStreamingCli] = useState<LeaderCliEntry[]>([]);
  const [streamStartTs, setStreamStartTs] = useState(0);
  const [status, setStatus] = useState('');
  const [leaderTool, setLeaderTool] = useState<'claude-code' | 'codex'>('claude-code');
  const [toolAvailable, setToolAvailable] = useState<boolean | null>(null);
  const [pendingPerms, setPendingPerms] = useState<Array<{ id: string; toolName: string; input: unknown; risk: string; reason?: string; createdAt: number }>>([]);

  // 每消息 CLI 区展开状态：历史消息用 ts 作 key（避免重载/切会话/删消息索引错位）；流式气泡单独一个布尔
  const [expandedCliTs, setExpandedCliTs] = useState<number | null>(null);
  const [streamingCliOpen, setStreamingCliOpenState] = useState(false);
  const streamingCliOpenRef = useRef(false);
  const setStreamingCliOpen = (v: boolean) => {
    streamingCliOpenRef.current = v;
    setStreamingCliOpenState(v);
  };

  // 流式累加 buffer（await 后读 state 是闭包旧值，故用 ref 保证完成消息拿到完整 tools/cli）
  const cliBufRef = useRef<LeaderCliEntry[]>([]);
  const toolBufRef = useRef<AtoLeaderToolEvent[]>([]);
  // 捕获 SSE error 帧（不抛异常，需主动记录才能在完成消息里展示）
  const errRef = useRef<string | null>(null);

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

    // 清空本轮 buffer 与流式状态
    cliBufRef.current = [];
    toolBufRef.current = [];
    errRef.current = null;
    setMessages((prev) => [...prev, { ts: Date.now(), role: 'user', content: text }]);
    setSending(true);
    setStreamingText('');
    setStreamingTools([]);
    setStreamingCli([]);
    setStreamingCliOpen(false);
    setStreamStartTs(Date.now());
    setStatus('思考中…');

    try {
      const full = await api.atoLeaderMessage(text, {
        onText: (delta) => setStreamingText((prev) => prev + delta),
        onTool: (e) => { toolBufRef.current.push(e); setStreamingTools((prev) => [...prev, e]); },
        onStatus: (s) => setStatus(s),
        onCli: (e) => { cliBufRef.current.push(e); setStreamingCli((prev) => [...prev, e]); },
        onError: (msg) => { errRef.current = msg; setStreamingCliOpen(true); },
      });
      const finalTs = Date.now();
      const capturedTools = toolBufRef.current;
      const capturedCli = cliBufRef.current;
      const errMsg = errRef.current;
      // SSE error 帧不抛异常，这里把错误写进完成消息（与后端持久化的 [错误] 内容一致）
      const content = errMsg ? `[错误] ${errMsg}` : (full || '(主 Agent 未返回内容)');
      setMessages((prev) => [
        ...prev,
        {
          ts: finalTs,
          role: 'assistant',
          content,
          tools: capturedTools.length > 0 ? capturedTools : undefined,
          leaderTool,
          cli: capturedCli.length > 0 ? capturedCli : undefined,
        },
      ]);
      // 流式 CLI 区若打开，或出错需排查，则展开完成的消息（用 ts 作 key）
      if (streamingCliOpenRef.current || errMsg) setExpandedCliTs(finalTs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const finalTs = Date.now();
      setMessages((prev) => [
        ...prev,
        {
          ts: finalTs,
          role: 'assistant',
          content: `⚠️ ${msg}`,
          leaderTool,
          cli: cliBufRef.current.length > 0 ? cliBufRef.current : undefined,
        },
      ]);
      // 出错时强制展开，便于查看 CLI 上下文排查
      setExpandedCliTs(finalTs);
    } finally {
      setSending(false);
      setStreamingText('');
      setStreamingTools([]);
      setStreamingCli([]);
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
      setStreamingCli([]);
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
      setStreamingCli([]);
      setExpandedCliTs(null);
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
        setStreamingCli([]);
        setExpandedCliTs(null);
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
            border: '1px solid var(--border-primary)', background: 'var(--bg-primary)',
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
          <div className="leader-msg-time leader-msg-time--user">{dayjs(m.ts).format('HH:mm')}</div>
        </div>
      );
    }
    const agentTool = m.leaderTool ?? leaderTool;
    const cliOpen = expandedCliTs === m.ts;
    return (
      <div key={i} className="leader-msg leader-msg--assistant">
        <div className="leader-msg-meta">
          <AgentBadge tool={agentTool} />
          <button
            className={`leader-cli-toggle${cliOpen ? ' is-open' : ''}${m.cli && m.cli.length > 0 ? ' has-output' : ''}`}
            onClick={() => setExpandedCliTs((prev) => (prev === m.ts ? null : m.ts))}
            title={cliOpen ? '收起 CLI 输出' : '查看 CLI 输出'}
          >
            <TerminalIcon />
            <span className="leader-cli-toggle-label">CLI</span>
            {m.cli && m.cli.length > 0 ? <span className="leader-cli-toggle-count">{m.cli.length}</span> : null}
            <span className="leader-cli-toggle-live" />
          </button>
          <span className="leader-msg-time">{dayjs(m.ts).format('HH:mm')}</span>
        </div>
        {m.tools && m.tools.length > 0 && (
          <div className="leader-tools-inline">
            {m.tools.map((t, j) => <ToolChip key={j} tool={t as AtoLeaderToolEvent} />)}
          </div>
        )}
        <div className="markdown-content"><ReactMarkdown>{m.content}</ReactMarkdown></div>
        {cliOpen && <CliOutput entries={m.cli ?? []} />}
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
              <div className="leader-msg-meta">
                <AgentBadge tool={leaderTool} />
                <button
                  className={`leader-cli-toggle${streamingCliOpen ? ' is-open' : ''}${streamingCli.length > 0 ? ' is-live' : ''}`}
                  onClick={() => setStreamingCliOpen(!streamingCliOpen)}
                  title={streamingCliOpen ? '收起实时 CLI 输出' : '查看实时 CLI 输出'}
                >
                  <TerminalIcon />
                  <span className="leader-cli-toggle-label">CLI</span>
                  {streamingCli.length > 0 ? <span className="leader-cli-toggle-count">{streamingCli.length}</span> : null}
                  <span className="leader-cli-toggle-live" />
                </button>
                <span className="leader-msg-time">{streamStartTs ? dayjs(streamStartTs).format('HH:mm') : ''}</span>
              </div>
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
              {streamingCliOpen && <CliOutput entries={streamingCli} live />}
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
      {renderSessionPanel()}
      <div className="leader-main">
        <div className="leader-top-left">{renderPanelToggle()}</div>
        {renderPending()}
        {renderChat()}
      </div>
    </div>
  );
}
