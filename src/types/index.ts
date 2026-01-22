/** 供应商信息 */
export interface Vendor {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

/** 供应商API接口的数据结构标准类型 */
export type SourceType = 'openai-chat' | 'openai-code' | 'openai-responses' | 'claude-chat' | 'claude-code' | 'deepseek-chat';
/** 路由的目标对象类型，目前，仅支持claude-code和codex */
export type TargetType = 'claude-code' | 'codex';

/** 供应商API服务 */
export interface APIService {
  id: string;
  vendorId: string;
  name: string;
  apiUrl: string;
  apiKey: string;
  timeout?: number;
  sourceType?: SourceType;
  supportedModels?: string[];
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
  targetType?: TargetType;                         // 来源对象类型
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
    model: string;                                 // 实际请求的模型名
  };
}

export interface AccessLog {
  id: string;
  timestamp: number;
  method: string;
  path: string;
  clientIp?: string;
  userAgent?: string;
  statusCode?: number;
  responseTime?: number;
  error?: string;
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
}

export interface AppConfig {
  enableLogging: boolean;
  logRetentionDays: number;
  maxLogSize: number;
  apiKey: string;
  enableFailover?: boolean;  // 是否启用智能故障切换,默认 true
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
