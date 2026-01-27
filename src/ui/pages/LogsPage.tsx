import { useState, useEffect, useMemo } from 'react';
import { api } from '../api/client';
import type { RequestLog, ErrorLog, Vendor, APIService, Session } from '../../types';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import JSONViewer from '../components/JSONViewer';
import { TARGET_TYPE } from '../constants';
import { Pagination } from '../components/Pagination';

dayjs.extend(relativeTime);

/**
 * 解析SSE事件行
 */
interface ParsedSSEEvent {
  event?: string;
  data?: any;
  raw: string;
}

function parseSSEChunks(chunks: string[]): ParsedSSEEvent[] {
  const events: ParsedSSEEvent[] = [];
  let currentEvent: { event?: string; dataLines: string[]; rawLines: string[] } = {
    dataLines: [],
    rawLines: []
  };

  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    for (const line of lines) {
      currentEvent.rawLines.push(line);

      if (!line.trim()) {
        // 空行表示事件结束
        if (currentEvent.event || currentEvent.dataLines.length > 0) {
          const eventData = currentEvent.dataLines.length > 0
            ? currentEvent.dataLines.join('\n')
            : undefined;
          const parsed: ParsedSSEEvent = {
            event: currentEvent.event,
            raw: currentEvent.rawLines.join('\n')
          };
          if (eventData) {
            try {
              parsed.data = JSON.parse(eventData);
            } catch {
              parsed.data = eventData;
            }
          }
          events.push(parsed);
        }
        currentEvent = { dataLines: [], rawLines: [] };
        continue;
      }

      if (line.startsWith('event:')) {
        currentEvent.event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        currentEvent.dataLines.push(line.slice(5).trim());
      }
    }
  }

  // 处理最后一个事件
  if (currentEvent.event || currentEvent.dataLines.length > 0) {
    const eventData = currentEvent.dataLines.length > 0
      ? currentEvent.dataLines.join('\n')
      : undefined;
    const parsed: ParsedSSEEvent = {
      event: currentEvent.event,
      raw: currentEvent.rawLines.join('\n')
    };
    if (eventData) {
      try {
        parsed.data = JSON.parse(eventData);
      } catch {
        parsed.data = eventData;
      }
    }
    events.push(parsed);
  }

  return events;
}

/**
 * 从解析的SSE事件中组装完整文本
 * 返回 { text, thinking } 结构
 */
function assembleStreamText(events: ParsedSSEEvent[], _targetType?: string): { text: string; thinking: string } {
  let text = '';
  let thinking = '';
  let inThinkingBlock = false;
  let inTextBlock = false;

  for (const event of events) {
    const data = event.data;
    if (!data) continue;

    // 处理Claude格式 (用于claude-code客户端)
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

    // 处理OpenAI格式 (用于codex客户端)
    if (!event.event && data.choices) {
      const delta = data.choices?.[0]?.delta;
      if (delta) {
        if (typeof delta.content === 'string') {
          text += delta.content;
        }
        // 某些OpenAI兼容API可能使用thinking字段
        if (delta.thinking && typeof delta.thinking.content === 'string') {
          thinking += delta.thinking.content;
        }
      }
    }

    // 处理直接包含thinking的数据（DeepSeek等）
    if (data.reasoning_content || data.thinking) {
      thinking += data.reasoning_content || data.thinking || '';
    }
  }

  return { text, thinking };
}

/**
 * 从stream chunks组装完整文本
 */
function assembleStreamTextFromChunks(chunks: string[] | undefined, targetType?: string): { text: string; thinking: string } {
  if (!chunks || chunks.length === 0) {
    return { text: '', thinking: '' };
  }

  const events = parseSSEChunks(chunks);
  return assembleStreamText(events, targetType);
}

type LogTab = 'request' | 'error' | 'sessions';

function LogsPage() {
  const [activeTab, setActiveTab] = useState<LogTab>('request');
  const [requestLogs, setRequestLogs] = useState<RequestLog[]>([]);
  const [errorLogs, setErrorLogs] = useState<ErrorLog[]>([]);
  const [selectedRequestLog, setSelectedRequestLog] = useState<RequestLog | null>(null);
  const [selectedErrorLog, setSelectedErrorLog] = useState<ErrorLog | null>(null);
  const [chunksExpanded, setChunksExpanded] = useState<boolean>(false);
  const [assembledTextExpanded, setAssembledTextExpanded] = useState<boolean>(true);

  // Sessions 相关状态
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [selectedSessionLogs, setSelectedSessionLogs] = useState<RequestLog[]>([]);
  const [sessionsTotal, setSessionsTotal] = useState(0);
  const [sessionsPage, setSessionsPage] = useState(1);
  const [sessionsPageSize, setSessionsPageSize] = useState(20);
  const [logsLoading, setLogsLoading] = useState(false);

  // 分页状态
  const [requestLogsPage, setRequestLogsPage] = useState(1);
  const [requestLogsPageSize, setRequestLogsPageSize] = useState(20);
  const [requestLogsTotal, setRequestLogsTotal] = useState(0);

  const [errorLogsPage, setErrorLogsPage] = useState(1);
  const [errorLogsPageSize, setErrorLogsPageSize] = useState(20);
  const [errorLogsTotal, setErrorLogsTotal] = useState(0);

  const [loading, setLoading] = useState(false);

  // 自动刷新相关状态
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [countdown, setCountdown] = useState(10);

  // 筛选器相关state
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [services, setServices] = useState<APIService[]>([]);
  const [filterTargetType, setFilterTargetType] = useState<string>('');
  const [filterVendorId, setFilterVendorId] = useState<string>('');
  const [filterServiceId, setFilterServiceId] = useState<string>('');
  const [filterModel, setFilterModel] = useState<string>('');

  useEffect(() => {
    loadLogs();
  }, [activeTab, requestLogsPage, requestLogsPageSize, errorLogsPage, errorLogsPageSize, sessionsPage, sessionsPageSize]);

  useEffect(() => {
    loadVendorsAndServices();
    loadAllCounts();
  }, []);

  // 自动刷新倒计时逻辑
  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null;
    let countdownId: NodeJS.Timeout | null = null;

    if (autoRefresh) {
      // 设置倒计时显示
      countdownId = setInterval(() => {
        setCountdown(prev => {
          if (prev <= 1) {
            // 倒计时结束，重置并刷新
            return 10;
          }
          return prev - 1;
        });
      }, 1000);

      // 每10秒刷新一次数据
      intervalId = setInterval(() => {
        loadLogs();
        loadAllCounts();
      }, 10000);
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
      if (countdownId) clearInterval(countdownId);
    };
  }, [autoRefresh, activeTab, requestLogsPage, requestLogsPageSize, errorLogsPage, errorLogsPageSize, sessionsPage, sessionsPageSize]);

  const loadLogs = async () => {
    setLoading(true);
    try {
      if (activeTab === 'request') {
        const offset = (requestLogsPage - 1) * requestLogsPageSize;
        const [data, countResult] = await Promise.all([
          api.getLogs(requestLogsPageSize, offset),
          api.getLogsCount()
        ]);
        setRequestLogs(data);
        setRequestLogsTotal(countResult.count);
      } else if (activeTab === 'error') {
        const offset = (errorLogsPage - 1) * errorLogsPageSize;
        const [data, countResult] = await Promise.all([
          api.getErrorLogs(errorLogsPageSize, offset),
          api.getErrorLogsCount()
        ]);
        setErrorLogs(data);
        setErrorLogsTotal(countResult.count);
      } else if (activeTab === 'sessions') {
        const offset = (sessionsPage - 1) * sessionsPageSize;
        const [data, countResult] = await Promise.all([
          api.getSessions(sessionsPageSize, offset),
          api.getSessionsCount()
        ]);
        setSessions(data);
        setSessionsTotal(countResult.count);
      }
    } catch (error) {
      console.error('Failed to load logs:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadVendorsAndServices = async () => {
    try {
      const [vendorsData, servicesData] = await Promise.all([
        api.getVendors(),
        api.getAPIServices()
      ]);
      setVendors(vendorsData);
      setServices(servicesData);
    } catch (error) {
      console.error('Failed to load vendors and services:', error);
    }
  };

  const loadAllCounts = async () => {
    try {
      const [requestCount, errorCount, sessionsCount] = await Promise.all([
        api.getLogsCount(),
        api.getErrorLogsCount(),
        api.getSessionsCount()
      ]);
      setRequestLogsTotal(requestCount.count);
      setErrorLogsTotal(errorCount.count);
      setSessionsTotal(sessionsCount.count);
    } catch (error) {
      console.error('Failed to load counts:', error);
    }
  };

  const handleClearLogs = async () => {
    const logTypeMap = {
      request: '请求日志',
      access: '访问日志',
      error: '错误日志',
      sessions: '会话'
    };

    const logType = logTypeMap[activeTab];
    const warningMessage = `确定要清空所有${logType}吗?\n\n⚠️ 警告:\n1. 此操作将永久删除所有${logType}记录\n2. 相关的统计数据也会被清空\n3. 此操作不可撤销\n\n是否继续?`;

    if (confirm(warningMessage)) {
      if (activeTab === 'request') {
        await api.clearLogs();
        setRequestLogs([]);
        setSelectedRequestLog(null);
        setRequestLogsPage(1);
        setRequestLogsTotal(0);
      } else if (activeTab === 'error') {
        await api.clearErrorLogs();
        setErrorLogs([]);
        setSelectedErrorLog(null);
        setErrorLogsPage(1);
        setErrorLogsTotal(0);
      } else if (activeTab === 'sessions') {
        await api.clearSessions();
        setSessions([]);
        setSelectedSession(null);
        setSelectedSessionLogs([]);
        setSessionsPage(1);
        setSessionsTotal(0);
      }
    }
  };

  const getStatusBadge = (statusCode: number | undefined) => {
    if (!statusCode) return 'badge-danger';
    if (statusCode >= 200 && statusCode < 300) return 'badge-success';
    if (statusCode >= 400 && statusCode < 500) return 'badge-warning';
    return 'badge-danger';
  };

  // 筛选相关函数
  const handleVendorChange = (vendorId: string) => {
    setFilterVendorId(vendorId);
    setFilterServiceId(''); // 重置服务选择
    setFilterModel(''); // 重置模型选择
  };

  const handleServiceChange = (serviceId: string) => {
    setFilterServiceId(serviceId);
    setFilterModel(''); // 重置模型选择
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

  const filterRequestLogs = (logs: RequestLog[]) => {
    return logs.filter(log => {
      if (filterTargetType && log.targetType !== filterTargetType) return false;
      if (filterVendorId && log.vendorId !== filterVendorId) return false;
      if (filterServiceId && log.targetServiceId !== filterServiceId) return false;
      if (filterModel && log.targetModel !== filterModel) return false;
      return true;
    });
  };

  const filteredRequestLogs = filterRequestLogs(requestLogs);

  // 分页回调函数
  const handleRequestLogsPageChange = (page: number) => {
    setRequestLogsPage(page);
  };

  const handleRequestLogsPageSizeChange = (size: number) => {
    setRequestLogsPageSize(size);
    setRequestLogsPage(1); // 重置到第1页
  };

  const handleErrorLogsPageChange = (page: number) => {
    setErrorLogsPage(page);
  };

  const handleErrorLogsPageSizeChange = (size: number) => {
    setErrorLogsPageSize(size);
    setErrorLogsPage(1);
  };

  // Sessions 相关函数
  const handleSessionsPageChange = (page: number) => {
    setSessionsPage(page);
  };

  const handleSessionsPageSizeChange = (size: number) => {
    setSessionsPageSize(size);
    setSessionsPage(1);
  };

  const handleSessionClick = async (session: Session) => {
    setSelectedSession(session);
    setLogsLoading(true);
    try {
      const logs = await api.getSessionLogs(session.id, 100);
      setSelectedSessionLogs(logs);
    } catch (error) {
      console.error('Failed to load session logs:', error);
    } finally {
      setLogsLoading(false);
    }
  };

  const formatDuration = (startTime: number, endTime: number) => {
    const duration = endTime - startTime;
    if (duration < 60000) {
      return `${Math.floor(duration / 1000)}秒`;
    } else if (duration < 3600000) {
      return `${Math.floor(duration / 60000)}分钟`;
    } else {
      return `${Math.floor(duration / 3600000)}小时`;
    }
  };

  const getTargetTypeBadge = (targetType: string) => {
    if (targetType === 'claude-code') {
      return <span className="badge badge-claude-code">Claude Code</span>;
    } else if (targetType === 'codex') {
      return <span className="badge badge-codex">Codex</span>;
    }
    return <span className="badge">{targetType}</span>;
  };

  const renderSessions = () => {
    if (sessions.length === 0) {
      return <div className="empty-state"><p>暂无会话记录</p></div>;
    }

    return (
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
                {session.title || session.id.slice(0, 8)}
              </td>
              <td>{getTargetTypeBadge(session.targetType)}</td>
              <td>{session.requestCount}</td>
              <td>{session.totalTokens.toLocaleString()}</td>
              <td>{dayjs(session.firstRequestAt).format('MM-DD HH:mm')}</td>
              <td>{dayjs(session.lastRequestAt).format('MM-DD HH:mm')}</td>
              <td>{formatDuration(session.firstRequestAt, session.lastRequestAt)}</td>
              <td>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSessionClick(session);
                  }}
                >
                  查看
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  const renderRequestLogs = () => {
    if (filteredRequestLogs.length === 0) {
      return <div className="empty-state"><p>暂无请求日志</p></div>;
    }

    return (
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>客户端类型</th>
            <th>路径</th>
            <th>状态</th>
            <th>响应时间</th>
            <th>Tokens信息</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {filteredRequestLogs.map((log) => (
            <tr key={log.id}>
              <td>{dayjs(log.timestamp).format('YYYY-MM-DD HH:mm:ss')}</td>
              <td>
                {TARGET_TYPE[log.targetType!] ? (
                  <span className={`badge ${log.targetType === 'claude-code' ? 'badge-claude-code' : log.targetType === 'codex' ? 'badge-codex' : 'badge-info'}`}>
                    {TARGET_TYPE[log.targetType!]}
                  </span>
                ) : '-'}
              </td>
              <td>{log.path}</td>
              <td>
                <span className={`badge ${getStatusBadge(log.statusCode)}`}>
                  {log.statusCode || 'Error'}
                </span>
              </td>
              <td>{log.responseTime ? `${log.responseTime}ms` : '-'}</td>
              <td>
                {log.usage ? (
                  <span>
                    {log.usage.totalTokens ? log.usage.totalTokens : log.usage.inputTokens + log.usage.outputTokens} tokens
                  </span>
                ) : '-'}
              </td>
              <td>
                <button className="btn btn-secondary" onClick={() => setSelectedRequestLog(log)}>详情</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  const renderErrorLogs = () => {
    if (errorLogs.length === 0) {
      return <div className="empty-state"><p>暂无错误日志</p></div>;
    }

    return (
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>方法</th>
            <th>路径</th>
            <th>状态</th>
            <th>错误信息</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {errorLogs.map((log) => (
            <tr key={log.id}>
              <td>{dayjs(log.timestamp).format('YYYY-MM-DD HH:mm:ss')}</td>
              <td><span className="badge badge-danger">{log.method}</span></td>
              <td>{log.path}</td>
              <td>
                <span className="badge badge-danger">
                  {log.statusCode || '-'}
                </span>
              </td>
              <td style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#e74c3c' }}>
                {log.errorMessage}
              </td>
              <td>
                <button className="btn btn-secondary" onClick={() => setSelectedErrorLog(log)}>详情</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  return (
    <div>
      <div className="page-header">
        <h1>日志</h1>
        <p>查看所有API请求日志</p>
      </div>

      <div className="card">
        <div style={{ borderBottom: '1px solid #ecf0f1', marginBottom: '20px' }}>
          <div style={{ display: 'flex', gap: '0' }}>
            <button
              onClick={() => setActiveTab('request')}
              style={{
                padding: '12px 24px',
                border: 'none',
                background: activeTab === 'request' ? '#3498db' : 'transparent',
                color: activeTab === 'request' ? 'white' : '#7f8c8d',
                cursor: 'pointer',
                borderBottom: activeTab === 'request' ? '2px solid #2980b9' : '2px solid transparent',
                fontWeight: activeTab === 'request' ? 'bold' : 'normal',
              }}
            >
              请求日志 ({requestLogsTotal})
            </button>
            <button
              onClick={() => setActiveTab('error')}
              style={{
                padding: '12px 24px',
                border: 'none',
                background: activeTab === 'error' ? '#e74c3c' : 'transparent',
                color: activeTab === 'error' ? 'white' : '#7f8c8d',
                cursor: 'pointer',
                borderBottom: activeTab === 'error' ? '2px solid #c0392b' : '2px solid transparent',
                fontWeight: activeTab === 'error' ? 'bold' : 'normal',
              }}
            >
              错误日志 ({errorLogsTotal})
            </button>
            <button
              onClick={() => setActiveTab('sessions')}
              style={{
                padding: '12px 24px',
                border: 'none',
                background: activeTab === 'sessions' ? '#9b59b6' : 'transparent',
                color: activeTab === 'sessions' ? 'white' : '#7f8c8d',
                cursor: 'pointer',
                borderBottom: activeTab === 'sessions' ? '2px solid #8e44ad' : '2px solid transparent',
                fontWeight: activeTab === 'sessions' ? 'bold' : 'normal',
              }}
            >
              会话 ({sessionsTotal})
            </button>
          </div>
        </div>

        <div className="toolbar">
          <h3>
            {activeTab === 'error' && '错误日志列表'}
            {activeTab === 'request' && '请求日志列表'}
            {activeTab === 'sessions' && '会话列表'}
          </h3>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '0 12px', background: 'var(--bg-secondary)', borderRadius: '8px' }}>
              <input
                type="checkbox"
                id="auto-refresh"
                checked={autoRefresh}
                onChange={(e) => {
                  setAutoRefresh(e.target.checked);
                  if (e.target.checked) {
                    setCountdown(10);
                  }
                }}
                style={{ cursor: 'pointer' }}
              />
              <label
                htmlFor="auto-refresh"
                style={{ cursor: 'pointer', fontSize: '14px', color: 'var(--text-primary)', userSelect: 'none' }}
              >
                自动刷新 {autoRefresh && `(⏱ ${countdown}s)`}
              </label>
            </div>
            <button className="btn btn-primary" onClick={() => { loadLogs(); loadAllCounts(); setCountdown(10); }}>刷新</button>
            <button className="btn btn-danger" onClick={handleClearLogs}>清空日志</button>
          </div>
        </div>

        {/* 筛选器 - 仅在请求日志tab显示 */}
        {activeTab === 'request' && (
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
              <label style={{ fontWeight: 'bold', minWidth: '80px', color: 'var(--text-primary)' }}>来源类型:</label>
              <select
                value={filterTargetType}
                onChange={(e) => setFilterTargetType(e.target.value)}
                style={{
                  padding: '6px 10px',
                  borderRadius: '8px',
                  border: '1px solid var(--border-primary)',
                  background: 'var(--bg-card)',
                  color: 'var(--text-primary)'
                }}
              >
                <option value="">全部</option>
                <option value="claude-code">Claude Code</option>
                <option value="codex">Codex</option>
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <label style={{ fontWeight: 'bold', minWidth: '80px', color: 'var(--text-primary)' }}>供应商:</label>
              <select
                value={filterVendorId}
                onChange={(e) => handleVendorChange(e.target.value)}
                style={{
                  padding: '6px 10px',
                  borderRadius: '8px',
                  border: '1px solid var(--border-primary)',
                  minWidth: '150px',
                  background: 'var(--bg-card)',
                  color: 'var(--text-primary)'
                }}
              >
                <option value="">全部供应商</option>
                {vendors.map(vendor => (
                  <option key={vendor.id} value={vendor.id}>{vendor.name}</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <label style={{ fontWeight: 'bold', minWidth: '80px', color: 'var(--text-primary)' }}>API服务:</label>
              <select
                value={filterServiceId}
                onChange={(e) => handleServiceChange(e.target.value)}
                disabled={!filterVendorId}
                style={{
                  padding: '6px 10px',
                  borderRadius: '8px',
                  border: '1px solid var(--border-primary)',
                  minWidth: '150px',
                  background: filterVendorId ? 'var(--bg-card)' : 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  cursor: filterVendorId ? 'pointer' : 'not-allowed',
                  opacity: filterVendorId ? 1 : 0.6
                }}
              >
                <option value="">全部服务</option>
                {getFilteredServices().map(service => (
                  <option key={service.id} value={service.id}>{service.name}</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <label style={{ fontWeight: 'bold', minWidth: '80px', color: 'var(--text-primary)' }}>模型:</label>
              <select
                value={filterModel}
                onChange={(e) => setFilterModel(e.target.value)}
                disabled={!filterServiceId}
                style={{
                  padding: '6px 10px',
                  borderRadius: '8px',
                  border: '1px solid var(--border-primary)',
                  minWidth: '150px',
                  background: filterServiceId ? 'var(--bg-card)' : 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  cursor: filterServiceId ? 'pointer' : 'not-allowed',
                  opacity: filterServiceId ? 1 : 0.6
                }}
              >
                <option value="">全部模型</option>
                {getAvailableModels().map(model => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
            </div>

            {(filterTargetType || filterVendorId || filterServiceId || filterModel) && (
              <button
                onClick={() => {
                  setFilterTargetType('');
                  setFilterVendorId('');
                  setFilterServiceId('');
                  setFilterModel('');
                }}
                style={{
                  padding: '6px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--accent-danger)',
                  background: 'var(--accent-danger)',
                  color: 'white',
                  cursor: 'pointer',
                  fontSize: '14px'
                }}
              >
                清除筛选
              </button>
            )}

            <div style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: '14px' }}>
              显示 {filteredRequestLogs.length} / {requestLogs.length} 条
            </div>
          </div>
        )}

        {activeTab === 'request' && (
          <>
            {loading ? (
              <div className="empty-state"><p>加载中...</p></div>
            ) : (
              renderRequestLogs()
            )}
            {!loading && (
              <Pagination
                currentPage={requestLogsPage}
                totalItems={requestLogsTotal}
                pageSize={requestLogsPageSize}
                onPageChange={handleRequestLogsPageChange}
                onPageSizeChange={handleRequestLogsPageSizeChange}
              />
            )}
          </>
        )}
        {activeTab === 'error' && (
          <>
            {loading ? (
              <div className="empty-state"><p>加载中...</p></div>
            ) : (
              renderErrorLogs()
            )}
            {!loading && (
              <Pagination
                currentPage={errorLogsPage}
                totalItems={errorLogsTotal}
                pageSize={errorLogsPageSize}
                onPageChange={handleErrorLogsPageChange}
                onPageSizeChange={handleErrorLogsPageSizeChange}
              />
            )}
          </>
        )}
        {activeTab === 'sessions' && (
          <>
            {loading ? (
              <div className="empty-state"><p>加载中...</p></div>
            ) : (
              renderSessions()
            )}
            {!loading && (
              <Pagination
                currentPage={sessionsPage}
                totalItems={sessionsTotal}
                pageSize={sessionsPageSize}
                onPageChange={handleSessionsPageChange}
                onPageSizeChange={handleSessionsPageSizeChange}
              />
            )}
          </>
        )}
      </div>

      {selectedRequestLog && (
        <div className="modal-overlay" style={{ zIndex: selectedSession ? 1100 : 1000 }}>
          <button
            type="button"
            className="modal-close-btn"
            onClick={() => setSelectedRequestLog(null)}
            aria-label="关闭"
            style={{ zIndex: selectedSession ? 1101 : 1001 }}
          >
            ×
          </button>
          <div className="modal" style={{ width: '800px', zIndex: selectedSession ? 1100 : 1000 }}>
            <div className="modal-container">
              <div className="modal-header">
                <h2>请求详情</h2>
              </div>
            <div>
              <div className="form-group">
                <label>日志ID</label>
                <input type="text" value={selectedRequestLog.id} readOnly />
              </div>
              <div className="form-group">
                <label>时间</label>
                <input type="text" value={dayjs(selectedRequestLog.timestamp).format('YYYY-MM-DD HH:mm:ss')} readOnly />
              </div>
              {selectedRequestLog.targetType && (
                <div className="form-group">
                  <label>客户端类型</label>
                  <input type="text" value={TARGET_TYPE[selectedRequestLog.targetType] || '-'} readOnly />
                </div>
              )}
              {selectedRequestLog.requestModel && (
                <div className="form-group">
                  <label>请求模型</label>
                  <input type="text" value={selectedRequestLog.requestModel} readOnly />
                </div>
              )}
              {selectedRequestLog.vendorName && (
                <div className="form-group">
                  <label>供应商</label>
                  <input type="text" value={selectedRequestLog.vendorName} readOnly />
                </div>
              )}
              {selectedRequestLog.targetServiceName && (
                <div className="form-group">
                  <label>供应商API服务</label>
                  <input type="text" value={selectedRequestLog.targetServiceName} readOnly />
                </div>
              )}
              {selectedRequestLog.targetModel && (
                <div className="form-group">
                  <label>供应商模型</label>
                  <input type="text" value={selectedRequestLog.targetModel} readOnly />
                </div>
              )}
              <div className="form-group">
                <label>请求方法</label>
                <input type="text" value={selectedRequestLog.method} readOnly />
              </div>
              <div className="form-group">
                <label>请求路径</label>
                <input type="text" value={selectedRequestLog.path} readOnly />
              </div>
              {selectedRequestLog.headers && (
                <div className="form-group">
                  <label>请求头</label>
                  <JSONViewer data={selectedRequestLog.headers} collapsed />
                </div>
              )}
              {selectedRequestLog.body && (
                <div className="form-group">
                  <label>请求体</label>
                  <JSONViewer data={selectedRequestLog.body} />
                </div>
              )}
              {selectedRequestLog.upstreamRequest && (
                <div className="form-group">
                  <label>实际转发信息</label>
                  <JSONViewer data={selectedRequestLog.upstreamRequest} />
                </div>
              )}
              <div className="form-group">
                <label>状态码</label>
                <input type="text" value={selectedRequestLog.statusCode || 'Error'} readOnly />
              </div>
              <div className="form-group">
                <label>响应时间</label>
                <input type="text" value={selectedRequestLog.responseTime ? `${selectedRequestLog.responseTime}ms` : '-'} readOnly />
              </div>
              {selectedRequestLog.responseHeaders && (
                <div className="form-group">
                  <label>响应头</label>
                  <JSONViewer data={selectedRequestLog.responseHeaders} collapsed />
                </div>
              )}
              {selectedRequestLog.responseBody && (
                <div className="form-group">
                  <label>响应体</label>
                  <JSONViewer data={selectedRequestLog.responseBody} />
                </div>
              )}
              {selectedRequestLog.streamChunks && selectedRequestLog.streamChunks.length > 0 && (
                <div className="form-group">
                  <label>
                    Stream Chunks ({selectedRequestLog.streamChunks.length}个)
                    <button
                      onClick={() => setChunksExpanded(!chunksExpanded)}
                      style={{ marginLeft: '10px', padding: '2px 8px', fontSize: '12px' }}
                      className='btn btn-sm btn-secondary'
                    >
                      {chunksExpanded ? '折叠' : '展开'}
                    </button>
                    <button
                      onClick={() => setAssembledTextExpanded(!assembledTextExpanded)}
                      style={{ marginLeft: '5px', padding: '2px 8px', fontSize: '12px' }}
                      className='btn btn-sm btn-primary'
                    >
                      {assembledTextExpanded ? '隐藏拼装结果' : '查看拼装结果'}
                    </button>
                  </label>
                  {chunksExpanded && (
                    <div style={{ maxHeight: '400px', overflowY: 'auto', border: '1px solid #ddd', padding: '10px', borderRadius: '4px' }}>
                      {selectedRequestLog.streamChunks.map((chunk, index) => (
                        <div key={index} style={{ marginBottom: '10px' }}>
                          <div style={{ fontWeight: 'bold', fontSize: '12px', color: '#7f8c8d', marginBottom: '4px' }}>
                            Chunk #{index + 1}
                          </div>
                          <JSONViewer data={chunk} collapsed={true} />
                        </div>
                      ))}
                    </div>
                  )}
                  {assembledTextExpanded && (
                    <div style={{
                      marginTop: '10px',
                      maxHeight: '400px',
                      overflowY: 'auto',
                      border: '1px solid #ddd',
                      padding: '10px',
                      borderRadius: '4px',
                      backgroundColor: '#f8f9fa'
                    }}>
                      <AssembledTextView chunks={selectedRequestLog.streamChunks} targetType={selectedRequestLog.targetType} />
                    </div>
                  )}
                </div>
              )}
              {selectedRequestLog.usage && (
                <div className="form-group">
                  <label>Token 使用</label>
                  <textarea
                    rows={4}
                    value={
                      `输入: ${selectedRequestLog.usage.inputTokens}\n` +
                      `输出: ${selectedRequestLog.usage.outputTokens}\n` +
                      (selectedRequestLog.usage.totalTokens !== undefined ? `总计: ${selectedRequestLog.usage.totalTokens}\n` : '') +
                      (selectedRequestLog.usage.cacheReadInputTokens !== undefined ? `缓存读取: ${selectedRequestLog.usage.cacheReadInputTokens}` : '')
                    }
                    readOnly
                  />
                </div>
              )}
              {selectedRequestLog.error && (
                <div className="form-group">
                  <label>错误信息</label>
                  <textarea rows={4} value={selectedRequestLog.error} readOnly style={{ color: 'red' }} />
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setSelectedRequestLog(null)}>关闭</button>
            </div>
            </div>
          </div>
        </div>
      )}

      {selectedErrorLog && (
        <div className="modal-overlay" style={{ zIndex: selectedSession ? 1100 : 1000 }}>
          <button
            type="button"
            className="modal-close-btn"
            onClick={() => setSelectedErrorLog(null)}
            aria-label="关闭"
            style={{ zIndex: selectedSession ? 1101 : 1001 }}
          >
            ×
          </button>
          <div className="modal" style={{ minWidth: '600px', zIndex: selectedSession ? 1100 : 1000 }}>
            <div className="modal-container">
              <div className="modal-header">
                <h2>错误日志详情</h2>
              </div>
            <div>
              <div className="form-group">
                <label>ID</label>
                <input type="text" value={selectedErrorLog.id} readOnly />
              </div>
              <div className="form-group">
                <label>时间</label>
                <input type="text" value={dayjs(selectedErrorLog.timestamp).format('YYYY-MM-DD HH:mm:ss')} readOnly />
              </div>
              <div className="form-group">
                <label>请求方法</label>
                <input type="text" value={selectedErrorLog.method} readOnly />
              </div>
              <div className="form-group">
                <label>请求路径</label>
                <input type="text" value={selectedErrorLog.path} readOnly />
              </div>
              <div className="form-group">
                <label>状态码</label>
                <input type="text" value={selectedErrorLog.statusCode || '-'} readOnly />
              </div>
              <div className="form-group">
                <label>响应时间</label>
                <input type="text" value={selectedErrorLog.responseTime ? `${selectedErrorLog.responseTime}ms` : '-'} readOnly />
              </div>
              <div className="form-group">
                <label>错误信息</label>
                <textarea rows={4} value={selectedErrorLog.errorMessage} readOnly style={{ color: '#e74c3c' }} />
              </div>
              {selectedErrorLog.errorStack && (
                <div className="form-group">
                  <label>错误堆栈</label>
                  <textarea rows={8} value={selectedErrorLog.errorStack} readOnly style={{ fontSize: '12px', color: '#7f8c8d' }} />
                </div>
              )}
              {selectedErrorLog.requestBody && (
                <div className="form-group">
                  <label>请求体</label>
                  <JSONViewer data={selectedErrorLog.requestBody} />
                </div>
              )}
              {selectedErrorLog.requestHeaders && (
                <div className="form-group">
                  <label>请求头</label>
                  <JSONViewer data={selectedErrorLog.requestHeaders} />
                </div>
              )}
              {selectedErrorLog.responseHeaders && (
                <div className="form-group">
                  <label>响应头</label>
                  <JSONViewer data={selectedErrorLog.responseHeaders} collapsed />
                </div>
              )}
              {selectedErrorLog.responseBody && (
                <div className="form-group">
                  <label>响应体</label>
                  <JSONViewer data={selectedErrorLog.responseBody} />
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setSelectedErrorLog(null)}>关闭</button>
            </div>
            </div>
          </div>
        </div>
      )}

      {selectedSession && (
        <div className="modal-overlay">
          <button
            type="button"
            className="modal-close-btn"
            onClick={() => {
              setSelectedSession(null);
              setSelectedSessionLogs([]);
            }}
            aria-label="关闭"
          >
            ×
          </button>
          <div className="modal" style={{ width: '900px', maxWidth: '90vw' }}>
            <div className="modal-container">
              <div className="modal-header">
                <h2>会话详情</h2>
              </div>
              <div>
                <div className="form-group">
                  <label>会话ID</label>
                  <input type="text" value={selectedSession.id} readOnly />
                </div>
                <div className="form-group">
                  <label>标题</label>
                  <input type="text" value={selectedSession.title || '(无标题)'} readOnly />
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
                  <div style={{ maxHeight: '400px', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                    <table style={{ fontSize: '14px' }}>
                      <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-card)' }}>
                        <tr>
                          <th>时间</th>
                          <th>状态</th>
                          <th>响应时间</th>
                          <th>Tokens</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedSessionLogs.map((log) => (
                          <tr key={log.id}>
                            <td>{dayjs(log.timestamp).format('HH:mm:ss')}</td>
                            <td>
                              <span className={`badge ${getStatusBadge(log.statusCode)}`}>
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
                              <button
                                className="btn btn-sm btn-secondary"
                                onClick={() => setSelectedRequestLog(log)}
                              >
                                详情
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => {
                  setSelectedSession(null);
                  setSelectedSessionLogs([]);
                }}>关闭</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 拼装文本展示组件
 */
interface AssembledTextViewProps {
  chunks: string[];
  targetType?: string;
}

function AssembledTextView({ chunks, targetType }: AssembledTextViewProps) {
  const { text, thinking } = useMemo(() => assembleStreamTextFromChunks(chunks, targetType), [chunks, targetType]);

  if (!text && !thinking) {
    return <div style={{ color: '#7f8c8d', fontStyle: 'italic' }}>无法解析出文本内容</div>;
  }

  return (
    <div className="assembled-text-view">
      {thinking && (
        <details
          style={{
            marginBottom: '15px',
            border: '1px solid #e0e0e0',
            borderRadius: '8px',
            padding: '10px',
            backgroundColor: '#fff9e6'
          }}
          open
        >
          <summary
            style={{
              cursor: 'pointer',
              fontWeight: 'bold',
              color: '#f39c12',
              userSelect: 'none'
            }}
          >
            思考内容 ({thinking.length} 字符)
          </summary>
          <pre
            style={{
              marginTop: '10px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'monospace',
              fontSize: '13px',
              color: '#555',
              backgroundColor: '#fff',
              padding: '10px',
              borderRadius: '4px',
              border: '1px solid #f0e6d3'
            }}
          >
            {thinking}
          </pre>
        </details>
      )}
      {text && (
        <div>
          <div style={{ fontWeight: 'bold', marginBottom: '8px', color: '#333' }}>
            回复内容 ({text.length} 字符)
          </div>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'monospace',
              fontSize: '13px',
              color: '#333',
              backgroundColor: '#fff',
              padding: '10px',
              borderRadius: '4px',
              border: '1px solid #ddd'
            }}
          >
            {text}
          </pre>
        </div>
      )}
    </div>
  );
}

export default LogsPage;
