import { useState, useEffect } from 'react';
import { api } from '../api/client';
import type { Route, Rule, APIService, ContentType, Vendor } from '../../types';

const CONTENT_TYPE_OPTIONS = [
  { value: 'default', label: '默认' },
  { value: 'background', label: '后台' },
  { value: 'thinking', label: '思考' },
  { value: 'long-context', label: '长上下文' },
  { value: 'image-understanding', label: '图像理解' },
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
    setRoutes(data);
    if (data.length > 0 && !selectedRoute) {
      setSelectedRoute(data[0]);
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

  const getAvailableContentTypes = () => {
    const usedTypes = new Set(rules.map(route => route.contentType));
    return CONTENT_TYPE_OPTIONS.filter(option => !usedTypes.has(option.value as ContentType));
  };

  const handleEditRule = (rule: Rule) => {
    setEditingRule(rule);
    const service = allServices.find(s => s.id === rule.targetServiceId);
    if (service) {
      setSelectedVendor(service.vendorId);
      // 直接设置当前供应商的服务列表，避免 useEffect 的异步延迟
      setServices(allServices.filter(s => s.vendorId === service.vendorId));
      // 使用 setTimeout 确保状态更新完成后再设置 selectedService 和 selectedModel
      setTimeout(() => {
        setSelectedService(service.id);
        setSelectedModel(rule.targetModel || '');
      }, 0);
    }
    setShowRuleModal(true);
  };

  const handleNewRule = () => {
    setEditingRule(null);
    setSelectedVendor('');
    setSelectedService('');
    setSelectedModel('');
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
                      {route.isActive && <span className="badge badge-success">{TARGET_TYPE_OPTIONS.find(opt => opt.value === route.targetType)?.label} 已激活</span>}
                    </div>
                     <div style={{ fontSize: '12px', color: 'var(--text-route-muted)', marginTop: '2px' }}>
                       路由对象: {TARGET_TYPE_OPTIONS.find(opt => opt.value === route.targetType)?.label}
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
                  <th>对象请求类型</th>
                  <th>供应商</th>
                  <th>API服务</th>
                  <th>模型</th>
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
                      <td>{contentTypeLabel}</td>
                      <td>{vendor ? vendor.name : 'Unknown'}</td>
                      <td>{service ? service.name : 'Unknown'}</td>
                      <td>{rule.targetModel || '-'}</td>
                      <td>
                        <div className="action-buttons">
                          <button className="btn btn-secondary" onClick={() => handleEditRule(rule)}>编辑</button>
                          <button className="btn btn-danger" onClick={() => handleDeleteRule(rule.id)}>删除</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showRouteModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
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
                <label>路由对象</label>
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
      )}

      {showRuleModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editingRule ? '编辑规则' : '新建规则'}</h2>
            </div>
            <form onSubmit={handleSaveRule}>
              <div className="form-group">
                <label>对象请求类型</label>
                <select
                  name="contentType"
                  defaultValue={editingRule ? editingRule.contentType : ''}
                  required
                >
                  <option value="" disabled>请选择对象请求类型</option>
                  {getAvailableContentTypes().map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
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
                <label>API服务</label>
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
                <label>模型</label>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  disabled={!selectedService}
                >
                  <option value="" disabled>请选择模型</option>
                  {allServices.find(s => s.id === selectedService)?.supportedModels?.map(model => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowRuleModal(false)}>取消</button>
                <button type="submit" className="btn btn-primary">保存</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
