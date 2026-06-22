import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';
import type { RequestLog, Session, Vendor, APIService, Route } from '../../types';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { Pagination } from '../components/Pagination';
import { toast } from '../components/Toast';
import { SessionMigrationModal } from '../components/SessionMigrationModal';
import { SessionRouteBindingModal } from '../components/SessionRouteBindingModal';
import { ClearSessionsModal } from '../components/ClearSessionsModal';
import SessionDetailModal from '../components/SessionDetailModal';
import { cleanSessionTitle, extractChatMessagesFromLogs } from '../utils/session-chat-utils';
import { parseSSEChunks, assembleStreamText } from '../utils/log-utils';

dayjs.extend(relativeTime);

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

  // 搜索和筛选
  const [searchQuery, setSearchQuery] = useState('');
  const [appliedSearchQuery, setAppliedSearchQuery] = useState('');
  const [filterTargetType, setFilterTargetType] = useState('');
  const [filterVendorId, setFilterVendorId] = useState('');
  const [filterServiceId, setFilterServiceId] = useState('');
  const [filterModel, setFilterModel] = useState('');
  const [filterRouteId, setFilterRouteId] = useState('');

  // 筛选下拉选项数据
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [services, setServices] = useState<APIService[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);

  // 自动刷新
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [countdown, setCountdown] = useState(10);
  const [migrationSession, setMigrationSession] = useState<Session | null>(null);
  const [routeBindingSession, setRouteBindingSession] = useState<Session | null>(null);
  const [clearSessionsOpen, setClearSessionsOpen] = useState(false);

  // 用 ref 保存最新查询参数，供自动刷新/手动刷新/回车直接调用 loadSessions 时读取
  const paramsRef = useRef({
    sessionsPage, sessionsPageSize, appliedSearchQuery,
    filterTargetType, filterVendorId, filterServiceId, filterModel, filterRouteId,
  });
  paramsRef.current = {
    sessionsPage, sessionsPageSize, appliedSearchQuery,
    filterTargetType, filterVendorId, filterServiceId, filterModel, filterRouteId,
  };

  useEffect(() => {
    loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsPage, sessionsPageSize, appliedSearchQuery,
      filterTargetType, filterVendorId, filterServiceId, filterModel, filterRouteId]);

  useEffect(() => {
    loadFilterOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, sessionsPage, sessionsPageSize]);

  const loadFilterOptions = async () => {
    try {
      const [vendorsData, servicesData, routesData] = await Promise.all([
        api.getVendors(),
        api.getAPIServices(),
        api.getRoutes(),
      ]);
      setVendors(vendorsData);
      setServices(servicesData);
      setRoutes(routesData);
    } catch (error) {
      console.error('Failed to load filter options:', error);
    }
  };

  const loadSessions = async () => {
    const p = paramsRef.current;
    try {
      const offset = (p.sessionsPage - 1) * p.sessionsPageSize;
      const result = await api.getSessions({
        filters: {
          targetType: p.filterTargetType || undefined,
          vendorId: p.filterVendorId || undefined,
          serviceId: p.filterServiceId || undefined,
          model: p.filterModel || undefined,
          routeId: p.filterRouteId || undefined,
        },
        keyword: p.appliedSearchQuery.trim() || undefined,
        limit: p.sessionsPageSize,
        offset,
      });
      setSessions(result.sessions);
      setSessionsTotal(result.total);
    } catch (error) {
      console.error('Failed to load sessions:', error);
    }
  };

  const handleSessionClick = async (session: Session) => {
    setSelectedSession(session);
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

  // 筛选下拉联动
  const handleVendorChange = (vendorId: string) => {
    setFilterVendorId(vendorId);
    setFilterServiceId('');
    setFilterModel('');
    setSessionsPage(1);
  };
  const handleServiceChange = (serviceId: string) => {
    setFilterServiceId(serviceId);
    setFilterModel('');
    setSessionsPage(1);
  };
  const getFilteredServices = () => {
    if (!filterVendorId) return [];
    return services.filter(s => s.vendorId === filterVendorId);
  };
  const getAvailableModels = () => {
    if (!filterServiceId) return [];
    const service = services.find(s => s.id === filterServiceId);
    return service?.supportedModels || [];
  };
  const hasAnyFilter = !!(appliedSearchQuery || filterTargetType || filterVendorId || filterServiceId || filterModel || filterRouteId);
  const clearAllFilters = () => {
    setSearchQuery('');
    setAppliedSearchQuery('');
    setFilterTargetType('');
    setFilterVendorId('');
    setFilterServiceId('');
    setFilterModel('');
    setFilterRouteId('');
    setSessionsPage(1);
  };

  const exportSessionAsJson = (session: { id: string; title?: string; targetType: string; firstRequestAt: number; lastRequestAt: number; requestCount: number; totalTokens: number; model?: string; vendorName?: string; serviceName?: string }, logs: RequestLog[], viewMode: 'logs' | 'chat') => {
    const s = session;

    // 对话模式：导出对话数据
    if (viewMode === 'chat') {
      const chatMessages = extractChatMessagesFromLogs(logs);
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
    const exportLogs = logs.map((log, index) => {
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
      logs: exportLogs,
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

  const filterSelectStyle: React.CSSProperties = {
    padding: '6px 10px',
    borderRadius: '8px',
    border: '1px solid var(--border-primary)',
    background: 'var(--bg-card)',
    color: 'var(--text-primary)',
    minWidth: '140px',
  };
  const filterLabelStyle: React.CSSProperties = { fontWeight: 'bold', color: 'var(--text-primary)' };

  return (
    <div className="sessions-page">
      <div className="page-header">
        <div className="page-header-content">
          <div className="page-header-text">
            <h1>会话</h1>
            <p>查看和管理所有会话记录</p>
          </div>
          <button className="btn btn-danger" onClick={() => setClearSessionsOpen(true)}>清除会话</button>
        </div>
      </div>

      <div className="card">
        {/* 工具栏 */}
        <div className="toolbar">
          <h3>会话列表</h3>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
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

        {/* 筛选行：字段筛选 + 搜索框（位于末尾） */}
        <div style={{
          padding: '15px',
          background: 'var(--bg-secondary)',
          borderRadius: '12px',
          marginBottom: '20px',
          display: 'flex',
          gap: '15px',
          alignItems: 'center',
          flexWrap: 'wrap',
          border: '1px solid var(--border-primary)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label style={filterLabelStyle}>来源类型:</label>
            <select
              value={filterTargetType}
              onChange={(e) => { setFilterTargetType(e.target.value); setSessionsPage(1); }}
              style={filterSelectStyle}
            >
              <option value="">全部</option>
              <option value="claude-code">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label style={filterLabelStyle}>供应商:</label>
            <select
              value={filterVendorId}
              onChange={(e) => handleVendorChange(e.target.value)}
              style={filterSelectStyle}
            >
              <option value="">全部供应商</option>
              {vendors.map(vendor => (
                <option key={vendor.id} value={vendor.id}>{vendor.name}</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label style={filterLabelStyle}>API服务:</label>
            <select
              value={filterServiceId}
              onChange={(e) => handleServiceChange(e.target.value)}
              disabled={!filterVendorId}
              style={{
                ...filterSelectStyle,
                background: filterVendorId ? 'var(--bg-card)' : 'var(--bg-secondary)',
                cursor: filterVendorId ? 'pointer' : 'not-allowed',
                opacity: filterVendorId ? 1 : 0.6,
              }}
            >
              <option value="">全部服务</option>
              {getFilteredServices().map(service => (
                <option key={service.id} value={service.id}>{service.name}</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label style={filterLabelStyle}>模型:</label>
            <select
              value={filterModel}
              onChange={(e) => { setFilterModel(e.target.value); setSessionsPage(1); }}
              disabled={!filterServiceId}
              style={{
                ...filterSelectStyle,
                background: filterServiceId ? 'var(--bg-card)' : 'var(--bg-secondary)',
                cursor: filterServiceId ? 'pointer' : 'not-allowed',
                opacity: filterServiceId ? 1 : 0.6,
              }}
            >
              <option value="">全部模型</option>
              {getAvailableModels().map(model => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label style={filterLabelStyle}>路由:</label>
            <select
              value={filterRouteId}
              onChange={(e) => { setFilterRouteId(e.target.value); setSessionsPage(1); }}
              style={filterSelectStyle}
            >
              <option value="">全部路由</option>
              {routes.map(route => (
                <option key={route.id} value={route.id}>{route.name}</option>
              ))}
            </select>
          </div>

          {hasAnyFilter && (
            <button
              onClick={clearAllFilters}
              style={{
                padding: '6px 12px', borderRadius: '8px', cursor: 'pointer', fontSize: '14px',
                border: '1px solid var(--accent-danger)', background: 'var(--accent-danger)', color: 'white',
              }}
            >清除筛选</button>
          )}

          {/* 搜索框：跟在「清除筛选」之后，同一容器自然换行；点击「搜索」才发起请求 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              type="text"
              placeholder="搜索标题或ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setAppliedSearchQuery(searchQuery);
                  setSessionsPage(1);
                }
              }}
              style={{
                padding: '6px 12px',
                border: '1px solid var(--border-primary)',
                borderRadius: '8px',
                fontSize: '14px',
                width: '320px',
                background: 'var(--bg-card)',
                color: 'var(--text-primary)'
              }}
            />
            <button
              onClick={() => { setAppliedSearchQuery(searchQuery); setSessionsPage(1); }}
              style={{
                padding: '6px 16px', borderRadius: '8px', cursor: 'pointer', fontSize: '14px',
                border: 'none', background: 'var(--accent-primary, #3498db)', color: 'white',
              }}
            >搜索</button>
            {(searchQuery || appliedSearchQuery) && (
              <button
                onClick={() => { setSearchQuery(''); setAppliedSearchQuery(''); setSessionsPage(1); }}
                style={{
                  padding: '6px 12px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px',
                  border: '1px solid var(--border-primary)', background: 'var(--bg-card)', color: 'var(--text-primary)',
                }}
              >清空</button>
            )}
          </div>
        </div>

        {sessions.length === 0 ? (
          <div className="empty-state"><p>{hasAnyFilter ? '没有匹配的会话' : '暂无会话记录'}</p></div>
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
                {sessions.map((session) => (
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
                          onClick={(e) => { e.stopPropagation(); handleSessionClick(session); }}
                        >查看</button>
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={(e) => { e.stopPropagation(); setSelectedSession(session); setLogsLoading(true); api.getSessionLogs(session.id, 10000).then(logs => setSelectedSessionLogs(logs)).catch(console.error).finally(() => setLogsLoading(false)); }}
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
        <SessionDetailModal
          session={selectedSession}
          logs={selectedSessionLogs}
          logsLoading={logsLoading}
          onRefreshLogs={async () => {
            if (!selectedSession) return;
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
          onFetchNewLogs={async () => {
            if (!selectedSession) return [];
            const freshLogs = await api.getSessionLogs(selectedSession.id, 10000);
            setSelectedSessionLogs(freshLogs);
            return freshLogs;
          }}
          onClose={() => { setSelectedSession(null); setSelectedSessionLogs([]); }}
          onExport={exportSessionAsJson}
        />
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

      {/* 清除会话 Modal */}
      {clearSessionsOpen && (
        <ClearSessionsModal
          onClose={() => setClearSessionsOpen(false)}
          onCleared={() => { setSessionsPage(1); loadSessions(); }}
        />
      )}

    </div>
  );
}

export default SessionsPage;
