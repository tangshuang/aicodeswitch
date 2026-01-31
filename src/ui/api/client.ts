import type { Vendor, APIService, Route, Rule, RequestLog, ErrorLog, AppConfig, AuthStatus, LoginResponse, Statistics, ServiceBlacklistEntry, Session, InstalledSkill, SkillCatalogItem, SkillInstallResponse, TargetType } from '../../types';

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
  activateRoute: (id: string) => Promise<boolean>;
  deactivateRoute: (id: string) => Promise<boolean>;

  getRules: (routeId?: string) => Promise<Rule[]>;
  createRule: (route: Omit<Rule, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Rule>;
  updateRule: (id: string, route: Partial<Rule>) => Promise<boolean>;
  deleteRule: (id: string) => Promise<boolean>;
  resetRuleTokens: (id: string) => Promise<boolean>;
  resetRuleRequests: (id: string) => Promise<boolean>;
  clearRuleBlacklist: (id: string) => Promise<boolean>;
  getRulesBlacklistStatus: (routeId: string) => Promise<Array<{
    ruleId: string;
    isBlacklisted: boolean;
    blacklistEntry?: ServiceBlacklistEntry;
  }>>;

  getLogs: (limit: number, offset: number) => Promise<RequestLog[]>;
  clearLogs: () => Promise<boolean>;
  getLogsCount: () => Promise<{ count: number }>;

  getErrorLogs: (limit: number, offset: number) => Promise<ErrorLog[]>;
  clearErrorLogs: () => Promise<boolean>;
  getErrorLogsCount: () => Promise<{ count: number }>;

  getConfig: () => Promise<AppConfig>;
  updateConfig: (config: AppConfig) => Promise<boolean>;

  exportData: (password: string) => Promise<string>;
  importData: (encryptedData: string, password: string) => Promise<boolean>;

  writeClaudeConfig: () => Promise<boolean>;
  writeCodexConfig: () => Promise<boolean>;
  restoreClaudeConfig: () => Promise<boolean>;
  restoreCodexConfig: () => Promise<boolean>;
  checkClaudeBackup: () => Promise<{ exists: boolean }>;
  checkCodexBackup: () => Promise<{ exists: boolean }>;
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

  getStatistics: (days?: number) => Promise<Statistics>;

  // Sessions 相关
  getSessions: (limit?: number, offset?: number) => Promise<Session[]>;
  getSessionsCount: () => Promise<{ count: number }>;
  getSession: (id: string) => Promise<Session | null>;
  getSessionLogs: (id: string, limit?: number) => Promise<RequestLog[]>;
  deleteSession: (id: string) => Promise<boolean>;
  clearSessions: () => Promise<boolean>;

  getRecommendVendorsMarkdown: () => Promise<string>;
  getReadmeMarkdown: () => Promise<string>;

  // Skills 管理相关
  getInstalledSkills: () => Promise<InstalledSkill[]>;
  searchSkills: (query: string) => Promise<SkillCatalogItem[]>;
  installSkill: (skill: SkillCatalogItem, targetType: TargetType) => Promise<SkillInstallResponse>;

  // Migration 相关
  getMigration: () => Promise<{ shouldShow: boolean; content: string }>;
  acknowledgeMigration: () => Promise<{ success: boolean }>;
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
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

    const message = await response.text();
    throw new Error(message || response.statusText);
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
  activateRoute: (id) => requestJson(buildUrl(`/api/routes/${id}/activate`), { method: 'POST' }),
  deactivateRoute: (id) => requestJson(buildUrl(`/api/routes/${id}/deactivate`), { method: 'POST' }),

  getRules: (routeId) => requestJson(buildUrl('/api/rules', routeId ? { routeId } : undefined)),
  createRule: (route) => requestJson(buildUrl('/api/rules'), { method: 'POST', body: JSON.stringify(route) }),
  updateRule: (id, route) => requestJson(buildUrl(`/api/rules/${id}`), { method: 'PUT', body: JSON.stringify(route) }),
  deleteRule: (id) => requestJson(buildUrl(`/api/rules/${id}`), { method: 'DELETE' }),
  resetRuleTokens: (id) => requestJson(buildUrl(`/api/rules/${id}/reset-tokens`), { method: 'PUT' }),
  resetRuleRequests: (id) => requestJson(buildUrl(`/api/rules/${id}/reset-requests`), { method: 'PUT' }),
  clearRuleBlacklist: (id) => requestJson(buildUrl(`/api/rules/${id}/clear-blacklist`), { method: 'PUT' }),
  getRulesBlacklistStatus: (routeId) => requestJson(buildUrl(`/api/rules/${routeId}/blacklist-status`)),

  getLogs: (limit, offset) => requestJson(buildUrl('/api/logs', { limit, offset })),
  clearLogs: () => requestJson(buildUrl('/api/logs'), { method: 'DELETE' }),

  getErrorLogs: (limit, offset) => requestJson(buildUrl('/api/error-logs', { limit, offset })),
  clearErrorLogs: () => requestJson(buildUrl('/api/error-logs'), { method: 'DELETE' }),

  getLogsCount: () => requestJson<{ count: number }>(buildUrl('/api/logs/count')),
  getErrorLogsCount: () => requestJson<{ count: number }>(buildUrl('/api/error-logs/count')),

  getConfig: () => requestJson(buildUrl('/api/config')),
  updateConfig: (config) => requestJson(buildUrl('/api/config'), { method: 'PUT', body: JSON.stringify(config) }),

  exportData: async (password) => {
    const result = await requestJson<{ data: string }>(
      buildUrl('/api/export'),
      { method: 'POST', body: JSON.stringify({ password }) }
    );
    return result.data;
  },

  importData: (encryptedData, password) => requestJson(buildUrl('/api/import'), {
    method: 'POST',
    body: JSON.stringify({ encryptedData, password }),
  }),

  writeClaudeConfig: () => requestJson(buildUrl('/api/write-config/claude'), { method: 'POST' }),
  writeCodexConfig: () => requestJson(buildUrl('/api/write-config/codex'), { method: 'POST' }),
  restoreClaudeConfig: () => requestJson(buildUrl('/api/restore-config/claude'), { method: 'POST' }),
  restoreCodexConfig: () => requestJson(buildUrl('/api/restore-config/codex'), { method: 'POST' }),
  checkClaudeBackup: () => requestJson(buildUrl('/api/check-backup/claude')),
  checkCodexBackup: () => requestJson(buildUrl('/api/check-backup/codex')),
  // 新的详细配置状态 API
  getClaudeConfigStatus: () => requestJson(buildUrl('/api/config-status/claude')),
  getCodexConfigStatus: () => requestJson(buildUrl('/api/config-status/codex')),

  getStatistics: (days) => requestJson(buildUrl('/api/statistics', days ? { days } : undefined)),

  // Sessions 相关
  getSessions: (limit, offset) => requestJson(buildUrl('/api/sessions', { limit, offset })),
  getSessionsCount: () => requestJson<{ count: number }>(buildUrl('/api/sessions/count')),
  getSession: (id) => requestJson<Session | null>(buildUrl(`/api/sessions/${id}`)),
  getSessionLogs: (id, limit) => requestJson(buildUrl(`/api/sessions/${id}/logs`, { limit })),
  deleteSession: (id) => requestJson(buildUrl(`/api/sessions/${id}`), { method: 'DELETE' }),
  clearSessions: () => requestJson(buildUrl('/api/sessions'), { method: 'DELETE' }),

  getRecommendVendorsMarkdown: () => requestJson(buildUrl('/api/docs/recommend-vendors')),

  getReadmeMarkdown: () => requestJson(buildUrl('/api/docs/readme')),

  // Skills 管理相关
  getInstalledSkills: () => requestJson(buildUrl('/api/skills/installed')),
  searchSkills: (query) => requestJson(buildUrl('/api/skills/search'), {
    method: 'POST',
    body: JSON.stringify({ query })
  }),
  installSkill: (skill, targetType) => requestJson(buildUrl('/api/skills/install'), {
    method: 'POST',
    body: JSON.stringify({
      skillId: skill.id,
      name: skill.name,
      description: skill.description,
      tags: skill.tags,
      targetType,
    })
  }),

  // Migration 相关
  getMigration: () => requestJson(buildUrl('/api/migration')),
  acknowledgeMigration: () => requestJson(buildUrl('/api/migration/ack'), { method: 'POST' }),
};
