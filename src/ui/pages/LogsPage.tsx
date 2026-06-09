import { useState, useEffect } from 'react';
import { api } from '../api/client';
import type { RequestLog, ErrorLog, Vendor, APIService } from '../../types';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { TARGET_TYPE } from '../constants';
import { Pagination } from '../components/Pagination';
import { useConfirm } from '../components/Confirm';
import { toast } from '../components/Toast';
import LogDetailModal from '../components/LogDetailModal';

dayjs.extend(relativeTime);

type LogTab = 'request' | 'error';

function LogsPage() {
  const { confirm } = useConfirm();
  const [activeTab, setActiveTab] = useState<LogTab>('request');
  const [requestLogs, setRequestLogs] = useState<RequestLog[]>([]);
  const [errorLogs, setErrorLogs] = useState<ErrorLog[]>([]);
  const [selectedRequestLog, setSelectedRequestLog] = useState<RequestLog | null>(null);
  const [selectedErrorLog, setSelectedErrorLog] = useState<ErrorLog | null>(null);

  // 分页状态
  const [requestLogsPage, setRequestLogsPage] = useState(1);
  const [requestLogsPageSize, setRequestLogsPageSize] = useState(20);
  const [requestLogsTotal, setRequestLogsTotal] = useState(0);

  const [errorLogsPage, setErrorLogsPage] = useState(1);
  const [errorLogsPageSize, setErrorLogsPageSize] = useState(20);
  const [errorLogsTotal, setErrorLogsTotal] = useState(0);

  const [loading, setLoading] = useState(false);

  // 自动刷新相关状态
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [countdown, setCountdown] = useState(10);

  // 筛选器相关state
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [services, setServices] = useState<APIService[]>([]);
  const [filterTargetType, setFilterTargetType] = useState<string>('');
  const [filterVendorId, setFilterVendorId] = useState<string>('');
  const [filterServiceId, setFilterServiceId] = useState<string>('');
  const [filterModel, setFilterModel] = useState<string>('');

  // 内容搜索相关state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [errorSearchQuery, setErrorSearchQuery] = useState<string>('');

  useEffect(() => {
    loadLogs();
  }, [activeTab, requestLogsPage, requestLogsPageSize, errorLogsPage, errorLogsPageSize, searchQuery, errorSearchQuery]);

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
  }, [autoRefresh, activeTab, requestLogsPage, requestLogsPageSize, errorLogsPage, errorLogsPageSize]);

  const loadLogs = async () => {
    setLoading(true);
    try {
      if (activeTab === 'request') {
        const offset = (requestLogsPage - 1) * requestLogsPageSize;
        const [data, countResult] = await Promise.all([
          searchQuery.trim()
            ? api.searchLogs(searchQuery.trim(), requestLogsPageSize, offset)
            : api.getLogs(requestLogsPageSize, offset),
          searchQuery.trim()
            ? api.searchLogsCount(searchQuery.trim())
            : api.getLogsCount()
        ]);
        setRequestLogs(data);
        setRequestLogsTotal(countResult.count);
      } else if (activeTab === 'error') {
        const offset = (errorLogsPage - 1) * errorLogsPageSize;
        const [data, countResult] = await Promise.all([
          errorSearchQuery.trim()
            ? api.searchErrorLogs(errorSearchQuery.trim(), errorLogsPageSize, offset)
            : api.getErrorLogs(errorLogsPageSize, offset),
          errorSearchQuery.trim()
            ? api.searchErrorLogsCount(errorSearchQuery.trim())
            : api.getErrorLogsCount()
        ]);
        setErrorLogs(data);
        setErrorLogsTotal(countResult.count);
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
      const [requestCount, errorCount] = await Promise.all([
        api.getLogsCount(),
        api.getErrorLogsCount()
      ]);
      setRequestLogsTotal(requestCount.count);
      setErrorLogsTotal(errorCount.count);
    } catch (error) {
      console.error('Failed to load counts:', error);
    }
  };

  const handleClearAllLogs = async () => {
    const warningMessage = `确定要清空所有日志吗?\n\n⚠️ 警告:\n1. 此操作将永久删除所有请求日志和错误日志\n2. 相关的统计数据也会被清空\n3. 此操作不可撤销\n\n是否继续?`;

    const confirmed = await confirm({
      message: warningMessage,
      title: '确认清空全部日志',
      type: 'danger',
      confirmText: '确认清空',
      cancelText: '取消'
    });

    if (confirmed) {
      try {
        // 并发清空所有类型的日志
        await Promise.all([
          api.clearLogs(),
          api.clearErrorLogs()
        ]);

        // 重置所有状态
        setRequestLogs([]);
        setSelectedRequestLog(null);
        setRequestLogsPage(1);
        setRequestLogsTotal(0);

        setErrorLogs([]);
        setSelectedErrorLog(null);
        setErrorLogsPage(1);
        setErrorLogsTotal(0);

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
                <div style={{ position: 'relative', display: 'inline-block' }}>
                  {(() => {
                    // 判断是否为流式响应
                    const downstreamBody = log.downstreamResponseBody;
                    const isStreaming = typeof downstreamBody === 'string' &&
                      (downstreamBody.includes('event:') || downstreamBody.includes('data:'));
                    return isStreaming && (
                      <span
                        style={{
                          position: 'absolute',
                          top: '-4px',
                          right: '-4px',
                          width: '6px',
                          height: '6px',
                          backgroundColor: '#f39c12',
                          borderRadius: '50%',
                          boxShadow: '0 0 0 2px rgba(243, 156, 18, 0.5)'
                        }}
                      />
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
    <div className='logs-page'>
      <div className="page-header">
        <div className="page-header-content">
          <div className="page-header-text">
            <h1>日志</h1>
            <p>查看所有API请求日志</p>
          </div>
          <button className="btn btn-danger" onClick={handleClearAllLogs}>清空全部日志</button>
        </div>
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
          </div>
        </div>

        <div className="toolbar">
          <h3>
            {activeTab === 'error' && '错误日志列表'}
            {activeTab === 'request' && '请求日志列表'}
          </h3>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            {/* 内容搜索框 */}
            {activeTab === 'request' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="text"
                  placeholder="搜索日志内容..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setRequestLogsPage(1); // 重置到第一页
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      loadLogs();
                    }
                  }}
                  style={{
                    padding: '6px 12px',
                    borderRadius: '8px',
                    border: '1px solid var(--border-primary)',
                    background: 'var(--bg-card)',
                    color: 'var(--text-primary)',
                    width: '200px',
                    fontSize: '14px'
                  }}
                />
                {searchQuery && (
                  <button
                    onClick={() => {
                      setSearchQuery('');
                      setRequestLogsPage(1);
                    }}
                    style={{
                      padding: '6px 10px',
                      borderRadius: '6px',
                      border: '1px solid var(--border-primary)',
                      background: 'var(--bg-secondary)',
                      color: 'var(--text-primary)',
                      cursor: 'pointer',
                      fontSize: '13px'
                    }}
                  >
                    清除
                  </button>
                )}
              </div>
            )}
            {activeTab === 'error' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="text"
                  placeholder="搜索错误日志..."
                  value={errorSearchQuery}
                  onChange={(e) => {
                    setErrorSearchQuery(e.target.value);
                    setErrorLogsPage(1);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      loadLogs();
                    }
                  }}
                  style={{
                    padding: '6px 12px',
                    borderRadius: '8px',
                    border: '1px solid var(--border-primary)',
                    background: 'var(--bg-card)',
                    color: 'var(--text-primary)',
                    width: '200px',
                    fontSize: '14px'
                  }}
                />
                {errorSearchQuery && (
                  <button
                    onClick={() => {
                      setErrorSearchQuery('');
                      setErrorLogsPage(1);
                    }}
                    style={{
                      padding: '6px 10px',
                      borderRadius: '6px',
                      border: '1px solid var(--border-primary)',
                      background: 'var(--bg-secondary)',
                      color: 'var(--text-primary)',
                      cursor: 'pointer',
                      fontSize: '13px'
                    }}
                  >
                    清除
                  </button>
                )}
              </div>
            )}
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
              <label style={{ fontWeight: 'bold', color: 'var(--text-primary)' }}>来源类型:</label>
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
              <label style={{ fontWeight: 'bold', color: 'var(--text-primary)' }}>供应商:</label>
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
              <label style={{ fontWeight: 'bold', color: 'var(--text-primary)' }}>API服务:</label>
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
              <label style={{ fontWeight: 'bold', color: 'var(--text-primary)' }}>模型:</label>
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
      </div>

      {selectedRequestLog && (
        <LogDetailModal log={selectedRequestLog} onClose={() => setSelectedRequestLog(null)} />
      )}
      {selectedErrorLog && (
        <LogDetailModal log={selectedErrorLog} onClose={() => setSelectedErrorLog(null)} />
      )}

    </div>
  );
}

export default LogsPage;
