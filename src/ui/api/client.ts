import type { Vendor, APIService, Route, Rule, RequestLog, ErrorLog, AppConfig, AuthStatus, LoginResponse, Statistics, ServiceBlacklistEntry, Session, InstalledSkill, SkillCatalogItem, SkillInstallResponse, TargetType, SkillDetail, ToolInstallationStatus, ImportPreview, ImportResult, MCPServer, MCPInstallRequest } from '../../types';

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
  toggleRuleDisable: (id: string) => Promise<{ success: boolean; isDisabled: boolean }>;
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

  getStatistics: (days?: number) => Promise<Statistics>;
  resetStatistics: () => Promise<boolean>;

  getConfig: () => Promise<AppConfig>;
  updateConfig: (config: AppConfig) => Promise<boolean>;

  exportData: (password: string) => Promise<string>;
  previewImportData: (encryptedData: string, password: string) => Promise<ImportPreview>;
  importData: (encryptedData: string, password: string) => Promise<ImportResult>;

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

  // Sessions 相关
  getSessions: (limit?: number, offset?: number) => Promise<Session[]>;
  getSessionsCount: () => Promise<{ count: number }>;
  getSession: (id: string) => Promise<Session | null>;
  getSessionLogs: (id: string, limit?: number) => Promise<RequestLog[]>;
  deleteSession: (id: string) => Promise<boolean>;
  clearSessions: () => Promise<boolean>;

  getRecommendVendorsMarkdown: () => Promise<string>;
  getReadmeMarkdown: () => Promise<string>;
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

  // 工具安装相关
  getToolsStatus: () => Promise<ToolInstallationStatus>;
  installTool: (tool: 'claude-code' | 'codex', callbacks: {
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
    onClose?: (code: number | null, success: boolean) => void;
    onError?: (error: string) => void;
  }) => (() => void) & { sendInput?: (input: string) => void }; // 返回取消函数和发送输入函数

  // MCP 工具管理相关
  getMCPs: () => Promise<MCPServer[]>;
  getMCP: (id: string) => Promise<MCPServer | null>;
  createMCP: (mcp: MCPInstallRequest) => Promise<MCPServer>;
  updateMCP: (id: string, mcp: Partial<MCPServer>) => Promise<boolean>;
  deleteMCP: (id: string) => Promise<boolean>;
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
  activateRoute: (id) => requestJson(buildUrl(`/api/routes/${id}/activate`), { method: 'POST' }),
  deactivateRoute: (id) => requestJson(buildUrl(`/api/routes/${id}/deactivate`), { method: 'POST' }),

  getRules: (routeId) => requestJson(buildUrl('/api/rules', routeId ? { routeId } : undefined)),
  createRule: (route) => requestJson(buildUrl('/api/rules'), { method: 'POST', body: JSON.stringify(route) }),
  updateRule: (id, route) => requestJson(buildUrl(`/api/rules/${id}`), { method: 'PUT', body: JSON.stringify(route) }),
  deleteRule: (id) => requestJson(buildUrl(`/api/rules/${id}`), { method: 'DELETE' }),
  resetRuleTokens: (id) => requestJson(buildUrl(`/api/rules/${id}/reset-tokens`), { method: 'PUT' }),
  resetRuleRequests: (id) => requestJson(buildUrl(`/api/rules/${id}/reset-requests`), { method: 'PUT' }),
  clearRuleBlacklist: (id) => requestJson(buildUrl(`/api/rules/${id}/clear-blacklist`), { method: 'PUT' }),
  toggleRuleDisable: (id) => requestJson(buildUrl(`/api/rules/${id}/toggle-disable`), { method: 'PUT' }),
  getRulesBlacklistStatus: (routeId) => requestJson(buildUrl(`/api/rules/${routeId}/blacklist-status`)),

  getLogs: (limit, offset) => requestJson(buildUrl('/api/logs', { limit, offset })),
  clearLogs: () => requestJson(buildUrl('/api/logs'), { method: 'DELETE' }),

  getErrorLogs: (limit, offset) => requestJson(buildUrl('/api/error-logs', { limit, offset })),
  clearErrorLogs: () => requestJson(buildUrl('/api/error-logs'), { method: 'DELETE' }),

  getLogsCount: () => requestJson<{ count: number }>(buildUrl('/api/logs/count')),
  getErrorLogsCount: () => requestJson<{ count: number }>(buildUrl('/api/error-logs/count')),

  getStatistics: (days = 30) => requestJson(buildUrl('/api/statistics', { days })),
  resetStatistics: () => requestJson(buildUrl('/api/statistics'), { method: 'DELETE' }),

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

  writeClaudeConfig: () => requestJson(buildUrl('/api/write-config/claude'), { method: 'POST' }),
  writeCodexConfig: () => requestJson(buildUrl('/api/write-config/codex'), { method: 'POST' }),
  restoreClaudeConfig: () => requestJson(buildUrl('/api/restore-config/claude'), { method: 'POST' }),
  restoreCodexConfig: () => requestJson(buildUrl('/api/restore-config/codex'), { method: 'POST' }),
  checkClaudeBackup: () => requestJson(buildUrl('/api/check-backup/claude')),
  checkCodexBackup: () => requestJson(buildUrl('/api/check-backup/codex')),
  // 新的详细配置状态 API
  getClaudeConfigStatus: () => requestJson(buildUrl('/api/config-status/claude')),
  getCodexConfigStatus: () => requestJson(buildUrl('/api/config-status/codex')),

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

  // 工具安装相关
  getToolsStatus: () => requestJson<ToolInstallationStatus>(buildUrl('/api/tools/status')),

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
  installTool: (tool, callbacks) => {
    console.log('[API Client] 开始安装工具:', tool);

    // 构建 WebSocket URL
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/api/tools/install`;

    console.log('[API Client] 连接 WebSocket:', wsUrl);

    let ws: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;

    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      console.error('[API Client] 创建 WebSocket 失败:', error);
      callbacks.onError?.('创建 WebSocket 连接失败');
      return () => {};
    }

    // 连接打开时发送安装请求
    ws.onopen = () => {
      console.log('[API Client] WebSocket 连接已建立');
      // 发送安装请求
      ws?.send(JSON.stringify({ type: 'install', tool }));
    };

    // 接收消息
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log('[API Client] 收到消息:', message.type);

        switch (message.type) {
          case 'start':
            console.log('[API Client] 安装开始:', message.data);
            callbacks.onStdout?.(`\n========== 开始安装 ${message.data.tool} ==========\n`);
            callbacks.onStdout?.(`操作系统: ${message.data.os}\n`);
            callbacks.onStdout?.(`执行命令: ${message.data.command}\n`);
            callbacks.onStdout?.(`子进程已创建 (PID: ${message.data.pid})\n`);
            callbacks.onStdout?.(`等待 npm 输出...\n\n`);
            break;
          case 'stdout':
            callbacks.onStdout?.(message.data);
            break;
          case 'stderr':
            callbacks.onStderr?.(message.data);
            break;
          case 'close':
            console.log('[API Client] 安装完成:', message.data);
            callbacks.onClose?.(message.data.code, message.data.success);
            // 延迟关闭 WebSocket，确保收到所有消息
            setTimeout(() => {
              ws?.close();
            }, 1000);
            break;
          case 'error':
            console.error('[API Client] 安装错误:', message.data);
            callbacks.onError?.(message.data);
            break;
        }
      } catch (error) {
        console.error('[API Client] 解析消息失败:', error, event.data);
      }
    };

    // 连接关闭
    ws.onclose = (event) => {
      console.log('[API Client] WebSocket 连接关闭:', event.code, event.reason);
      if (!event.wasClean) {
        callbacks.onError?.('连接意外关闭');
      }
    };

    // 连接错误
    ws.onerror = (error) => {
      console.error('[API Client] WebSocket 错误:', error);
      callbacks.onError?.('WebSocket 连接错误');
    };

    // 返回取消函数和发送输入函数
    const cleanup = () => {
      console.log('[API Client] 清理 WebSocket 连接');
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (ws) {
        ws.close();
        ws = null;
      }
    };

    const sendInput = (input: string) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: input }));
        console.log('[API Client] 发送输入:', input.slice(0, 10));
      } else {
        console.warn('[API Client] WebSocket 未连接，无法发送输入');
      }
    };

    // 返回取消函数，同时提供 sendInput 方法
    const cancelFn = cleanup as (() => void) & { sendInput?: (input: string) => void };
    cancelFn.sendInput = sendInput;

    return cancelFn;
  },
};
