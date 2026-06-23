/** 供应商信息 */
export interface Vendor {
  id: string;
  name: string;
  description?: string;
  apiKey?: string;
  apiBaseUrl?: string;  // 供应商默认 API Base URL
  authType?: AuthType;  // 供应商默认 API 认证方式
  sortOrder?: number;
  services: APIService[];  // 供应商的 API 服务列表
  createdAt: number;
  updatedAt: number;
}

/** 供应商API接口的数据结构标准类型 */
export type SourceType = 'openai-chat' | 'openai' | 'claude-chat' | 'claude' | 'gemini' | 'gemini-chat';
/** 工具名称（用于工具绑定，独立于路由） */
export type ToolName = 'claude-code' | 'codex';
/** 路由的目标对象类型，保留用于日志、统计等向后兼容场景 */
export type ToolType = 'claude-code' | 'codex';
/** TargetType 是 ToolType 的别名，用于向后兼容 */
export type TargetType = ToolType;

/** 单个工具的路由激活配置 */
export interface ToolBinding {
  tool: ToolName;
  routeId: string | null;
}

/** 所有工具的路由激活配置集合 */
export type ToolBindings = Record<ToolName, ToolBinding>;
/** Codex 推理强度配置 */
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

/** Claude Code effort level 配置 */
export type ClaudeEffortLevel = 'low' | 'medium' | 'high' | 'max';

/** Claude Code permissions.defaultMode 配置 */
export type ClaudePermissionDefaultMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions';

/** Skills 管理相关类型 */
export interface InstalledSkill {
  id: string;
  name: string;
  description?: string;
  targets: ToolType[];
  enabledTargets: ToolType[];
  githubUrl?: string;
  skillPath?: string;
  installedAt: number;
}

export interface SkillCatalogItem {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  url?: string;
  stars?: number;  // 评分数
}

export interface SkillInstallRequest {
  skillId: string;
  targetType: ToolType;
  name?: string;
  description?: string;
  tags?: string[];
  githubUrl?: string;
  skillPath?: string;
}

export interface SkillDetail {
  id: string;
  name: string;
  description?: string;
  author?: string;
  stars?: number;
  githubUrl?: string;
  skillPath?: string;
  readme?: string;
  tags?: string[];
}

export interface SkillInstallResponse {
  success: boolean;
  message?: string;
  installedSkill?: InstalledSkill;
}

/** 认证方式类型 */
export enum AuthType {
  AUTH_TOKEN = 'authorization',
  API_KEY = 'x-api-key',
  G_API_KEY = 'x-goog-api-key',  // Google Gemini API 认证方式
  // 注意: 'auto' 值已从前端移除，但后端仍保留兼容性处理
  // AUTO = 'auto',  // 已废弃
};

/** 供应商API服务 */
export interface APIService {
  id: string;
  vendorId?: string;  // 仅在 API 请求时使用，数据存储时不保存此字段
  name: string;
  apiUrl: string;
  apiKey: string;
  inheritVendorApiKey?: boolean;
  inheritVendorApiBaseUrl?: boolean;  // 是否继承供应商的 API Base URL
  inheritVendorAuthType?: boolean;    // 是否继承供应商的 API 认证方式
  sourceType?: SourceType;
  authType?: AuthType; // 认证方式（ AUTH_TOKEN/API_KEY/G_API_KEY），默认为 AUTH_TOKEN
  supportedModels?: string[];
  modelLimits?: Record<string, number>; // 模型名 -> 最大输出tokens映射
  enableProxy?: boolean; // 是否启用代理
  enableCodingPlan?: boolean; // 是否启用编程套餐限制。启用后仅允许编程工具（Claude Code / Codex / Cursor 等）发起的请求通过。
  isDowngradeCompatibility?: boolean; // 是否开启降级兼容。开启后同格式 passthrough 会清理私有扩展字段/工具类型，
                                       // 确保与非原始提供商（如火山方舟/豆包）的兼容性。默认 false（不清理）。

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
  frequencyLimit?: number;       // 频率限制次数（如每分钟最多N个请求）
  frequencyWindow?: number;      // 频率限制时间窗口（秒）
  isDisabled?: boolean;          // 是否临时屏蔽该规则
  useMCP?: boolean;              // 是否使用MCP（仅适用于图像理解）
  mcpId?: string;                // MCP工具ID（仅当useMCP为true时）
  sessionTokenThreshold?: number;// 长上下文规则的session累积tokens阈值（单位：k，默认1000k=1M）
  createdAt: number;
  updatedAt: number;
}

export type ContentType = 'default' | 'background' | 'thinking' | 'long-context' | 'image-understanding' | 'model-mapping' | 'high-iq' | 'compact';

export interface RequestLog {
  id: string;
  timestamp: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: any;                                      // 改为对象类型
  statusCode?: number;
  responseTime?: number;
  targetProvider?: string;
  usage?: TokenUsage;
  error?: string;

  // 新增字段 - 用于日志筛选和详情展示
  contentType?: ContentType;                       // 请求类型（规则内容类型）
  ruleId?: string;                                 // 使用的规则ID
  routeId?: string;                                // 使用的路由ID
  targetType?: ToolType;                         // 客户端类型
  targetServiceId?: string;                        // API服务ID
  targetServiceName?: string;                      // API服务名
  targetModel?: string;                            // 模型名
  vendorId?: string;                               // 供应商ID
  vendorName?: string;                             // 供应商名称
  requestModel?: string;                           // 请求模型名（从请求体中读取）
  tags?: string[];                                 // 标签（如"使用原始配置"）

  responseHeaders?: Record<string, string>;        // 响应头
  responseBody?: any;                              // 响应体(非stream)，改为对象类型
  streamChunks?: string[];                         // stream chunks数组
  upstreamRequest?: {                              // 实际发送给后端的请求信息
    url: string;                                   // 实际请求的URL路径
    useProxy?: boolean;                            // 是否使用了代理
    headers?: Record<string, string>;              // 实际发送的请求头
    body?: any;                                    // 实际发送的请求体，改为对象类型
  };
  downstreamResponseBody?: any;                      // 实际转发的响应体（经过转换后发送给客户端的响应体）

  // —— 服务性能数据点（全局统计，与 AUTH 无关） ——
  ttftMs?: number;                                   // 首 Token 返回时间（firstTokenAt − requestStartAt）
  generationMs?: number;                             // 纯生成阶段时长（lastTokenAt − firstTokenAt）
  tokensPerSecond?: number;                          // 等效 tokens/s（TPM/60）
  timingAccuracy?: 'precise' | 'estimated';          // 流式精确 / 非流式端到端估算
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

  // 请求日志中的详细信息字段
  ruleId?: string;                                 // 使用的规则ID
  routeId?: string;                                // 使用的路由ID
  targetType?: ToolType;                         // 客户端类型
  targetServiceId?: string;                        // API服务ID
  targetServiceName?: string;                      // API服务名
  targetModel?: string;                            // 模型名
  vendorId?: string;                               // 供应商ID
  vendorName?: string;                             // 供应商名称
  requestModel?: string;                           // 请求模型名（从请求体中读取）
  tags?: string[];                                 // 标签（如"使用原始配置"）

  upstreamRequest?: {                              // 实际发送给后端的请求信息
    url: string;                                   // 实际请求的URL路径
    useProxy?: boolean;                            // 是否使用了代理
    headers?: Record<string, string>;              // 实际发送的请求头
    body?: string;                                 // 实际发送的请求体
  };
}

export interface AppConfig {
  enableLogging?: boolean;
  logRetentionDays?: number;
  maxLogSize?: number;
  enableFailover?: boolean;  // 是否启用智能故障切换,默认 true
  failoverRecoverySeconds?: number;  // 故障自动恢复时间（秒）,默认 10
  ruleGlobalTimeout?: number;  // 规则全局超时时间（秒），覆盖未设置超时的规则，默认 300
  // 工具全局配置
  enableAgentTeams?: boolean;  // Claude Code Agent Teams（全局）
  enableBypassPermissionsSupport?: boolean;  // Claude Code bypassPermissions 门控（全局）：决定 bypassPermissions 模式是否可见/可选
  claudePermissionsDefaultMode?: ClaudePermissionDefaultMode;  // Claude Code permissions.defaultMode（全局）
  claudeEffortLevel?: ClaudeEffortLevel;  // Claude Code effort level（全局）
  autocompactPctOverride?: number;  // Claude Code 自动压缩百分比阈值（1-100，全局）
  claudeDefaultModel?: string;  // Claude Code 默认模型（全局）
  codexModelReasoningEffort?: CodexReasoningEffort;  // Codex reasoning effort（全局）
  codexEnableMemories?: boolean;  // Codex 记忆功能（全局）
  codexDefaultModel?: string;  // Codex 默认模型（全局）
  // 代理配置
  proxyEnabled?: boolean;  // 是否启用代理
  proxyUrl?: string;  // 代理地址，例如: proxy.example.com:8080
  proxyUsername?: string;  // 代理认证用户名
  proxyPassword?: string;  // 代理认证密码
  // 局域网同步
  enableLanDiscovery?: boolean;  // 是否允许局域网发现并拉取配置，默认 false
  // Agent Map「一轮结束」OS 通知开关（持久化；Node 端据此决定是否弹，重启不丢）
  agentMapNotifyEnabled?: boolean;
  // API 路径路由映射
}

/** 局域网发现响应 */
export interface LanDiscoverResponse {
  node: {
    name: string;
    version: string;
    port: number;
  };
  skills: LanSkillItem[];
  mcps: LanMcpItem[];
}

/** 局域网同步的 Skill 条目 */
export interface LanSkillItem {
  name: string;
  description?: string;
  targets?: ToolType[];
  githubUrl?: string;
  skillPath?: string;
  instruction?: string;
}

/** 局域网同步的 MCP 条目 */
export interface LanMcpItem {
  name: string;
  description?: string;
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  targets?: ToolType[];
}

/** 局域网同步请求 */
export interface LanSyncRequest {
  remoteNode: {
    ip: string;
    port: number;
    name: string;
  };
  skills: LanSkillItem[];
  mcps: LanMcpItem[];
  vendor: {
    enabled: boolean;
    apiKey?: string;
  };
}

/** 局域网同步结果 */
export interface LanSyncResult {
  success: boolean;
  result?: {
    skillsImported: number;
    mcpsImported: number;
    vendorCreated: boolean;
    vendorName?: string;
    servicesCreated?: number;
  };
  error?: string;
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

/** 导入结果 */
export interface ImportResult {
  success: boolean;
  message: string;
  details?: string;
}

/** 导入预览数据 */
export interface ImportPreview {
  success: boolean;
  message?: string;
  data?: {
    vendors: number;
    services: number;
    routes: number;
    rules: number;
    exportDate: number;
    version: string;
  };
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
  expiresAt: number;          // 过期时间 = blacklistedAt + 默认30秒（可通过failoverRecoverySeconds配置）
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
  id: string;              // session ID (对于Claude Code是metadata.user_id，对于Codex是headers.session-id或headers.session_id)
  targetType: ToolType;  // 客户端类型 (claude-code 或 codex)
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
  highIqMode?: boolean;    // 是否启用高智商模式
  highIqRuleId?: string;   // 使用的高智商规则ID
  highIqEnabledAt?: number;// 启用高智商模式的时间戳
  routeId?: string;        // 绑定的路由ID（可选，未绑定为 undefined）
  routeName?: string;      // 绑定的路由名称（冗余字段，用于 UI 快速显示）

  // —— Agent Map 任务可视化（活跃度自动推断，可选字段，兼容旧数据） ——
  status?: SessionStatus;            // 任务状态（active/idle/completed/error），由活跃度自动推断
  statusReason?: string;             // 状态推断依据（调试 / UI tooltip）
  lastActivitySummary?: string;      // 最近一次工具 / 响应摘要，用于地图节点副标
  lastToolName?: string;             // 最近一次工具调用名（Read/Edit/Bash...）
  lastStatusCode?: number;           // 最近一次请求的 HTTP 状态码
}

// ==================== Agent Map（任务可视化节点地图） ====================

/**
 * Session 任务状态（基于活跃度自动推断，无需用户手动标记）
 * - active：最近 N 秒内有请求 或 当前有在途请求
 * - idle：超过 N 秒无新请求，但近 M 分钟内有过活动
 * - completed：超过 M 分钟无活动 且 末轮正常结束
 * - error：末次请求失败（5xx / 流式中断）
 */
export type SessionStatus = 'active' | 'idle' | 'completed' | 'error';

/**
 * 活动事件：从代理日志中抽取的细粒度节点，用于地图副标、活动路径子图、全局活动流
 */
export interface ActivityEvent {
  id: string;
  ts: number;
  sessionId: string;
  agent: ToolType;                                   // claude-code / codex
  source?: 'global' | 'access-key';                  // 会话来源
  keyId?: string;                                    // source=access-key 时的密钥 ID
  keyName?: string;
  kind: 'prompt' | 'thinking' | 'tool_use' | 'tool_result' | 'response' | 'error' | 'cancelled';
  toolName?: string;                                 // Read/Edit/Bash/Grep/WebFetch...
  summary: string;                                   // 一行摘要
  tokensDelta?: number;                              // 本轮 token 增量
  statusCode?: number;
}

/**
 * Agent Map 画布上的一个 Session 节点（运行时聚合态，不持久化）
 */
export interface SessionMapItem {
  sessionId: string;
  agent: ToolType;
  source: 'global' | 'access-key';
  keyId?: string;
  keyName?: string;
  title?: string;
  status: SessionStatus;
  statusReason?: string;
  firstRequestAt: number;
  lastRequestAt: number;
  requestCount: number;
  totalTokens: number;
  inputTokens: number;                              // 累计输入 token（运行时累加，重启归零）
  outputTokens: number;                             // 累计输出 token（运行时累加，重启归零）
  lastToolName?: string;
  lastActivitySummary?: string;
  lastStatusCode?: number;
  lastModel?: string;
  inFlight: number;                                  // 当前在途请求数
  projectPath?: string;                              // 项目路径（仅 global 来源可解析；access-key 无）
}

/** SSE 推送的 init 快照 */
export interface AgentMapInitPayload {
  type: 'init';
  sessions: SessionMapItem[];
  events: ActivityEvent[];                           // 全局最近活动（倒序）
  stats: AgentMapStats;
  serverTime: number;
}

export interface AgentMapStats {
  totalSessions: number;
  activeSessions: number;
  idleSessions: number;
  completedSessions: number;
  errorSessions: number;
  inFlightRequests: number;
  recentToolCalls: number;                           // 近 1 分钟工具调用数
  recentTokens: number;                              // 近 1 分钟 token 吞吐
}

/** SSE 增量事件 */
export type AgentMapStreamEvent =
  | { type: 'session-update'; session: SessionMapItem }
  | { type: 'activity'; event: ActivityEvent }
  | { type: 'stats'; stats: AgentMapStats }
  | { type: 'heartbeat'; timestamp: number };

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
    targetType: ToolType;
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

/** 工具安装状态 */
export interface ToolInstallationStatus {
  claudeCode: {
    installed: boolean;
    version?: string;
    installCommand?: string;
  };
  codex: {
    installed: boolean;
    version?: string;
    installCommand?: string;
  };
}

/** 安装请求 */
export interface InstallToolRequest {
  tool: 'claude-code' | 'codex';
}

/** 安装响应 */
export interface InstallToolResponse {
  success: boolean;
  message?: string;
}

/** MCP 工具类型 */
export interface MCPServer {
  id: string;
  name: string;
  description?: string;
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  targets?: ToolType[];
  createdAt: number;
  updatedAt: number;
}

/** MCP 工具安装请求 */
export interface MCPInstallRequest {
  name: string;
  description?: string;
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  targets?: ToolType[];
}

/** MCP 工具启用/禁用请求 */
export interface MCPEnableRequest {
  mcpId: string;
  target: ToolType;
  enabled: boolean;
}

// ============================================================================
// 配置合并相关类型
// ============================================================================

/** 字段路径表示（用于定义管理字段） */
export type FieldPath = (string | number)[];

/** 管理字段路径定义 */
export interface ManagedFieldPath {
  path: FieldPath;
  isSection?: boolean;  // 是否是整个对象/section
  optional?: boolean;   // 字段是否可选
}

/** 增强的配置文件状态 */
export interface ConfigFileState {
  filePath: string;
  exists: boolean;
  backupExists: boolean;
  currentHash?: string;
  backupHash?: string;
  hasUnmanagedChanges?: boolean;
  managedFieldsChanged?: boolean;
}

/** 会话迁移相关类型 */

export interface MigrationOptions {
  sourceSessionId: string;
  targetTool: ToolType;
  includeThinking?: boolean;
  includeToolCalls?: boolean;
  maxRounds?: number;
}

export interface MigrationRound {
  index: number;
  userMessage: string;
  assistantResponse: string;
  toolCallSummaries: string[];
  thinking?: string;
  timestamp: number;
}

export interface MigrationContent {
  sessionId: string;
  sessionTitle: string;
  sourceTool: ToolType;
  rounds: MigrationRound[];
  totalRounds: number;
  extractedRounds: number;
}

export interface MigrationPreview {
  content: MigrationContent;
  generatedPrompt: string;
  estimatedTokens: number;
  warnings: string[];
}

export interface MigrationResult {
  success: boolean;
  prompt: string;
  format: 'markdown';
  estimatedTokens: number;
  warnings: string[];
}

export interface LaunchResult {
  success: boolean;
  method: 'cli-launch' | 'fallback';
  pid?: number;
  command?: string;
  promptFilePath?: string;
  reason?: string;
  prompt?: string;
  estimatedTokens?: number;
  fallbackSuggestions?: string[];
}

/** 标准 API 路径枚举 */
export type ApiPath =
  | '/v1/messages'
  | '/v1/responses'
  | '/v1/chat/completions'
  | '/v1beta/models'
  | '/v1/models';

/** 路径与路由的绑定关系 */
export interface ApiPathBinding {
  apiPath: ApiPath;
  routeId: string | null;
}

// ============================================================================
// AccessKey 接入密钥共享相关类型
// ============================================================================

/** 接入密钥 */
export interface AccessKey {
  id: string;                     // 系统生成的唯一标识，如 "key_abc123"
  name: string;                   // 名称，如 "张三 - 前端组"
  remark?: string;                // 备注信息
  apiKey: string;                 // API Key（sk_ 前缀）
  apiKeyHash: string;             // API Key 的 SHA-256 前16字符哈希值（用于快速查找）
  policyId?: string;              // 绑定的策略 ID
  status: 'active' | 'disabled'; // 状态
  createdAt: number;              // 创建时间（Unix 时间戳）
  updatedAt: number;              // 更新时间
  lastActiveAt?: number;          // 最后活跃时间
}

/** 写入本地记录（持久化哪些 AccessKey 被写入了哪些工具的配置文件） */
export interface WriteLocalRecord {
  accessKeyId: string;
  targets: string[];      // 'claude-code' | 'codex'
  timestamp: number;
}

/** 策略 */
export interface Policy {
  id: string;                     // 系统生成的唯一标识
  name: string;                   // 策略名称
  description?: string;           // 策略描述

  // 路由绑定
  routeId?: string;               // 绑定的路由 ID

  // Token 配额（单位：千 Token）
  dailyTokenLimit?: number;       // 日 Token 限额（k）
  weeklyTokenLimit?: number;      // 周 Token 限额（k）
  monthlyTokenLimit?: number;     // 月 Token 限额（k）
  customTokenLimit?: number;      // 自定义周期 Token 限额（k）
  customTokenResetHours?: number; // 自定义周期小时数

  // 请求次数配额
  dailyRequestLimit?: number;     // 日请求限额
  weeklyRequestLimit?: number;    // 周请求限额
  monthlyRequestLimit?: number;   // 月请求限额
  customRequestLimit?: number;    // 自定义周期请求限额
  customRequestResetHours?: number; // 自定义周期小时数

  // 频率与并发
  rpmLimit?: number;              // 每分钟请求数上限
  concurrentLimit?: number;       // 最大并发数

  // 模型过滤
  allowedModels?: string[];       // 模型白名单
  blockedModels?: string[];       // 模型黑名单

  createdAt: number;
  updatedAt: number;
}

/** Key 级用量统计 */
export interface KeyUsage {
  keyId: string;

  // 累计用量（全生命周期）
  lifetime: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    totalRequests: number;
    errorCount: number;
  };

  // 周期性用量（按维度分别跟踪）
  periods: {
    daily: KeyUsagePeriod;
    weekly: KeyUsagePeriod;
    monthly: KeyUsagePeriod;
    custom?: KeyUsagePeriod & { resetHours: number };
  };

  // 历史趋势（按天汇总，保留 90 天）
  dailyHistory: KeyUsageDailyRecord[];
}

export interface KeyUsagePeriod {
  tokens: number;
  requests: number;
  periodStart: number;  // 当前周期的起始时间戳
}

export interface KeyUsageDailyRecord {
  date: string;         // "YYYY-MM-DD"
  tokens: number;
  requests: number;
  errors: number;
}

/** AccessKey 级会话信息（独立于全局 Session，按密钥隔离存储） */
export interface AccessKeySession {
  id: string;
  targetType: ToolType;
  title?: string;
  firstRequestAt: number;
  lastRequestAt: number;
  requestCount: number;
  totalTokens: number;
  vendorId?: string;
  vendorName?: string;
  serviceId?: string;
  serviceName?: string;
  model?: string;
}

/** AccessKey 请求的日志（复用 RequestLog 结构，额外附加 keyId/keyName） */
export interface AccessKeyRequestLog extends RequestLog {
  keyId: string;
  keyName: string;
}

/** 接入密钥创建响应 */
export interface AccessKeyCreateResponse {
  key: AccessKey;
  apiKey: string;  // 仅创建时返回完整的 apiKey
}

/** 配额告警 */
export interface QuotaAlert {
  keyId: string;
  keyName: string;
  dimension: string;
  usage: number;
  limit: number;
  percentage: number;
  level: 'warning' | 'critical' | 'exceeded';
}

// ===================== 服务性能统计（全局，与 AUTH 无关） =====================
// 数据点为每次请求的 TTFT（首 Token 返回时间）与 TPM（每分钟吐 token 数），
// 以「供应商 → 服务 → 模型」三级聚合，走势统一按小时桶。

/** 加权求和单元：avg 由 sum/count 派生，保证三级上卷数学自洽 */
export interface PerfBucket {
  count: number;            // 样本数
  sumTtftMs: number;        // Σ TTFT（毫秒）
  sumTps: number;           // Σ tokensPerSecond
  totalOutputTokens: number;
  sumInputTokens: number;   // Σ 输入 token（含非流式样本，不受计时精度门控）
  sumTotalTokens: number;   // Σ 总 token（input+output 或上游 totalTokens）
}

/** 单个聚合节点（模型级 / 服务级 / 供应商级通用） */
export interface PerfAggregate {
  precise: PerfBucket;      // 流式精确口径
  estimated: PerfBucket;    // 非流式端到端估算（TPM 用，TTFT 不计）
  errorCount: number;       // 失败请求数（计入样本但不参与吞吐均值）
  /** 模型级独有：极值（仅精确样本）；服务级/供应商级为子项 min/max 的聚合 */
  minTtftMs?: number;
  maxTtftMs?: number;
  minTps?: number;
  maxTps?: number;
  /** 小时走势桶，键 "YYYY-MM-DD HH" */
  hourly: Record<string, PerfBucket>;
}

/** 全局性能数据桶（独立存储于 service-performance.json） */
export interface ServicePerformanceFile {
  vendors: {
    [vendorId: string]: {
      vendorName?: string;
      vendorRollup: PerfAggregate;
      services: {
        [serviceId: string]: {
          serviceName?: string;
          serviceRollup: PerfAggregate;
          models: {
            [model: string]: PerfAggregate;
          };
          updatedAt: number;
        };
      };
    };
  };
}

/** API 返回的派生视图项（avg 由 sum/count 计算） */
export interface PerfDerived {
  count: number;
  avgTtftMs: number;
  avgTpm: number;
  minTtftMs?: number;
  maxTtftMs?: number;
  minTps?: number;
  maxTps?: number;
  errorCount: number;
  totalOutputTokens: number;
  totalInputTokens: number;   // Σ 输入 token（跨 precise+estimated）
  totalTokens: number;        // Σ 总 token（跨 precise+estimated）
  successRate: number;
}

/** 小时走势点（API 返回） */
export interface PerfTrendPoint {
  hour: string;            // "YYYY-MM-DD HH"
  count: number;
  avgTtftMs: number;
  avgTpm: number;
  inputTokens: number;     // 该小时输入 token（含非流式样本）
  outputTokens: number;    // 该小时输出 token
  totalTokens: number;     // 该小时总 token
}

/** API 响应类型（前端 / tracker 共享结构） */
export interface PerfVendorOverview {
  vendorId: string;
  vendorName?: string;
  derived: PerfDerived;
}
export interface PerfServiceOverview {
  serviceId: string;
  serviceName?: string;
  vendorId: string;
  vendorName?: string;
  derived: PerfDerived;
}
export interface PerfServiceSummary {
  serviceId: string;
  serviceName?: string;
  derived: PerfDerived;
}
export interface PerfVendorDetail {
  vendorName?: string;
  derived: PerfDerived;
  hourly: PerfTrendPoint[];
  services: PerfServiceSummary[];
}
export interface PerfModelSummary {
  model: string;
  derived: PerfDerived;
}
export interface PerfServiceDetail {
  vendorId?: string;
  vendorName?: string;
  serviceName?: string;
  derived: PerfDerived;
  hourly: PerfTrendPoint[];
  models: PerfModelSummary[];
}
export interface PerfModelDetail {
  derived: PerfDerived;
  hourly: PerfTrendPoint[];
}
