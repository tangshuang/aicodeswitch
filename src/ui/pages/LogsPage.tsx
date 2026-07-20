import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';
import type { RequestLog, ErrorLog, Vendor, APIService, Route } from '../../types';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { TARGET_TYPE } from '../constants';
import { Pagination } from '../components/Pagination';
import { useConfirm } from '../components/Confirm';
import { toast } from '../components/Toast';
import LogDetailModal from '../components/LogDetailModal';
import { IS_CLEAR_LOGS_VISIBLE } from '../config';
import CleanupLogsModal from '../components/CleanupLogsModal';
import { formatBytes } from '../utils/format';
import type { LogsDiskUsage } from '../api/client';

dayjs.extend(relativeTime);

type LogTab = 'request' | 'error';

function LogsPage() {
  const { confirm } = useConfirm();
  const [activeTab, setActiveTab] = useState<LogTab>('request');
  const [requestLogs, setRequestLogs] = useState<RequestLog[]>([]);
  const [errorLogs, setErrorLogs] = useState<ErrorLog[]>([]);
  const [selectedRequestLog, setSelectedRequestLog] = useState<RequestLog | null>(null);
  const [selectedErrorLog, setSelectedErrorLog] = useState<ErrorLog | null>(null);

  // 分页状态（当前页 + 过滤后的 total）
  const [requestLogsPage, setRequestLogsPage] = useState(1);
  const [requestLogsPageSize, setRequestLogsPageSize] = useState(20);
  const [requestLogsTotal, setRequestLogsTotal] = useState(0);
  const [errorLogsPage, setErrorLogsPage] = useState(1);
  const [errorLogsPageSize, setErrorLogsPageSize] = useState(20);
  const [errorLogsTotal, setErrorLogsTotal] = useState(0);

  // tab 角标总数（未过滤，独立于分页 total，保证两个角标始终有值）
  const [requestBadge, setRequestBadge] = useState(0);
  const [errorBadge, setErrorBadge] = useState(0);

  // 日志占用空间 + 清理弹窗
  const [diskUsage, setDiskUsage] = useState<LogsDiskUsage | null>(null);
  const [showCleanupModal, setShowCleanupModal] = useState(false);

  const [loading, setLoading] = useState(false);

  // 自动刷新相关状态
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [countdown, setCountdown] = useState(10);

  // 筛选器（请求/错误两个 tab 共用同一组筛选维度）
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [services, setServices] = useState<APIService[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [filterTargetType, setFilterTargetType] = useState<string>('');
  const [filterVendorId, setFilterVendorId] = useState<string>('');
  const [filterServiceId, setFilterServiceId] = useState<string>('');
  const [filterModel, setFilterModel] = useState<string>('');
  const [filterRouteId, setFilterRouteId] = useState<string>('');

  // 内容搜索：输入值 + 已应用值（仅点击「搜索」/回车后才参与查询）
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [appliedSearchQuery, setAppliedSearchQuery] = useState<string>('');
  const [errorSearchQuery, setErrorSearchQuery] = useState<string>('');
  const [appliedErrorSearchQuery, setAppliedErrorSearchQuery] = useState<string>('');

  // 用 ref 保存最新查询参数，供自动刷新/手动刷新直接调用 loadLogs 时读取
  const paramsRef = useRef({
    activeTab, requestLogsPage, requestLogsPageSize, errorLogsPage, errorLogsPageSize,
    appliedSearchQuery, appliedErrorSearchQuery,
    filterTargetType, filterVendorId, filterServiceId, filterModel, filterRouteId,
  });
  paramsRef.current = {
    activeTab, requestLogsPage, requestLogsPageSize, errorLogsPage, errorLogsPageSize,
    appliedSearchQuery, appliedErrorSearchQuery,
    filterTargetType, filterVendorId, filterServiceId, filterModel, filterRouteId,
  };

  useEffect(() => {
    loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, requestLogsPage, requestLogsPageSize, errorLogsPage, errorLogsPageSize,
      appliedSearchQuery, appliedErrorSearchQuery,
      filterTargetType, filterVendorId, filterServiceId, filterModel, filterRouteId]);

  useEffect(() => {
    loadFilterOptions();
    loadBadgeCounts();
    loadDiskUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自动刷新倒计时逻辑
  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null;
    let countdownId: NodeJS.Timeout | null = null;

    if (autoRefresh) {
      countdownId = setInterval(() => {
        setCountdown(prev => (prev <= 1 ? 10 : prev - 1));
      }, 1000);

      intervalId = setInterval(() => {
        loadLogs();
        loadBadgeCounts();
      }, 10000);
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
      if (countdownId) clearInterval(countdownId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, activeTab, requestLogsPage, requestLogsPageSize, errorLogsPage, errorLogsPageSize]);

  const loadFilterOptions = async () => {
    try {
      const [vendorsData, servicesData, routesData] = await Promise.all([
        api.getVendors(), api.getAPIServices(), api.getRoutes(),
      ]);
      setVendors(vendorsData);
      setServices(servicesData);
      setRoutes(routesData);
    } catch (error) {
      console.error('Failed to load filter options:', error);
    }
  };

  // 拉取两个 tab 的角标总数（未过滤，便宜）
  const loadBadgeCounts = async () => {
    try {
      const [req, err] = await Promise.all([api.getLogsCount(), api.getErrorLogsCount()]);
      setRequestBadge(req.count);
      setErrorBadge(err.count);
    } catch (error) {
      console.error('Failed to load badge counts:', error);
    }
  };

  const loadDiskUsage = async () => {
    try {
      const data = await api.getLogsDiskUsage();
      setDiskUsage(data);
    } catch (error) {
      console.error('Failed to load disk usage:', error);
    }
  };

  const loadLogs = async () => {
    const p = paramsRef.current;
    const filters = {
      targetType: p.filterTargetType || undefined,
      vendorId: p.filterVendorId || undefined,
      serviceId: p.filterServiceId || undefined,
      model: p.filterModel || undefined,
      routeId: p.filterRouteId || undefined,
    };
    setLoading(true);
    try {
      if (p.activeTab === 'request') {
        const offset = (p.requestLogsPage - 1) * p.requestLogsPageSize;
        const result = await api.queryLogs({
          filters,
          keyword: p.appliedSearchQuery.trim() || undefined,
          limit: p.requestLogsPageSize,
          offset,
        });
        setRequestLogs(result.logs);
        setRequestLogsTotal(result.total);
      } else if (p.activeTab === 'error') {
        const offset = (p.errorLogsPage - 1) * p.errorLogsPageSize;
        const result = await api.queryErrorLogs({
          filters,
          keyword: p.appliedErrorSearchQuery.trim() || undefined,
          limit: p.errorLogsPageSize,
          offset,
        });
        setErrorLogs(result.logs);
        setErrorLogsTotal(result.total);
      }
    } catch (error) {
      console.error('Failed to load logs:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleClearAllLogs = async () => {
    const warningMessage = `确定要清空所有日志吗?\n\n⚠️ 警告:\n1. 此操作将永久删除所有请求日志和错误日志\n2. 相关的统计数据也会被清空\n3. 此操作不可撤销\n\n是否继续?`;
    const confirmed = await confirm({
      message: warningMessage, title: '确认清空全部日志', type: 'danger',
      confirmText: '确认清空', cancelText: '取消'
    });
    if (confirmed) {
      try {
        await Promise.all([api.clearLogs(), api.clearErrorLogs()]);
        setRequestLogs([]); setSelectedRequestLog(null); setRequestLogsPage(1); setRequestLogsTotal(0);
        setErrorLogs([]); setSelectedErrorLog(null); setErrorLogsPage(1); setErrorLogsTotal(0);
        setRequestBadge(0); setErrorBadge(0);
        toast.success('所有日志已清空');
      } catch (error) {
        console.error('清空日志失败:', error);
        toast.error('清空日志失败，请重试');
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
    setFilterVendorId(vendorId); setFilterServiceId(''); setFilterModel('');
    setRequestLogsPage(1); setErrorLogsPage(1);
  };
  const handleServiceChange = (serviceId: string) => {
    setFilterServiceId(serviceId); setFilterModel('');
    setRequestLogsPage(1); setErrorLogsPage(1);
  };
  const resetPage = () => { setRequestLogsPage(1); setErrorLogsPage(1); };
  const handleTargetTypeChange = (v: string) => { setFilterTargetType(v); resetPage(); };
  const handleModelChange = (v: string) => { setFilterModel(v); resetPage(); };
  const handleRouteChange = (v: string) => { setFilterRouteId(v); resetPage(); };

  const clearAllFilters = () => {
    setFilterTargetType(''); setFilterVendorId(''); setFilterServiceId('');
    setFilterModel(''); setFilterRouteId('');
    setSearchQuery(''); setAppliedSearchQuery('');
    setErrorSearchQuery(''); setAppliedErrorSearchQuery('');
    resetPage();
  };
  const clearSearch = () => { setSearchQuery(''); setAppliedSearchQuery(''); setRequestLogsPage(1); };
  const clearErrorSearch = () => { setErrorSearchQuery(''); setAppliedErrorSearchQuery(''); setErrorLogsPage(1); };

  const getFilteredServices = () => {
    if (!filterVendorId) return [];
    return services.filter(s => s.vendorId === filterVendorId);
  };
  const getAvailableModels = () => {
    if (!filterServiceId) return [];
    return services.find(s => s.id === filterServiceId)?.supportedModels || [];
  };

  const hasAnyFilter = !!(filterTargetType || filterVendorId || filterServiceId || filterModel || filterRouteId ||
    appliedSearchQuery || appliedErrorSearchQuery);

  // 分页回调
  const handleRequestLogsPageChange = (page: number) => setRequestLogsPage(page);
  const handleRequestLogsPageSizeChange = (size: number) => { setRequestLogsPageSize(size); setRequestLogsPage(1); };
  const handleErrorLogsPageChange = (page: number) => setErrorLogsPage(page);
  const handleErrorLogsPageSizeChange = (size: number) => { setErrorLogsPageSize(size); setErrorLogsPage(1); };

  const renderRequestLogs = () => {
    if (requestLogs.length === 0) return <div className="empty-state"><p>暂无请求日志</p></div>;
    return (
      <table>
        <thead>
          <tr><th>时间</th><th>客户端类型</th><th>路径</th><th>状态</th><th>响应时间</th><th>Tokens信息</th><th>操作</th></tr>
        </thead>
        <tbody>
          {requestLogs.map((log) => (
            <tr key={log.id}>
              <td>{dayjs(log.timestamp).format('YYYY-MM-DD HH:mm:ss')}</td>
              <td>
                {TARGET_TYPE[log.targetType!] ? (
                  <span className={`badge ${log.targetType === 'claude-code' ? 'badge-claude-code' : log.targetType === 'codex' ? 'badge-codex' : log.targetType === 'opencode' ? 'badge-opencode' : 'badge-info'}`}>
                    {TARGET_TYPE[log.targetType!]}
                  </span>
                ) : '-'}
              </td>
              <td>{log.path}</td>
              <td><span className={`badge ${getStatusBadge(log.statusCode)}`}>{log.statusCode || 'Error'}</span></td>
              <td>{log.responseTime ? `${log.responseTime}ms` : '-'}</td>
              <td>
                {log.usage ? (
                  <span>{log.usage.totalTokens ? log.usage.totalTokens : log.usage.inputTokens + log.usage.outputTokens} tokens</span>
                ) : '-'}
              </td>
              <td>
                <div style={{ position: 'relative', display: 'inline-block' }}>
                  {(() => {
                    const downstreamBody = log.downstreamResponseBody;
                    const isStreaming = typeof downstreamBody === 'string' &&
                      (downstreamBody.includes('event:') || downstreamBody.includes('data:'));
                    return isStreaming && (
                      <span style={{
                        position: 'absolute', top: '-4px', right: '-4px', width: '6px', height: '6px',
                        backgroundColor: '#f39c12', borderRadius: '50%', boxShadow: '0 0 0 2px rgba(243, 156, 18, 0.5)'
                      }} />
                    );
                  })()}
                  <button className="btn btn-secondary" onClick={() => setSelectedRequestLog(log)}>详情</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  const renderErrorLogs = () => {
    if (errorLogs.length === 0) return <div className="empty-state"><p>暂无错误日志</p></div>;
    return (
      <table>
        <thead>
          <tr><th>时间</th><th>方法</th><th>路径</th><th>状态</th><th>错误信息</th><th>操作</th></tr>
        </thead>
        <tbody>
          {errorLogs.map((log) => (
            <tr key={log.id}>
              <td>{dayjs(log.timestamp).format('YYYY-MM-DD HH:mm:ss')}</td>
              <td><span className="badge badge-danger">{log.method}</span></td>
              <td>{log.path}</td>
              <td><span className="badge badge-danger">{log.statusCode || '-'}</span></td>
              <td style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#e74c3c' }}>{log.errorMessage}</td>
              <td><button className="btn btn-secondary" onClick={() => setSelectedErrorLog(log)}>详情</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  // 统一控件样式
  const filterRowStyle: React.CSSProperties = {
    padding: '15px', background: 'var(--bg-secondary)', borderRadius: '12px',
    marginBottom: '20px', display: 'flex', gap: '15px', alignItems: 'center',
    flexWrap: 'wrap', border: '1px solid var(--border-primary)',
  };
  const filterItemStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px' };
  const filterLabelStyle: React.CSSProperties = { fontWeight: 'bold', color: 'var(--text-primary)' };
  const selectStyle: React.CSSProperties = {
    padding: '6px 10px', borderRadius: '8px', border: '1px solid var(--border-primary)',
    background: 'var(--bg-card)', color: 'var(--text-primary)',
  };
  const selectWideStyle: React.CSSProperties = { ...selectStyle, minWidth: '150px' };
  const clearFilterBtnStyle: React.CSSProperties = {
    padding: '6px 12px', borderRadius: '8px', cursor: 'pointer', fontSize: '14px',
    border: '1px solid var(--accent-danger)', background: 'var(--accent-danger)', color: 'white',
  };
  const searchInputStyle: React.CSSProperties = {
    padding: '6px 12px', borderRadius: '8px', border: '1px solid var(--border-primary)',
    background: 'var(--bg-card)', color: 'var(--text-primary)', width: '320px', fontSize: '14px',
  };
  const searchBtnStyle: React.CSSProperties = {
    padding: '6px 16px', borderRadius: '8px', cursor: 'pointer', fontSize: '14px',
    border: 'none', background: 'var(--accent-primary, #3498db)', color: 'white',
  };
  const clearSearchBtnStyle: React.CSSProperties = {
    padding: '6px 12px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px',
    border: '1px solid var(--border-primary)', background: 'var(--bg-card)', color: 'var(--text-primary)',
  };

  // 当前 tab 的搜索状态绑定
  const isRequest = activeTab === 'request';
  const activeSearchValue = isRequest ? searchQuery : errorSearchQuery;
  const setActiveSearchValue = (v: string) => isRequest ? setSearchQuery(v) : setErrorSearchQuery(v);
  const applySearch = () => {
    if (isRequest) { setAppliedSearchQuery(searchQuery); setRequestLogsPage(1); }
    else { setAppliedErrorSearchQuery(errorSearchQuery); setErrorLogsPage(1); }
  };
  const appliedSearchValue = isRequest ? appliedSearchQuery : appliedErrorSearchQuery;
  const clearActiveSearch = isRequest ? clearSearch : clearErrorSearch;

  return (
    <div className='logs-page'>
      <div className="page-header">
        <div className="page-header-content">
          <div className="page-header-text">
            <h1>日志</h1>
            <p>查看所有API请求日志</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {diskUsage && (
              <span style={{
                fontSize: '13px', color: 'var(--text-secondary)',
                background: 'var(--bg-secondary)', padding: '6px 12px',
                borderRadius: '8px', border: '1px solid var(--border-primary)', whiteSpace: 'nowrap',
              }}>
                日志占用：<strong style={{ color: 'var(--text-primary)' }}>{formatBytes(diskUsage.totalBytes)}</strong>
              </span>
            )}
            <button className="btn btn-secondary" onClick={() => setShowCleanupModal(true)}>清理</button>
            {IS_CLEAR_LOGS_VISIBLE && (
              <button className="btn btn-danger" onClick={handleClearAllLogs}>清空全部日志</button>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div style={{ borderBottom: '1px solid #ecf0f1', marginBottom: '20px' }}>
          <div style={{ display: 'flex', gap: '0' }}>
            <button onClick={() => setActiveTab('request')} style={{
              padding: '12px 24px', border: 'none',
              background: activeTab === 'request' ? '#3498db' : 'transparent',
              color: activeTab === 'request' ? 'white' : '#7f8c8d', cursor: 'pointer',
              borderBottom: activeTab === 'request' ? '2px solid #2980b9' : '2px solid transparent',
              fontWeight: activeTab === 'request' ? 'bold' : 'normal',
            }}>请求日志 ({requestBadge})</button>
            <button onClick={() => setActiveTab('error')} style={{
              padding: '12px 24px', border: 'none',
              background: activeTab === 'error' ? '#e74c3c' : 'transparent',
              color: activeTab === 'error' ? 'white' : '#7f8c8d', cursor: 'pointer',
              borderBottom: activeTab === 'error' ? '2px solid #c0392b' : '2px solid transparent',
              fontWeight: activeTab === 'error' ? 'bold' : 'normal',
            }}>错误日志 ({errorBadge})</button>
          </div>
        </div>

        <div className="toolbar">
          <h3>{activeTab === 'error' ? '错误日志列表' : '请求日志列表'}</h3>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '0 12px', background: 'var(--bg-secondary)', borderRadius: '8px' }}>
              <input type="checkbox" id="auto-refresh" checked={autoRefresh}
                onChange={(e) => { setAutoRefresh(e.target.checked); if (e.target.checked) setCountdown(10); }}
                style={{ cursor: 'pointer' }} />
              <label htmlFor="auto-refresh" style={{ cursor: 'pointer', fontSize: '14px', color: 'var(--text-primary)', userSelect: 'none' }}>
                自动刷新 {autoRefresh && `(⏱ ${countdown}s)`}
              </label>
            </div>
            <button className="btn btn-primary" onClick={() => { loadLogs(); loadBadgeCounts(); setCountdown(10); }}>刷新</button>
          </div>
        </div>

        {/* 筛选 + 搜索（两个 tab 共用，搜索无 label，点击「搜索」才发起请求） */}
        <div style={filterRowStyle}>
          <div style={filterItemStyle}>
            <label style={filterLabelStyle}>来源类型:</label>
            <select value={filterTargetType} onChange={(e) => handleTargetTypeChange(e.target.value)} style={selectStyle}>
              <option value="">全部</option>
              <option value="claude-code">Claude Code</option>
              <option value="codex">Codex</option>
              <option value="opencode">OpenCode</option>
            </select>
          </div>
          <div style={filterItemStyle}>
            <label style={filterLabelStyle}>供应商:</label>
            <select value={filterVendorId} onChange={(e) => handleVendorChange(e.target.value)} style={selectWideStyle}>
              <option value="">全部供应商</option>
              {vendors.map(vendor => (<option key={vendor.id} value={vendor.id}>{vendor.name}</option>))}
            </select>
          </div>
          <div style={filterItemStyle}>
            <label style={filterLabelStyle}>API服务:</label>
            <select value={filterServiceId} onChange={(e) => handleServiceChange(e.target.value)} disabled={!filterVendorId}
              style={{ ...selectWideStyle, background: filterVendorId ? 'var(--bg-card)' : 'var(--bg-secondary)', cursor: filterVendorId ? 'pointer' : 'not-allowed', opacity: filterVendorId ? 1 : 0.6 }}>
              <option value="">全部服务</option>
              {getFilteredServices().map(service => (<option key={service.id} value={service.id}>{service.name}</option>))}
            </select>
          </div>
          <div style={filterItemStyle}>
            <label style={filterLabelStyle}>模型:</label>
            <select value={filterModel} onChange={(e) => handleModelChange(e.target.value)} disabled={!filterServiceId}
              style={{ ...selectWideStyle, background: filterServiceId ? 'var(--bg-card)' : 'var(--bg-secondary)', cursor: filterServiceId ? 'pointer' : 'not-allowed', opacity: filterServiceId ? 1 : 0.6 }}>
              <option value="">全部模型</option>
              {getAvailableModels().map(model => (<option key={model} value={model}>{model}</option>))}
            </select>
          </div>
          <div style={filterItemStyle}>
            <label style={filterLabelStyle}>路由:</label>
            <select value={filterRouteId} onChange={(e) => handleRouteChange(e.target.value)} style={selectWideStyle}>
              <option value="">全部路由</option>
              {routes.map(route => (<option key={route.id} value={route.id}>{route.name}</option>))}
            </select>
          </div>
          {hasAnyFilter && (
            <button style={clearFilterBtnStyle} onClick={clearAllFilters}>清除筛选</button>
          )}
          <div style={filterItemStyle}>
            <input
              type="text"
              placeholder={isRequest ? '搜索日志内容...' : '搜索错误日志...'}
              value={activeSearchValue}
              onChange={(e) => setActiveSearchValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applySearch(); }}
              style={searchInputStyle}
            />
            <button style={searchBtnStyle} onClick={applySearch}>搜索</button>
            {(activeSearchValue || appliedSearchValue) && (
              <button style={clearSearchBtnStyle} onClick={clearActiveSearch}>清空</button>
            )}
          </div>
        </div>

        {activeTab === 'request' && (
          <>
            {loading ? <div className="empty-state"><p>加载中...</p></div> : renderRequestLogs()}
            {!loading && (
              <Pagination
                currentPage={requestLogsPage} totalItems={requestLogsTotal} pageSize={requestLogsPageSize}
                onPageChange={handleRequestLogsPageChange} onPageSizeChange={handleRequestLogsPageSizeChange}
              />
            )}
          </>
        )}
        {activeTab === 'error' && (
          <>
            {loading ? <div className="empty-state"><p>加载中...</p></div> : renderErrorLogs()}
            {!loading && (
              <Pagination
                currentPage={errorLogsPage} totalItems={errorLogsTotal} pageSize={errorLogsPageSize}
                onPageChange={handleErrorLogsPageChange} onPageSizeChange={handleErrorLogsPageSizeChange}
              />
            )}
          </>
        )}
      </div>

      {selectedRequestLog && (
        <LogDetailModal log={selectedRequestLog} onClose={() => setSelectedRequestLog(null)} />
      )}
      {selectedErrorLog && (
        <LogDetailModal log={selectedErrorLog} onClose={() => setSelectedErrorLog(null)} />
      )}
      {showCleanupModal && (
        <CleanupLogsModal
          onClose={() => setShowCleanupModal(false)}
          onCleared={() => {
            loadDiskUsage();
            loadLogs();
            loadBadgeCounts();
          }}
        />
      )}
    </div>
  );
}

export default LogsPage;
