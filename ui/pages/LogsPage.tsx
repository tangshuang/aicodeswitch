import { useState, useEffect } from 'react';
import { api } from '../api/client';
import type { RequestLog, AccessLog, ErrorLog, Vendor, APIService } from '../../types';
import dayjs from 'dayjs';
import JSONViewer from '../components/JSONViewer';
import { TARGET_TYPE } from '../constants';

type LogTab = 'request' | 'access' | 'error';

function LogsPage() {
  const [activeTab, setActiveTab] = useState<LogTab>('request');
  const [requestLogs, setRequestLogs] = useState<RequestLog[]>([]);
  const [accessLogs, setAccessLogs] = useState<AccessLog[]>([]);
  const [errorLogs, setErrorLogs] = useState<ErrorLog[]>([]);
  const [selectedRequestLog, setSelectedRequestLog] = useState<RequestLog | null>(null);
  const [selectedAccessLog, setSelectedAccessLog] = useState<AccessLog | null>(null);
  const [selectedErrorLog, setSelectedErrorLog] = useState<ErrorLog | null>(null);
  const [chunksExpanded, setChunksExpanded] = useState<boolean>(false);
  const limit = 100;
  const offset = 0;

  // 筛选器相关state
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [services, setServices] = useState<APIService[]>([]);
  const [filterTargetType, setFilterTargetType] = useState<string>('');
  const [filterVendorId, setFilterVendorId] = useState<string>('');
  const [filterServiceId, setFilterServiceId] = useState<string>('');
  const [filterModel, setFilterModel] = useState<string>('');

  useEffect(() => {
    loadLogs();
    loadVendorsAndServices();
  }, [activeTab]);

  const loadLogs = async () => {
    if (activeTab === 'request') {
      const data = await api.getLogs(limit, offset);
      setRequestLogs(data);
    } else if (activeTab === 'access') {
      const data = await api.getAccessLogs(limit, offset);
      setAccessLogs(data);
    } else if (activeTab === 'error') {
      const data = await api.getErrorLogs(limit, offset);
      setErrorLogs(data);
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

  const handleClearLogs = async () => {
    if (confirm('确定要清空当前类型的所有日志吗?')) {
      if (activeTab === 'request') {
        await api.clearLogs();
        setRequestLogs([]);
        setSelectedRequestLog(null);
      } else if (activeTab === 'access') {
        await api.clearAccessLogs();
        setAccessLogs([]);
        setSelectedAccessLog(null);
      } else if (activeTab === 'error') {
        await api.clearErrorLogs();
        setErrorLogs([]);
        setSelectedErrorLog(null);
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

  const renderRequestLogs = () => {
    if (filteredRequestLogs.length === 0) {
      return <div className="empty-state"><p>暂无请求日志</p></div>;
    }

    return (
      <table>
        <thead>
          <tr>
            <th>来源对象类型</th>
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
              <td>
                {TARGET_TYPE[log.targetType!] ? (
                  <span className="badge badge-info">
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

  const renderAccessLogs = () => {
    if (accessLogs.length === 0) {
      return <div className="empty-state"><p>暂无访问日志</p></div>;
    }

    return (
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>方法</th>
            <th>路径</th>
            <th>状态</th>
            <th>响应时间</th>
            <th>客户端IP</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {accessLogs.map((log) => (
            <tr key={log.id}>
              <td>{dayjs(log.timestamp).format('YYYY-MM-DD HH:mm:ss')}</td>
              <td><span className="badge badge-success">{log.method}</span></td>
              <td>{log.path}</td>
              <td>
                <span className={`badge ${getStatusBadge(log.statusCode)}`}>
                  {log.statusCode || '-'}
                </span>
              </td>
              <td>{log.responseTime ? `${log.responseTime}ms` : '-'}</td>
              <td style={{ fontSize: '12px' }}>{log.clientIp || '-'}</td>
              <td>
                <button className="btn btn-secondary" onClick={() => setSelectedAccessLog(log)}>详情</button>
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
        <h1>请求日志</h1>
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
              请求日志 ({requestLogs.length})
            </button>
            <button
              onClick={() => setActiveTab('access')}
              style={{
                padding: '12px 24px',
                border: 'none',
                background: activeTab === 'access' ? '#3498db' : 'transparent',
                color: activeTab === 'access' ? 'white' : '#7f8c8d',
                cursor: 'pointer',
                borderBottom: activeTab === 'access' ? '2px solid #2980b9' : '2px solid transparent',
                fontWeight: activeTab === 'access' ? 'bold' : 'normal',
              }}
            >
              访问日志 ({accessLogs.length})
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
              错误日志 ({errorLogs.length})
            </button>
          </div>
        </div>

        <div className="toolbar">
          <h3>
            {activeTab === 'access' && '访问日志列表'}
            {activeTab === 'error' && '错误日志列表'}
            {activeTab === 'request' && '请求日志列表'}
          </h3>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button className="btn btn-primary" onClick={loadLogs}>刷新</button>
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

        {activeTab === 'request' && renderRequestLogs()}
        {activeTab === 'access' && renderAccessLogs()}
        {activeTab === 'error' && renderErrorLogs()}
      </div>

      {selectedRequestLog && (
        <div className="modal-overlay" onClick={() => setSelectedRequestLog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ minWidth: '600px', maxHeight: '90vh', overflowY: 'auto' }}>
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
                  <label>来源对象类型</label>
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
              {selectedRequestLog.body && (
                <div className="form-group">
                  <label>请求体</label>
                  <JSONViewer data={selectedRequestLog.body} />
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
                      className='btn btn-sm btn-primary'
                    >
                      {chunksExpanded ? '折叠' : '展开'}
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
      )}

      {selectedAccessLog && (
        <div className="modal-overlay" onClick={() => setSelectedAccessLog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ minWidth: '600px' }}>
            <div className="modal-header">
              <h2>访问日志详情</h2>
            </div>
            <div>
              <div className="form-group">
                <label>时间</label>
                <input type="text" value={dayjs(selectedAccessLog.timestamp).format('YYYY-MM-DD HH:mm:ss')} readOnly />
              </div>
              <div className="form-group">
                <label>请求方法</label>
                <input type="text" value={selectedAccessLog.method} readOnly />
              </div>
              <div className="form-group">
                <label>请求路径</label>
                <input type="text" value={selectedAccessLog.path} readOnly />
              </div>
              <div className="form-group">
                <label>状态码</label>
                <input type="text" value={selectedAccessLog.statusCode || '-'} readOnly />
              </div>
              <div className="form-group">
                <label>响应时间</label>
                <input type="text" value={selectedAccessLog.responseTime ? `${selectedAccessLog.responseTime}ms` : '-'} readOnly />
              </div>
              <div className="form-group">
                <label>客户端IP</label>
                <input type="text" value={selectedAccessLog.clientIp || '-'} readOnly />
              </div>
              <div className="form-group">
                <label>User Agent</label>
                <textarea rows={2} value={selectedAccessLog.userAgent || '-'} readOnly />
              </div>
              {selectedAccessLog.error && (
                <div className="form-group">
                  <label>错误信息</label>
                  <textarea rows={6} value={selectedAccessLog.error} readOnly style={{ color: '#e74c3c' }} />
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setSelectedAccessLog(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {selectedErrorLog && (
        <div className="modal-overlay" onClick={() => setSelectedErrorLog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ minWidth: '600px' }}>
            <div className="modal-header">
              <h2>错误日志详情</h2>
            </div>
            <div>
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
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setSelectedErrorLog(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default LogsPage;
