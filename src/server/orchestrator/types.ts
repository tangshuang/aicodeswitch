/**
 * ATO (Agent Team Orchestrator) 核心类型定义
 *
 * 设计依据：docs/PRD/supervisor-agent/supervisor-agent-v4.md
 * - Ralph Loop 调度（选任务 → spawn 全新子 Agent → 验证 → 下一轮）
 * - 验证即出口（外部脚本裁定，而非 Agent 自我报告）
 * - stdout 协议问答（«ATO_QUESTION» 标记，跨工具统一）
 * - 无状态运行 + 持久化环境（每次全新进程，状态写磁盘）
 */

/** CLI Agent 工具名 */
export type AgentToolName = string;

/** 适配器能力声明 */
export interface AgentAdapterFeatures {
  /** 是否支持 stream-json 输出（claude-code） */
  streamJson: boolean;
  /** 是否支持通过文件/stdin 传入上下文 */
  contextFile: boolean;
  /** 是否支持独立工作空间 */
  workspaceIsolation: boolean;
  /** 是否支持 stdout 协议问答（统一为 true） */
  stdoutProtocol: boolean;
}

/** spawn 子 Agent 的参数 */
export interface SpawnOptions {
  taskId: string;
  teamId: string;
  contextFilePath: string;
  workspacePath: string;
  /** 额外环境变量（如团队 AccessKey） */
  env?: Record<string, string>;
  /** 超时（毫秒） */
  timeoutMs?: number;
}

/** 子 Agent 运行结果 */
export interface AgentRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 粗略 token 估算（基于输出字符数） */
  estimatedTokens: number;
}

/** 解析出的问题（stdout 协议） */
export interface ParsedQuestion {
  id: string;
  level: QuestionLevel;
  text: string;
  options: string[];
}

export type QuestionLevel = 'L0' | 'L1' | 'L2';

/** Agent 适配器接口（IAgentAdapter） */
export interface AgentAdapter {
  readonly name: AgentToolName;
  readonly features: AgentAdapterFeatures;
  /** 启动子 Agent 进程并等待退出，返回完整输出 */
  spawn(opts: SpawnOptions): Promise<AgentRunResult>;
  /** 生成上下文内容（注入依赖产出 + 历史决策） */
  generateContext(task: Task, deps: TaskResult[], decisions: Decision[]): string;
  /** 从子 Agent stdout 中解析 «ATO_QUESTION» 问题 */
  parseQuestions(stdout: string): ParsedQuestion[];
  /** 健康检查（CLI 是否可用） */
  checkHealth(): Promise<boolean>;
}

/** 历史问答决策（注入下一轮 context） */
export interface Decision {
  questionId: string;
  taskId: string;
  level: QuestionLevel;
  text: string;
  choice: string;
  decidedBy: 'leader' | 'user';
  decidedAt: number;
}

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'awaiting-question'
  | 'completed'
  | 'failed'
  | 'skipped';

/** 子任务定义 */
export interface Task {
  id: string;
  description: string;
  dependencies: string[];
  expectedOutput?: string;
  /** 验证脚本（exit 0 = 通过） */
  verificationScript?: string;
  /** 指定使用的 Agent 工具（覆盖团队默认） */
  agentTool?: AgentToolName;
  /** 绑定的 AICodeSwitch Route（Layer 1 task 级路由） */
  routeId?: string;
}

/** 子任务运行状态 */
export interface TaskResult {
  taskId: string;
  status: TaskStatus;
  summary?: string;
  artifacts?: string[];
  retryCount: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  /** 估算 token 消耗 */
  tokensEstimate?: number;
  /** 最近一次 spawn 的 stdout 摘要（调试用） */
  lastStdoutTail?: string;
}

export type TeamStatus =
  | 'queued'
  | 'running'
  | 'awaiting-question'
  | 'completed'
  | 'failed'
  | 'stopped';

/** 待处理问题（已上抛，等待 L0 自动 / L1 倒计时 / L2 人工） */
export interface PendingQuestion {
  id: string;
  taskId: string;
  level: QuestionLevel;
  text: string;
  options: string[];
  suggestion?: string;
  createdAt: number;
  /** L1 自动采纳的截止时间 */
  autoAdoptAt?: number;
}

/** 团队运行配置 */
export interface TeamConfig {
  maxConcurrency: number;
  taskTimeoutMs: number;
  retryCount: number;
  verificationTimeoutMs: number;
  failureStrategy: 'abort' | 'skip' | 'replan';
  atomicCommits: boolean;
  autoL0: boolean;
  autoL1TimeoutSeconds: number;
  forceL2Keywords: string[];
}

/** Token 预算（团队级） */
export interface TokenBudget {
  total?: number;
  spent: number;
}

/** 日志条目（NDJSON，群聊风格） */
export interface LogEntry {
  ts: number;
  agentId: string;
  agentTool?: string;
  taskId?: string;
  type:
    | 'status'
    | 'decision'
    | 'question'
    | 'answer'
    | 'result'
    | 'error'
    | 'verification'
    | 'log';
  content: unknown;
}

/** 一次团队任务运行 */
export interface TeamRun {
  id: string;
  prompt: string;
  createdAt: number;
  updatedAt: number;
  status: TeamStatus;
  workspacePath: string;
  defaultAgent: AgentToolName;
  /** 团队预算 AccessKey（可选，用于复用配额/统计） */
  teamAccessKey?: string;
  config: TeamConfig;
  tasks: Record<string, Task>;
  results: Record<string, TaskResult>;
  logs: LogEntry[];
  pendingQuestions: PendingQuestion[];
  decisions: Decision[];
  tokenBudget: TokenBudget;
  error?: string;
  /** 运行时句柄（不持久化） */
  _scheduler?: unknown;
}

/** 创建团队的请求 */
export interface CreateTeamRequest {
  prompt: string;
  workspacePath?: string;
  defaultAgent?: AgentToolName;
  routeId?: string;
  teamAccessKey?: string;
  verificationScript?: string;
  /** 显式子任务（不传则用 prompt 生成单个任务） */
  tasks?: Array<Partial<Task> & { description: string }>;
  config?: Partial<TeamConfig>;
}
