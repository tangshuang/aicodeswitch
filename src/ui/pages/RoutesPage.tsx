import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';
import type { Route, Rule, APIService, ContentType, Vendor, ServiceBlacklistEntry } from '../../types';
import { useFlipAnimation } from '../hooks/useFlipAnimation';
import { useConfirm } from '../components/Confirm';
import { toast } from '../components/Toast';

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

/**
 * 将 Date 对象转换为 datetime-local input 所需的格式
 */
function formatDateTimeLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

/**
 * 获取配置文件相关的API方法
 */
const getConfigApi = (targetType: 'claude-code' | 'codex') => {
  return targetType === 'claude-code'
    ? {
        write: api.writeClaudeConfig,
        restore: api.restoreClaudeConfig,
        checkBackup: api.checkClaudeBackup,
        toolName: 'Claude Code'
      }
    : {
        write: api.writeCodexConfig,
        restore: api.restoreCodexConfig,
        checkBackup: api.checkCodexBackup,
        toolName: 'Codex'
      };
};

export default function RoutesPage() {
  const { confirm } = useConfirm();
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
  const [selectedTokenResetBaseTime, setSelectedTokenResetBaseTime] = useState<Date | undefined>(undefined);
  const [selectedTimeout, setSelectedTimeout] = useState<number | undefined>(undefined);
  const [selectedRequestCountLimit, setSelectedRequestCountLimit] = useState<number | undefined>(undefined);
  const [selectedRequestResetInterval, setSelectedRequestResetInterval] = useState<number | undefined>(undefined);
  const [selectedRequestResetBaseTime, setSelectedRequestResetBaseTime] = useState<Date | undefined>(undefined);
  const [hoveredRuleId, setHoveredRuleId] = useState<string | null>(null);
  const [inheritedTokenLimit, setInheritedTokenLimit] = useState<boolean>(false);
  const [inheritedRequestLimit, setInheritedRequestLimit] = useState<boolean>(false);
  const [maxTokenLimit, setMaxTokenLimit] = useState<number | undefined>(undefined);
  const [maxRequestCountLimit, setMaxRequestCountLimit] = useState<number | undefined>(undefined);
  const [blacklistStatuses, setBlacklistStatuses] = useState<Record<string, {
    isBlacklisted: boolean;
    blacklistEntry?: ServiceBlacklistEntry;
  }>>({});

  // 配置文件备份状态
  const [backupStatus, setBackupStatus] = useState<{
    'claude-code': boolean;
    'codex': boolean;
  }>({
    'claude-code': false,
    'codex': false
  });

  // 配置操作loading状态
  const [isConfiguringRoute, setIsConfiguringRoute] = useState<string | null>(null);

  // FLIP动画相关
  const { recordPositions, applyAnimation } = useFlipAnimation();
  const routeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const activatingRouteIdRef = useRef<string | null>(null);

  useEffect(() => {
    loadRoutes();
    loadVendors();
    loadAllServices();
    checkBackupStatus();
  }, []);

  // 添加页面刷新保护
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isConfiguringRoute) {
        e.preventDefault();
        e.returnValue = '正在配置路由，刷新页面可能导致配置不完整。';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isConfiguringRoute]);

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

    // 加载黑名单状态
    if (routeId) {
      try {
        const statuses = await api.getRulesBlacklistStatus(routeId);
        const statusMap = statuses.reduce((acc, status) => {
          acc[status.ruleId] = status;
          return acc;
        }, {} as Record<string, typeof statuses[0]>);
        setBlacklistStatuses(statusMap);
      } catch (error) {
        console.error('Failed to load blacklist status:', error);
      }
    }
  };

  const loadVendors = async () => {
    const data = await api.getVendors();
    setVendors(data);
  };

  const loadAllServices = async () => {
    const data = await api.getAPIServices();
    setAllServices(data);
  };

  const checkBackupStatus = async () => {
    try {
      const [claudeBackup, codexBackup] = await Promise.all([
        api.checkClaudeBackup(),
        api.checkCodexBackup()
      ]);
      setBackupStatus({
        'claude-code': claudeBackup.exists,
        'codex': codexBackup.exists
      });
    } catch (error) {
      console.error('检查备份状态失败:', error);
      // 失败时假设没有备份，避免误判
      setBackupStatus({
        'claude-code': false,
        'codex': false
      });
    }
  };

  const handleActivateRoute = async (id: string) => {
    const route = routes.find(r => r.id === id);
    if (!route) return;

    // 重新检查备份状态，避免使用过期数据
    await checkBackupStatus();
    const needsConfigWrite = !backupStatus[route.targetType];

    setIsConfiguringRoute(id);
    let configWritten = false;

    try {
      // 步骤1：覆盖配置文件（如果需要）
      if (needsConfigWrite) {
        try {
          const configApi = getConfigApi(route.targetType);
          await configApi.write();
          configWritten = true;
        } catch (error: any) {
          throw new Error(`配置文件覆盖失败: ${error.message || '未知错误'}`);
        }
      }

      // 步骤2：激活路由（使用现有的FLIP动画逻辑）
      try {
        // 记录当前被激活路由项的位置（First阶段）
        const routeElement = routeRefs.current.get(id);
        if (routeElement) {
          recordPositions(id, routeElement);
        }

        activatingRouteIdRef.current = id;
        await api.activateRoute(id);
        await loadRoutes();
        await checkBackupStatus();

        // 在下一帧应用动画（Invert和Play阶段）
        if (routeElement) {
          // 使用setTimeout确保DOM已经更新
          setTimeout(() => {
            const newRouteElement = routeRefs.current.get(id);
            if (newRouteElement) {
              applyAnimation(id, newRouteElement, 400);
            }
            activatingRouteIdRef.current = null;
          }, 0);
        }
      } catch (error: any) {
        // 如果路由激活失败且刚刚覆盖了配置，尝试回滚
        if (configWritten) {
          try {
            const configApi = getConfigApi(route.targetType);
            await configApi.restore();
            throw new Error(`路由激活失败，配置文件已回滚: ${error.message || '未知错误'}`);
          } catch (rollbackError: any) {
            throw new Error(
              `路由激活失败且配置回滚失败！请手动检查配置文件。\n` +
              `激活错误: ${error.message}\n` +
              `回滚错误: ${rollbackError.message}`
            );
          }
        }
        throw new Error(`路由激活失败: ${error.message || '未知错误'}`);
      }
    } catch (error: any) {
      console.error('激活路由失败:', error);
      toast.error(error.message);
    } finally {
      setIsConfiguringRoute(null);
    }
  };

  const handleDeactivateRoute = async (id: string) => {
    const route = routes.find(r => r.id === id);
    if (!route) return;

    const configApi = getConfigApi(route.targetType);
    setIsConfiguringRoute(id);

    try {
      // 步骤1：先恢复配置文件
      try {
        await configApi.restore();
      } catch (error: any) {
        throw new Error(
          `配置文件恢复失败: ${error.message || '未知错误'}\n\n` +
          `路由未停用，请检查配置文件权限。`
        );
      }

      // 步骤2：停用路由
      try {
        await api.deactivateRoute(id);
        await loadRoutes();
        await checkBackupStatus();
      } catch (error: any) {
        // 配置已恢复但路由停用失败
        throw new Error(
          `配置文件已恢复，但路由停用失败: ${error.message || '未知错误'}\n\n` +
          `请刷新页面后重试。`
        );
      }
    } catch (error: any) {
      console.error('停用路由失败:', error);
      toast.error(error.message);
    } finally {
      setIsConfiguringRoute(null);
    }
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
    const confirmed = await confirm({
      message: '确定要删除此路由吗？',
      title: '确认删除',
      type: 'danger',
      confirmText: '删除',
      cancelText: '取消'
    });

    if (confirmed) {
      await api.deleteRoute(id);
      loadRoutes();
      if (selectedRoute && selectedRoute.id === id) {
        setSelectedRoute(null);
        setRules([]);
      }
      toast.success('路由已删除');
    }
  };

  const handleSaveRule = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    // 验证超量值不超过API服务的限制
    if (selectedTokenLimit !== undefined && maxTokenLimit !== undefined && selectedTokenLimit > maxTokenLimit) {
      toast.warning(`Token超量值 (${selectedTokenLimit}k) 不能超过API服务的限制 (${maxTokenLimit}k)`);
      return;
    }

    if (selectedRequestCountLimit !== undefined && maxRequestCountLimit !== undefined && selectedRequestCountLimit > maxRequestCountLimit) {
      toast.warning(`请求次数超量值 (${selectedRequestCountLimit}) 不能超过API服务的限制 (${maxRequestCountLimit})`);
      return;
    }

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
      tokenResetBaseTime: selectedTokenResetBaseTime ? selectedTokenResetBaseTime.getTime() : undefined,
      requestCountLimit: selectedRequestCountLimit,
      requestResetInterval: selectedRequestResetInterval,
      requestResetBaseTime: selectedRequestResetBaseTime ? selectedRequestResetBaseTime.getTime() : undefined,
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
    const confirmed = await confirm({
      message: '确定要删除此路由吗？',
      title: '确认删除',
      type: 'danger',
      confirmText: '删除',
      cancelText: '取消'
    });

    if (confirmed) {
      await api.deleteRule(id);
      if (selectedRoute) {
        loadRules(selectedRoute.id);
      }
      toast.success('规则已删除');
    }
  };

  // const handleResetTokens = async (id: string) => {
  //   if (confirm('确定要重置此规则的Token计数吗？')) {
  //     await api.resetRuleTokens(id);
  //     if (selectedRoute) {
  //       loadRules(selectedRoute.id);
  //     }
  //   }
  // };

  // const handleResetRequests = async (id: string) => {
  //   if (confirm('确定要重置此规则的请求次数吗？')) {
  //     await api.resetRuleRequests(id);
  //     if (selectedRoute) {
  //       loadRules(selectedRoute.id);
  //     }
  //   }
  // };

  const handleClearBlacklist = async (id: string) => {
    try {
      await api.clearRuleBlacklist(id);
      if (selectedRoute) {
        loadRules(selectedRoute.id);
      }
      toast.success('已恢复');
    } catch (error: any) {
      toast.error('恢复失败: ' + error.message);
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
        setSelectedTokenResetBaseTime(
          (rule as any).tokenResetBaseTime ? new Date((rule as any).tokenResetBaseTime) : undefined
        );
        setSelectedRequestCountLimit(rule.requestCountLimit);
        setSelectedRequestResetInterval(rule.requestResetInterval);
        setSelectedRequestResetBaseTime(
          (rule as any).requestResetBaseTime ? new Date((rule as any).requestResetBaseTime) : undefined
        );

        // 设置API服务的限制值和继承状态
        if (service.enableTokenLimit && service.tokenLimit) {
          setMaxTokenLimit(service.tokenLimit);
          setInheritedTokenLimit(true);
        } else {
          setMaxTokenLimit(undefined);
          setInheritedTokenLimit(false);
        }

        if (service.enableRequestLimit && service.requestCountLimit) {
          setMaxRequestCountLimit(service.requestCountLimit);
          setInheritedRequestLimit(true);
        } else {
          setMaxRequestCountLimit(undefined);
          setInheritedRequestLimit(false);
        }
      }, 0);
    }
    setShowRuleModal(true);
  };

  // 判断规则状态
  const getRuleStatus = (rule: Rule) => {
    const blacklistStatus = blacklistStatuses[rule.id];
    const issues: string[] = [];

    // 1. 检查黑名单（包括timeout）
    if (blacklistStatus?.isBlacklisted) {
      const entry = blacklistStatus.blacklistEntry;
      if (entry?.errorType === 'timeout') {
        issues.push('请求超时');
      } else if (entry?.lastStatusCode) {
        issues.push(`HTTP ${entry.lastStatusCode}错误`);
      }
    }

    // 2. 检查token限制
    if (rule.tokenLimit && rule.totalTokensUsed !== undefined) {
      if (rule.totalTokensUsed >= rule.tokenLimit) {
        issues.push('Token超限');
      }
    }

    // 3. 检查请求次数限制
    if (rule.requestCountLimit && rule.totalRequestsUsed !== undefined) {
      if (rule.totalRequestsUsed >= rule.requestCountLimit) {
        issues.push('次数超限');
      }
    }

    // 如果有任何错误，显示第一个错误
    if (issues.length > 0) {
      return {
        status: 'error',
        label: blacklistStatus?.isBlacklisted
          ? (blacklistStatus.blacklistEntry?.errorType === 'timeout' ? '超时' : '服务错误')
          : issues[0],
        reason: issues.join(', ')
      };
    }

    // 检查警告状态
    const warnings: string[] = [];

    if (rule.tokenLimit && rule.totalTokensUsed !== undefined) {
      const usagePercent = (rule.totalTokensUsed / rule.tokenLimit) * 100;
      if (usagePercent >= 80) {
        warnings.push(`Token ${usagePercent.toFixed(0)}%`);
      }
    }

    if (rule.requestCountLimit && rule.totalRequestsUsed !== undefined) {
      const usagePercent = (rule.totalRequestsUsed / rule.requestCountLimit) * 100;
      if (usagePercent >= 80) {
        warnings.push(`次数 ${usagePercent.toFixed(0)}%`);
      }
    }

    if (warnings.length > 0) {
      return { status: 'warning', label: '接近限制', reason: warnings.join(', ') };
    }

    // 正常状态
    return { status: 'success', label: '正常', reason: '' };
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
    setSelectedTokenResetBaseTime(undefined);
    setSelectedRequestCountLimit(undefined);
    setSelectedRequestResetInterval(undefined);
    setSelectedRequestResetBaseTime(undefined);
    setInheritedTokenLimit(false);
    setInheritedRequestLimit(false);
    setMaxTokenLimit(undefined);
    setMaxRequestCountLimit(undefined);
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
                  ref={(el) => {
                    if (el) {
                      routeRefs.current.set(route.id, el);
                    } else {
                      routeRefs.current.delete(route.id);
                    }
                  }}
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
                      {route.isActive && <span className={`badge ${route.targetType === 'claude-code' ? 'badge-claude-code' : 'badge-codex'}`}
                        style={{
                          position: 'absolute',
                          top: -16,
                          right: -8
                        }}>{TARGET_TYPE_OPTIONS.find(opt => opt.value === route.targetType)?.label} 已激活</span>}
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
                          disabled={isConfiguringRoute !== null}
                        >
                          {isConfiguringRoute === route.id ? '处理中...' : '激活'}
                        </button>
                      ) : (
                        <button
                          className="btn btn-warning"
                          style={{ padding: '4px 8px', fontSize: '12px' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeactivateRoute(route.id);
                          }}
                          disabled={isConfiguringRoute !== null}
                        >
                          {isConfiguringRoute === route.id ? '处理中...' : '停用'}
                        </button>
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
                  <th>类型</th>
                  <th>API服务</th>
                  <th>状态</th>
                  <th>用量情况</th>
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
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.6em', flexWrap: 'wrap' }}>
                          <span>{vendor ? vendor.name : 'Unknown'}:</span>
                          <span>{service ? service.name : 'Unknown'}:</span>
                          <span>{rule.targetModel || '透传模型'}</span>
                        </div>
                      </td>
                      <td>
                        {/* 新增：状态列 */}
                        {(() => {
                          const ruleStatus = getRuleStatus(rule);
                          const blacklistStatus = blacklistStatuses[rule.id];
                          const isBlacklistedOnly = blacklistStatus?.isBlacklisted &&
                            !ruleStatus.reason?.includes('Token超限') &&
                            !ruleStatus.reason?.includes('次数超限');

                          return (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                {ruleStatus.status === 'success' && (
                                  <span style={{ color: '#28a745', fontWeight: 'bold', fontSize: '14px' }}>✓</span>
                                )}
                                {ruleStatus.status === 'warning' && (
                                  <span style={{ color: '#ffc107', fontWeight: 'bold', fontSize: '14px' }}>⚠</span>
                                )}
                                {ruleStatus.status === 'error' && (
                                  <span style={{ color: '#dc3545', fontWeight: 'bold', fontSize: '14px' }}>✗</span>
                                )}
                                <span style={{
                                  fontSize: '13px',
                                  color: ruleStatus.status === 'success' ? '#28a745' :
                                         ruleStatus.status === 'warning' ? '#ffc107' :
                                         '#dc3545',
                                  fontWeight: ruleStatus.status !== 'success' ? 'bold' : 'normal'
                                }}>
                                  {ruleStatus.label}
                                </span>
                                {ruleStatus.reason && (
                                  <div
                                    style={{ position: 'relative', display: 'inline-block', cursor: 'help' }}
                                    onMouseEnter={() => setHoveredRuleId(rule.id + '-status')}
                                    onMouseLeave={() => setHoveredRuleId(null)}
                                  >
                                    <span style={{ fontSize: '12px', color: '#999', marginLeft: '4px' }}> ⓘ</span>
                                    {hoveredRuleId === rule.id + '-status' && (
                                      <div style={{
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
                                      }}>
                                        {ruleStatus.reason}
                                        <div style={{
                                          position: 'absolute',
                                          left: '50%',
                                          transform: 'translateX(-50%)',
                                          bottom: '-4px',
                                          width: '0',
                                          height: '0',
                                          borderLeft: '4px solid transparent',
                                          borderRight: '4px solid transparent',
                                          borderTop: '4px solid var(--bg-popover, #333)',
                                        }}/>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                              {isBlacklistedOnly && (
                                <button
                                  className="btn btn-info"
                                  style={{ padding: '2px 8px', fontSize: '11px' }}
                                  onClick={() => handleClearBlacklist(rule.id)}
                                >
                                  恢复
                                </button>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      <td>
                        <div style={{ fontSize: '13px' }}>
                          {/* Token限制 */}
                          <div>
                            <span style={{ fontWeight: 'bold', fontSize: '12px' }}>Token:</span>
                            {rule.tokenLimit ? (
                              <>
                                <span style={{
                                  color: rule.totalTokensUsed && rule.tokenLimit && rule.totalTokensUsed >= rule.tokenLimit ? 'red' : 'inherit'
                                }}>
                                  {((rule.totalTokensUsed || 0) / 1000).toFixed(1)}K/{(rule.tokenLimit / 1000).toFixed(0)}K
                                </span>
                                {rule.totalTokensUsed && rule.tokenLimit && rule.totalTokensUsed >= rule.tokenLimit ? (
                                  <span style={{ color: 'red', marginLeft: '4px', fontWeight: 'bold', fontSize: '11px' }}>超限</span>
                                ) : null}
                              </>
                            ) : (
                              <span style={{ color: '#999' }}>不限制</span>
                            )}
                          </div>
                          {/* 请求次数限制 */}
                          <div style={{ marginTop: '6px' }}>
                            <span style={{ fontWeight: 'bold', fontSize: '12px' }}>次数:</span>
                            {rule.requestCountLimit ? (
                              <>
                                <span style={{
                                  color: rule.totalRequestsUsed && rule.requestCountLimit && rule.totalRequestsUsed >= rule.requestCountLimit ? 'red' : 'inherit'
                                }}>
                                  {rule.totalRequestsUsed || 0}/{rule.requestCountLimit}
                                </span>
                                {rule.totalRequestsUsed && rule.requestCountLimit && rule.totalRequestsUsed >= rule.requestCountLimit ? (
                                  <span style={{ color: 'red', marginLeft: '4px', fontWeight: 'bold', fontSize: '11px' }}>超限</span>
                                ) : null}
                              </>
                            ) : (
                              <span style={{ color: '#999' }}>不限制</span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="action-buttons">
                          <button className="btn btn-secondary" onClick={() => handleEditRule(rule)}>编辑</button>
                          {/* {rule.tokenLimit && (
                            <button className="btn btn-info" onClick={() => handleResetTokens(rule.id)}>重置Token</button>
                          )} */}
                          {/* {rule.requestCountLimit && (
                            <button className="btn btn-info" onClick={() => handleResetRequests(rule.id)}>重置次数</button>
                          )} */}
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
              color: 'var(--text-info-box)',
              marginTop: '16px',
              padding: '12px',
              backgroundColor: 'var(--bg-info-box)',
              borderRadius: '6px',
              border: '1px solid var(--border-info-box)',
              lineHeight: '1.6'
            }}>
              <strong>💡 智能故障切换机制</strong>
              <div style={{ marginTop: '6px' }}>
                • 当同一请求类型配置多个规则时,系统会按排序优先使用第一个<br/>
                • 如果某个服务报错(4xx/5xx)或请求超时,将自动切换到下一个可用服务<br/>
                • 报错或超时的服务会被标记为不可用,有效期10分钟<br/>
                • 10分钟后自动解除标记,如果再次报错或超时则重新标记<br/>
                • 确保您的请求始终路由到稳定可用的服务<br/>
                • 规则状态列会实时显示每个规则的可用性状态<br/>
                • 如不需要此功能,可在<strong>设置</strong>页面关闭"启用智能故障切换"选项
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 配置文件自动管理说明 - 独立容器 */}
      <div className="card" style={{ marginTop: '20px' }}>
        <div className="toolbar">
          <h3>📝 配置文件自动管理</h3>
        </div>
        <div style={{ padding: '20px', lineHeight: '1.8' }}>
          <div style={{
            background: 'var(--bg-info-blue)',
            padding: '15px',
            borderRadius: '8px',
            marginBottom: '15px',
            borderLeft: '4px solid var(--border-info-blue)'
          }}>
            <strong>💡 工作原理</strong>
            <p style={{ marginTop: '8px', marginBottom: '0' }}>
              激活路由时，系统会自动修改编程工具的配置文件，使其通过本代理服务器访问AI服务。
              停用路由时，系统会自动恢复原始配置。
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
            <div style={{
              background: 'var(--bg-info-green)',
              padding: '15px',
              borderRadius: '8px',
              borderLeft: '4px solid var(--border-info-green)'
            }}>
              <strong>✓ 激活路由</strong>
              <ul style={{ marginTop: '8px', paddingLeft: '20px', marginBottom: '0' }}>
                <li>首次激活：自动备份并覆盖配置文件</li>
                <li>再次激活：仅切换路由，不重复覆盖</li>
              </ul>
            </div>

            <div style={{
              background: 'var(--bg-info-orange)',
              padding: '15px',
              borderRadius: '8px',
              borderLeft: '4px solid var(--border-info-orange)'
            }}>
              <strong>○ 停用路由</strong>
              <ul style={{ marginTop: '8px', paddingLeft: '20px', marginBottom: '0' }}>
                <li>自动恢复原始配置文件</li>
                <li>删除备份文件</li>
              </ul>
            </div>
          </div>

          <div style={{
            marginTop: '15px',
            padding: '12px 15px',
            background: 'var(--bg-info-yellow)',
            borderRadius: '8px',
            borderLeft: '4px solid var(--border-info-yellow)'
          }}>
            <strong>⚠️ 重要提示</strong>
            <ul style={{ marginTop: '8px', paddingLeft: '20px', marginBottom: '0' }}>
              <li>激活（首次）/停用路由后，<strong>必须重启对应的编程工具</strong>才能使配置生效</li>
              <li>操作前建议关闭编程工具，避免配置冲突</li>
            </ul>
          </div>

          <details style={{ marginTop: '15px', cursor: 'pointer' }}>
            <summary style={{ fontWeight: 'bold', color: '#666' }}>📂 配置文件位置（点击展开）</summary>
            <ul style={{ marginTop: '8px', paddingLeft: '20px', color: '#666' }}>
              <li><strong>Claude Code:</strong> ~/.claude/settings.json, ~/.claude.json</li>
              <li><strong>Codex:</strong> ~/.codex/config.toml, ~/.codex/auth.json</li>
            </ul>
          </details>
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
                    const serviceId = e.target.value;
                    setSelectedService(serviceId);
                    setSelectedModel('');

                    // 获取选中的API服务
                    const service = allServices.find(s => s.id === serviceId);
                    if (service) {
                      // 如果API服务启用了Token超量限制，自动填充并设置最大值
                      if (service.enableTokenLimit && service.tokenLimit) {
                        setSelectedTokenLimit(service.tokenLimit);
                        setSelectedResetInterval(service.tokenResetInterval);
                        setSelectedTokenResetBaseTime(
                          service.tokenResetBaseTime ? new Date(service.tokenResetBaseTime) : undefined
                        );
                        setMaxTokenLimit(service.tokenLimit);
                        setInheritedTokenLimit(true);
                      } else {
                        setMaxTokenLimit(undefined);
                        setInheritedTokenLimit(false);
                      }

                      // 如果API服务启用了请求次数超量限制，自动填充并设置最大值
                      if (service.enableRequestLimit && service.requestCountLimit) {
                        setSelectedRequestCountLimit(service.requestCountLimit);
                        setSelectedRequestResetInterval(service.requestResetInterval);
                        setSelectedRequestResetBaseTime(
                          service.requestResetBaseTime ? new Date(service.requestResetBaseTime) : undefined
                        );
                        setMaxRequestCountLimit(service.requestCountLimit);
                        setInheritedRequestLimit(true);
                      } else {
                        setMaxRequestCountLimit(undefined);
                        setInheritedRequestLimit(false);
                      }
                    }
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
                  onChange={(e) => {
                    const value = e.target.value ? parseInt(e.target.value) : undefined;
                    if (value !== undefined && maxTokenLimit !== undefined && value > maxTokenLimit) {
                      toast.warning(`Token超量值不能超过API服务的限制 (${maxTokenLimit}k)`);
                      return;
                    }
                    setSelectedTokenLimit(value);
                  }}
                  min="0"
                  max={maxTokenLimit}
                  placeholder={inheritedTokenLimit ? `最大 ${maxTokenLimit}k` : "不限制"}
                />
                {inheritedTokenLimit && maxTokenLimit && (
                  <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                    ⚠️ API服务限制：最大 {maxTokenLimit}k，当前值不能超过此限制
                  </small>
                )}
                {!inheritedTokenLimit && (
                  <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                    当编程工具的请求tokens达到这个量时，在配置了其他规则的情况下，本条规则将失效，从而保护你的余额。例如：输入100表示100k即100,000个tokens
                  </small>
                )}
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
                  disabled={inheritedTokenLimit}
                />
                {inheritedTokenLimit && (
                  <small style={{ color: '#999', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                    此配置从API服务继承，不可修改
                  </small>
                )}
                {!inheritedTokenLimit && (
                  <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                    设置后，系统将每隔指定小时数自动重置token计数。例如设置5小时，则每5小时重置一次
                  </small>
                )}
              </div>

              {/* Token下一次重置时间基点字段 */}
              <div className="form-group">
                <label>Token下一次重置时间基点</label>
                <input
                  type="datetime-local"
                  value={selectedTokenResetBaseTime ? formatDateTimeLocal(selectedTokenResetBaseTime) : ''}
                  onChange={(e) => {
                    if (e.target.value) {
                      setSelectedTokenResetBaseTime(new Date(e.target.value));
                    } else {
                      setSelectedTokenResetBaseTime(undefined);
                    }
                  }}
                  disabled={!selectedResetInterval || inheritedTokenLimit}
                  className="datetime-picker-input"
                />
                {inheritedTokenLimit && (
                  <small style={{ color: '#999', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                    此配置从API服务继承，不可修改
                  </small>
                )}
                {!inheritedTokenLimit && (
                  <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                    配合"Tokens超量自动重置间隔"使用，设置下一次重置的精确时间点。例如，每月1日0点重置（间隔720小时），或每周一0点重置（间隔168小时）。设置后，系统会基于此时间点自动计算后续重置周期
                  </small>
                )}
              </div>

              {/* 请求次数超量字段 */}
              <div className="form-group">
                <label>请求次数超量</label>
                <input
                  type="number"
                  value={selectedRequestCountLimit || ''}
                  onChange={(e) => {
                    const value = e.target.value ? parseInt(e.target.value) : undefined;
                    if (value !== undefined && maxRequestCountLimit !== undefined && value > maxRequestCountLimit) {
                      toast.warning(`请求次数超量值不能超过API服务的限制 (${maxRequestCountLimit})`);
                      return;
                    }
                    setSelectedRequestCountLimit(value);
                  }}
                  min="0"
                  max={maxRequestCountLimit}
                  placeholder={inheritedRequestLimit ? `最大 ${maxRequestCountLimit}` : "不限制"}
                />
                {inheritedRequestLimit && maxRequestCountLimit && (
                  <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                    ⚠️ API服务限制：最大 {maxRequestCountLimit}，当前值不能超过此限制
                  </small>
                )}
                {!inheritedRequestLimit && (
                  <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                    当请求次数达到这个量时，在配置了其他规则的情况下，本条规则将失效
                  </small>
                )}
              </div>

              {/* 请求次数自动重置间隔字段 */}
              <div className="form-group">
                <label>请求次数自动重置间隔（小时）</label>
                <input
                  type="number"
                  value={selectedRequestResetInterval || ''}
                  onChange={(e) => setSelectedRequestResetInterval(e.target.value ? parseInt(e.target.value) : undefined)}
                  min="1"
                  placeholder="不自动重置"
                  disabled={inheritedRequestLimit}
                />
                {inheritedRequestLimit && (
                  <small style={{ color: '#999', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                    此配置从API服务继承，不可修改
                  </small>
                )}
                {!inheritedRequestLimit && (
                  <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                    设置后，系统将每隔指定小时数自动重置请求次数计数。例如设置24小时，则每24小时重置一次
                  </small>
                )}
              </div>

              {/* 下一次重置时间基点字段 */}
              <div className="form-group">
                <label>下一次重置时间基点</label>
                <input
                  type="datetime-local"
                  value={selectedRequestResetBaseTime ? formatDateTimeLocal(selectedRequestResetBaseTime) : ''}
                  onChange={(e) => {
                    if (e.target.value) {
                      setSelectedRequestResetBaseTime(new Date(e.target.value));
                    } else {
                      setSelectedRequestResetBaseTime(undefined);
                    }
                  }}
                  disabled={!selectedRequestResetInterval || inheritedRequestLimit}
                  className="datetime-picker-input"
                />
                {inheritedRequestLimit && (
                  <small style={{ color: '#999', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                    此配置从API服务继承，不可修改
                  </small>
                )}
                {!inheritedRequestLimit && (
                  <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                    配合"请求次数自动重置间隔"使用，设置下一次重置的精确时间点。例如，每月1日0点重置（间隔720小时），或每周一0点重置（间隔168小时）。设置后，系统会基于此时间点自动计算后续重置周期
                  </small>
                )}
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
