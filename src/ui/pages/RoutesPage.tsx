import { useState, useEffect } from 'react';
import { api } from '../api/client';
import type { Route, Rule, APIService, ContentType, Vendor } from '../../types';

const CONTENT_TYPE_OPTIONS = [
  { value: 'default', label: '默认' },
  { value: 'background', label: '后台' },
  { value: 'thinking', label: '思考' },
  { value: 'long-context', label: '长上下文' },
  { value: 'image-understanding', label: '图像理解' },
  { value: 'model-mapping', label: '模型顶替' },
];

const TARGET_TYPE_OPTIONS = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
];

export default function RoutesPage() {
  const [routes, setRoutes] = useState<Route[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [allServices, setAllServices] = useState<APIService[]>([]);
  const [services, setServices] = useState<APIService[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<Route | null>(null);
  const [showRouteModal, setShowRouteModal] = useState(false);
  const [showRuleModal, setShowRuleModal] = useState(false);
  const [editingRoute, setEditingRoute] = useState<Route | null>(null);
  const [editingRule, setEditingRule] = useState<Rule | null>(null);
  const [selectedVendor, setSelectedVendor] = useState<string>('');
  const [selectedService, setSelectedService] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [selectedReplacedModel, setSelectedReplacedModel] = useState<string>('');
  const [selectedSortOrder, setSelectedSortOrder] = useState<number>(0);
  const [selectedContentType, setSelectedContentType] = useState<string>(editingRule?.contentType || '');
  const [selectedTokenLimit, setSelectedTokenLimit] = useState<number | undefined>(undefined);
  const [selectedResetInterval, setSelectedResetInterval] = useState<number | undefined>(undefined);
  const [selectedTimeout, setSelectedTimeout] = useState<number | undefined>(undefined);
  const [hoveredRuleId, setHoveredRuleId] = useState<string | null>(null);

  useEffect(() => {
    loadRoutes();
    loadVendors();
    loadAllServices();
  }, []);

  useEffect(() => {
    if (selectedRoute) {
      loadRules(selectedRoute.id);
    }
  }, [selectedRoute]);

  useEffect(() => {
    if (selectedVendor) {
      setServices(allServices.filter(service => service.vendorId === selectedVendor));
    } else {
      setServices([]);
    }
    setSelectedService('');
    setSelectedModel('');
  }, [selectedVendor, allServices]);

  const loadRoutes = async () => {
    const data = await api.getRoutes();
    // 将已激活的路由排在前面
    const sortedData = data.sort((a, b) => {
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      return 0;
    });
    setRoutes(sortedData);
    if (sortedData.length > 0 && !selectedRoute) {
      setSelectedRoute(sortedData[0]);
    }
  };

  const loadRules = async (routeId: string) => {
    const data = await api.getRules(routeId);
    setRules(data);
  };

  const loadVendors = async () => {
    const data = await api.getVendors();
    setVendors(data);
  };

  const loadAllServices = async () => {
    const data = await api.getAPIServices();
    setAllServices(data);
  };

  const handleActivateRoute = async (id: string) => {
    await api.activateRoute(id);
    loadRoutes();
  };

  const handleDeactivateRoute = async (id: string) => {
    await api.deactivateRoute(id);
    loadRoutes();
  };

  const handleSaveRoute = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const route = {
      name: formData.get('name') as string,
      description: formData.get('description') as string,
      targetType: formData.get('targetType') as 'claude-code' | 'codex',
      isActive: false,
    };

    if (editingRoute) {
      await api.updateRoute(editingRoute.id, route);
    } else {
      await api.createRoute(route);
    }

    setShowRouteModal(false);
    loadRoutes();
  };

  const handleDeleteRoute = async (id: string) => {
    if (confirm('确定要删除此路由吗')) {
      await api.deleteRoute(id);
      loadRoutes();
      if (selectedRoute && selectedRoute.id === id) {
        setSelectedRoute(null);
        setRules([]);
      }
    }
  };

  const handleSaveRule = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const rule = {
      routeId: selectedRoute!.id,
      contentType: formData.get('contentType') as ContentType,
      targetServiceId: selectedService,
      targetModel: selectedModel || undefined,
      replacedModel: selectedReplacedModel || undefined,
      sortOrder: selectedSortOrder,
      timeout: selectedTimeout ? selectedTimeout * 1000 : undefined, // 转换为毫秒
      tokenLimit: selectedTokenLimit ? selectedTokenLimit * 1000 : undefined, // 转换为实际token数
      resetInterval: selectedResetInterval,
    };

    if (editingRule) {
      await api.updateRule(editingRule.id, rule);
    } else {
      await api.createRule(rule);
    }

    setShowRuleModal(false);
    if (selectedRoute) {
      loadRules(selectedRoute.id);
    }
  };

  const handleDeleteRule = async (id: string) => {
    if (confirm('确定要删除此路由吗')) {
      await api.deleteRule(id);
      if (selectedRoute) {
        loadRules(selectedRoute.id);
      }
    }
  };

  const handleResetTokens = async (id: string) => {
    if (confirm('确定要重置此规则的Token计数吗？')) {
      await api.resetRuleTokens(id);
      if (selectedRoute) {
        loadRules(selectedRoute.id);
      }
    }
  };

  const getAvailableContentTypes = () => {
    // 取消对象请求类型的互斥限制，允许添加多个相同类型的规则
    // 通过 sort_order 字段区分优先级
    return CONTENT_TYPE_OPTIONS;
  };

  const handleEditRule = (rule: Rule) => {
    setEditingRule(rule);
    setSelectedContentType(rule.contentType);
    const service = allServices.find(s => s.id === rule.targetServiceId);
    if (service) {
      setSelectedVendor(service.vendorId);
      // 直接设置当前供应商的服务列表，避免 useEffect 的异步延迟
      setServices(allServices.filter(s => s.vendorId === service.vendorId));
      // 使用 setTimeout 确保状态更新完成后再设置 selectedService 和 selectedModel
      setTimeout(() => {
        setSelectedService(service.id);
        setSelectedModel(rule.targetModel || '');
        setSelectedReplacedModel(rule.replacedModel || '');
        setSelectedSortOrder(rule.sortOrder || 0);
        setSelectedTimeout(rule.timeout ? rule.timeout / 1000 : undefined); // 转换为秒
        setSelectedTokenLimit(rule.tokenLimit ? rule.tokenLimit / 1000 : undefined); // 转换为k值
        setSelectedResetInterval(rule.resetInterval);
      }, 0);
    }
    setShowRuleModal(true);
  };

  const handleNewRule = () => {
    setEditingRule(null);
    setSelectedContentType('default');
    setSelectedVendor('');
    setSelectedService('');
    setSelectedModel('');
    setSelectedReplacedModel('');
    setSelectedSortOrder(0);
    setSelectedTimeout(undefined);
    setSelectedTokenLimit(undefined);
    setSelectedResetInterval(undefined);
    setShowRuleModal(true);
  };

  return (
    <div>
      <div className="page-header">
        <h1>路由管理</h1>
        <p>管理API路由和路由配置</p>
      </div>

      <div style={{ display: 'flex', gap: '20px' }}>
        <div className="card" style={{ flex: '0 0 33%' }}>
          <div className="toolbar">
            <h3>路由</h3>
            <button className="btn btn-primary" onClick={() => setShowRouteModal(true)}>新建</button>
          </div>
          {routes.length === 0 ? (
            <div className="empty-state"><p>暂无路由</p></div>
          ) : (
            <div style={{ marginTop: '10px' }}>
              {routes.map((route) => (
                <div
                  key={route.id}
                  onClick={() => setSelectedRoute(route)}
                  style={{
                    padding: '12px',
                    marginBottom: '8px',
                    backgroundColor: selectedRoute && selectedRoute.id === route.id
                      ? 'var(--bg-route-item-selected)'
                      : 'var(--bg-route-item)',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    border: '1px solid var(--border-primary)',
                    transition: 'all 0.2s ease',
                    position: 'relative',
                  }}
                  onMouseEnter={(e) => {
                    if (selectedRoute?.id !== route.id) {
                      e.currentTarget.style.backgroundColor = 'var(--bg-route-item-hover)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (selectedRoute?.id !== route.id) {
                      e.currentTarget.style.backgroundColor = 'var(--bg-route-item)';
                    }
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ fontWeight: 500 }}>{route.name}</div>
                      {route.isActive && <span className="badge badge-warning">{TARGET_TYPE_OPTIONS.find(opt => opt.value === route.targetType)?.label} 已激活</span>}
                    </div>
                     <div style={{ fontSize: '12px', color: 'var(--text-route-muted)', marginTop: '2px' }}>
                       客户端工具: {TARGET_TYPE_OPTIONS.find(opt => opt.value === route.targetType)?.label}
                     </div>
                    <div className="action-buttons" style={{ marginTop: '8px' }}>
                      {!route.isActive ? (
                        <button
                          className="btn btn-success"
                          style={{ padding: '4px 8px', fontSize: '12px' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleActivateRoute(route.id);
                          }}
                        >激活</button>
                      ) : (
                        <button
                          className="btn btn-warning"
                          style={{ padding: '4px 8px', fontSize: '12px' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeactivateRoute(route.id);
                          }}
                        >停用</button>
                      )}
                      <button
                        className="btn btn-secondary"
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingRoute(route);
                          setShowRouteModal(true);
                        }}
                      >编辑</button>
                      <button
                        className="btn btn-danger"
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteRoute(route.id);
                        }}
                        disabled={route.isActive}
                      >删除</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card" style={{ flex: 1 }}>
          <div className="toolbar">
            <h3>规则列表</h3>
            {selectedRoute && (
              <button className="btn btn-primary" onClick={handleNewRule}>新建规则</button>
            )}
          </div>
          {!selectedRoute ? (
            <div className="empty-state"><p>请先选择一个路由</p></div>
          ) : rules.length === 0 ? (
            <div className="empty-state"><p>暂无路由</p></div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>优先级</th>
                  <th>请求类型</th>
                  <th>供应商</th>
                  <th>API服务</th>
                  <th>模型</th>
                  <th>Token使用情况</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => {
                  const service = allServices.find(s => s.id === rule.targetServiceId);
                  const vendor = vendors.find(v => v.id === service?.vendorId);
                  const contentTypeLabel = CONTENT_TYPE_OPTIONS.find(opt => opt.value === rule.contentType)?.label;
                  return (
                    <tr key={rule.id}>
                      <td>{rule.sortOrder || 0}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span>{contentTypeLabel}</span>
                          {rule.contentType === 'model-mapping' && rule.replacedModel && (
                            <div
                              style={{ position: 'relative', display: 'inline-block' }}
                              onMouseEnter={() => setHoveredRuleId(rule.id)}
                              onMouseLeave={() => setHoveredRuleId(null)}
                            >
                              <span
                                style={{
                                  cursor: 'help',
                                  fontSize: '14px',
                                  color: 'var(--text-info)',
                                  fontWeight: 'bold',
                                }}
                              >
                                ⓘ
                              </span>
                              {hoveredRuleId === rule.id && (
                                <div
                                  style={{
                                    position: 'absolute',
                                    left: '50%',
                                    transform: 'translateX(-50%)',
                                    bottom: 'calc(100% + 8px)',
                                    backgroundColor: 'var(--bg-popover, #333)',
                                    color: 'var(--text-popover, #fff)',
                                    padding: '6px 10px',
                                    borderRadius: '4px',
                                    fontSize: '12px',
                                    whiteSpace: 'nowrap',
                                    zIndex: 1000,
                                    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                                  }}
                                >
                                  被顶替的模型是: {rule.replacedModel}
                                  <div
                                    style={{
                                      position: 'absolute',
                                      left: '50%',
                                      transform: 'translateX(-50%)',
                                      bottom: '-4px',
                                      width: '0',
                                      height: '0',
                                      borderLeft: '4px solid transparent',
                                      borderRight: '4px solid transparent',
                                      borderTop: '4px solid var(--bg-popover, #333)',
                                    }}
                                  />
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                      <td>{vendor ? vendor.name : 'Unknown'}</td>
                      <td>{service ? service.name : 'Unknown'}</td>
                      <td>{rule.targetModel || '透传'}</td>
                      <td>
                        {rule.tokenLimit ? (
                          <div style={{ fontSize: '13px' }}>
                            <div>
                              <span style={{
                                color: rule.totalTokensUsed && rule.tokenLimit && rule.totalTokensUsed >= rule.tokenLimit ? 'red' : 'inherit'
                              }}>
                                {((rule.totalTokensUsed || 0) / 1000).toFixed(1)}k / {(rule.tokenLimit / 1000).toFixed(0)}k
                              </span>
                              {rule.totalTokensUsed && rule.tokenLimit && rule.totalTokensUsed >= rule.tokenLimit && (
                                <span style={{ color: 'red', marginLeft: '6px', fontWeight: 'bold' }}>已超限</span>
                              )}
                            </div>
                            {rule.resetInterval && (
                              <div style={{ fontSize: '11px', color: '#999', marginTop: '2px' }}>
                                每{rule.resetInterval}小时重置
                                {rule.lastResetAt && (
                                  <>
                                    {(() => {
                                      const nextResetTime = rule.lastResetAt + (rule.resetInterval * 60 * 60 * 1000);
                                      const now = Date.now();
                                      const hoursUntilReset = Math.max(0, Math.ceil((nextResetTime - now) / (60 * 60 * 1000)));
                                      return ` (${hoursUntilReset}小时后)`;
                                    })()}
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span style={{ color: '#999', fontSize: '13px' }}>不限制</span>
                        )}
                      </td>
                      <td>
                        <div className="action-buttons">
                          <button className="btn btn-secondary" onClick={() => handleEditRule(rule)}>编辑</button>
                          {rule.tokenLimit && (
                            <button className="btn btn-info" onClick={() => handleResetTokens(rule.id)}>重置Token</button>
                          )}
                          <button className="btn btn-danger" onClick={() => handleDeleteRule(rule.id)}>删除</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {selectedRoute && rules.length > 0 && (
            <div style={{
              fontSize: '12px',
              color: '#666',
              marginTop: '16px',
              padding: '12px',
              backgroundColor: '#f8f9fa',
              borderRadius: '6px',
              border: '1px solid #e0e0e0',
              lineHeight: '1.6'
            }}>
              <strong>💡 智能故障切换机制</strong>
              <div style={{ marginTop: '6px' }}>
                • 当同一请求类型配置多个规则时,系统会按排序优先使用第一个<br/>
                • 如果某个服务报错(4xx/5xx),将自动切换到下一个可用服务<br/>
                • 报错的服务会被标记为不可用,有效期10分钟<br/>
                • 10分钟后自动解除标记,如果再次报错则重新标记<br/>
                • 确保您的请求始终路由到稳定可用的服务<br/>
                • 如不需要此功能,可在<strong>设置</strong>页面关闭"启用智能故障切换"选项
              </div>
            </div>
          )}
        </div>
      </div>

      {showRouteModal && (
        <div className="modal-overlay">
          <button
            type="button"
            className="modal-close-btn"
            onClick={() => setShowRouteModal(false)}
            aria-label="关闭"
          >
            ×
          </button>
          <div className="modal">
            <div className="modal-container">
              <div className="modal-header">
                <h2>{editingRoute ? '编辑路由' : '新建路由'}</h2>
              </div>
            <form onSubmit={handleSaveRoute}>
              <div className="form-group">
                <label>路由名称</label>
                <input type="text" name="name" defaultValue={editingRoute ? editingRoute.name : ''} required />
              </div>
              <div className="form-group">
                <label>描述</label>
                <textarea name="description" rows={3} defaultValue={editingRoute ? editingRoute.description : ''} />
              </div>
              <div className="form-group">
                <label>客户端工具</label>
                <select name="targetType" defaultValue={editingRoute ? editingRoute.targetType : 'claude-code'} required>
                  {TARGET_TYPE_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowRouteModal(false)}>取消</button>
                <button type="submit" className="btn btn-primary">保存</button>
              </div>
            </form>
            </div>
          </div>
        </div>
      )}

      {showRuleModal && (
        <div className="modal-overlay">
          <button
            type="button"
            className="modal-close-btn"
            onClick={() => setShowRuleModal(false)}
            aria-label="关闭"
          >
            ×
          </button>
          <div className="modal">
            <div className="modal-container">
              <div className="modal-header">
                <h2>{editingRule ? '编辑规则' : '新建规则'}</h2>
              </div>
            <form onSubmit={handleSaveRule}>
              <div className="form-group">
                <label>对象请求类型</label>
                <select
                  name="contentType"
                  value={selectedContentType}
                  required
                  onChange={(e) => {
                    setSelectedContentType(e.target.value);
                  }}
                >
                  {getAvailableContentTypes().map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              {/* 新增：被顶替模型字段，仅在选择模型顶替时显示 */}
              {selectedContentType === 'model-mapping' && (
                <div className="form-group">
                  <label>被顶替模型 <small>（可在日志中找出想要顶替的模型名）</small></label>
                  <input
                    type="text"
                    value={selectedReplacedModel}
                    onChange={(e) => setSelectedReplacedModel(e.target.value)}
                    placeholder="例如：gpt-4"
                  />
                </div>
              )}

              {/* 新增：排序字段 */}
              <div className="form-group">
                <label>排序（值越大优先级越高）</label>
                <input
                  type="number"
                  value={selectedSortOrder}
                  onChange={(e) => setSelectedSortOrder(parseInt(e.target.value) || 0)}
                  min="0"
                  max="1000"
                />
              </div>

              <div className="form-group">
                <label>供应商</label>
                <select
                  value={selectedVendor}
                  onChange={(e) => setSelectedVendor(e.target.value)}
                  required
                >
                  <option value="" disabled>请选择供应商</option>
                  {vendors.map(vendor => (
                    <option key={vendor.id} value={vendor.id}>{vendor.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>供应商API服务</label>
                <select
                  value={selectedService}
                  onChange={(e) => {
                    setSelectedService(e.target.value);
                    setSelectedModel('');
                  }}
                  required
                  disabled={!selectedVendor}
                >
                  <option value="" disabled>请选择API服务</option>
                  {services.map(service => (
                    <option key={service.id} value={service.id}>{service.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>供应商模型</label>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  disabled={!selectedService}
                >
                  <option value="">透传模型名</option>
                  {allServices.find(s => s.id === selectedService)?.supportedModels?.map(model => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
              </div>

              {/* Tokens超量字段 */}
              <div className="form-group">
                <label>Tokens超量（单位：k）</label>
                <input
                  type="number"
                  value={selectedTokenLimit || ''}
                  onChange={(e) => setSelectedTokenLimit(e.target.value ? parseInt(e.target.value) : undefined)}
                  min="0"
                  placeholder="不限制"
                />
                <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                  当编程工具的请求tokens达到这个量时，在配置了其他规则的情况下，本条规则将失效，从而保护你的余额。例如：输入100表示100k即100,000个tokens
                </small>
              </div>

              {/* 超时时间字段 */}
              <div className="form-group">
                <label>超时时间（秒）</label>
                <input
                  type="number"
                  value={selectedTimeout || ''}
                  onChange={(e) => setSelectedTimeout(e.target.value ? parseInt(e.target.value) : undefined)}
                  min="1"
                  placeholder="默认300秒"
                />
                <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                  设置此规则的API请求超时时间。不设置则使用默认值300秒（5分钟）
                </small>
              </div>

              {/* 重置时间字段 */}
              <div className="form-group">
                <label>Tokens超量自动重置间隔（小时）</label>
                <input
                  type="number"
                  value={selectedResetInterval || ''}
                  onChange={(e) => setSelectedResetInterval(e.target.value ? parseInt(e.target.value) : undefined)}
                  min="1"
                  placeholder="不自动重置"
                />
                <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                  设置后，系统将每隔指定小时数自动重置token计数。例如设置5小时，则每5小时重置一次
                </small>
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowRuleModal(false)}>取消</button>
                <button type="submit" className="btn btn-primary">保存</button>
              </div>
            </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
