import type { Vendor, APIService, Route, Rule, RequestLog, AccessLog, ErrorLog, AppConfig, AuthStatus, LoginResponse, Statistics } from '../../types';

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

  getLogs: (limit: number, offset: number) => Promise<RequestLog[]>;
  clearLogs: () => Promise<boolean>;

  getAccessLogs: (limit: number, offset: number) => Promise<AccessLog[]>;
  clearAccessLogs: () => Promise<boolean>;

  getErrorLogs: (limit: number, offset: number) => Promise<ErrorLog[]>;
  clearErrorLogs: () => Promise<boolean>;

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

  getStatistics: (days?: number) => Promise<Statistics>;
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

  getLogs: (limit, offset) => requestJson(buildUrl('/api/logs', { limit, offset })),
  clearLogs: () => requestJson(buildUrl('/api/logs'), { method: 'DELETE' }),

  getAccessLogs: (limit, offset) => requestJson(buildUrl('/api/access-logs', { limit, offset })),
  clearAccessLogs: () => requestJson(buildUrl('/api/access-logs'), { method: 'DELETE' }),

  getErrorLogs: (limit, offset) => requestJson(buildUrl('/api/error-logs', { limit, offset })),
  clearErrorLogs: () => requestJson(buildUrl('/api/error-logs'), { method: 'DELETE' }),

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

  getStatistics: (days) => requestJson(buildUrl('/api/statistics', days ? { days } : undefined)),
};
