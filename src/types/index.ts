/** 供应商信息 */
export interface Vendor {
  id: string;
  name: string;
  description?: string;
  sortOrder?: number;
  createdAt: number;
  updatedAt: number;
}

/** 供应商API接口的数据结构标准类型 */
export type SourceType = 'openai-chat' | 'openai-responses' | 'claude-chat' | 'claude-code' | 'deepseek-reasoning-chat';
/** 路由的目标对象类型，目前，仅支持claude-code和codex */
export type TargetType = 'claude-code' | 'codex';

/** Skills 管理相关类型 */
export interface InstalledSkill {
  id: string;
  name: string;
  description?: string;
  targets: TargetType[];
}

export interface SkillCatalogItem {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  url?: string;
}

export interface SkillInstallRequest {
  skillId: string;
  targetType: TargetType;
  name?: string;
  description?: string;
  tags?: string[];
}

export interface SkillInstallResponse {
  success: boolean;
  message?: string;
  installedSkill?: InstalledSkill;
}

/** 认证方式类型 */
export type AuthType = 'authorization' | 'x-api-key' | 'auto';

/** 供应商API服务 */
export interface APIService {
  id: string;
  vendorId: string;
  name: string;
  apiUrl: string;
  apiKey: string;
  sourceType?: SourceType;
  authType?: AuthType; // 认证方式，默认为 'auto'（根据 sourceType 自动判断）
  supportedModels?: string[];
  modelLimits?: Record<string, number>; // 模型名 -> 最大输出tokens映射
  enableProxy?: boolean; // 是否启用代理

  // 新增：Token超量配置
  enableTokenLimit?: boolean;          // 是否启用Token超量限制
  tokenLimit?: number;                 // Token超量值（单位：k）
  tokenResetInterval?: number;         // Token自动重置间隔（小时）
  tokenResetBaseTime?: number;         // Token下一次重置时间基点

  // 新增：请求次数超量配置
  enableRequestLimit?: boolean;        // 是否启用请求次数超量限制
  requestCountLimit?: number;          // 请求次数超量值
  requestResetInterval?: number;       // 请求次数自动重置间隔（小时）
  requestResetBaseTime?: number;       // 请求次数下一次重置时间基点

  createdAt: number;
  updatedAt: number;
}

/** 路由信息 */
export interface Route {
  id: string;
  name: string;
  description?: string;
  targetType: TargetType;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 路由规则 */
export interface Rule {
  id: string;
  routeId: string;
  contentType: ContentType;
  targetServiceId: string;
  targetModel?: string;
  replacedModel?: string;
  sortOrder?: number;
  timeout?: number;              // 超时时间（毫秒）
  tokenLimit?: number;           // token使用量上限
  totalTokensUsed?: number;      // 当前累计token使用量
  resetInterval?: number;        // 自动重置间隔（小时）
  lastResetAt?: number;          // 上次重置时间戳
  tokenResetBaseTime?: number;   // Token下一次重置的时间基点（Unix时间戳）
  requestCountLimit?: number;    // 请求次数上限
  totalRequestsUsed?: number;    // 当前累计请求次数
  requestResetInterval?: number; // 次数重置间隔（小时）
  requestLastResetAt?: number;   // 上次次数重置时间戳
  requestResetBaseTime?: number; // 下一次重置的时间基点（Unix时间戳）
  createdAt: number;
  updatedAt: number;
}

export type ContentType = 'default' | 'background' | 'thinking' | 'long-context' | 'image-understanding' | 'model-mapping';

export interface RequestLog {
  id: string;
  timestamp: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  statusCode?: number;
  responseTime?: number;
  targetProvider?: string;
  usage?: TokenUsage;
  error?: string;

  // 新增字段 - 用于日志筛选和详情展示
  ruleId?: string;                                 // 使用的规则ID
  targetType?: TargetType;                         // 客户端类型
  targetServiceId?: string;                        // API服务ID
  targetServiceName?: string;                      // API服务名
  targetModel?: string;                            // 模型名
  vendorId?: string;                               // 供应商ID
  vendorName?: string;                             // 供应商名称
  requestModel?: string;                           // 请求模型名（从请求体中读取）

  responseHeaders?: Record<string, string>;        // 响应头
  responseBody?: string;                           // 响应体(非stream)
  streamChunks?: string[];                         // stream chunks数组
  upstreamRequest?: {                              // 实际发送给后端的请求信息
    url: string;                                   // 实际请求的URL路径
    // model: string;                                 // 实际请求的模型名
    // max_tokens?: number;                           // 实际的 max_tokens 值
    // max_completion_tokens?: number;                // 实际的 max_completion_tokens 值
    useProxy?: boolean;                            // 是否使用了代理
    headers?: Record<string, string>;              // 实际发送的请求头
    body?: string;                                 // 实际发送的请求体
  };
}

export interface ErrorLog {
  id: string;
  timestamp: number;
  method: string;
  path: string;
  statusCode?: number;
  errorMessage: string;
  errorStack?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  responseTime?: number;
}

export interface AppConfig {
  enableLogging?: boolean;
  logRetentionDays?: number;
  maxLogSize?: number;
  apiKey?: string;
  enableFailover?: boolean;  // 是否启用智能故障切换,默认 true
  // 代理配置
  proxyEnabled?: boolean;  // 是否启用代理
  proxyUrl?: string;  // 代理地址，例如: proxy.example.com:8080
  proxyUsername?: string;  // 代理认证用户名
  proxyPassword?: string;  // 代理认证密码
}

export interface ExportData {
  version: string;
  exportDate: number;
  vendors: Vendor[];
  apiServices: APIService[];
  routes: Route[];
  rules: Rule[];
  config: AppConfig;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  // 兼容OpenAI格式
  promptTokens?: number;
  completionTokens?: number;
}

/** 服务黑名单记录 */
export interface ServiceBlacklistEntry {
  serviceId: string;
  routeId: string;
  contentType: ContentType;
  blacklistedAt: number;      // 标记时间戳
  expiresAt: number;          // 过期时间 = blacklistedAt + 10分钟
  errorCount: number;         // 错误计数
  lastError?: string;         // 最后一次错误信息
  lastStatusCode?: number;    // 最后一次错误的状态码
  errorType?: 'http' | 'timeout' | 'unknown'; // 错误类型
}

/** 鉴权状态响应 */
export interface AuthStatus {
  enabled: boolean;
}

/** 登录请求 */
export interface LoginRequest {
  authCode: string;
}

/** 登录响应 */
export interface LoginResponse {
  token: string;
}

/** Session 会话信息 */
export interface Session {
  id: string;              // session ID (对于Claude Code是metadata.user_id，对于Codex是headers.session_id)
  targetType: TargetType;  // 客户端类型 (claude-code 或 codex)
  title?: string;          // 会话标题（从第一条消息内容提取）
  firstRequestAt: number;  // 第一次请求时间
  lastRequestAt: number;   // 最后一次请求时间
  requestCount: number;    // 请求总数
  totalTokens: number;     // 总token使用量
  vendorId?: string;       // 最后使用的供应商ID
  vendorName?: string;     // 最后使用的供应商名称
  serviceId?: string;      // 最后使用的服务ID
  serviceName?: string;    // 最后使用的服务名称
  model?: string;          // 最后使用的模型
}

/** 统计数据 */
export interface Statistics {
  overview: {
    totalRequests: number;
    totalTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalVendors: number;
    totalServices: number;
    totalRoutes: number;
    totalRules: number;
    avgResponseTime: number;
    successRate: number;
    totalCodingTime: number; // 编程时长(分钟)
  };
  byTargetType: {
    targetType: TargetType;
    totalRequests: number;
    totalTokens: number;
    avgResponseTime: number;
  }[];
  byVendor: {
    vendorId: string;
    vendorName: string;
    totalRequests: number;
    totalTokens: number;
    avgResponseTime: number;
  }[];
  byService: {
    serviceId: string;
    serviceName: string;
    vendorName: string;
    totalRequests: number;
    totalTokens: number;
    avgResponseTime: number;
  }[];
  byModel: {
    modelName: string;
    totalRequests: number;
    totalTokens: number;
    avgResponseTime: number;
  }[];
  timeline: {
    date: string; // YYYY-MM-DD
    totalRequests: number;
    totalTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  }[];
  contentTypeDistribution: {
    contentType: string;
    count: number;
    percentage: number;
  }[];
  errors: {
    totalErrors: number;
    recentErrors: number; // 最近24小时
  };
}
