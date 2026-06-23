import type { Vendor, APIService, Route, Rule, RequestLog, ErrorLog, AppConfig, AuthStatus, LoginResponse, Statistics, ServiceBlacklistEntry, Session, InstalledSkill, SkillCatalogItem, SkillInstallResponse, TargetType, SkillDetail, ImportPreview, ImportResult, MCPServer, MCPInstallRequest, CodexReasoningEffort, ClaudePermissionDefaultMode, ApiPathBinding, ToolName, ToolBindings, MigrationOptions, MigrationPreview, MigrationResult, LaunchResult, AccessKey, Policy, KeyUsage, AccessKeyRequestLog, AccessKeySession, KeyUsageDailyRecord, QuotaAlert, LanDiscoverResponse, LanSyncRequest, LanSyncResult, PerfVendorOverview, PerfVendorDetail, PerfServiceDetail, PerfModelDetail, PerfServiceOverview } from '../../types';

interface BackendAPI {
  // 鉴权相关
  getAuthStatus: () => Promise<AuthStatus>;
  login: (authCode: string) => Promise<LoginResponse>;

  // 版本检查
  checkVersion: () => Promise<{ hasUpdate: boolean; currentVersion: string | null; latestVersion: string | null }>;

  getVendors: () => Promise<Vendor[]>;
  createVendor: (vendor: Omit<Vendor, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Vendor>;
  updateVendor: (id: string, vendor: Partial<Vendor>) => Promise<boolean>;
  deleteVendor: (id: string) => Promise<boolean>;

  getAPIServices: (vendorId?: string) => Promise<APIService[]>;
  createAPIService: (service: Omit<APIService, 'id' | 'createdAt' | 'updatedAt'>) => Promise<APIService>;
  updateAPIService: (id: string, service: Partial<APIService>) => Promise<boolean>;
  deleteAPIService: (id: string) => Promise<boolean>;

  getRoutes: () => Promise<Route[]>;
  createRoute: (group: Omit<Route, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Route>;
  updateRoute: (id: string, group: Partial<Route>) => Promise<boolean>;
  deleteRoute: (id: string) => Promise<boolean>;
  getToolBindings: () => Promise<ToolBindings>;
  activateToolRoute: (tool: ToolName, routeId: string) => Promise<{ success: boolean }>;
  deactivateToolRoute: (tool: ToolName) => Promise<{ success: boolean }>;

  getRules: (routeId?: string) => Promise<Rule[]>;
  createRule: (route: Omit<Rule, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Rule>;
  updateRule: (id: string, route: Partial<Rule>) => Promise<boolean>;
  deleteRule: (id: string) => Promise<boolean>;
  resetRuleTokens: (id: string) => Promise<boolean>;
  resetRuleRequests: (id: string) => Promise<boolean>;
  clearRuleBlacklist: (id: string) => Promise<boolean>;
  toggleRuleDisable: (id: string) => Promise<{ success: boolean; isDisabled: boolean }>;
  clearRuleStatus: (id: string) => Promise<boolean>;
  getRuleStatuses: () => Promise<Array<{
    ruleId: string;
    status: 'in_use' | 'idle' | 'error' | 'suspended';
    totalTokensUsed?: number;
    totalRequestsUsed?: number;
    errorMessage?: string;
    errorType?: 'http' | 'timeout' | 'unknown';
    timestamp: number;
  }>>;
  getRulesBlacklistStatus: (routeId: string) => Promise<Array<{
    ruleId: string;
    isBlacklisted: boolean;
    blacklistEntry?: ServiceBlacklistEntry;
  }>>;

  getLogs: (limit: number, offset: number) => Promise<RequestLog[]>;
  clearLogs: () => Promise<boolean>;
  getLogsCount: () => Promise<{ count: number }>;
  searchLogs: (query: string, limit: number, offset: number) => Promise<RequestLog[]>;
  searchLogsCount: (query: string) => Promise<{ count: number }>;
  queryLogs: (params: {
    filters?: { targetType?: string; vendorId?: string; serviceId?: string; model?: string; routeId?: string };
    keyword?: string;
    limit: number;
    offset: number;
  }) => Promise<{ logs: RequestLog[]; total: number }>;
  queryErrorLogs: (params: {
    filters?: { targetType?: string; vendorId?: string; serviceId?: string; model?: string; routeId?: string };
    keyword?: string;
    limit: number;
    offset: number;
  }) => Promise<{ logs: ErrorLog[]; total: number }>;

  getErrorLogs: (limit: number, offset: number) => Promise<ErrorLog[]>;
  clearErrorLogs: () => Promise<boolean>;
  getErrorLogsCount: () => Promise<{ count: number }>;
  searchErrorLogs: (query: string, limit: number, offset: number) => Promise<ErrorLog[]>;
  searchErrorLogsCount: (query: string) => Promise<{ count: number }>;

  getStatistics: (days?: number) => Promise<Statistics>;
  resetStatistics: () => Promise<boolean>;

  // 服务性能统计（全局，与 AUTH 无关）
  getPerformanceServicesOverview: () => Promise<PerfServiceOverview[]>;
  getPerformanceVendors: () => Promise<PerfVendorOverview[]>;
  getPerformanceVendor: (vendorId: string) => Promise<PerfVendorDetail>;
  getPerformanceService: (serviceId: string) => Promise<PerfServiceDetail>;
  getPerformanceModel: (serviceId: string, model: string) => Promise<PerfModelDetail>;

  getConfig: () => Promise<AppConfig>;
  updateConfig: (config: AppConfig) => Promise<boolean>;

  exportData: (password: string) => Promise<string>;
  previewImportData: (encryptedData: string, password: string) => Promise<ImportPreview>;
  importData: (encryptedData: string, password: string) => Promise<ImportResult>;

  writeClaudeConfig: (enableAgentTeams?: boolean, enableBypassPermissionsSupport?: boolean, permissionsDefaultMode?: ClaudePermissionDefaultMode) => Promise<boolean>;
  writeCodexConfig: (modelReasoningEffort?: CodexReasoningEffort, enableMemories?: boolean) => Promise<boolean>;
  restoreClaudeConfig: () => Promise<boolean>;
  restoreCodexConfig: () => Promise<boolean>;
  checkClaudeBackup: () => Promise<{ exists: boolean }>;
  checkCodexBackup: () => Promise<{ exists: boolean }>;
  updateClaudeAgentTeams: (enableAgentTeams: boolean) => Promise<boolean>;
  updateClaudeBypassPermissionsSupport: (enableBypassPermissionsSupport: boolean) => Promise<boolean>;
  updateCodexReasoningEffort: (modelReasoningEffort: CodexReasoningEffort) => Promise<boolean>;
  // 新的详细配置状态 API
  getClaudeConfigStatus: () => Promise<{
    isOverwritten: boolean;
    isModified: boolean;
    hasBackup: boolean;
    metadata?: {
      configType: string;
      timestamp: number;
      proxyMarker: string;
    };
  }>;
  getCodexConfigStatus: () => Promise<{
    isOverwritten: boolean;
    isModified: boolean;
    hasBackup: boolean;
    metadata?: {
      configType: string;
      timestamp: number;
      proxyMarker: string;
    };
  }>;

  // Sessions 相关
  getSessions: (params?: {
    filters?: { targetType?: string; vendorId?: string; serviceId?: string; model?: string; routeId?: string };
    keyword?: string;
    limit?: number;
    offset?: number;
  }) => Promise<{ sessions: Session[]; total: number }>;
  getSessionsCount: () => Promise<{ count: number }>;
  getSession: (id: string) => Promise<Session | null>;
  getSessionLogs: (id: string, limit?: number) => Promise<RequestLog[]>;
  deleteSession: (id: string) => Promise<boolean>;
  clearSessions: () => Promise<boolean>;
  cleanupSessions: (beforeDays: number, onlyLogs: boolean) => Promise<{ sessionsAffected: number; logsDeleted: number }>;

  getRecommendVendorsMarkdown: () => Promise<string>;
  getReadmeMarkdown: () => Promise<string>;

  // Agent Map（任务可视化节点地图）
  getAgentMapSessions: () => Promise<import('../../types').SessionMapItem[]>;
  getAgentMapSessionEvents: (id: string, since?: number) => Promise<import('../../types').ActivityEvent[]>;
  getAgentMapStats: () => Promise<import('../../types').AgentMapStats>;
  getAgentMapSessionMeta: (id: string) => Promise<{ source: 'global' | 'access-key' | 'unknown'; projectPath?: string; title?: string }>;
  getAgentMapNotify: () => Promise<{ enabled: boolean }>;
  setAgentMapNotify: (enabled: boolean) => Promise<{ enabled: boolean }>;
  setAgentMapNotifyFocus: (hidden: boolean) => Promise<{ ok: boolean }>;
  testAgentMapNotify: () => Promise<{ ok: boolean }>;
  /** 建立 Agent Map SSE 实时流（返回 AbortController，回调逐帧解析） */
  streamAgentMap: (handlers: {
    onInit?: (payload: import('../../types').AgentMapInitPayload) => void;
    onSessionUpdate?: (s: import('../../types').SessionMapItem) => void;
    onActivity?: (e: import('../../types').ActivityEvent) => void;
    onStats?: (s: import('../../types').AgentMapStats) => void;
    onError?: (err: Error) => void;
  }) => { abort: () => void };
  getUpgradeMarkdown: () => Promise<string>;

  // Skills 管理相关
  getInstalledSkills: () => Promise<InstalledSkill[]>;
  searchSkills: (query: string) => Promise<SkillCatalogItem[]>;
  getSkillDetails: (skillId: string) => Promise<SkillDetail | null>;
  installSkill: (skill: SkillCatalogItem, targetType?: TargetType) => Promise<SkillInstallResponse>;
  enableSkill: (skillId: string, targetType: TargetType) => Promise<{ success: boolean; error?: string }>;
  disableSkill: (skillId: string, targetType: TargetType) => Promise<{ success: boolean; error?: string }>;
  deleteSkill: (skillId: string) => Promise<{ success: boolean; error?: string }>;
  createLocalSkill: (data: { name: string; description: string; instruction: string; link?: string; targets: TargetType[] }) => Promise<SkillInstallResponse>;

  // Upgrade 相关
  getUpgrade: () => Promise<{ shouldShow: boolean; content: string }>;
  acknowledgeUpgrade: () => Promise<{ success: boolean }>;

  // MCP 工具管理相关
  getMCPs: () => Promise<MCPServer[]>;
  getMCP: (id: string) => Promise<MCPServer | null>;
  createMCP: (mcp: MCPInstallRequest) => Promise<MCPServer>;
  updateMCP: (id: string, mcp: Partial<MCPServer>) => Promise<boolean>;
  deleteMCP: (id: string) => Promise<boolean>;

  // Session Route Binding
  bindSessionRoute: (sessionId: string, routeId: string) => Promise<{ success: boolean; session?: Session; error?: string }>;
  unbindSessionRoute: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
  getBoundSessions: (routeId: string) => Promise<{ routeId: string; sessions: Array<{ id: string; title?: string; targetType: string; requestCount: number; totalTokens: number; lastRequestAt: number }> }>;

  // Session Migration
  migrationPreview: (sessionId: string, options: Partial<MigrationOptions>) => Promise<MigrationPreview>;
  migrateSession: (sessionId: string, options: Partial<MigrationOptions> & { editedPrompt?: string }) => Promise<MigrationResult>;
  migrateLaunch: (sessionId: string, options: Partial<MigrationOptions>) => Promise<LaunchResult>;

  // API 路径路由映射
  getApiPathBindings: () => Promise<{ bindings: ApiPathBinding[]; models: string }>;
  updateApiPathBindings: (bindings: ApiPathBinding[], models?: string) => Promise<{ success: boolean; bindings: ApiPathBinding[] }>;

  // AccessKey 接入密钥
  getAccessKeys: (params?: { page?: number; pageSize?: number; status?: string; policyId?: string; search?: string }) => Promise<{ data: (AccessKey & { policyName?: string })[]; total: number; page: number; pageSize: number }>;
  createAccessKey: (data: { name: string; remark?: string; policyId?: string }) => Promise<{ key: AccessKey; apiKey: string }>;
  getAccessKey: (id: string) => Promise<AccessKey & { policyName?: string }>;
  updateAccessKey: (id: string, data: Partial<Pick<AccessKey, 'name' | 'remark' | 'policyId' | 'status'>>) => Promise<boolean>;
  deleteAccessKey: (id: string) => Promise<boolean>;
  regenerateAccessKey: (id: string) => Promise<{ apiKey: string }>;
  batchUpdateAccessKeyStatus: (keyIds: string[], status: 'active' | 'disabled') => Promise<{ count: number }>;
  batchBindAccessKeyPolicy: (keyIds: string[], policyId: string) => Promise<{ count: number }>;
  batchDeleteAccessKeys: (keyIds: string[]) => Promise<{ count: number }>;
  getAccessKeyUsage: (id: string) => Promise<KeyUsage>;
  getAccessKeyUsageTrend: (id: string, days?: number) => Promise<KeyUsageDailyRecord[]>;
  getAccessKeyLogs: (id: string, params?: { page?: number; pageSize?: number; startDate?: string; endDate?: string; contentType?: string; search?: string }) => Promise<{ data: AccessKeyRequestLog[]; total: number }>;
  // AccessKey 会话
  getAccessKeySessions: (id: string, params?: { page?: number; pageSize?: number; targetType?: string; search?: string }) => Promise<{ data: AccessKeySession[]; total: number }>;
  getAccessKeySession: (keyId: string, sessionId: string) => Promise<AccessKeySession | null>;
  getAccessKeySessionLogs: (keyId: string, sessionId: string, limit?: number) => Promise<AccessKeyRequestLog[]>;
  deleteAccessKeySession: (keyId: string, sessionId: string) => Promise<boolean>;
  clearAccessKeySessions: (keyId: string) => Promise<boolean>;
  getAccessKeyGuide: (id: string, host?: string, port?: string) => Promise<{
    claudeCode: { description: string; envVars: Record<string, string> };
    codex: { description: string; envVars: Record<string, string> };
    openai: { description: string; envVars: Record<string, string> };
  }>;
  writeAccessKeyToLocal: (id: string, targets: string[]) => Promise<{ success: boolean; results: Record<string, boolean> }>;
  getWriteLocalRecords: () => Promise<{ accessKeyId: string; targets: string[]; timestamp: number }[]>;

  // Policy 策略
  getPolicies: () => Promise<(Policy & { keyCount?: number })[]>;
  createPolicy: (data: Omit<Policy, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Policy>;
  getPolicy: (id: string) => Promise<Policy>;
  updatePolicy: (id: string, data: Partial<Omit<Policy, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<boolean>;
  deletePolicy: (id: string) => Promise<boolean>;
  duplicatePolicy: (id: string) => Promise<Policy>;
  getPolicyKeys: (id: string) => Promise<AccessKey[]>;
  getPolicyTemplates: () => Promise<Array<{ name: string; description: string; config: Omit<Policy, 'id' | 'createdAt' | 'updatedAt'> }>>;

  // AccessKey 统计
  getAccessKeyRanking: (params?: { sortBy?: string; order?: string; limit?: number }) => Promise<Array<{ keyId: string; keyName: string; totalTokens: number; totalRequests: number; lastActiveAt?: number }>>;
  getQuotaAlerts: () => Promise<QuotaAlert[]>;

  // 局域网同步
  lanScan: () => Promise<{ localIp: string; subnet: string; port: number; networkInterfaces: Array<{ name: string; address: string; subnet: string; netmask: string }> }>;
  lanDiscover: (ip: string, port: number) => Promise<LanDiscoverResponse>;
  lanSync: (data: LanSyncRequest) => Promise<LanSyncResult>;
}

const buildUrl = (
  path: string,
  query?: Record<string, string | number | undefined>
): string => {
  if (!query) {
    return path;
  }
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  });
  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
};

const requestJson = async <T>(path: string, options: RequestInit = {}): Promise<T> => {
  // 从 localStorage 读取 token
  const token = localStorage.getItem('auth_token');

  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Access-Token': token } : {}),
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    // 如果是 401,清除本地 token 并抛出特殊错误
    if (response.status === 401) {
      localStorage.removeItem('auth_token');
      const message = await response.text();
      const error = new Error(message || response.statusText) as Error & { status: number };
      error.status = 401;
      throw error;
    }

    // 尝试解析 JSON 错误响应，如果失败则使用文本
    const text = await response.text();
    let parsedError: string | null = null;
    try {
      const jsonError = JSON.parse(text);
      if (jsonError.error) {
        parsedError = jsonError.error;
      }
    } catch {
      // JSON 解析失败，使用原始文本
    }
    throw new Error(parsedError || text || response.statusText);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json() as Promise<T>;
  }
  return response.text() as Promise<T>;
};

export const api: BackendAPI = {
  // 鉴权相关
  getAuthStatus: () => requestJson(buildUrl('/api/auth/status')),
  login: (authCode) => requestJson(buildUrl('/api/auth/login'), {
    method: 'POST',
    body: JSON.stringify({ authCode })
  }),

  // 版本检查
  checkVersion: () => requestJson(buildUrl('/api/version/check')),

  getVendors: () => requestJson(buildUrl('/api/vendors')),
  createVendor: (vendor) => requestJson(buildUrl('/api/vendors'), { method: 'POST', body: JSON.stringify(vendor) }),
  updateVendor: (id, vendor) => requestJson(buildUrl(`/api/vendors/${id}`), { method: 'PUT', body: JSON.stringify(vendor) }),
  deleteVendor: (id) => requestJson(buildUrl(`/api/vendors/${id}`), { method: 'DELETE' }),

  getAPIServices: (vendorId) => requestJson(buildUrl('/api/services', vendorId ? { vendorId } : undefined)),
  createAPIService: (service) => requestJson(buildUrl('/api/services'), { method: 'POST', body: JSON.stringify(service) }),
  updateAPIService: (id, service) => requestJson(buildUrl(`/api/services/${id}`), { method: 'PUT', body: JSON.stringify(service) }),
  deleteAPIService: (id) => requestJson(buildUrl(`/api/services/${id}`), { method: 'DELETE' }),

  getRoutes: () => requestJson(buildUrl('/api/routes')),
  createRoute: (group) => requestJson(buildUrl('/api/routes'), { method: 'POST', body: JSON.stringify(group) }),
  updateRoute: (id, group) => requestJson(buildUrl(`/api/routes/${id}`), { method: 'PUT', body: JSON.stringify(group) }),
  deleteRoute: (id) => requestJson(buildUrl(`/api/routes/${id}`), { method: 'DELETE' }),
  getToolBindings: () => requestJson(buildUrl('/api/tool-bindings')),
  activateToolRoute: (tool: ToolName, routeId: string) => requestJson(buildUrl('/api/tool-bindings/activate'), { method: 'POST', body: JSON.stringify({ tool, routeId }) }),
  deactivateToolRoute: (tool: ToolName) => requestJson(buildUrl('/api/tool-bindings/deactivate'), { method: 'POST', body: JSON.stringify({ tool }) }),

  getRules: (routeId) => requestJson(buildUrl('/api/rules', routeId ? { routeId } : undefined)),
  createRule: (route) => requestJson(buildUrl('/api/rules'), { method: 'POST', body: JSON.stringify(route) }),
  updateRule: (id, route) => requestJson(buildUrl(`/api/rules/${id}`), { method: 'PUT', body: JSON.stringify(route) }),
  deleteRule: (id) => requestJson(buildUrl(`/api/rules/${id}`), { method: 'DELETE' }),
  resetRuleTokens: (id) => requestJson(buildUrl(`/api/rules/${id}/reset-tokens`), { method: 'PUT' }),
  resetRuleRequests: (id) => requestJson(buildUrl(`/api/rules/${id}/reset-requests`), { method: 'PUT' }),
  clearRuleBlacklist: (id) => requestJson(buildUrl(`/api/rules/${id}/clear-blacklist`), { method: 'PUT' }),
  toggleRuleDisable: (id) => requestJson(buildUrl(`/api/rules/${id}/toggle-disable`), { method: 'PUT' }),
  clearRuleStatus: (id) => requestJson(buildUrl(`/api/rules/${id}/clear-status`), { method: 'POST' }),
  getRuleStatuses: () => requestJson(buildUrl('/api/rules/status')),
  getRulesBlacklistStatus: (routeId) => requestJson(buildUrl(`/api/rules/${routeId}/blacklist-status`)),

  getLogs: (limit, offset) => requestJson(buildUrl('/api/logs', { limit, offset })),
  clearLogs: () => requestJson(buildUrl('/api/logs'), { method: 'DELETE' }),

  getErrorLogs: (limit, offset) => requestJson(buildUrl('/api/error-logs', { limit, offset })),
  clearErrorLogs: () => requestJson(buildUrl('/api/error-logs'), { method: 'DELETE' }),

  getLogsCount: () => requestJson<{ count: number }>(buildUrl('/api/logs/count')),
  getErrorLogsCount: () => requestJson<{ count: number }>(buildUrl('/api/error-logs/count')),

  searchLogs: (query, limit, offset) => requestJson(buildUrl('/api/logs/search', { query, limit, offset })),
  searchLogsCount: (query) => requestJson<{ count: number }>(buildUrl('/api/logs/search/count', { query })),
  queryLogs: async ({ filters, keyword, limit, offset }) => {
    const raw = await requestJson<unknown>(
      buildUrl('/api/logs', {
        targetType: filters?.targetType,
        vendorId: filters?.vendorId,
        serviceId: filters?.serviceId,
        model: filters?.model,
        routeId: filters?.routeId,
        keyword,
        limit,
        offset,
      })
    );
    // 新格式 { logs, total }
    if (!Array.isArray(raw)) {
      const obj = raw as { logs?: RequestLog[]; total?: number };
      return { logs: obj.logs ?? [], total: obj.total ?? 0 };
    }
    // 旧格式（裸数组，旧版服务）：补一次 count 以保证分页正确
    const logs = raw as RequestLog[];
    let total = logs.length;
    try {
      const hasFilter = !!(filters && (filters.targetType || filters.vendorId || filters.serviceId || filters.model || filters.routeId));
      if (!hasFilter) {
        const c = await requestJson<{ count: number }>(buildUrl('/api/logs/count'));
        total = c.count;
      }
    } catch { /* 旧版服务无 count 时退化为本页条数 */ }
    return { logs, total };
  },
  queryErrorLogs: async ({ filters, keyword, limit, offset }) => {
    const raw = await requestJson<unknown>(
      buildUrl('/api/error-logs', {
        targetType: filters?.targetType,
        vendorId: filters?.vendorId,
        serviceId: filters?.serviceId,
        model: filters?.model,
        routeId: filters?.routeId,
        keyword,
        limit,
        offset,
      })
    );
    if (!Array.isArray(raw)) {
      const obj = raw as { logs?: ErrorLog[]; total?: number };
      return { logs: obj.logs ?? [], total: obj.total ?? 0 };
    }
    const logs = raw as ErrorLog[];
    let total = logs.length;
    try {
      const hasFilter = !!(filters && (filters.targetType || filters.vendorId || filters.serviceId || filters.model || filters.routeId)) || !!keyword;
      if (!hasFilter) {
        const c = await requestJson<{ count: number }>(buildUrl('/api/error-logs/count'));
        total = c.count;
      }
    } catch { /* 旧版服务无 count 时退化为本页条数 */ }
    return { logs, total };
  },
  searchErrorLogs: (query, limit, offset) => requestJson(buildUrl('/api/error-logs/search', { query, limit, offset })),
  searchErrorLogsCount: (query) => requestJson<{ count: number }>(buildUrl('/api/error-logs/search/count', { query })),

  getStatistics: (days = 30) => requestJson(buildUrl('/api/statistics', { days })),
  resetStatistics: () => requestJson(buildUrl('/api/statistics'), { method: 'DELETE' }),

  // 服务性能统计（全局，与 AUTH 无关）
  getPerformanceServicesOverview: () => requestJson(buildUrl('/api/performance/services-overview')),
  getPerformanceVendors: () => requestJson(buildUrl('/api/performance/vendors')),
  getPerformanceVendor: (vendorId) => requestJson(buildUrl(`/api/performance/vendors/${vendorId}`)),
  getPerformanceService: (serviceId) => requestJson(buildUrl(`/api/performance/services/${serviceId}`)),
  getPerformanceModel: (serviceId, model) => requestJson(buildUrl(`/api/performance/services/${serviceId}/models/${encodeURIComponent(model)}`)),

  getConfig: () => requestJson(buildUrl('/api/config')),
  updateConfig: (config) => requestJson(buildUrl('/api/config'), { method: 'PUT', body: JSON.stringify(config) }),

  exportData: async (password) => {
    const result = await requestJson<{ data: string }>(
      buildUrl('/api/export'),
      { method: 'POST', body: JSON.stringify({ password }) }
    );
    return result.data;
  },

  previewImportData: (encryptedData: string, password: string) =>
    requestJson<ImportPreview>(buildUrl('/api/import/preview'), {
      method: 'POST',
      body: JSON.stringify({ encryptedData, password }),
    }),
  importData: (encryptedData: string, password: string) =>
    requestJson<ImportResult>(buildUrl('/api/import'), {
      method: 'POST',
      body: JSON.stringify({ encryptedData, password }),
    }),

  writeClaudeConfig: (enableAgentTeams?: boolean, enableBypassPermissionsSupport?: boolean, permissionsDefaultMode?: ClaudePermissionDefaultMode) =>
    requestJson(buildUrl('/api/write-config/claude'), {
      method: 'POST',
      body: JSON.stringify({ enableAgentTeams, enableBypassPermissionsSupport, permissionsDefaultMode })
    }),
  writeCodexConfig: (modelReasoningEffort?: CodexReasoningEffort, enableMemories?: boolean) =>
    requestJson(buildUrl('/api/write-config/codex'), {
      method: 'POST',
      body: JSON.stringify({ modelReasoningEffort, enableMemories })
    }),
  restoreClaudeConfig: () => requestJson(buildUrl('/api/restore-config/claude'), { method: 'POST' }),
  restoreCodexConfig: () => requestJson(buildUrl('/api/restore-config/codex'), { method: 'POST' }),
  updateClaudeAgentTeams: (enableAgentTeams: boolean) =>
    requestJson(buildUrl('/api/update-claude-agent-teams'), {
      method: 'POST',
      body: JSON.stringify({ enableAgentTeams })
    }),
  updateClaudeBypassPermissionsSupport: (enableBypassPermissionsSupport: boolean) =>
    requestJson(buildUrl('/api/update-claude-bypass-permissions-support'), {
      method: 'POST',
      body: JSON.stringify({ enableBypassPermissionsSupport })
    }),
  updateCodexReasoningEffort: (modelReasoningEffort: CodexReasoningEffort) =>
    requestJson(buildUrl('/api/update-codex-reasoning-effort'), {
      method: 'POST',
      body: JSON.stringify({ modelReasoningEffort })
    }),
  checkClaudeBackup: () => requestJson(buildUrl('/api/check-backup/claude')),
  checkCodexBackup: () => requestJson(buildUrl('/api/check-backup/codex')),
  // 新的详细配置状态 API
  getClaudeConfigStatus: () => requestJson(buildUrl('/api/config-status/claude')),
  getCodexConfigStatus: () => requestJson(buildUrl('/api/config-status/codex')),

  // Sessions 相关
  getSessions: async ({ filters, keyword, limit, offset } = {}) => {
    const raw = await requestJson<unknown>(
      buildUrl('/api/sessions', {
        targetType: filters?.targetType,
        vendorId: filters?.vendorId,
        serviceId: filters?.serviceId,
        model: filters?.model,
        routeId: filters?.routeId,
        keyword,
        limit,
        offset,
      })
    );
    // 新格式 { sessions, total }
    if (!Array.isArray(raw)) {
      const obj = raw as { sessions?: Session[]; total?: number };
      return { sessions: obj.sessions ?? [], total: obj.total ?? 0 };
    }
    // 旧格式（裸数组，旧版服务）：补一次 count 以保证分页正确
    const sessions = raw as Session[];
    let total = sessions.length;
    try {
      const hasFilter = !!(filters && (filters.targetType || filters.vendorId || filters.serviceId || filters.model || filters.routeId)) || !!keyword;
      if (!hasFilter) {
        const c = await requestJson<{ count: number }>(buildUrl('/api/sessions/count'));
        total = c.count;
      }
    } catch { /* 旧版服务无 count 时退化为本页条数 */ }
    return { sessions, total };
  },
  getSessionsCount: () => requestJson<{ count: number }>(buildUrl('/api/sessions/count')),
  getSession: (id) => requestJson<Session | null>(buildUrl(`/api/sessions/${id}`)),
  getSessionLogs: (id, limit) => requestJson(buildUrl(`/api/sessions/${id}/logs`, { limit })),
  deleteSession: (id) => requestJson(buildUrl(`/api/sessions/${id}`), { method: 'DELETE' }),
  clearSessions: () => requestJson(buildUrl('/api/sessions'), { method: 'DELETE' }),
  cleanupSessions: (beforeDays, onlyLogs) => requestJson(buildUrl('/api/sessions/cleanup'), {
    method: 'POST',
    body: JSON.stringify({ beforeDays, onlyLogs })
  }),

  getRecommendVendorsMarkdown: () => requestJson(buildUrl('/api/docs/recommend-vendors')),

  getReadmeMarkdown: () => requestJson(buildUrl('/api/docs/readme')),

  // Skills 管理相关
  getInstalledSkills: () => requestJson(buildUrl('/api/skills/installed')),
  searchSkills: (query) => requestJson(buildUrl('/api/skills/search'), {
    method: 'POST',
    body: JSON.stringify({ query })
  }),
  getSkillDetails: (skillId) => requestJson<SkillDetail | null>(buildUrl(`/api/skills/${skillId}/details`)),
  installSkill: (skill, targetType) => requestJson(buildUrl('/api/skills/install'), {
    method: 'POST',
    body: JSON.stringify({
      skillId: skill.id,
      name: skill.name,
      description: skill.description,
      tags: skill.tags,
      ...(targetType ? { targetType } : {}),
      githubUrl: skill.url,
    })
  }),
  enableSkill: (skillId: string, targetType: TargetType) => requestJson(buildUrl(`/api/skills/${skillId}/enable`), {
    method: 'POST',
    body: JSON.stringify({ targetType })
  }),
  disableSkill: (skillId: string, targetType: TargetType) => requestJson(buildUrl(`/api/skills/${skillId}/disable`), {
    method: 'POST',
    body: JSON.stringify({ targetType })
  }),
  deleteSkill: (skillId: string) => requestJson(buildUrl(`/api/skills/${skillId}`), {
    method: 'DELETE'
  }),
  createLocalSkill: (data) => requestJson(buildUrl('/api/skills/create-local'), {
    method: 'POST',
    body: JSON.stringify(data)
  }),

  // Upgrade 相关
  getUpgradeMarkdown: () => requestJson(buildUrl('/api/docs/upgrade')),
  getUpgrade: () => requestJson(buildUrl('/api/upgrade')),
  acknowledgeUpgrade: () => requestJson(buildUrl('/api/upgrade/ack'), { method: 'POST' }),

  // MCP 工具管理相关
  getMCPs: () => requestJson<MCPServer[]>(buildUrl('/api/mcps')),
  getMCP: (id: string) => requestJson<MCPServer | null>(buildUrl(`/api/mcps/${id}`)),
  createMCP: (mcp: MCPInstallRequest) => requestJson<MCPServer>(buildUrl('/api/mcps'), {
    method: 'POST',
    body: JSON.stringify(mcp)
  }),
  updateMCP: (id: string, mcp: Partial<MCPServer>) => requestJson<boolean>(buildUrl(`/api/mcps/${id}`), {
    method: 'PUT',
    body: JSON.stringify(mcp)
  }),
  deleteMCP: (id: string) => requestJson<boolean>(buildUrl(`/api/mcps/${id}`), {
    method: 'DELETE'
  }),

  // Session Route Binding
  bindSessionRoute: (sessionId: string, routeId: string) =>
    requestJson<{ success: boolean; session?: Session; error?: string }>(buildUrl(`/api/sessions/${sessionId}/bind-route`), {
      method: 'PUT',
      body: JSON.stringify({ routeId }),
    }),
  unbindSessionRoute: (sessionId: string) =>
    requestJson<{ success: boolean; error?: string }>(buildUrl(`/api/sessions/${sessionId}/bind-route`), {
      method: 'DELETE',
    }),
  getBoundSessions: (routeId: string) =>
    requestJson(buildUrl(`/api/routes/${routeId}/bound-sessions`)),

  // Session Migration
  migrationPreview: (sessionId: string, options: Partial<MigrationOptions>) =>
    requestJson<MigrationPreview>(buildUrl(`/api/sessions/${sessionId}/migration-preview`), {
      method: 'POST',
      body: JSON.stringify(options),
    }),
  migrateSession: (sessionId: string, options: Partial<MigrationOptions> & { editedPrompt?: string }) =>
    requestJson<MigrationResult>(buildUrl(`/api/sessions/${sessionId}/migrate`), {
      method: 'POST',
      body: JSON.stringify(options),
    }),
  migrateLaunch: (sessionId: string, options: Partial<MigrationOptions>) =>
    requestJson<LaunchResult>(buildUrl(`/api/sessions/${sessionId}/migrate-launch`), {
      method: 'POST',
      body: JSON.stringify(options),
    }),

  // API 路径路由映射
  getApiPathBindings: () => requestJson(buildUrl('/api/api-path-bindings')),
  updateApiPathBindings: (bindings: ApiPathBinding[], models?: string) =>
    requestJson(buildUrl('/api/api-path-bindings'), {
      method: 'PUT',
      body: JSON.stringify({ bindings, models }),
    }),

  // AccessKey 接入密钥
  getAccessKeys: (params) => requestJson(buildUrl('/api/access-keys', params as Record<string, string | number | undefined>)),
  createAccessKey: (data) => requestJson(buildUrl('/api/access-keys'), { method: 'POST', body: JSON.stringify(data) }),
  getAccessKey: (id) => requestJson(buildUrl(`/api/access-keys/${id}`)),
  updateAccessKey: (id, data) => requestJson(buildUrl(`/api/access-keys/${id}`), { method: 'PUT', body: JSON.stringify(data) }),
  deleteAccessKey: (id) => requestJson(buildUrl(`/api/access-keys/${id}`), { method: 'DELETE' }),
  regenerateAccessKey: (id) => requestJson(buildUrl(`/api/access-keys/${id}/regenerate`), { method: 'POST' }),
  batchUpdateAccessKeyStatus: (keyIds, status) => requestJson(buildUrl('/api/access-keys/batch/status'), { method: 'PUT', body: JSON.stringify({ keyIds, status }) }),
  batchBindAccessKeyPolicy: (keyIds, policyId) => requestJson(buildUrl('/api/access-keys/batch/policy'), { method: 'PUT', body: JSON.stringify({ keyIds, policyId }) }),
  batchDeleteAccessKeys: (keyIds) => requestJson(buildUrl('/api/access-keys/batch'), { method: 'DELETE', body: JSON.stringify({ keyIds }) }),
  getAccessKeyUsage: (id) => requestJson(buildUrl(`/api/access-keys/${id}/usage`)),
  getAccessKeyUsageTrend: (id, days) => requestJson(buildUrl(`/api/access-keys/${id}/usage/trend`, { days })),
  getAccessKeyLogs: (id, params) => requestJson(buildUrl(`/api/access-keys/${id}/logs`, params as Record<string, string | number | undefined>)),
  // AccessKey 会话
  getAccessKeySessions: (id, params) => requestJson(buildUrl(`/api/access-keys/${id}/sessions`, params as Record<string, string | number | undefined>)),
  getAccessKeySession: (keyId, sessionId) => requestJson(buildUrl(`/api/access-keys/${keyId}/sessions/${sessionId}`)),
  getAccessKeySessionLogs: (keyId, sessionId, limit) => requestJson(buildUrl(`/api/access-keys/${keyId}/sessions/${sessionId}/logs`, { limit })),
  deleteAccessKeySession: (keyId, sessionId) => requestJson(buildUrl(`/api/access-keys/${keyId}/sessions/${sessionId}`), { method: 'DELETE' }),
  clearAccessKeySessions: (keyId) => requestJson(buildUrl(`/api/access-keys/${keyId}/sessions`), { method: 'DELETE' }),
  getAccessKeyGuide: (id, host, port) => requestJson(buildUrl(`/api/access-keys/${id}/guide`, { host, port })),
  writeAccessKeyToLocal: (id, targets: string[]) => requestJson(buildUrl(`/api/access-keys/${id}/write-local`), { method: 'POST', body: JSON.stringify({ targets }) }),
  getWriteLocalRecords: () => requestJson(buildUrl('/api/write-local-records')),

  // Policy 策略
  getPolicies: () => requestJson(buildUrl('/api/policies')),
  createPolicy: (data) => requestJson(buildUrl('/api/policies'), { method: 'POST', body: JSON.stringify(data) }),
  getPolicy: (id) => requestJson(buildUrl(`/api/policies/${id}`)),
  updatePolicy: (id, data) => requestJson(buildUrl(`/api/policies/${id}`), { method: 'PUT', body: JSON.stringify(data) }),
  deletePolicy: (id) => requestJson(buildUrl(`/api/policies/${id}`), { method: 'DELETE' }),
  duplicatePolicy: (id) => requestJson(buildUrl(`/api/policies/${id}/duplicate`), { method: 'POST' }),
  getPolicyKeys: (id) => requestJson(buildUrl(`/api/policies/${id}/keys`)),
  getPolicyTemplates: () => requestJson(buildUrl('/api/policies/templates')),

  // AccessKey 统计
  getAccessKeyRanking: (params) => requestJson(buildUrl('/api/statistics/access-keys', params as Record<string, string | number | undefined>)),
  getQuotaAlerts: () => requestJson(buildUrl('/api/statistics/quota-alerts')),

  // 局域网同步
  lanScan: () => requestJson(buildUrl('/api/lan/scan')),
  lanDiscover: (ip, port) => {
    // 直接请求远端节点，不经过本地代理
    const url = `http://${ip}:${port}/api/lan/discover`;
    return fetch(url, { signal: AbortSignal.timeout(3000) }).then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    });
  },
  lanSync: (data) => requestJson(buildUrl('/api/lan/sync'), { method: 'POST', body: JSON.stringify(data) }),

  // Agent Map（任务可视化节点地图）
  getAgentMapSessions: () => requestJson(buildUrl('/api/agent-map/sessions')),
  getAgentMapSessionEvents: (id, since) => requestJson(buildUrl(`/api/agent-map/sessions/${id}/events`, since != null ? { since } : undefined)),
  getAgentMapStats: () => requestJson(buildUrl('/api/agent-map/stats')),
  getAgentMapSessionMeta: (id) => requestJson(buildUrl(`/api/agent-map/sessions/${id}/meta`)),
  getAgentMapNotify: () => requestJson(buildUrl('/api/agent-map/notify')),
  setAgentMapNotify: (enabled) => requestJson(buildUrl('/api/agent-map/notify'), { method: 'POST', body: JSON.stringify({ enabled }) }),
  setAgentMapNotifyFocus: (hidden) => requestJson(buildUrl('/api/agent-map/notify-focus'), { method: 'POST', body: JSON.stringify({ hidden }) }),
  testAgentMapNotify: () => requestJson(buildUrl('/api/agent-map/notify-test'), { method: 'POST' }),
  streamAgentMap: (handlers) => {
    const controller = new AbortController();
    const token = localStorage.getItem('auth_token');
    let stopped = false;
    let attempt = 0;

    // 一次连接 + 读循环；正常结束或抛错由外层 loop 决定是否重连
    const runOnce = async () => {
      const resp = await fetch('/api/agent-map/stream', {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'Accept': 'text/event-stream',
          ...(token ? { 'Access-Token': token } : {}),
        },
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE 帧以双换行分隔
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split('\n').find(l => l.startsWith('data:'));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (!payload) continue;
          let msg: any;
          try { msg = JSON.parse(payload); } catch { continue; }
          switch (msg.type) {
            case 'init':
              handlers.onInit?.({
                type: 'init',
                sessions: msg.sessions || [],
                events: msg.events || [],
                stats: msg.stats,
                serverTime: msg.serverTime,
              });
              break;
            case 'session-update': handlers.onSessionUpdate?.(msg.session); break;
            case 'activity': handlers.onActivity?.(msg.event); break;
            case 'stats': handlers.onStats?.(msg.stats); break;
            // heartbeat 忽略
          }
        }
      }
    };

    // 自动重连：连接断开（done/error）后，按指数退避重试，直到用户 abort
    (async () => {
      while (!stopped) {
        try {
          await runOnce();
          attempt = 0; // 成功连上并正常结束 → 重置退避
        } catch (err: any) {
          if (err?.name === 'AbortError') return; // 用户主动断开
          handlers.onError?.(err);
        }
        if (stopped) break;
        attempt = Math.min(attempt + 1, 5);
        const delay = Math.min(1000 * 2 ** (attempt - 1), 15000); // 1s → 2s → 4s → 8s → 15s 封顶
        await new Promise(r => setTimeout(r, delay));
      }
    })();

    return {
      abort: () => {
        stopped = true;
        controller.abort();
      },
    };
  },
};
