import { useState, useEffect } from 'react';
import { api } from '../api/client';
import type { Route, Rule, APIService, ContentType, Vendor, ServiceBlacklistEntry, MCPServer, ToolInstallationStatus, CodexReasoningEffort, ClaudeEffortLevel, AppConfig, ApiPathBinding, ToolName, ToolBindings } from '../../types';
import { useConfirm } from '../components/Confirm';
import { toast } from '../components/Toast';
import SyncConfigModal from '../components/SyncConfigModal';
import { useRulesStatus } from '../hooks/useRulesStatus';
import QuickSetupModal from '../components/QuickSetupModal';
import openaiIcon from '../assets/openai.webp';
import claudeIcon from '../assets/claude.webp';

const CONTENT_TYPE_OPTIONS = [
  { value: 'compact', label: '压缩对话', icon: '📦' },
  { value: 'image-understanding', label: '图像理解', icon: '🖼' },
  { value: 'high-iq', label: '高智商', icon: '🧠' },
  { value: 'long-context', label: '长上下文', icon: '📄' },
  { value: 'thinking', label: '思考', icon: '💭' },
  { value: 'background', label: '后台', icon: '⚙' },
  { value: 'model-mapping', label: '模型顶替', icon: '🔄' },
  { value: 'default', label: '默认' },
];

// 类型排序权重（数值越小越靠前）
const CONTENT_TYPE_ORDER: Record<string, number> = {
  'compact': 0,
  'image-understanding': 1,
  'high-iq': 2,
  'long-context': 3,
  'thinking': 4,
  'background': 5,
  'model-mapping': 6,
  'default': 7,
};

// 类型到图标的映射
const CONTENT_TYPE_ICONS: Record<string, string> = {
  'compact': '📦',
  'background': '🧱',
  'thinking': '💭',
  'high-iq': '🧠',
  'long-context': '📄',
  'image-understanding': '🖼️',
  'model-mapping': '🔄',
};

const CODEX_REASONING_EFFORT_OPTIONS: Array<{ value: CodexReasoningEffort; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
];

const CLAUDE_EFFORT_LEVEL_OPTIONS: Array<{ value: ClaudeEffortLevel; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

const isCodexReasoningEffort = (value: unknown): value is CodexReasoningEffort => {
  return CODEX_REASONING_EFFORT_OPTIONS.some(option => option.value === value);
};

const isClaudeEffortLevel = (value: unknown): value is ClaudeEffortLevel => {
  return CLAUDE_EFFORT_LEVEL_OPTIONS.some(option => option.value === value);
};

const getGlobalCodexReasoningEffort = (config: AppConfig | null): CodexReasoningEffort => {
  return isCodexReasoningEffort(config?.codexModelReasoningEffort)
    ? config.codexModelReasoningEffort
    : 'high';
};

const getGlobalClaudeEffortLevel = (config: AppConfig | null): ClaudeEffortLevel => {
  return isClaudeEffortLevel(config?.claudeEffortLevel)
    ? config.claudeEffortLevel
    : 'medium';
};

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

export default function RoutesPage() {
  const { confirm } = useConfirm();
  const { ruleStatuses, clearRuleStatus } = useRulesStatus();
  const [routes, setRoutes] = useState<Route[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [allServices, setAllServices] = useState<APIService[]>([]);
  const [services, setServices] = useState<APIService[]>([]);
  const [mcps, setMCPs] = useState<MCPServer[]>([]);
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const [apiPathBindings, setApiPathBindings] = useState<ApiPathBinding[]>([]);
  const [apiPathModels, setApiPathModels] = useState('');
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
  const [ruleGlobalTimeout, setRuleGlobalTimeout] = useState<string>('');
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
  const [selectedSessionTokenThreshold, setSelectedSessionTokenThreshold] = useState<number | undefined>(1000); // 默认1M (1000k)

  // 超量配置展开状态
  const [showTokenLimit, setShowTokenLimit] = useState(false);
  const [showRequestLimit, setShowRequestLimit] = useState(false);

  // Claude Code 版本检查状态
  const [claudeVersionCheck, setClaudeVersionCheck] = useState<ToolInstallationStatus | null>(null);

  // 一键配置弹窗状态
  const [showQuickSetupModal, setShowQuickSetupModal] = useState(false);
  const [showSyncConfigModal, setShowSyncConfigModal] = useState(false);

  // 配置操作loading状态
  const [isUpdatingCodexReasoning, setIsUpdatingCodexReasoning] = useState(false);
  const [isUpdatingClaudeEffort, setIsUpdatingClaudeEffort] = useState(false);
  const [claudeDefaultModelInput, setClaudeDefaultModelInput] = useState<string>('');
  const [claudeDefaultModelDirty, setClaudeDefaultModelDirty] = useState(false);
  const [autocompactPctInput, setAutocompactPctInput] = useState<string>('');
  const [autocompactPctDirty, setAutocompactPctDirty] = useState(false);
  const [codexDefaultModelInput, setCodexDefaultModelInput] = useState<string>('');
  const [codexDefaultModelDirty, setCodexDefaultModelDirty] = useState(false);

  // 路由绑定会话相关状态
  const [boundSessionCounts, setBoundSessionCounts] = useState<Record<string, number>>({});
  const [showBoundSessionsRouteId, setShowBoundSessionsRouteId] = useState<string | null>(null);
  const [boundSessions, setBoundSessions] = useState<Array<{ id: string; title?: string; targetType: string; requestCount: number; totalTokens: number; lastRequestAt: number }>>([]);
  const [boundSessionsLoading, setBoundSessionsLoading] = useState(false);

  useEffect(() => {
    loadRoutes();
    loadVendors();
    loadAllServices();
    loadMCPs();
    loadAppConfig();
    loadToolBindings();
    loadApiPathBindings();
    checkClaudeVersion();
  }, []);


  const loadApiPathBindings = async () => {
    try {
      const result = await api.getApiPathBindings();
      setApiPathBindings(result.bindings || []);
      setApiPathModels(result.models || '');
    } catch (error) {
      console.error('Failed to load API path bindings:', error);
    }
  };

  const saveBindings = async (bindings: ApiPathBinding[], models: string) => {
    try {
      const result = await api.updateApiPathBindings(bindings, models);
      setApiPathBindings(result.bindings);
      toast.success('路由映射已保存');
    } catch (error: any) {
      toast.error(error.message || '保存失败');
    }
  };

  const handleBindingChange = (apiPath: string, routeId: string | null) => {
    const updated = apiPathBindings.map(b => b.apiPath === apiPath ? { ...b, routeId } : b);
    setApiPathBindings(updated);
    saveBindings(updated, apiPathModels);
  };

  const handleModelsBlur = () => {
    saveBindings(apiPathBindings, apiPathModels);
  };



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
    setRoutes(data);
    if (data.length > 0 && !selectedRoute) {
      setSelectedRoute(data[0]);
    }
    // 加载每个路由的绑定会话数
    const counts: Record<string, number> = {};
    for (const route of data) {
      try {
        const result = await api.getBoundSessions(route.id);
        counts[route.id] = result.sessions.length;
      } catch {
        counts[route.id] = 0;
      }
    }
    setBoundSessionCounts(counts);
  };

  // 打开绑定会话弹窗
  const handleShowBoundSessions = async (routeId: string) => {
    setShowBoundSessionsRouteId(routeId);
    setBoundSessionsLoading(true);
    setBoundSessions([]);
    try {
      const result = await api.getBoundSessions(routeId);
      setBoundSessions(result.sessions);
    } catch {
      setBoundSessions([]);
    } finally {
      setBoundSessionsLoading(false);
    }
  };

  // 关闭绑定会话弹窗
  const handleCloseBoundSessions = () => {
    setShowBoundSessionsRouteId(null);
    setBoundSessions([]);
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

  const [toolBindings, setToolBindings] = useState<ToolBindings | null>(null);
  const [isConfiguringBinding, setIsConfiguringBinding] = useState<ToolName | null>(null);

  const loadAppConfig = async () => {
    try {
      const data = await api.getConfig();
      setAppConfig(data);
      setClaudeDefaultModelInput(data.claudeDefaultModel || '');
      setClaudeDefaultModelDirty(false);
      setAutocompactPctInput(data.autocompactPctOverride != null ? String(data.autocompactPctOverride) : '');
      setAutocompactPctDirty(false);
      setCodexDefaultModelInput(data.codexDefaultModel || '');
      setCodexDefaultModelDirty(false);
      setRuleGlobalTimeout(
        typeof data.ruleGlobalTimeout === 'number' && data.ruleGlobalTimeout > 0
          ? String(data.ruleGlobalTimeout)
          : ''
      );
    } catch (error) {
      console.error('Failed to load app config:', error);
    }
  };

  const loadToolBindings = async () => {
    try {
      const data = await api.getToolBindings();
      setToolBindings(data);
    } catch (error) {
      console.error('Failed to load tool bindings:', error);
    }
  };

  const handleActivateToolRoute = async (tool: ToolName, routeId: string) => {
    setIsConfiguringBinding(tool);
    try {
      const result = await api.activateToolRoute(tool, routeId);
      if (result.success) {
        await loadToolBindings();
        await loadRoutes();
        toast.success('路由已激活');
      } else {
        toast.error('激活失败');
      }
    } catch (error: any) {
      toast.error(`激活失败: ${error.message || '未知错误'}`);
    } finally {
      setIsConfiguringBinding(null);
    }
  };

  const handleDeactivateToolRoute = async (tool: ToolName) => {
    setIsConfiguringBinding(tool);
    try {
      const result = await api.deactivateToolRoute(tool);
      if (result.success) {
        await loadToolBindings();
        await loadRoutes();
        toast.success('路由已停用');
      } else {
        toast.error('停用失败');
      }
    } catch (error: any) {
      toast.error(`停用失败: ${error.message || '未知错误'}`);
    } finally {
      setIsConfiguringBinding(null);
    }
  };



  const handleSaveRoute = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const route = {
      name: formData.get('name') as string,
      description: formData.get('description') as string,
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
      try {
        await api.deleteRoute(id);
        loadRoutes();
        if (selectedRoute && selectedRoute.id === id) {
          setSelectedRoute(null);
          setRules([]);
        }
        toast.success('路由已删除');
      } catch (error: any) {
        toast.error(error.message || '删除失败');
      }
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
      sessionTokenThreshold: selectedContentType === 'long-context' ? selectedSessionTokenThreshold : undefined,
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

  // 统一的规则恢复处理（同时清除黑名单和 WebSocket 实时状态）
  const handleRuleRecovery = async (ruleId: string) => {
    try {
      const promises: Promise<any>[] = [];

      // 清除黑名单状态
      if (blacklistStatuses[ruleId]?.isBlacklisted) {
        promises.push(api.clearRuleBlacklist(ruleId));
      }

      // 清除 WebSocket 实时状态
      const wsStatus = ruleStatuses[ruleId]?.status;
      if (wsStatus === 'error' || wsStatus === 'suspended') {
        promises.push(clearRuleStatus(ruleId));
      }

      // 并行执行所有清除操作
      await Promise.all(promises);

      // 重新加载规则列表
      if (selectedRoute) {
        loadRules(selectedRoute.id);
      }

      toast.success('已恢复');
    } catch (error: any) {
      toast.error('恢复失败: ' + error.message);
    }
  };

  // 提升规则优先级（设为同类型最大值 + 1）
  const handleIncreasePriority = async (id: string) => {
    try {
      // 找到对应的规则
      const rule = rules.find(r => r.id === id);
      if (!rule) return;

      // 找到同类型的所有规则，计算最大优先级
      const sameTypeRules = rules.filter(r => r.contentType === rule.contentType);
      const maxSortOrder = Math.max(...sameTypeRules.map(r => r.sortOrder || 0));
      const newSortOrder = maxSortOrder + 1;

      // 调用 API 更新
      await api.updateRule(id, { sortOrder: newSortOrder });

      // 重新加载规则列表
      if (selectedRoute) {
        loadRules(selectedRoute.id);
      }
      toast.success('优先级已提升至最高');
    } catch (error: any) {
      toast.error('操作失败: ' + error.message);
    }
  };

  // 降低规则优先级（设为同类型最小值 0）
  const handleDecreasePriority = async (id: string) => {
    try {
      // 找到对应的规则
      const rule = rules.find(r => r.id === id);
      if (!rule) return;

      // 设为最小优先级 0
      const newSortOrder = 0;

      // 调用 API 更新
      await api.updateRule(id, { sortOrder: newSortOrder });

      // 重新加载规则列表
      if (selectedRoute) {
        loadRules(selectedRoute.id);
      }
      toast.success('优先级已降至最低');
    } catch (error: any) {
      toast.error('操作失败: ' + error.message);
    }
  };

  const handleToggleAgentTeams = async (newValue: boolean) => {
    // 检查版本是否支持
    if (newValue && !isAgentTeamsSupported()) {
      toast.error('当前 Claude Code 版本不支持 Agent Teams 功能，需要版本 ≥ 2.1.32');
      return;
    }

    try {
      const current = appConfig || {};
      await api.updateConfig({
        ...current,
        enableAgentTeams: newValue,
      });
      toast.success(newValue
        ? 'Agent Teams 设置已保存（重启 Claude Code 后生效）'
        : 'Agent Teams 设置已取消（重启 Claude Code 后生效）');
      await loadAppConfig();
    } catch (error: any) {
      toast.error('更新失败: ' + error.message);
    }
  };

  const handleToggleBypassPermissionsSupport = async (newValue: boolean) => {
    try {
      const current = appConfig || {};
      await api.updateConfig({
        ...current,
        enableBypassPermissionsSupport: newValue,
      });
      toast.success(newValue
        ? '对 bypassPermissions 的支持设置已保存（重启 Claude Code 后生效）'
        : '对 bypassPermissions 的支持设置已取消（重启 Claude Code 后生效）');
      await loadAppConfig();
    } catch (error: any) {
      toast.error('更新失败: ' + error.message);
    }
  };

  const handleUpdateCodexReasoningEffort = async (newValue: CodexReasoningEffort) => {
    try {
      setIsUpdatingCodexReasoning(true);
      const current = appConfig || {};
      await api.updateConfig({
        ...current,
        codexModelReasoningEffort: newValue,
      });
      toast.success('Reasoning Effort 设置已保存（重启 Codex 后生效）');
      await loadAppConfig();
    } catch (error: any) {
      toast.error('更新失败: ' + error.message);
    } finally {
      setIsUpdatingCodexReasoning(false);
    }
  };

  const handleUpdateClaudeEffortLevel = async (newValue: ClaudeEffortLevel) => {
    try {
      setIsUpdatingClaudeEffort(true);
      const current = appConfig || {};
      await api.updateConfig({
        ...current,
        claudeEffortLevel: newValue,
      });
      toast.success('Effort Level 设置已保存（重启 Claude Code 后生效）');
      await loadAppConfig();
    } catch (error: any) {
      toast.error('更新失败: ' + error.message);
    } finally {
      setIsUpdatingClaudeEffort(false);
    }
  };

  const handleSaveClaudeDefaultModel = async () => {
    try {
      const current = appConfig || {};
      await api.updateConfig({
        ...current,
        claudeDefaultModel: claudeDefaultModelInput.trim() || undefined,
      });
      toast.success('默认模型已保存（重启 Claude Code 后生效）');
      setClaudeDefaultModelDirty(false);
      await loadAppConfig();
    } catch (error: any) {
      toast.error('保存失败: ' + error.message);
    }
  };

  const handleSaveAutocompactPct = async () => {
    const trimmed = autocompactPctInput.trim();
    if (trimmed === '') {
      // 清除设置
      try {
        const current = appConfig || {};
        await api.updateConfig({
          ...current,
          autocompactPctOverride: undefined,
        });
        toast.success('自动压缩百分比已清除（重启 Claude Code 后生效）');
        setAutocompactPctDirty(false);
        await loadAppConfig();
      } catch (error: any) {
        toast.error('保存失败: ' + error.message);
      }
      return;
    }
    const num = Number(trimmed);
    if (!Number.isInteger(num) || num < 1 || num > 100) {
      toast.error('自动压缩百分比必须为 1-100 的整数');
      return;
    }
    try {
      const current = appConfig || {};
      await api.updateConfig({
        ...current,
        autocompactPctOverride: num,
      });
      toast.success('自动压缩百分比已保存（重启 Claude Code 后生效）');
      setAutocompactPctDirty(false);
      await loadAppConfig();
    } catch (error: any) {
      toast.error('保存失败: ' + error.message);
    }
  };

  const handleSaveCodexDefaultModel = async () => {
    try {
      const current = appConfig || {};
      await api.updateConfig({
        ...current,
        codexDefaultModel: codexDefaultModelInput.trim() || undefined,
      });
      toast.success('默认模型已保存（重启 Codex 后生效）');
      setCodexDefaultModelDirty(false);
      await loadAppConfig();
    } catch (error: any) {
      toast.error('保存失败: ' + error.message);
    }
  };

  const handleUpdateRuleGlobalTimeout = async () => {
    try {
      const current = appConfig || {};
      const parsed = Number(ruleGlobalTimeout);
      const value = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
      await api.updateConfig({
        ...current,
        ruleGlobalTimeout: value,
      });
      toast.success(value
        ? `规则全局超时时间已设置为 ${value} 秒`
        : '规则全局超时时间已恢复为默认值（300秒）');
      await loadAppConfig();
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

        // 加载sessionTokenThreshold（仅long-context规则）
        setSelectedSessionTokenThreshold(rule.sessionTokenThreshold ?? 1000);
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
      setSelectedSessionTokenThreshold(rule.sessionTokenThreshold ?? 1000);
    } else {
      // 默认情况
      setSelectedSessionTokenThreshold(rule.sessionTokenThreshold ?? 1000);
    }
    setShowRuleModal(true);
  };

  // 判断规则状态
  const getRuleStatus = (rule: Rule) => {
    const blacklistStatus = blacklistStatuses[rule.id];
    const issues: string[] = [];

    // 0. 首先检查实时状态（从 WebSocket 状态）
    const wsStatus = ruleStatuses[rule.id];

    // 检查是否正在使用
    if (wsStatus?.status === 'in_use') {
      return {
        status: 'in_use',
        label: '使用中',
        reason: '正在处理请求'
      };
    }

    // 检查是否被挂起（黑名单）
    if (wsStatus?.status === 'suspended') {
      const errorTypeLabel = wsStatus.errorType === 'timeout' ? '超时' :
                             wsStatus.errorType === 'http' ? 'HTTP错误' : '错误';
      return {
        status: 'suspended',
        label: '已挂起',
        reason: wsStatus.errorMessage || `${errorTypeLabel}导致服务暂时不可用`
      };
    }

    // 检查是否有错误
    if (wsStatus?.status === 'error') {
      return {
        status: 'error',
        label: '请求失败',
        reason: wsStatus.errorMessage || '请求处理失败'
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
    setSelectedSessionTokenThreshold(1000);
    setShowRuleModal(true);
  };

  return (
    <div className='routes-page'>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>路由管理</h1>
          <p>管理API路由和路由配置</p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn btn-secondary" onClick={() => setShowSyncConfigModal(true)} style={{ whiteSpace: 'nowrap' }}>
            局域网内同步配置
          </button>
          <button className="btn btn-primary" onClick={() => setShowQuickSetupModal(true)} style={{ whiteSpace: 'nowrap' }}>
            一键配置
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', gap: '20px' }}>
          <div className="card" style={{ flex: '0 0 25%', minWidth: 300 }}>
            <div className="toolbar">
              <h3>路由</h3>
              <button className="btn btn-primary" onClick={() => setShowRouteModal(true)}>新建</button>
            </div>
            {routes.length === 0 ? (
              <div className="empty-state"><p>暂无路由规则</p></div>
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
                      position: 'relative',
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div style={{ fontWeight: 500, flex: 1, minWidth: 0 }}>{route.name}</div>
                        <div style={{ display: 'flex', gap: '3px', alignItems: 'center', flexShrink: 0, marginLeft: '8px' }}>
                          {/* 会话绑定数量图标 */}
                          {boundSessionCounts[route.id] > 0 && (
                            <div style={{ position: 'relative' }}>
                              <div
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleShowBoundSessions(route.id);
                                }}
                                style={{
                                  width: '18px',
                                  height: '18px',
                                  borderRadius: '50%',
                                  border: '2px solid var(--color-primary, #2980b9)',
                                  boxSizing: 'border-box',
                                  backgroundColor: 'transparent',
                                  color: 'var(--color-primary, #2980b9)',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  fontSize: '10px',
                                  fontWeight: 700,
                                  cursor: 'pointer',
                                  flexShrink: 0,
                                }}
                              >
                                {boundSessionCounts[route.id] > 99 ? '99+' : boundSessionCounts[route.id]}
                              </div>
                              <span className="route-icon-popover">
                                {boundSessionCounts[route.id]} 个会话绑定此路由，点击查看
                              </span>
                            </div>
                          )}
                          {/* Codex 绑定图标 */}
                          <div style={{ position: 'relative' }}>
                            <img
                              src={openaiIcon}
                              alt="Codex"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (isConfiguringBinding) return;
                                if (toolBindings?.['codex']?.routeId === route.id) {
                                  handleDeactivateToolRoute('codex');
                                } else {
                                  handleActivateToolRoute('codex', route.id);
                                }
                              }}
                              style={{
                                width: '18px',
                                height: '18px',
                                borderRadius: '50%',
                                cursor: isConfiguringBinding ? 'wait' : 'pointer',
                                opacity: toolBindings?.['codex']?.routeId === route.id ? 1 : 0.1,
                                transition: 'opacity 0.2s ease',
                                objectFit: 'cover',
                                flexShrink: 0,
                                display: 'block',
                              }}
                            />
                            <span className="route-icon-popover">
                              {toolBindings?.['codex']?.routeId === route.id ? 'Codex 已绑定此路由，点击解绑' : '点击将 Codex 绑定到此路由'}
                            </span>
                          </div>
                          {/* Claude Code 绑定图标 */}
                          <div style={{ position: 'relative' }}>
                            <img
                              src={claudeIcon}
                              alt="Claude Code"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (isConfiguringBinding) return;
                                if (toolBindings?.['claude-code']?.routeId === route.id) {
                                  handleDeactivateToolRoute('claude-code');
                                } else {
                                  handleActivateToolRoute('claude-code', route.id);
                                }
                              }}
                              style={{
                                width: '18px',
                                height: '18px',
                                borderRadius: '50%',
                                cursor: isConfiguringBinding ? 'wait' : 'pointer',
                                opacity: toolBindings?.['claude-code']?.routeId === route.id ? 1 : 0.1,
                                transition: 'opacity 0.2s ease',
                                objectFit: 'cover',
                                flexShrink: 0,
                                display: 'block',
                              }}
                            />
                            <span className="route-icon-popover">
                              {toolBindings?.['claude-code']?.routeId === route.id ? 'Claude Code 已绑定此路由，点击解绑' : '点击将 Claude Code 绑定到此路由'}
                            </span>
                          </div>
                        </div>
                      </div>
                      {route.description && (
                        <div style={{ fontSize: '12px', color: 'var(--text-route-muted)', marginTop: '2px' }}>
                          {route.description}
                        </div>
                      )}
                      <div className="action-buttons" style={{ marginTop: '8px' }}>
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
                <div className="empty-state"><p>暂无路由规则</p></div>
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
                    {/* 排序规则：先按类型顺序，再按同类型内的 sortOrder 倒序 */}
                    {[...rules].sort((a, b) => {
                      const orderA = CONTENT_TYPE_ORDER[a.contentType] ?? 999;
                      const orderB = CONTENT_TYPE_ORDER[b.contentType] ?? 999;
                      if (orderA !== orderB) {
                        return orderA - orderB;
                      }

                      const sortOrderA = a.sortOrder || 0;
                      const sortOrderB = b.sortOrder || 0;
                      return sortOrderB - sortOrderA;
                    }).map((rule) => {
                      const service = allServices.find(s => s.id === rule.targetServiceId);
                      const vendor = vendors.find(v => v.id === service?.vendorId);
                      const contentTypeLabel = CONTENT_TYPE_OPTIONS.find(opt => opt.value === rule.contentType)?.label;
                      return (
                        <tr key={rule.id}>
                          <td className="col-priority" style={rule.isDisabled ? { opacity: 0.4 } : undefined}>
                            <div className='col-priority-box'>
                              <span>{rule.sortOrder || 0}</span>
                              <button
                                className="priority-arrow-btn"
                                onClick={() => handleDecreasePriority(rule.id)}
                                title="降至最低优先级"
                              >
                                ↓
                              </button>
                              <button
                                className="priority-arrow-btn"
                                onClick={() => handleIncreasePriority(rule.id)}
                                title="升至最高优先级"
                              >
                                ↑
                              </button>
                            </div>
                          </td>
                          <td style={rule.isDisabled ? { opacity: 0.4 } : undefined}>
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
                          <td style={rule.isDisabled ? { opacity: 0.4 } : undefined}>
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
                          <td style={{ whiteSpace: 'nowrap', ...(rule.isDisabled ? { opacity: 0.4 } : {}) }}>
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

                              // 判断是否需要显示恢复按钮（黑名单或 WebSocket 挂起/错误状态）
                              const needsRecovery = isBlacklistedOnly ||
                                ruleStatuses[rule.id]?.status === 'error' ||
                                ruleStatuses[rule.id]?.status === 'suspended';

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
                                    {ruleStatus.status === 'suspended' && (
                                      <span style={{ color: '#6f42c1', fontWeight: 'bold', fontSize: '14px' }}>⏸</span>
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
                                            ruleStatus.status === 'suspended' ? '#6f42c1' :
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
                                  {/* 统一的恢复按钮 */}
                                  {needsRecovery && (
                                    <button
                                      className="btn btn-info"
                                      style={{ padding: '2px 8px', fontSize: '11px' }}
                                      onClick={() => handleRuleRecovery(rule.id)}
                                    >
                                      恢复
                                    </button>
                                  )}
                                </div>
                              );
                            })()}
                          </td>
                          <td style={rule.isDisabled ? { opacity: 0.4 } : undefined}>
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
                  <strong>📌 如何配置规则（推荐）</strong>
                  <div style={{ marginTop: '6px' }}>
                    • 先创建一条 <strong>默认</strong> 规则作为兜底，避免请求无规则可走<br />
                    • 再按你的实际场景增加规则：如图像理解、长上下文、思考、高智商等<br />
                    • 按类型匹配顺序：<strong>压缩对话 → 图像理解 → 高智商 → 长上下文 → 思考 → 后台 → 模型顶替 → 默认</strong><br />
                    • 如果要“指定模型走指定服务”，再加 <strong>模型顶替</strong> 规则<br />
                    • 同一类型可配多条：<strong>把主力服务放上面（优先级更大），备用服务放下面</strong><br />
                    • 开启智能故障切换后，系统会在主力不可用时自动切到下一个可用规则<br />
                    • 你只需要记住：<strong>先分类型，再排顺序，上主下备</strong>
                  </div>
                </div>
              )}
              {selectedRoute && rules.length > 0 && (
                <div style={{
                  fontSize: '12px',
                  color: 'var(--text-info-box)',
                  marginTop: '12px',
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
                    • 报错或超时的服务会被标记为不可用（默认10秒），可在设置页面修改“故障自动恢复时间”<br />
                    • 到达恢复时间后自动解除标记,如果再次报错或超时则重新标记<br />
                    • 确保您的请求始终路由到稳定可用的服务<br />
                    • 规则状态列会实时显示每个规则的可用性状态<br />
                    • 如不需要此功能,可在<strong>设置</strong>页面关闭"启用智能故障切换"选项
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>


      </div>

      {/* 规则配置 */}
      <div className="card">
        <div className="toolbar">
          <h3>规则配置</h3>
        </div>
        <div style={{ padding: '20px' }}>
          <div
            className="form-group"
            style={{
              marginBottom: '0',
              maxWidth: '420px',
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
            }}
          >
            <label
              htmlFor="rule-global-timeout"
              style={{ marginBottom: 0, minWidth: '140px', whiteSpace: 'nowrap' }}
            >
              超时时间（秒）
            </label>
            <input
              id="rule-global-timeout"
              type="number"
              value={ruleGlobalTimeout}
              onChange={(e) => setRuleGlobalTimeout(e.target.value)}
              onBlur={() => handleUpdateRuleGlobalTimeout()}
              min="1"
              placeholder="默认300秒"
              style={{ flex: 1, minWidth: 0 }}
            />
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '12px' }}>
            设置规则的全局超时时间。当单个规则未配置超时时间时，将使用此值作为超时上限。
            不设置则默认为300秒（5分钟）。超时后会自动触发故障切换到下一个可用规则。
          </div>
        </div>
      </div>

      {/* API 路径路由映射 */}
      <div className="card api-binding-card" style={{ marginTop: '20px' }}>
        <div className="api-binding-header">
          <h3>API 路径路由映射</h3>
        </div>
        <p className="api-binding-desc">
          将标准 API 路径绑定到路由，使任何兼容该 API 的编程工具都可以通过对应路径使用服务。
        </p>
        <div className="api-binding-baseurl-row">
          <span className="api-binding-baseurl-prefix">Base URL</span>
          <span className="api-binding-baseurl-value">{window.location.origin}</span>
        </div>
        <div className="api-binding-list">
          {apiPathBindings.map(binding => {
            const isModelsPath = binding.apiPath === '/v1/models';
            const isBound = isModelsPath ? !!apiPathModels.trim() : !!binding.routeId;
            return (
              <div key={binding.apiPath} className="api-binding-row">
                <span className={`api-binding-status ${isBound ? 'api-binding-status--bound' : ''}`} />
                <span className={`api-binding-path`}>
                  {binding.apiPath === '/v1beta/models' ? '/v1beta/models/{model}:{action}' : binding.apiPath}
                </span>
                <span className="api-binding-arrow">→</span>
                <div className="api-binding-control">
                  {isModelsPath ? (
                    <input
                      type="text"
                      value={apiPathModels}
                      onChange={(e) => setApiPathModels(e.target.value)}
                      onBlur={handleModelsBlur}
                      placeholder="自定义模型列表，英文逗号分隔，留空使用默认列表"
                    />
                  ) : (
                    <select
                      value={binding.routeId || ''}
                      onChange={(e) => handleBindingChange(binding.apiPath, e.target.value || null)}
                    >
                      <option value="">无</option>
                      {routes.map(r => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card" style={{ marginTop: '20px' }}>
        <div className="toolbar">
          <h3>Claude Code 全局配置</h3>
        </div>
        <div style={{ padding: '20px' }}>
          <div className="tool-binding-block">
            <div className="tool-binding-label">
              <span className="tool-binding-label-icon">⚡</span>
              激活路由
            </div>
            <div className="tool-binding-row">
              <select
                id="claude-route-binding"
                value={toolBindings?.['claude-code']?.routeId || ''}
                onChange={(e) => {
                  const routeId = e.target.value || null;
                  if (routeId) {
                    handleActivateToolRoute('claude-code', routeId);
                  }
                }}
                disabled={isConfiguringBinding === 'claude-code'}
              >
                <option value="">选择要激活的路由...</option>
                {routes.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.name}{toolBindings?.['claude-code']?.routeId === r.id ? ' (已激活)' : ''}
                  </option>
                ))}
              </select>
              {toolBindings?.['claude-code']?.routeId && (
                <button
                  className="btn btn-warning tool-binding-deactivate-btn"
                  onClick={() => handleDeactivateToolRoute('claude-code')}
                  disabled={isConfiguringBinding === 'claude-code'}
                >
                  {isConfiguringBinding === 'claude-code' ? '处理中...' : '停用'}
                </button>
              )}
            </div>
            <div className="tool-binding-desc">
              选择一条路由用于 Claude Code 代理请求。激活后，/claude-code/ 路径的请求将使用该路由的规则。
            </div>
          </div>

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
          <div style={{ marginBottom: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <input
                type="checkbox"
                id="agent-teams-toggle"
                checked={appConfig?.enableAgentTeams || false}
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
                : '开启后将启用 Agent Teams 实验性功能，并实时写入配置；重启 Claude Code 后生效。'}
            </div>
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <input
                type="checkbox"
                id="bypass-permissions-support-toggle"
                checked={appConfig?.enableBypassPermissionsSupport || false}
                onChange={(e) => handleToggleBypassPermissionsSupport(e.target.checked)}
                style={{ cursor: 'pointer', width: '16px', height: '16px' }}
              />
              <label
                htmlFor="bypass-permissions-support-toggle"
                style={{ cursor: 'pointer', fontSize: '14px', userSelect: 'none' }}
              >
                开启对 bypassPermissions 的支持
              </label>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '12px' }}>
              开启后默认编辑跳过危险模式权限提示，你可以切换到其他模式。该设置会实时写入配置文件，重启 Claude Code 后生效。
            </div>
          </div>
          <div style={{ marginTop: '20px' }}>
            <div
              className="form-group"
              style={{
                marginBottom: '0',
                maxWidth: '420px',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
              }}
            >
              <label
                htmlFor="claude-effort-level"
                style={{ marginBottom: 0, minWidth: '100px', whiteSpace: 'nowrap' }}
              >
                Effort Level
              </label>
              <select
                id="claude-effort-level"
                value={getGlobalClaudeEffortLevel(appConfig)}
                onChange={(e) => handleUpdateClaudeEffortLevel(e.target.value as ClaudeEffortLevel)}
                disabled={isUpdatingClaudeEffort}
                style={{ flex: 1, minWidth: 0 }}
              >
                {CLAUDE_EFFORT_LEVEL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '12px' }}>
              该设置会实时写入 ~/.claude/settings.json，重启 Claude Code 后生效。
            </div>
          </div>
          <div style={{ marginTop: '20px' }}>
            <div
              className="form-group"
              style={{
                marginBottom: '0',
                maxWidth: '420px',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
              }}
            >
              <label
                htmlFor="claude-default-model"
                style={{ marginBottom: 0, minWidth: '100px', whiteSpace: 'nowrap' }}
              >
                默认模型
              </label>
              <input
                id="claude-default-model"
                type="text"
                value={claudeDefaultModelInput}
                onChange={(e) => {
                  setClaudeDefaultModelInput(e.target.value);
                  setClaudeDefaultModelDirty(e.target.value !== (appConfig?.claudeDefaultModel || ''));
                }}
                onBlur={() => { if (claudeDefaultModelDirty) handleSaveClaudeDefaultModel(); }}
                placeholder="例如：claude-3-5-sonnet-20241022"
                style={{ flex: 1, minWidth: 0 }}
              />
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '12px' }}>
              设置后写入 ~/.claude/settings.json 的 model 字段，重启 Claude Code 后生效。留空则不写入。
            </div>
          </div>
          <div style={{ marginTop: '20px' }}>
            <div
              className="form-group"
              style={{
                marginBottom: '0',
                maxWidth: '420px',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
              }}
            >
              <label
                htmlFor="claude-autocompact-pct"
                style={{ marginBottom: 0, minWidth: '100px', whiteSpace: 'nowrap' }}
              >
                Autocompact PCT
              </label>
              <input
                id="claude-autocompact-pct"
                type="number"
                min="1"
                max="100"
                value={autocompactPctInput}
                onChange={(e) => {
                  setAutocompactPctInput(e.target.value);
                  setAutocompactPctDirty(e.target.value !== (appConfig?.autocompactPctOverride != null ? String(appConfig.autocompactPctOverride) : ''));
                }}
                onBlur={() => { if (autocompactPctDirty) handleSaveAutocompactPct(); }}
                placeholder="1-100"
                style={{ flex: 1, minWidth: 0 }}
              />
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '12px' }}>
              设置自动压缩百分比阈值（1-100），写入 ~/.claude/settings.json 的 env 字段，重启 Claude Code 后生效。留空则不写入。
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: '20px' }}>
        <div className="toolbar">
          <h3>Codex 全局配置</h3>
        </div>
        <div style={{ padding: '20px' }}>
          <div className="tool-binding-block">
            <div className="tool-binding-label">
              <span className="tool-binding-label-icon">⚡</span>
              激活路由
            </div>
            <div className="tool-binding-row">
              <select
                id="codex-route-binding"
                value={toolBindings?.['codex']?.routeId || ''}
                onChange={(e) => {
                  const routeId = e.target.value || null;
                  if (routeId) {
                    handleActivateToolRoute('codex', routeId);
                  }
                }}
                disabled={isConfiguringBinding === 'codex'}
              >
                <option value="">选择要激活的路由...</option>
                {routes.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.name}{toolBindings?.['codex']?.routeId === r.id ? ' (已激活)' : ''}
                  </option>
                ))}
              </select>
              {toolBindings?.['codex']?.routeId && (
                <button
                  className="btn btn-warning tool-binding-deactivate-btn"
                  onClick={() => handleDeactivateToolRoute('codex')}
                  disabled={isConfiguringBinding === 'codex'}
                >
                  {isConfiguringBinding === 'codex' ? '处理中...' : '停用'}
                </button>
              )}
            </div>
            <div className="tool-binding-desc">
              选择一条路由用于 Codex 代理请求。激活后，/codex/ 路径的请求将使用该路由的规则。
            </div>
          </div>
          <div
            className="form-group"
            style={{
              marginBottom: '0',
              maxWidth: '420px',
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
            }}
          >
            <label
              htmlFor="codex-reasoning-effort"
              style={{ marginBottom: 0, minWidth: '120px', whiteSpace: 'nowrap' }}
            >
              Reasoning Effort
            </label>
            <select
              id="codex-reasoning-effort"
              value={getGlobalCodexReasoningEffort(appConfig)}
              onChange={(e) => handleUpdateCodexReasoningEffort(e.target.value as CodexReasoningEffort)}
              disabled={isUpdatingCodexReasoning}
              style={{ flex: 1, minWidth: 0 }}
            >
              {CODEX_REASONING_EFFORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '12px' }}>
            该设置会实时写入 ~/.codex/config.toml，重启 Codex 后生效。
          </div>
          <div style={{ marginTop: '20px' }}>
            <div
              className="form-group"
              style={{
                marginBottom: '0',
                maxWidth: '420px',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
              }}
            >
              <label
                htmlFor="codex-default-model"
                style={{ marginBottom: 0, minWidth: '100px', whiteSpace: 'nowrap' }}
              >
                默认模型
              </label>
              <input
                id="codex-default-model"
                type="text"
                value={codexDefaultModelInput}
                onChange={(e) => {
                  setCodexDefaultModelInput(e.target.value);
                  setCodexDefaultModelDirty(e.target.value !== (appConfig?.codexDefaultModel || ''));
                }}
                onBlur={() => { if (codexDefaultModelDirty) handleSaveCodexDefaultModel(); }}
                placeholder="例如：o1"
                style={{ flex: 1, minWidth: 0 }}
              />
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '12px' }}>
              设置后写入 ~/.codex/config.toml 的 model 字段，重启 Codex 后生效。留空则使用默认值 gpt-5.3-codex。
            </div>
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
              配置文件由服务生命周期统一管理：服务启动时自动写入代理配置，服务停止时自动恢复原始配置；运行中修改全局工具配置会实时写入配置文件。
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
            <div style={{
              background: 'var(--bg-info-green)',
              padding: '15px',
              borderRadius: '8px',
              borderLeft: '4px solid var(--border-info-green)'
            }}>
              <strong>✓ 服务启动</strong>
              <ul style={{ marginTop: '8px', paddingLeft: '20px', marginBottom: '0' }}>
                <li>自动备份并覆盖配置文件</li>
                <li>按全局工具设置写入 Claude/Codex 配置</li>
              </ul>
            </div>

            <div style={{
              background: 'var(--bg-info-orange)',
              padding: '15px',
              borderRadius: '8px',
              borderLeft: '4px solid var(--border-info-orange)'
            }}>
              <strong>○ 服务停止</strong>
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
              <li>修改路由规则后立即生效；修改全局工具配置后仅需重启对应编程工具（无需重启服务）</li>
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
                        }}>[!]</code> 标记高智商请求（仅在”最近一条真实用户输入”生效）</li>
                        <li>使用 <code style={{
                          background: 'var(--bg-code-inline, #f5f5f5)',
                          padding: '2px 6px',
                          borderRadius: '3px',
                          fontFamily: 'monospace',
                          fontSize: '12px'
                        }}>[x]</code> 标记退出高智商模式，继续走普通模式</li>
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
                      }}>[!] 重构A模块</code><br />
                      • <code style={{
                        background: 'var(--bg-code-inline, #f5f5f5)',
                        padding: '2px 6px',
                        borderRadius: '3px',
                        fontFamily: 'monospace',
                        fontSize: '12px'
                      }}>继续正常对话（不加 [!]）</code><br />
                      • <code style={{
                        background: 'var(--bg-code-inline, #f5f5f5)',
                        padding: '2px 6px',
                        borderRadius: '3px',
                        fontFamily: 'monospace',
                        fontSize: '12px'
                      }}>[x] 接下来帮我解决一个简单的问题</code>
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

                {/* 长上下文类型显示session tokens阈值配置 */}
                {selectedContentType === 'long-context' && (
                  <div className="form-group">
                    <label>Session累积Tokens阈值 (单位: k) <small>默认1000k (1M tokens)</small></label>
                    <input
                      type="number"
                      value={selectedSessionTokenThreshold ?? 1000}
                      onChange={(e) => setSelectedSessionTokenThreshold(Number(e.target.value))}
                      placeholder="1000"
                      min="1"
                    />
                    <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                      当前对话（session）的累积tokens数量超过 {selectedSessionTokenThreshold ?? 1000}k 时，该对话的新请求将走此规则
                    </small>
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
                    placeholder={appConfig?.ruleGlobalTimeout ? `全局${appConfig.ruleGlobalTimeout}秒` : "默认300秒"}
                  />
                  <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                    设置此规则的API请求超时时间。不设置则使用全局超时配置（当前为{appConfig?.ruleGlobalTimeout ? `${appConfig.ruleGlobalTimeout}秒` : '默认300秒'}），超时后自动触发故障切换
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

      <QuickSetupModal
        show={showQuickSetupModal}
        onClose={() => setShowQuickSetupModal(false)}
        onComplete={() => {
          loadRoutes();
          loadVendors();
          loadAllServices();
          loadToolBindings();
          loadApiPathBindings();
        }}
      />

      <SyncConfigModal
        show={showSyncConfigModal}
        onClose={() => setShowSyncConfigModal(false)}
        onComplete={() => {
          loadVendors();
          loadAllServices();
        }}
      />

      {/* 绑定会话弹窗 */}
      {showBoundSessionsRouteId && (
        <div className="modal-overlay">
          <button
            type="button"
            className="modal-close-btn"
            onClick={handleCloseBoundSessions}
            aria-label="关闭"
          >×</button>
          <div className="modal" style={{ width: '500px', maxWidth: '90vw' }}>
            <div className="modal-header">
              <h2>绑定会话 - {routes.find(r => r.id === showBoundSessionsRouteId)?.name || showBoundSessionsRouteId}</h2>
            </div>
            <div className="modal-body-scrollable" style={{ padding: '20px' }}>
              {boundSessionsLoading ? (
                <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-tertiary)' }}>
                  加载中...
                </div>
              ) : boundSessions.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-tertiary)' }}>
                  <p>暂无绑定会话</p>
                </div>
              ) : (
                <div style={{ marginBottom: '12px', fontSize: '13px', color: 'var(--text-tertiary)' }}>
                  以下 {boundSessions.length} 个会话绑定了此路由：
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {boundSessions.slice(0, 50).map((s) => (
                  <div
                    key={s.id}
                    style={{
                      padding: '10px 14px',
                      backgroundColor: 'var(--bg-secondary)',
                      borderRadius: '6px',
                    }}
                  >
                    <div style={{ fontWeight: 500, fontSize: '14px', marginBottom: '4px' }}>
                      {s.title?.replace(/<\/?session>/g, '').trim() || s.id.slice(0, 8)}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', display: 'flex', gap: '12px', alignItems: 'center' }}>
                      <span className={`badge ${s.targetType === 'claude-code' ? 'badge-claude-code' : 'badge-codex'}`} style={{ fontSize: '11px' }}>
                        {s.targetType === 'claude-code' ? 'Claude Code' : 'Codex'}
                      </span>
                      <span>{s.requestCount} 次请求</span>
                      <span>{s.totalTokens.toLocaleString()} tokens</span>
                    </div>
                  </div>
                ))}
                {boundSessions.length > 50 && (
                  <div style={{ textAlign: 'center', fontSize: '12px', color: 'var(--text-tertiary)', padding: '8px' }}>
                    等共 {boundSessions.length} 个会话
                  </div>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <div style={{ flex: 1 }} />
              <button className="btn btn-secondary" onClick={handleCloseBoundSessions}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
