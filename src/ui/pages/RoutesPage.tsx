import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';
import type { Route, Rule, APIService, ContentType, Vendor, ServiceBlacklistEntry, MCPServer, ToolInstallationStatus } from '../../types';
import { useFlipAnimation } from '../hooks/useFlipAnimation';
import { useConfirm } from '../components/Confirm';
import { toast } from '../components/Toast';
import { useRulesStatus } from '../hooks/useRulesStatus';

const CONTENT_TYPE_OPTIONS = [
  { value: 'default', label: '默认' },
  { value: 'background', label: '后台', icon: '⚙' },
  { value: 'thinking', label: '思考', icon: '💭' },
  { value: 'high-iq', label: '高智商', icon: '🧠' },
  { value: 'long-context', label: '长上下文', icon: '📄' },
  { value: 'image-understanding', label: '图像理解', icon: '🖼' },
  { value: 'model-mapping', label: '模型顶替', icon: '🔄' },
];

// 类型排序权重（数值越小越靠前）
const CONTENT_TYPE_ORDER: Record<string, number> = {
  'default': 0,
  'background': 1,
  'thinking': 2,
  'high-iq': 3,
  'long-context': 4,
  'image-understanding': 5,
  'model-mapping': 6,
};

// 类型到图标的映射
const CONTENT_TYPE_ICONS: Record<string, string> = {
  'background': '🧱',
  'thinking': '💭',
  'high-iq': '🧠',
  'long-context': '📄',
  'image-understanding': '🖼️',
  'model-mapping': '🔄',
};

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
  const { ruleStatuses } = useRulesStatus();
  const [routes, setRoutes] = useState<Route[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [allServices, setAllServices] = useState<APIService[]>([]);
  const [services, setServices] = useState<APIService[]>([]);
  const [mcps, setMCPs] = useState<MCPServer[]>([]);
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
  const [selectedFrequencyLimit, setSelectedFrequencyLimit] = useState<number | undefined>(undefined);
  const [selectedFrequencyWindow, setSelectedFrequencyWindow] = useState<number | undefined>(undefined);
  const [hoveredRuleId, setHoveredRuleId] = useState<string | null>(null);
  const [inheritedTokenLimit, setInheritedTokenLimit] = useState<boolean>(false);
  const [inheritedRequestLimit, setInheritedRequestLimit] = useState<boolean>(false);
  const [maxTokenLimit, setMaxTokenLimit] = useState<number | undefined>(undefined);
  const [maxRequestCountLimit, setMaxRequestCountLimit] = useState<number | undefined>(undefined);
  const [blacklistStatuses, setBlacklistStatuses] = useState<Record<string, {
    isBlacklisted: boolean;
    blacklistEntry?: ServiceBlacklistEntry;
  }>>({});
  const [useMCP, setUseMCP] = useState<boolean>(false);
  const [selectedMCPId, setSelectedMCPId] = useState<string>('');

  // 超量配置展开状态
  const [showTokenLimit, setShowTokenLimit] = useState(false);
  const [showRequestLimit, setShowRequestLimit] = useState(false);

  // Claude Code 版本检查状态
  const [claudeVersionCheck, setClaudeVersionCheck] = useState<ToolInstallationStatus | null>(null);

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
    loadMCPs();
    checkBackupStatus();
    checkClaudeVersion();
  }, []);

  // 添加页面刷新保护
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isConfiguringRoute) {
        e.preventDefault();
        // 现代浏览器会忽略自定义消息，显示标准确认对话框
        // 为了兼容性，仍然设置 returnValue（但会被浏览器忽略）
        e.returnValue = '';
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
  }, [selectedVendor]);  // 移除 allServices 依赖，避免无限循环

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

  // 检查Claude Code版本
  const checkClaudeVersion = async () => {
    try {
      const versionInfo = await api.checkClaudeVersion();
      setClaudeVersionCheck(versionInfo);
    } catch (error) {
      console.error('Failed to check Claude version:', error);
    }
  };

  // 比较版本号（返回: 1=version1>version2, -1=version1<version2, 0=equal）
  const compareVersions = (v1: string | null | undefined, v2: string): number => {
    if (!v1) return -1;
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < 3; i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;
      if (p1 > p2) return 1;
      if (p1 < p2) return -1;
    }
    return 0;
  };

  // 检查是否支持 Agent Teams 功能
  const isAgentTeamsSupported = () => {
    if (!claudeVersionCheck?.claudeCode?.version) return false;
    return compareVersions(claudeVersionCheck.claudeCode.version, '2.1.32') >= 0;
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

  const loadMCPs = async () => {
    const data = await api.getMCPs();
    setMCPs(data);
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
          // 对于Claude Code路由，传递enableAgentTeams设置
          if (route.targetType === 'claude-code') {
            await api.writeClaudeConfig(route.enableAgentTeams);
          } else {
            await configApi.write();
          }
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
              applyAnimation(id, newRouteElement, 250);
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

    // 如果使用MCP，验证必须选择MCP
    if (selectedContentType === 'image-understanding' && useMCP && !selectedMCPId) {
      toast.warning('请选择一个MCP工具');
      return;
    }

    // 如果不使用MCP，验证必须选择服务
    if (!useMCP && !selectedService) {
      toast.warning('请选择供应商API服务');
      return;
    }

    // 验证超量值不超过API服务的限制
    if (!useMCP && selectedTokenLimit !== undefined && maxTokenLimit !== undefined && selectedTokenLimit > maxTokenLimit) {
      toast.warning(`Token超量值 (${selectedTokenLimit}k) 不能超过API服务的限制 (${maxTokenLimit}k)`);
      return;
    }

    if (!useMCP && selectedRequestCountLimit !== undefined && maxRequestCountLimit !== undefined && selectedRequestCountLimit > maxRequestCountLimit) {
      toast.warning(`请求次数超量值 (${selectedRequestCountLimit}) 不能超过API服务的限制 (${maxRequestCountLimit})`);
      return;
    }

    const formData = new FormData(e.currentTarget);
    const rule = {
      routeId: selectedRoute!.id,
      contentType: formData.get('contentType') as ContentType,
      targetServiceId: useMCP ? '' : selectedService,
      targetModel: useMCP ? undefined : (selectedModel || undefined),
      replacedModel: selectedReplacedModel || undefined,
      sortOrder: selectedSortOrder,
      timeout: selectedTimeout ? selectedTimeout * 1000 : undefined, // 转换为毫秒
      tokenLimit: useMCP ? undefined : (selectedTokenLimit || undefined), // k值（与Service保持一致）
      resetInterval: useMCP ? undefined : selectedResetInterval,
      tokenResetBaseTime: useMCP ? undefined : (selectedTokenResetBaseTime ? selectedTokenResetBaseTime.getTime() : undefined),
      requestCountLimit: useMCP ? undefined : selectedRequestCountLimit,
      requestResetInterval: useMCP ? undefined : selectedRequestResetInterval,
      requestResetBaseTime: useMCP ? undefined : (selectedRequestResetBaseTime ? selectedRequestResetBaseTime.getTime() : undefined),
      frequencyLimit: selectedFrequencyLimit,
      frequencyWindow: selectedFrequencyWindow,
      useMCP: selectedContentType === 'image-understanding' ? useMCP : false,
      mcpId: (selectedContentType === 'image-understanding' && useMCP) ? selectedMCPId : undefined,
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

  const handleToggleRuleDisable = async (id: string) => {
    try {
      const result = await api.toggleRuleDisable(id);
      if (selectedRoute) {
        loadRules(selectedRoute.id);
      }
      toast.success(result.isDisabled ? '规则已屏蔽' : '规则已启用');
    } catch (error: any) {
      toast.error('操作失败: ' + error.message);
    }
  };

  // 提升规则优先级（sortOrder + 1）
  const handleIncreasePriority = async (id: string) => {
    try {
      // 找到对应的规则
      const rule = rules.find(r => r.id === id);
      if (!rule) return;

      // 计算新的优先级（当前优先级 + 1）
      const newSortOrder = (rule.sortOrder || 0) + 1;

      // 调用 API 更新
      await api.updateRule(id, { sortOrder: newSortOrder });

      // 重新加载规则列表
      if (selectedRoute) {
        loadRules(selectedRoute.id);
      }
      toast.success('优先级已提升');
    } catch (error: any) {
      toast.error('操作失败: ' + error.message);
    }
  };

  // 降低规则优先级（sortOrder - 1）
  const handleDecreasePriority = async (id: string) => {
    try {
      // 找到对应的规则
      const rule = rules.find(r => r.id === id);
      if (!rule) return;

      // 计算新的优先级（当前优先级 - 1），最小为 0
      const newSortOrder = Math.max(0, (rule.sortOrder || 0) - 1);

      // 调用 API 更新
      await api.updateRule(id, { sortOrder: newSortOrder });

      // 重新加载规则列表
      if (selectedRoute) {
        loadRules(selectedRoute.id);
      }
      toast.success('优先级已降低');
    } catch (error: any) {
      toast.error('操作失败: ' + error.message);
    }
  };

  const handleToggleAgentTeams = async (newValue: boolean) => {
    if (!selectedRoute) return;

    // 检查版本是否支持
    if (newValue && !isAgentTeamsSupported()) {
      toast.error('当前 Claude Code 版本不支持 Agent Teams 功能，需要版本 ≥ 2.1.32');
      return;
    }

    try {
      if (selectedRoute.isActive) {
        // 路由激活时：同时更新配置文件和路由数据库
        await api.updateClaudeAgentTeams(newValue);
        await api.updateRoute(selectedRoute.id, { enableAgentTeams: newValue });
        toast.success(newValue ? 'Agent Teams 功能已开启' : 'Agent Teams 功能已关闭');
      } else {
        // 路由未激活时：只更新路由数据库
        await api.updateRoute(selectedRoute.id, { enableAgentTeams: newValue });
        toast.success(newValue ? 'Agent Teams 设置已保存（将在激活时生效）' : 'Agent Teams 设置已取消');
      }
      // 立即更新 selectedRoute 状态，避免 UI 延迟
      setSelectedRoute({ ...selectedRoute, enableAgentTeams: newValue });
      await loadRoutes();
    } catch (error: any) {
      toast.error('更新失败: ' + error.message);
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
    setUseMCP(rule.useMCP || false);
    setSelectedMCPId(rule.mcpId || '');

    const service = allServices.find(s => s.id === rule.targetServiceId);
    if (service) {
      if (service.vendorId) {
        setSelectedVendor(service.vendorId);
        // 直接设置当前供应商的服务列表，避免 useEffect 的异步延迟
        setServices(allServices.filter(s => s.vendorId === service.vendorId));
      }
      // 使用 setTimeout 确保状态更新完成后再设置 selectedService 和 selectedModel
      setTimeout(() => {
        setSelectedService(service.id);
        setSelectedModel(rule.targetModel || '');
        setSelectedReplacedModel(rule.replacedModel || '');
        setSelectedSortOrder(rule.sortOrder || 0);
        setSelectedTimeout(rule.timeout ? rule.timeout / 1000 : undefined); // 转换为秒
        setSelectedTokenLimit(rule.tokenLimit || undefined); // k值（与Service保持一致）
        setSelectedResetInterval(rule.resetInterval);
        setSelectedTokenResetBaseTime(
          (rule as any).tokenResetBaseTime ? new Date((rule as any).tokenResetBaseTime) : undefined
        );
        setSelectedRequestCountLimit(rule.requestCountLimit);
        setSelectedRequestResetInterval(rule.requestResetInterval);
        setSelectedRequestResetBaseTime(
          (rule as any).requestResetBaseTime ? new Date((rule as any).requestResetBaseTime) : undefined
        );

        // 加载频率限制
        setSelectedFrequencyLimit(rule.frequencyLimit);
        setSelectedFrequencyWindow(rule.frequencyWindow);

        // 设置API服务的限制值和继承状态
        // 只有当规则的限制值与 API 服务的值完全一致时，才显示为继承状态
        if (service.enableTokenLimit && service.tokenLimit) {
          setMaxTokenLimit(service.tokenLimit);
          // 检查规则的限制是否与 API 服务一致
          // 规则必须有完整的配置才认为是继承的
          const isTokenInherited = rule.tokenLimit === service.tokenLimit &&
            rule.resetInterval === (service.tokenResetInterval || undefined) &&
            rule.tokenLimit !== null &&
            rule.resetInterval !== null;
          setInheritedTokenLimit(isTokenInherited);
        } else {
          setMaxTokenLimit(undefined);
          setInheritedTokenLimit(false);
        }

        if (service.enableRequestLimit && service.requestCountLimit) {
          setMaxRequestCountLimit(service.requestCountLimit);
          // 检查规则的限制是否与 API 服务一致
          // 规则必须有完整的配置才认为是继承的
          const isRequestInherited = rule.requestCountLimit === service.requestCountLimit &&
            rule.requestResetInterval === (service.requestResetInterval || undefined) &&
            rule.requestCountLimit !== null &&
            rule.requestResetInterval !== null;
          setInheritedRequestLimit(isRequestInherited);
        } else {
          setMaxRequestCountLimit(undefined);
          setInheritedRequestLimit(false);
        }

        // 如果规则有配置超量限制，则展开对应的字段
        setShowTokenLimit(!!rule.tokenLimit);
        setShowRequestLimit(!!rule.requestCountLimit);
      }, 0);
    } else if (rule.useMCP) {
      // 如果使用MCP，清空供应商相关字段
      setSelectedVendor('');
      setSelectedService('');
      setSelectedModel('');
      setSelectedReplacedModel('');
      setSelectedSortOrder(rule.sortOrder || 0);
      setSelectedTimeout(rule.timeout ? rule.timeout / 1000 : undefined);
      setShowTokenLimit(false);
      setShowRequestLimit(false);
    }
    setShowRuleModal(true);
  };

  // 判断规则状态
  const getRuleStatus = (rule: Rule) => {
    const blacklistStatus = blacklistStatuses[rule.id];
    const issues: string[] = [];

    // 0. 首先检查是否正在使用（从 WebSocket 状态）
    const wsStatus = ruleStatuses[rule.id];
    if (wsStatus?.status === 'in_use') {
      return {
        status: 'in_use',
        label: '使用中',
        reason: '正在处理请求'
      };
    }

    // 1. 检查黑名单（包括timeout）
    if (blacklistStatus?.isBlacklisted) {
      const entry = blacklistStatus.blacklistEntry;
      if (entry?.errorType === 'timeout') {
        issues.push('请求超时');
      } else if (entry?.lastStatusCode) {
        issues.push(`HTTP ${entry.lastStatusCode}错误`);
      }
    }

    // 2. 检查token限制（tokenLimit单位是k，需要乘以1000转换为实际token数）
    // 使用 WebSocket 实时数据，如果有的话
    const currentTokensUsed = wsStatus?.totalTokensUsed !== undefined
      ? wsStatus.totalTokensUsed
      : rule.totalTokensUsed;

    if (rule.tokenLimit && currentTokensUsed !== undefined) {
      if (currentTokensUsed >= rule.tokenLimit * 1000) {
        issues.push('Token超限');
      }
    }

    // 3. 检查请求次数限制
    // 使用 WebSocket 实时数据，如果有的话
    const currentRequestsUsed = wsStatus?.totalRequestsUsed !== undefined
      ? wsStatus.totalRequestsUsed
      : rule.totalRequestsUsed;

    if (rule.requestCountLimit && currentRequestsUsed !== undefined) {
      if (currentRequestsUsed >= rule.requestCountLimit) {
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

    if (rule.tokenLimit && currentTokensUsed !== undefined) {
      const usagePercent = (currentTokensUsed / (rule.tokenLimit * 1000)) * 100;
      if (usagePercent >= 80) {
        warnings.push(`Token ${usagePercent.toFixed(0)}%`);
      }
    }

    if (rule.requestCountLimit && currentRequestsUsed !== undefined) {
      const usagePercent = (currentRequestsUsed / rule.requestCountLimit) * 100;
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
    setShowTokenLimit(false);
    setShowRequestLimit(false);
    setUseMCP(false);
    setSelectedMCPId('');
    setShowRuleModal(true);
  };

  return (
    <div className='routes-page'>
      <div className="page-header">
        <h1>路由管理</h1>
        <p>管理API路由和路由配置</p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', gap: '20px' }}>
          <div className="card" style={{ flex: '0 0 25%', minWidth: 300 }}>
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
                      position: 'relative',
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

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
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
                <table className="rules-table">
                  <thead>
                    <tr>
                      <th className="col-priority">优先级</th>
                      <th>类型</th>
                      <th>API服务</th>
                      <th>状态</th>
                      <th>用量情况</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* 排序规则：先按 sortOrder 倒序，再按 contentType 分类排序 */}
                    {[...rules].sort((a, b) => {
                      // 首先按 sortOrder 倒序
                      const sortOrderA = a.sortOrder || 0;
                      const sortOrderB = b.sortOrder || 0;
                      if (sortOrderA !== sortOrderB) {
                        return sortOrderB - sortOrderA;
                      }
                      // sortOrder 相同时，按 contentType 分类排序
                      const orderA = CONTENT_TYPE_ORDER[a.contentType] ?? 999;
                      const orderB = CONTENT_TYPE_ORDER[b.contentType] ?? 999;
                      return orderA - orderB;
                    }).map((rule) => {
                      const service = allServices.find(s => s.id === rule.targetServiceId);
                      const vendor = vendors.find(v => v.id === service?.vendorId);
                      const contentTypeLabel = CONTENT_TYPE_OPTIONS.find(opt => opt.value === rule.contentType)?.label;
                      return (
                        <tr key={rule.id}>
                          <td className="col-priority">
                            <div className='col-priority-box'>
                              <span>{rule.sortOrder || 0}</span>
                              <button
                                className="priority-arrow-btn"
                                onClick={() => handleDecreasePriority(rule.id)}
                                title="降低优先级"
                              >
                                ↓
                              </button>
                              <button
                                className="priority-arrow-btn"
                                onClick={() => handleIncreasePriority(rule.id)}
                                title="提升优先级"
                              >
                                ↑
                              </button>
                            </div>
                          </td>
                          <td>
                            <div style={{ fontSize: '12px', whiteSpace: 'nowrap' }}>
                              {/* 为非默认类型添加图标 */}
                              {rule.contentType !== 'default' && CONTENT_TYPE_ICONS[rule.contentType] && (
                                <span style={{ fontSize: '14px' }}>
                                  {CONTENT_TYPE_ICONS[rule.contentType]}
                                </span>
                              )}
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
                            <div className='vendor-sevices-col' style={{ fontSize: '0.6em' }}>
                              {rule.useMCP ? (
                                <>
                                  <div>MCP：{mcps.find(m => m.id === rule.mcpId)?.name || 'Unknown'}</div>
                                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>使用MCP工具</div>
                                </>
                              ) : (
                                <>
                                  <div>供应商：{vendor ? vendor.name : 'Unknown'}</div>
                                  <div>服务：{service ? service.name : 'Unknown'}</div>
                                  <div>模型：{rule.targetModel || '透传模型'}</div>
                                </>
                              )}
                            </div>
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {/* 新增：状态列 */}
                            {(() => {
                              const ruleStatus = getRuleStatus(rule);
                              const blacklistStatus = blacklistStatuses[rule.id];
                              const isBlacklistedOnly = blacklistStatus?.isBlacklisted &&
                                !ruleStatus.reason?.includes('Token超限') &&
                                !ruleStatus.reason?.includes('次数超限');

                              // 如果规则被屏蔽，显示屏蔽状态
                              if (rule.isDisabled) {
                                return (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <span style={{ color: '#6c757d', fontWeight: 'bold', fontSize: '14px' }}>⊘</span>
                                    <span style={{ fontSize: '13px', color: '#6c757d', fontWeight: 'bold' }}>
                                      已屏蔽
                                    </span>
                                  </div>
                                );
                              }

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
                                    {ruleStatus.status === 'in_use' && (
                                      <>
                                        <span
                                          style={{
                                            color: '#007bff',
                                            fontWeight: 'bold',
                                            fontSize: '14px',
                                            animation: 'pulse 1.5s ease-in-out infinite',
                                          }}
                                        >
                                          ●
                                        </span>
                                      </>
                                    )}
                                    <span style={{
                                      fontSize: '13px',
                                      color: ruleStatus.status === 'success' ? '#28a745' :
                                        ruleStatus.status === 'warning' ? '#ffc107' :
                                          ruleStatus.status === 'in_use' ? '#007bff' :
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
                                            }} />
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
                            {/* 当 tokenLimit 和 requestCountLimit 都不限制时，不显示用量情况 */}
                            {(rule.tokenLimit || rule.requestCountLimit) ? (
                            <div style={{ fontSize: '13px' }}>
                              {/* Token限制 */}
                              {rule.tokenLimit && (
                              <div style={{ whiteSpace: 'nowrap' }}>
                                <span style={{ fontWeight: 'bold', fontSize: '12px' }}>Tokens:</span>
                                  <>
                                    {/* 使用 WebSocket 实时数据 */}
                                    <span style={{
                                      color: (() => {
                                        const currentTokensUsed = ruleStatuses[rule.id]?.totalTokensUsed ?? rule.totalTokensUsed;
                                        return currentTokensUsed && rule.tokenLimit && currentTokensUsed >= rule.tokenLimit * 1000 ? 'red' : 'inherit';
                                      })()
                                    }}>
                                      {(((ruleStatuses[rule.id]?.totalTokensUsed ?? rule.totalTokensUsed) || 0) / 1000).toFixed(1)}K/{rule.tokenLimit.toFixed(0)}K
                                    </span>
                                    {(() => {
                                      const currentTokensUsed = ruleStatuses[rule.id]?.totalTokensUsed ?? rule.totalTokensUsed;
                                      return currentTokensUsed && rule.tokenLimit && currentTokensUsed >= rule.tokenLimit * 1000 ? (
                                        <span style={{ color: 'red', marginLeft: '4px', fontWeight: 'bold', fontSize: '11px' }}>超限</span>
                                      ) : null;
                                    })()}
                                  </>
                              </div>
                              )}
                              {/* 请求次数限制 */}
                              {rule.requestCountLimit && (
                              <div style={{ marginTop: rule.tokenLimit ? '6px' : 0 }}>
                                <span style={{ fontWeight: 'bold', fontSize: '12px' }}>次数:</span>
                                  <>
                                    {/* 使用 WebSocket 实时数据 */}
                                    <span style={{
                                      color: (() => {
                                        const currentRequestsUsed = ruleStatuses[rule.id]?.totalRequestsUsed ?? rule.totalRequestsUsed;
                                        return currentRequestsUsed && rule.requestCountLimit && currentRequestsUsed >= rule.requestCountLimit ? 'red' : 'inherit';
                                      })()
                                    }}>
                                      {(ruleStatuses[rule.id]?.totalRequestsUsed ?? rule.totalTokensUsed) || 0}/{rule.requestCountLimit}
                                    </span>
                                    {(() => {
                                      const currentRequestsUsed = ruleStatuses[rule.id]?.totalRequestsUsed ?? rule.totalRequestsUsed;
                                      return currentRequestsUsed && rule.requestCountLimit && currentRequestsUsed >= rule.requestCountLimit ? (
                                        <span style={{ color: 'red', marginLeft: '4px', fontWeight: 'bold', fontSize: '11px' }}>超限</span>
                                      ) : null;
                                    })()}
                                  </>
                              </div>
                              )}
                            </div>
                            ) : (
                              <span style={{ color: '#999', fontSize: '12px' }}>不限制</span>
                            )}
                          </td>
                          <td>
                            <div className="action-buttons" style={{ justifyContent: 'flex-end' }}>
                              <button
                                className={`btn ${rule.isDisabled ? 'btn-success' : 'btn-warning'}`}
                                onClick={() => handleToggleRuleDisable(rule.id)}
                                title={rule.isDisabled ? '启用规则' : '临时屏蔽规则'}
                              >
                                {rule.isDisabled ? '启用' : '屏蔽'}
                              </button>
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
                    • 当同一请求类型配置多个规则时,系统会按排序优先使用第一个<br />
                    • 如果某个服务报错(4xx/5xx)或请求超时,将自动切换到下一个可用服务<br />
                    • 报错或超时的服务会被标记为不可用,有效期10分钟<br />
                    • 10分钟后自动解除标记,如果再次报错或超时则重新标记<br />
                    • 确保您的请求始终路由到稳定可用的服务<br />
                    • 规则状态列会实时显示每个规则的可用性状态<br />
                    • 如不需要此功能,可在<strong>设置</strong>页面关闭"启用智能故障切换"选项
                  </div>
                </div>
              )}
            </div>
            {/* Claude Code 配置容器 - 独立卡片，仅对 Claude Code 路由显示 */}
            {selectedRoute && selectedRoute.targetType === 'claude-code' && (
              <div className="card">
                <div className="toolbar">
                  <h3>Claude Code 配置</h3>
                </div>
                <div style={{ padding: '20px' }}>
                  {!isAgentTeamsSupported() && claudeVersionCheck?.claudeCode?.version && (
                    <div style={{
                      backgroundColor: 'var(--bg-warning, #fff3cd)',
                      border: '1px solid var(--border-warning, #ffc107)',
                      borderRadius: '6px',
                      padding: '12px',
                      marginBottom: '12px',
                      fontSize: '13px',
                      color: 'var(--text-warning, #856404)'
                    }}>
                      ⚠️ 当前 Claude Code 版本 ({claudeVersionCheck.claudeCode.version}) 不支持 Agent Teams 功能。<br />
                      Agent Teams 功能需要 Claude Code 版本 ≥ 2.1.32。请升级 Claude Code 后再使用此功能。
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <input
                      type="checkbox"
                      id="agent-teams-toggle"
                      checked={selectedRoute.enableAgentTeams || false}
                      onChange={(e) => handleToggleAgentTeams(e.target.checked)}
                      disabled={!isAgentTeamsSupported()}
                      style={{ cursor: isAgentTeamsSupported() ? 'pointer' : 'not-allowed', width: '16px', height: '16px' }}
                    />
                    <label
                      htmlFor="agent-teams-toggle"
                      style={{ cursor: isAgentTeamsSupported() ? 'pointer' : 'not-allowed', fontSize: '14px', userSelect: 'none', color: isAgentTeamsSupported() ? 'inherit' : 'var(--text-muted)' }}
                    >
                      开启 Agent Teams 功能
                    </label>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '12px' }}>
                    {!isAgentTeamsSupported()
                      ? 'Agent Teams 功能需要 Claude Code 版本 ≥ 2.1.32。请升级 Claude Code 后再使用此功能。'
                      : selectedRoute.isActive
                        ? '开启后将在 Claude Code 中启用 Agent Teams 实验性功能，已立即生效。'
                        : '开启后将在激活此路由时启用 Agent Teams 实验性功能。'}
                  </div>
                </div>
              </div>
            )}
          </div>
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

                {/* 高智商请求类型提示 */}
                {selectedContentType === 'high-iq' && (
                  <div style={{
                    background: 'var(--bg-info-blue)',
                    padding: '12px',
                    borderRadius: '6px',
                    borderLeft: '4px solid var(--border-info-blue)',
                    marginBottom: '16px'
                  }}>
                    <div style={{ fontSize: '13px', fontWeight: 'bold', marginBottom: '6px' }}>
                      💡 高智商请求使用方法
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.6' }}>
                      在编程工具中输入提示词时：
                      <ul style={{ marginTop: '8px', paddingLeft: '20px', lineHeight: '1.8' }}>
                        <li>使用 <code style={{
                          background: 'var(--bg-code-inline, #f5f5f5)',
                          padding: '2px 6px',
                          borderRadius: '3px',
                          fontFamily: 'monospace',
                          fontSize: '12px'
                        }}>!!</code> 开启高智商模式（整个会话持续使用）</li>
                        <li>使用 <code style={{
                          background: 'var(--bg-code-inline, #f5f5f5)',
                          padding: '2px 6px',
                          borderRadius: '3px',
                          fontFamily: 'monospace',
                          fontSize: '12px'
                        }}>!x</code> 关闭高智商模式</li>
                      </ul>
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px', lineHeight: '1.6' }}>
                      <strong>示例：</strong><br />
                      • <code style={{
                        background: 'var(--bg-code-inline, #f5f5f5)',
                        padding: '2px 6px',
                        borderRadius: '3px',
                        fontFamily: 'monospace',
                        fontSize: '12px'
                      }}>!! 重构A模块</code><br />
                      • <code style={{
                        background: 'var(--bg-code-inline, #f5f5f5)',
                        padding: '2px 6px',
                        borderRadius: '3px',
                        fontFamily: 'monospace',
                        fontSize: '12px'
                      }}>!x 继续正常对话</code>
                    </div>
                  </div>
                )}

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

                {/* 图像理解类型显示使用MCP开关 */}
                {selectedContentType === 'image-understanding' && (
                  <div className="form-group">
                    <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={useMCP}
                        onChange={(e) => setUseMCP(e.target.checked)}
                        style={{ marginRight: '8px', cursor: 'pointer', width: '16px', height: '16px' }}
                      />
                      <span>使用MCP</span>
                    </label>
                    <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                      开启后，将使用MCP工具处理图像理解请求，而不是直接调用API服务
                    </small>
                  </div>
                )}

                {/* MCP选择列表（仅当图像理解+使用MCP时显示） */}
                {selectedContentType === 'image-understanding' && useMCP && (
                  <div className="form-group">
                    <label>选择MCP工具 <span className="required">*</span></label>
                    <div style={{
                      maxHeight: '300px',
                      overflowY: 'auto',
                      border: '1px solid var(--border-primary)',
                      borderRadius: '6px',
                      padding: '8px'
                    }}>
                      {mcps.length === 0 ? (
                        <div style={{ padding: '12px', textAlign: 'center', color: 'var(--text-muted)' }}>
                          暂无MCP工具，请先在MCP管理页面添加
                        </div>
                      ) : (
                        mcps.map((mcp) => (
                          <div
                            key={mcp.id}
                            onClick={() => setSelectedMCPId(mcp.id)}
                            style={{
                              padding: '12px',
                              marginBottom: '8px',
                              border: `2px solid ${selectedMCPId === mcp.id ? 'var(--primary-color)' : 'var(--border-primary)'}`,
                              borderRadius: '6px',
                              cursor: 'pointer',
                              backgroundColor: selectedMCPId === mcp.id ? 'var(--bg-info-blue)' : 'var(--bg-card)',
                              transition: 'all 0.2s ease',
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <div style={{ fontWeight: 600, fontSize: '14px' }}>{mcp.name}</div>
                              <div className="badge badge-secondary" style={{ fontSize: '11px' }}>
                                {mcp.type === 'stdio' ? '命令行' : mcp.type.toUpperCase()}
                              </div>
                            </div>
                            {mcp.description && (
                              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                                {mcp.description}
                              </div>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}

                {/* 供应商相关字段（当不使用MCP时显示） */}
                {!useMCP && (
                  <>
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
                              // API服务的tokenLimit已经是k值，直接使用
                              setSelectedTokenLimit(service.tokenLimit);
                              setSelectedResetInterval(service.tokenResetInterval);
                              setSelectedTokenResetBaseTime(
                                service.tokenResetBaseTime ? new Date(service.tokenResetBaseTime) : undefined
                              );
                              setMaxTokenLimit(service.tokenLimit);
                              setInheritedTokenLimit(true);
                              setShowTokenLimit(true); // 自动展开
                            } else {
                              setMaxTokenLimit(undefined);
                              setInheritedTokenLimit(false);
                              setShowTokenLimit(false); // 收起
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
                              setShowRequestLimit(true); // 自动展开
                            } else {
                              setMaxRequestCountLimit(undefined);
                              setInheritedRequestLimit(false);
                              setShowRequestLimit(false); // 收起
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

                    {/* Tokens超量配置 */}
                    <div className="form-group">
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <label style={{ display: 'flex', alignItems: 'center', cursor: inheritedTokenLimit ? 'not-allowed' : 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={showTokenLimit}
                            onChange={(e) => setShowTokenLimit(e.target.checked)}
                            disabled={inheritedTokenLimit}
                            style={{ marginRight: '8px', cursor: inheritedTokenLimit ? 'not-allowed' : 'pointer', width: '16px', height: '16px' }}
                          />
                          <span>启用Tokens超量限制</span>
                          {inheritedTokenLimit && (
                            <small style={{ color: '#999', fontSize: '12px', marginLeft: '8px' }}>（从API服务继承）</small>
                          )}
                        </label>
                        {inheritedTokenLimit && (
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary"
                            onClick={() => setInheritedTokenLimit(false)}
                            style={{ padding: '4px 12px', fontSize: '12px' }}
                          >
                            自定义限制
                          </button>
                        )}
                      </div>
                    </div>

                    {showTokenLimit && !inheritedTokenLimit && (
                      <>
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
                              // 如果值改变，自动解除继承状态
                              if (inheritedTokenLimit && value !== maxTokenLimit) {
                                setInheritedTokenLimit(false);
                              }
                            }}
                            min="0"
                            max={maxTokenLimit}
                            placeholder={maxTokenLimit ? `最大 ${maxTokenLimit}k` : "不限制"}
                            disabled={inheritedTokenLimit}
                          />
                          {maxTokenLimit && (
                            <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                              ⚠️ API服务限制：最大 {maxTokenLimit}k，当前值不能超过此限制
                            </small>
                          )}
                          <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                            当编程工具的请求tokens达到这个量时，在配置了其他规则的情况下，本条规则将失效，从而保护你的余额。例如：输入100表示100k即100,000个tokens
                          </small>
                        </div>

                        {/* 重置时间字段 */}
                        <div className="form-group">
                          <label>Tokens超量自动重置间隔（小时）</label>
                          <input
                            type="number"
                            value={selectedResetInterval || ''}
                            onChange={(e) => {
                              setSelectedResetInterval(e.target.value ? parseInt(e.target.value) : undefined);
                              // 如果值改变，自动解除继承状态
                              if (inheritedTokenLimit) {
                                setInheritedTokenLimit(false);
                              }
                            }}
                            min="1"
                            placeholder="不自动重置"
                            disabled={inheritedTokenLimit}
                          />
                          <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                            设置后，系统将每隔指定小时数自动重置token计数。例如设置5小时，则每5小时重置一次
                          </small>
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
                              // 如果值改变，自动解除继承状态
                              if (inheritedTokenLimit) {
                                setInheritedTokenLimit(false);
                              }
                            }}
                            disabled={!selectedResetInterval || inheritedTokenLimit}
                            className="datetime-picker-input"
                          />
                          <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                            配合"Tokens超量自动重置间隔"使用，设置下一次重置的精确时间点。例如，每月1日0点重置（间隔720小时），或每周一0点重置（间隔168小时）。设置后，系统会基于此时间点自动计算后续重置周期
                          </small>
                        </div>
                      </>
                    )}

                    {/* 请求次数超量配置 */}
                    <div className="form-group">
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <label style={{ display: 'flex', alignItems: 'center', cursor: inheritedRequestLimit ? 'not-allowed' : 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={showRequestLimit}
                            onChange={(e) => setShowRequestLimit(e.target.checked)}
                            disabled={inheritedRequestLimit}
                            style={{ marginRight: '8px', cursor: inheritedRequestLimit ? 'not-allowed' : 'pointer', width: '16px', height: '16px' }}
                          />
                          <span>启用请求次数超量限制</span>
                          {inheritedRequestLimit && (
                            <small style={{ color: '#999', fontSize: '12px', marginLeft: '8px' }}>（从API服务继承）</small>
                          )}
                        </label>
                        {inheritedRequestLimit && (
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary"
                            onClick={() => setInheritedRequestLimit(false)}
                            style={{ padding: '4px 12px', fontSize: '12px' }}
                          >
                            自定义限制
                          </button>
                        )}
                      </div>
                    </div>

                    {showRequestLimit && !inheritedRequestLimit && (
                      <>
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
                              // 如果值改变，自动解除继承状态
                              if (inheritedRequestLimit && value !== maxRequestCountLimit) {
                                setInheritedRequestLimit(false);
                              }
                            }}
                            min="0"
                            max={maxRequestCountLimit}
                            placeholder={maxRequestCountLimit ? `最大 ${maxRequestCountLimit}` : "不限制"}
                            disabled={inheritedRequestLimit}
                          />
                          {maxRequestCountLimit && (
                            <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                              ⚠️ API服务限制：最大 {maxRequestCountLimit}，当前值不能超过此限制
                            </small>
                          )}
                          <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                            当请求次数达到这个量时，在配置了其他规则的情况下，本条规则将失效
                          </small>
                        </div>

                        {/* 请求次数自动重置间隔字段 */}
                        <div className="form-group">
                          <label>请求次数自动重置间隔（小时）</label>
                          <input
                            type="number"
                            value={selectedRequestResetInterval || ''}
                            onChange={(e) => {
                              setSelectedRequestResetInterval(e.target.value ? parseInt(e.target.value) : undefined);
                              // 如果值改变，自动解除继承状态
                              if (inheritedRequestLimit) {
                                setInheritedRequestLimit(false);
                              }
                            }}
                            min="1"
                            placeholder="不自动重置"
                            disabled={inheritedRequestLimit}
                          />
                          <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                            设置后，系统将每隔指定小时数自动重置请求次数计数。例如设置24小时，则每24小时重置一次
                          </small>
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
                              // 如果值改变，自动解除继承状态
                              if (inheritedRequestLimit) {
                                setInheritedRequestLimit(false);
                              }
                            }}
                            disabled={!selectedRequestResetInterval || inheritedRequestLimit}
                            className="datetime-picker-input"
                          />
                          <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                            配合"请求次数自动重置间隔"使用，设置下一次重置的精确时间点。例如，每月1日0点重置（间隔720小时），或每周一0点重置（间隔168小时）。设置后，系统会基于此时间点自动计算后续重置周期
                          </small>
                        </div>
                      </>
                    )}
                  </>
                )}

                {/* 频率限制配置 */}
                <div className="form-group">
                  <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={!!selectedFrequencyLimit}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedFrequencyLimit(10); // 默认值
                          setSelectedFrequencyWindow(0); // 默认0秒（同一时刻）
                        } else {
                          setSelectedFrequencyLimit(undefined);
                          setSelectedFrequencyWindow(undefined);
                        }
                      }}
                      style={{ marginRight: '8px', cursor: 'pointer', width: '16px', height: '16px' }}
                    />
                    <span>启用请求频率限制</span>
                  </label>
                  <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                    启用后，当同一内容类型的请求频率超过限制时，系统会自动切换到其他同类型规则
                  </small>
                </div>

                {selectedFrequencyLimit && (
                  <>
                    {/* 频率限制次数字段 */}
                    <div className="form-group">
                      <label>频率限制次数（并发数）</label>
                      <input
                        type="number"
                        value={selectedFrequencyLimit || ''}
                        onChange={(e) => setSelectedFrequencyLimit(e.target.value ? parseInt(e.target.value) : undefined)}
                        min="1"
                        placeholder="例如: 10"
                      />
                      <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                        在指定时间窗口内允许的最大请求次数
                      </small>
                    </div>

                    {/* 频率限制时间窗口字段 */}
                    <div className="form-group">
                      <label>频率限制时间窗口（秒，0=同一时刻）</label>
                      <input
                        type="number"
                        value={selectedFrequencyWindow === 0 ? 0 : (selectedFrequencyWindow || '')}
                        onChange={(e) => {
                          const value = e.target.value ? parseInt(e.target.value) : undefined;
                          setSelectedFrequencyWindow(value === 0 ? 0 : value);
                        }}
                        min="0"
                        placeholder="0 表示同一时刻"
                      />
                      <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                        时间窗口大小。0 表示同一时刻（并发数），持续累积；设置为 60 则在 60 秒内最多允许 N 次请求
                      </small>
                    </div>
                  </>
                )}

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

                {/* 排序字段 */}
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
