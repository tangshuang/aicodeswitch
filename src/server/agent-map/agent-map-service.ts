/**
 * Agent Map 服务（单例）
 *
 * 职责：
 * 1. 维护在途请求注册表（sessionId → 在途计数），用于 active 判定
 * 2. 维护每个 Session 的运行时聚合态（SessionMapItem）—— 状态由活跃度自动推断
 * 3. 维护活动事件环形缓冲（每 session + 全局）
 * 4. 通过 EventEmitter 向 SSE 路由广播 session-update / activity / stats
 * 5. 定时清扫：idle → completed 的状态迁移
 *
 * 数据来源：proxy-server 的 finalizeLog（含 AccessKey 与普通路由两条分支）。
 * 服务自身持有运行时态，不依赖 dbManager 做状态推断（兼容 global / access-key 两种会话存储）。
 * dbManager 仅用于 attach 时种子化已有全局 Session。
 */
import { EventEmitter } from 'events';
import type {
  ActivityEvent,
  AgentMapStats,
  AppConfig,
  RequestLog,
  SessionMapItem,
  SessionStatus,
  ToolType,
} from '../../types';
import { deriveLastActivity, extractActivityEvents, detectTurnEnd, type ExtractInput } from './activity-extractor';
import { resolveSessionMeta } from './session-meta';
import { notify } from '../notifier';

type DbManagerLike = {
  getSessions?: (opts?: any, limit?: number, offset?: number) => Promise<any[]>;
  getLogsBySessionId?: (sessionId: string, limit?: number, since?: number) => Promise<RequestLog[]>;
  // 批量回填多会话近期日志（跨会话合并分片读取），用于启动重建，避免重复解析同一分片
  getRecentLogsBySessions?: (
    sessionIds: string[],
    opts?: { since?: number; perSessionLimit?: number }
  ) => Promise<Map<string, RequestLog[]>>;
  // 配置读写（用于持久化通知开关 agentMapNotifyEnabled）
  getConfig?: () => AppConfig;
  updateConfig?: (config: AppConfig) => Promise<boolean>;
  // 绝对写入会话字段（用于回填历史输入/输出 token 拆分，不走累加语义）
  updateSession?: (sessionId: string, updates: Record<string, any>) => Promise<boolean>;
};

interface RuntimeState {
  sessionId: string;
  agent: ToolType;
  source: 'global' | 'access-key';
  keyId?: string;
  keyName?: string;
  title?: string;
  firstRequestAt: number;
  lastRequestAt: number;
  requestCount: number;
  totalTokens: number;
  inputTokens: number;       // 累计输入 token（持久化到 Session，重启由 seedFromDb 恢复；3D 连线输入段用）
  outputTokens: number;      // 累计输出 token（持久化到 Session，重启由 seedFromDb 恢复；3D 连线输出段用）
  // 在途流式请求的「实时累计」token（仅当前请求的 usage，请求结束清零）。
  // 展示值 = 已落盘累计 + 实时累计，使节点在流式过程中随 token 增长实时上移；finalize 时 onFinalized 把最终值并入累计并清零此处，避免双算。
  runningInputTokens: number;
  runningOutputTokens: number;
  lastToolName?: string;
  lastActivitySummary?: string;
  lastStatusCode?: number;
  lastModel?: string;
  status: SessionStatus;
  statusReason?: string;
  inFlight: number;
  projectPath?: string;
  metaResolved?: boolean; // 是否已尝试解析本地会话元信息（避免重复扫盘）
  tokenSplitBackfilled?: boolean; // 历史 token 输入/输出拆分是否已从日志回填（仅 legacy 会话需回填一次）
  lastTurnEnd?: boolean | null; // 末轮响应是否表示「一轮结束」（仅作展示参考，不再作为状态判定主信号）
  lastPromptSummary?: string; // 最近一次真正写入的 prompt 文本，用于跨轮次去重
  lastNotifyAt?: number; // 最近一次「一轮结束」OS 通知时间，用于冷却去重
  // ── 可靠活动追踪（替代旧的 lastRequestAt 60s 窗口 + detectTurnEnd 正则）──
  lastActivityAt: number;      // 最近一次「真实活动」时刻：请求开始 / SSE chunk / 请求结束
  streamingInFlight: number;   // 当前在途的 SSE 流数量（用于区分同步 / 流式活跃判定）
  thinkingInFlight: number;    // 当前在途的「思考类」请求数量（thinking 期间用更宽的静默上限）
  streamFirstChunkAt: number;  // 本轮流首个 chunk 时刻（0=尚未收到 chunk，仍在等首 Token）
  inFlightSince: number;       // 在途计数从 0→正 的时刻（同步请求 5min 超时基线）
  notifiedForTurn: boolean;    // 本轮（主任务）是否已弹过结束通知；新一轮主请求会重置
  notifyTimer: NodeJS.Timeout | null; // 结束通知防抖定时器：延迟 NOTIFY_DEBOUNCE_MS 再弹，期间有新请求则取消
}

export interface FinalizeContext {
  sessionId: string;
  agent: ToolType;
  source?: 'global' | 'access-key';
  keyId?: string;
  keyName?: string;
  title?: string;
  timestamp: number;
  statusCode?: number;
  model?: string;
  tokensDelta?: number;
  inputTokensDelta?: number;   // 本次请求输入 token 增量（3D 连线输入段）
  outputTokensDelta?: number;  // 本次请求输出 token 增量（3D 连线输出段）
  body?: any;
  downstreamResponseBody?: any;
  responseBody?: any;
}

const IDLE_WINDOW_MS = 10 * 60_000;    // 无在途请求后，10min 内 → idle；超出 → completed
const SWEEP_INTERVAL_MS = 15_000;      // 每 15s 扫描一次状态迁移（含在途陈旧度检查）
const MAX_EVENTS_PER_SESSION = 200;
const MAX_GLOBAL_EVENTS = 500;
const RECENT_WINDOW_FOR_STATS_MS = 60_000;
// SSE 流「静默」判定：流已开始产出后，超过该时长无新 chunk 视为停滞（用户规范：30s）。
const SSE_SILENCE_MS = 30_000;
// Thinking（思考）请求的静默上限：思考类模型在首 Token 后、正式内容前常有较长静默思考期
// （部分上游不流式下发 thinking token），需比普通 SSE 30s 更宽松，避免误判停滞。
const THINKING_SILENCE_MS = 3 * 60_000;
// 同步请求 / SSE 首 Token 前的「最长存活」保护：服务中断导致请求永不返回时，
// 超过该时长强制结束（用户规范：5min），避免会话永远卡在「进行中」。
const SYNC_MAX_MS = 5 * 60_000;
// 「一轮结束」OS 通知冷却：同一会话在此窗口内的多次 active→idle（典型来自主轮之后的
// 后台/计数/compact 等续发请求，每个 end_turn 都会再触发一次迁移）只弹一次，避免重复打扰。
const NOTIFY_COOLDOWN_MS = 60_000;
// 「任务结束」防抖延迟（同时作用于：展示状态保持 active 的时长 + 结束通知的弹前等待）：
// 检测到任务结束时，先保持「进行中」满该时长，期满且无新请求才落实「空闲」并弹通知；若期间发起新
// 主请求（用户/客户端马上继续下一轮），lastActivityAt 刷新 + 取消挂起通知 → 继续保持「进行中」。
// 避免「每轮结束都闪一下空闲 / 都弹通知」，也兜底吸收 end_turn 误判。
const NOTIFY_DEBOUNCE_MS = 8_000;
// 启动重建：只回填最近 1h 内有活动的会话，每会话最多回填 N 条事件，避免重复解析大量历史分片
const REBUILD_SINCE_MS = 60 * 60_000;
const REBUILD_EVENTS_PER_SESSION = 30;
// 点节点按需重建：取更宽松的窗口，保证老节点点开后仍能看到近期活动路径
const ONDEMAND_SINCE_MS = 24 * 60 * 60_000;

export class AgentMapService extends EventEmitter {
  private db: DbManagerLike | null = null;
  private states = new Map<string, RuntimeState>();
  private sessionEvents = new Map<string, ActivityEvent[]>();
  private globalEvents: ActivityEvent[] = [];
  private sweepTimer: NodeJS.Timeout | null = null;
  // 任务结束 OS 通知（服务端交付）。开关开启后始终弹，不再区分页面是否后台。
  private notifyEnabled = false;

  // 阈值可调（供测试/配置覆盖）
  public readonly idleWindowMs = IDLE_WINDOW_MS;
  public readonly sseSilenceMs = SSE_SILENCE_MS;
  public readonly thinkingSilenceMs = THINKING_SILENCE_MS;
  public readonly syncMaxMs = SYNC_MAX_MS;

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /** 由 main.ts 在 dbManager 就绪后调用 */
  attach(db: DbManagerLike) {
    this.db = db;
    // 恢复持久化的通知开关，使重启后无需浏览器即可正常弹通知
    try {
      this.notifyEnabled = !!db.getConfig?.()?.agentMapNotifyEnabled;
    } catch { /* ignore */ }
    this.seedFromDb().catch(err => {
      console.error('[AgentMap] seed error:', err);
    });
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
      // 不阻止进程退出
      if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
    }
  }

  private async seedFromDb() {
    if (!this.db?.getSessions) return;
    try {
      const sessions = await this.db.getSessions(undefined, 500, 0);
      const now = Date.now();
      for (const s of sessions) {
        if (!s || !s.id) continue;
        if (this.states.has(s.id)) continue;
        const lastRequestAt = s.lastRequestAt || s.firstRequestAt || now;
        const { status, reason } = this.inferStatus({
          lastActivityAt: lastRequestAt,
          lastStatusCode: s.lastStatusCode,
          inFlight: 0,
          streamingInFlight: 0,
          thinkingInFlight: 0,
          streamFirstChunkAt: 0,
          inFlightSince: 0,
          lastTurnEnd: null,
          now,
        });
        this.states.set(s.id, {
          sessionId: s.id,
          agent: s.targetType || 'claude-code',
          source: 'global',
          title: s.title,
          firstRequestAt: s.firstRequestAt || lastRequestAt,
          lastRequestAt,
          requestCount: s.requestCount || 0,
          totalTokens: s.totalTokens || 0,
          inputTokens: s.inputTokens || 0,
          outputTokens: s.outputTokens || 0,
          runningInputTokens: 0,
          runningOutputTokens: 0,
          lastToolName: s.lastToolName,
          lastActivitySummary: s.lastActivitySummary,
          lastStatusCode: s.lastStatusCode,
          lastModel: s.model,
          status,
          statusReason: reason,
          inFlight: 0,
          lastActivityAt: lastRequestAt,
          streamingInFlight: 0,
          thinkingInFlight: 0,
          streamFirstChunkAt: 0,
          inFlightSince: 0,
          notifiedForTurn: false,
          notifyTimer: null,
        });
      }
      this.broadcastStats();
      // 从 Session Log 重建最近一批会话的活动事件（填充全局活动流 + 详情路径），见 rebuildSessionEvents
      this.rebuildRecentEvents().catch(err => console.error('[AgentMap] rebuildRecentEvents error:', err));
    } catch (err) {
      console.error('[AgentMap] seedFromDb error:', err);
    }
  }

  /**
   * 从已加载的请求日志现算活动事件（与 onFinalized 同源解析，含连续相同 prompt 去重）。
   * 不再触发任何 DB 读取，供 rebuildSessionEvents / rebuildRecentEvents 复用。
   */
  private buildEventsFromLogs(sessionId: string, agent: ToolType, logs: RequestLog[]): ActivityEvent[] {
    if (!Array.isArray(logs) || logs.length === 0) return [];
    const sorted = [...logs].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const out: ActivityEvent[] = [];
    for (const log of sorted) {
      const usage = (log as any).usage;
      const tokensDelta = usage?.totalTokens || ((usage?.inputTokens || 0) + (usage?.outputTokens || 0));
      const input: ExtractInput = {
        sessionId,
        agent,
        timestamp: log.timestamp,
        source: 'global',
        body: log.body,
        downstreamResponseBody: log.downstreamResponseBody,
        responseBody: log.responseBody,
        statusCode: log.statusCode,
        tokensDelta,
      };
      const evs = extractActivityEvents(input);
      // 连续相同 prompt 去重（与 onFinalized 一致）
      for (const e of evs) {
        if (e.kind === 'prompt' && out.length > 0) {
          const last = out[out.length - 1];
          if (last.kind === 'prompt' && last.summary === e.summary) continue;
        }
        out.push(e);
      }
    }
    if (out.length > MAX_EVENTS_PER_SESSION) out.splice(0, out.length - MAX_EVENTS_PER_SESSION);
    return out;
  }

  /**
   * 从某会话的请求日志现算重建活动事件（与 onFinalized 同源解析，含连续相同 prompt 去重）。
   * 用于重启后恢复活动路径/全局活动流；失败或无日志返回 []。
   * since 下推到 DB 层，先用索引 ref 的时间戳过滤，老分片完全不读。
   */
  private async rebuildSessionEvents(sessionId: string, agent: ToolType, since?: number): Promise<ActivityEvent[]> {
    if (!this.db?.getLogsBySessionId) return [];
    try {
      const logs = await this.db.getLogsBySessionId(sessionId, MAX_EVENTS_PER_SESSION, since);
      return this.buildEventsFromLogs(sessionId, agent, logs);
    } catch {
      return [];
    }
  }

  /**
   * 启动时为最近 1 小时内有活动的 global 会话重建活动事件，填充全局活动流（fire-and-forget）。
   * 通过 getRecentLogsBySessions 跨会话合并分片读取，每个分片只 loadLogShard 一次，
   * 避免「每会话独立读同一分片」导致的重复解析与内存爆炸。
   */
  private async rebuildRecentEvents() {
    if (!this.db) return;
    const now = Date.now();
    const since = now - REBUILD_SINCE_MS;
    const recentStates = Array.from(this.states.values())
      .filter(st => st.source === 'global' && st.lastRequestAt >= since)
      .sort((a, b) => b.lastRequestAt - a.lastRequestAt);

    if (recentStates.length === 0) {
      this.emit('stats', this.computeStats());
      return;
    }

    let logsBySession: Map<string, RequestLog[]>;
    if (this.db.getRecentLogsBySessions) {
      // 批量回填：跨会话分片去重
      logsBySession = await this.db.getRecentLogsBySessions(
        recentStates.map(st => st.sessionId),
        { since, perSessionLimit: REBUILD_EVENTS_PER_SESSION }
      );
    } else if (this.db.getLogsBySessionId) {
      // 兼容降级：逐会话回填（仍带 since 时间窗过滤）
      logsBySession = new Map();
      for (const st of recentStates) {
        try {
          const logs = await this.db.getLogsBySessionId(st.sessionId, REBUILD_EVENTS_PER_SESSION, since);
          if (logs.length > 0) logsBySession.set(st.sessionId, logs);
        } catch {
          // 忽略单会话失败
        }
      }
    } else {
      this.emit('stats', this.computeStats());
      return;
    }

    for (const st of recentStates) {
      const logs = logsBySession.get(st.sessionId);
      if (!logs || logs.length === 0) continue;
      const evs = this.buildEventsFromLogs(st.sessionId, st.agent, logs);
      if (evs.length > 0) {
        this.sessionEvents.set(st.sessionId, evs);
        this.globalEvents.push(...evs);
      }
    }
    if (this.globalEvents.length > MAX_GLOBAL_EVENTS) {
      this.globalEvents.splice(0, this.globalEvents.length - MAX_GLOBAL_EVENTS);
    }
    this.globalEvents.sort((a, b) => a.ts - b.ts);
    this.emit('stats', this.computeStats()); // 通知已连接客户端活动流已就绪
    // 把重建出的最近 100 条全局活动按时间正序回放给已连接客户端（前端 onActivity 会倒序 prepend，正好 newest 在顶）
    // 解决「客户端在 rebuild 完成前就连上、init 快照里 feed 为空」的时序问题
    for (const e of this.globalEvents.slice(-100)) {
      this.emit('activity', e);
    }
  }

  // ============ 在途请求注册表 + 可靠活动追踪 ============

  /**
   * 请求开始：在途计数 + 活动时钟刷新。
   * - background=true（count_tokens / compact / 后台请求）：刷新活动、计入在途，用于「是否还活着」判定；
   *   但不重置 notifiedForTurn —— 这样主任务结束后紧跟的后台请求不会再次触发结束通知。
   * - background=false（主轮请求）：视为「新一轮用户任务」，重置 notifiedForTurn，允许结束时再弹一次通知。
   */
  startRequest(sessionId: string, agent: ToolType, opts?: {
    source?: 'global' | 'access-key'; keyId?: string; keyName?: string; title?: string;
    background?: boolean; thinking?: boolean;
  }) {
    if (!sessionId || sessionId === '-') return;
    const now = Date.now();
    let st = this.states.get(sessionId);
    if (!st) {
      st = {
        sessionId,
        agent,
        source: opts?.source || 'global',
        keyId: opts?.keyId,
        keyName: opts?.keyName,
        title: opts?.title,
        firstRequestAt: now,
        lastRequestAt: now,
        requestCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        runningInputTokens: 0,
        runningOutputTokens: 0,
        status: 'active',
        statusReason: 'in-flight',
        inFlight: 0,
        lastActivityAt: now,
        streamingInFlight: 0,
        thinkingInFlight: 0,
        streamFirstChunkAt: 0,
        inFlightSince: now,
        notifiedForTurn: false,
        notifyTimer: null,
      };
      this.states.set(sessionId, st);
    }
    if (st.inFlight === 0) {
      // 新的一批在途开始：记录起跑时刻（同步请求 5min 超时基线）
      st.inFlightSince = now;
      st.streamFirstChunkAt = 0;
    }
    st.inFlight += 1;
    if (opts?.thinking) st.thinkingInFlight += 1;
    st.lastRequestAt = now;
    st.lastActivityAt = now;
    if (!opts?.background) {
      // 主轮（用户发起的新任务）：会话再次活跃 → 取消上一轮可能挂起的结束通知（防抖），并重置通知标记
      this.cancelNotifyTimer(st);
      st.notifiedForTurn = false;
    }
    // 有在途请求必然 active
    if (st.status !== 'active') {
      st.status = 'active';
      st.statusReason = 'in-flight';
    }
    this.emitSession(st);
  }

  /** SSE 流真正开始（pipeline 已建立）。记一个在途流，并刷新活动时钟（首 Token 仍待 heartbeat 标记）。 */
  markStreaming(sessionId: string) {
    if (!sessionId || sessionId === '-') return;
    const st = this.states.get(sessionId);
    if (!st) return;
    st.streamingInFlight += 1;
    st.lastActivityAt = Date.now();
  }

  /**
   * SSE chunk 心跳：每流经一个下游 chunk 刷新一次活动时钟（节流由调用方负责）。
   * 可附带当前流式请求的实时累计 usage（input/output）：写入 running 计数并广播 session-update，
   * 使前端节点在流式过程中随 token 增长实时上移。finalize 时 onFinalized 会把最终值并入累计并清零 running。
   */
  heartbeat(sessionId: string, usage?: { inputTokens?: number; outputTokens?: number }) {
    if (!sessionId || sessionId === '-') return;
    const st = this.states.get(sessionId);
    if (!st) return;
    const now = Date.now();
    st.lastActivityAt = now;
    if (st.streamFirstChunkAt === 0) st.streamFirstChunkAt = now;
    if (usage) {
      st.runningInputTokens = usage.inputTokens || 0;
      st.runningOutputTokens = usage.outputTokens || 0;
      this.emitSession(st);
    }
  }

  /** 请求结束：在途计数递减（流式请求同时递减在途流计数，思考请求递减思考计数）。不立即改 status，由 onFinalized / reevaluate / sweep 决定。 */
  endRequest(sessionId: string, opts?: { isStream?: boolean; thinking?: boolean }) {
    if (!sessionId || sessionId === '-') return;
    const st = this.states.get(sessionId);
    if (!st) return;
    st.inFlight = Math.max(0, st.inFlight - 1);
    if (opts?.isStream) st.streamingInFlight = Math.max(0, st.streamingInFlight - 1);
    if (opts?.thinking) st.thinkingInFlight = Math.max(0, st.thinkingInFlight - 1);
    st.lastActivityAt = Date.now();
    if (st.inFlight === 0) {
      st.inFlightSince = 0;
      st.streamingInFlight = 0;
      st.thinkingInFlight = 0;
      st.streamFirstChunkAt = 0;
      // 在途已清空：实时累计让位给 onFinalized 的最终累计，避免双算
      st.runningInputTokens = 0;
      st.runningOutputTokens = 0;
    }
  }

  /**
   * 重算单个会话状态并广播（含通知判定）。供 onFinalized / 安全网 / REST 主动刷新复用。
   * 返回是否有状态变化。
   */
  reevaluate(sessionId: string): boolean {
    if (!sessionId || sessionId === '-') return false;
    const st = this.states.get(sessionId);
    if (!st) return false;
    const prevStatus = st.status;
    const { status, reason } = this.inferStatus({
      lastActivityAt: st.lastActivityAt,
      lastStatusCode: st.lastStatusCode,
      inFlight: st.inFlight,
      streamingInFlight: st.streamingInFlight,
      thinkingInFlight: st.thinkingInFlight,
      streamFirstChunkAt: st.streamFirstChunkAt,
      inFlightSince: st.inFlightSince,
      lastTurnEnd: st.lastTurnEnd,
      now: Date.now(),
    });
    if (status === prevStatus && reason === st.statusReason) return false;
    st.status = status;
    st.statusReason = reason;
    // 安全网路径（finalizeLog 未走 onFinalized 的泄漏场景）：脱离 active 时补调度防抖通知
    if (status !== 'active') this.considerEndNotify(st, status === 'error');
    this.emitSession(st);
    return true;
  }

  // ============ 请求收尾：抽事件 + 重算状态 + 广播 ============

  onFinalized(ctx: FinalizeContext) {
    if (!ctx.sessionId || ctx.sessionId === '-') return;

    const extractInput: ExtractInput = {
      sessionId: ctx.sessionId,
      agent: ctx.agent,
      timestamp: ctx.timestamp,
      source: ctx.source,
      keyId: ctx.keyId,
      keyName: ctx.keyName,
      body: ctx.body,
      downstreamResponseBody: ctx.downstreamResponseBody,
      responseBody: ctx.responseBody,
      statusCode: ctx.statusCode,
      tokensDelta: ctx.tokensDelta,
    };
    const rawEvents = extractActivityEvents(extractInput);
    // 跨轮次 prompt 去重：若本轮 prompt 与该会话「最近一次真正写入的 prompt」文本相同，则丢弃。
    // 比旧逻辑（仅当上一条已记录事件本身也是相同 prompt 才丢）更稳：无论两条相同提问之间
    // 夹了多少 tool_use / response（工具循环 / 客户端重试 / 末条 user 同时含 text+tool_result）都能命中。
    const existingState = this.states.get(ctx.sessionId);
    const prevPromptSummary = existingState?.lastPromptSummary;
    const firstPromptIdx = rawEvents.findIndex(e => e.kind === 'prompt');
    let events = rawEvents;
    let recordedPromptSummary = prevPromptSummary;
    if (firstPromptIdx >= 0
      && prevPromptSummary
      && rawEvents[firstPromptIdx].summary === prevPromptSummary) {
      events = rawEvents.filter((_, i) => i !== firstPromptIdx);
    } else if (firstPromptIdx >= 0) {
      recordedPromptSummary = rawEvents[firstPromptIdx].summary;
    }
    const { summary, toolName } = deriveLastActivity(events);

    const now = Date.now();
    let st = this.states.get(ctx.sessionId);
    if (!st) {
      st = {
        sessionId: ctx.sessionId,
        agent: ctx.agent,
        source: ctx.source || 'global',
        keyId: ctx.keyId,
        keyName: ctx.keyName,
        title: ctx.title,
        firstRequestAt: ctx.timestamp,
        lastRequestAt: ctx.timestamp,
        requestCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        runningInputTokens: 0,
        runningOutputTokens: 0,
        status: 'active',
        inFlight: 0,
        lastActivityAt: ctx.timestamp,
        streamingInFlight: 0,
        thinkingInFlight: 0,
        streamFirstChunkAt: 0,
        inFlightSince: ctx.timestamp,
        notifiedForTurn: false,
        notifyTimer: null,
      };
      this.states.set(ctx.sessionId, st);
    }
    st.agent = ctx.agent;
    st.source = ctx.source || st.source || 'global';
    if (ctx.keyId) st.keyId = ctx.keyId;
    if (ctx.keyName) st.keyName = ctx.keyName;
    if (ctx.title && !st.title) st.title = ctx.title;
    st.lastPromptSummary = recordedPromptSummary;
    st.lastRequestAt = ctx.timestamp;
    st.requestCount += 1;
    if (ctx.tokensDelta) st.totalTokens += ctx.tokensDelta;
    if (ctx.inputTokensDelta) st.inputTokens += ctx.inputTokensDelta;
    if (ctx.outputTokensDelta) st.outputTokens += ctx.outputTokensDelta;
    if (ctx.model) st.lastModel = ctx.model;
    if (ctx.statusCode != null) st.lastStatusCode = ctx.statusCode;
    if (summary) st.lastActivitySummary = summary;
    if (toolName) st.lastToolName = toolName;

    // 本轮响应是否表示「一轮结束」：
    // - true  = end_turn 等明确结束 → 任务完成，可弹通知
    // - false = tool_use 等还要继续 → 客户端将本地执行工具后再次请求，此时静默、保持「进行中」
    // - null  = 无法判定 → 兜底按结束处理
    const turnEnd = detectTurnEnd(ctx.agent, ctx.downstreamResponseBody, ctx.responseBody);
    st.lastTurnEnd = turnEnd;

    // 重算状态：请求已结束（endRequest 已把 inFlight 减 1）。inferStatus 会在「结束」情形下防抖保持 active。
    const { status, reason } = this.inferStatus({
      lastActivityAt: st.lastActivityAt,
      lastStatusCode: st.lastStatusCode,
      inFlight: st.inFlight,
      streamingInFlight: st.streamingInFlight,
      thinkingInFlight: st.thinkingInFlight,
      streamFirstChunkAt: st.streamFirstChunkAt,
      inFlightSince: st.inFlightSince,
      lastTurnEnd: turnEnd,
      now,
    });
    st.status = status;
    st.statusReason = reason;
    // 任务结束检测：无在途且末响应非 tool_use（end_turn / 未知）→ 调度防抖通知。
    // tool_use 不调度（客户端将本地执行工具后继续）；防抖期内来新主请求会取消它。
    if (st.inFlight === 0 && st.lastTurnEnd !== false) {
      this.considerEndNotify(st, (st.lastStatusCode ?? 0) >= 500);
    }

    // 记录事件
    if (events.length > 0) {
      this.recordEvents(ctx.sessionId, events);
      for (const e of events) {
        this.emit('activity', e);
      }
    }
    this.emitSession(st);

    // 异步解析本地会话元信息（项目路径 + 原始标题）；仅 global 来源、且未解析过
    this.enrichSession(st);
  }

  /** 从本机 Claude/Codex 会话存储读取项目路径并回填（access-key 不解析）。
   *  注意：不在此处覆盖标题——统一沿用 proxy 抽取的标题（与会话列表一致），避免两边标题分叉。 */
  private async enrichSession(st: RuntimeState) {
    if (st.source === 'access-key' || st.metaResolved) return;
    st.metaResolved = true;
    try {
      const meta = await resolveSessionMeta(st.sessionId, st.agent);
      if (meta.projectPath && !st.projectPath) {
        st.projectPath = meta.projectPath;
        this.emitSession(st);
      }
    } catch { /* ignore */ }
  }

  /** 按需解析（供 REST 端点 / 详情 popover）。返回 source 便于前端给出恰当提示 */
  async getSessionMeta(sessionId: string): Promise<{ source: 'global' | 'access-key' | 'unknown'; projectPath?: string; title?: string }> {
    const st = this.states.get(sessionId);
    const source = st ? st.source : 'unknown';
    if (source === 'access-key' || source === 'unknown') {
      return { source, projectPath: st?.projectPath, title: st?.title };
    }
    // global：命中缓存或现解析（仅项目路径；标题沿用 proxy 抽取值，与会话列表保持一致）
    const meta = await resolveSessionMeta(sessionId, st?.agent || 'claude-code');
    if (st) {
      if (meta.projectPath && !st.projectPath) st.projectPath = meta.projectPath;
      st.metaResolved = true;
      // legacy 会话（修复前累积、拆分从未持久化）：点开详情时按日志回填输入/输出拆分
      this.backfillTokenSplit(st).catch(err => console.error('[AgentMap] backfillTokenSplit error:', err));
    }
    return { source, projectPath: meta.projectPath || st?.projectPath, title: st?.title };
  }

  /**
   * 历史 token 输入/输出拆分回填。
   * 仅对 legacy 会话生效：累计 token > 0 但拆分为 0（修复前从未持久化）。
   * 从该会话的全部请求日志现算 usage.inputTokens / outputTokens 之和，写回 RuntimeState + DB（绝对值），
   * 之后新请求照常在回填基线上累加。每个会话只回填一次（tokenSplitBackfilled）。
   */
  private async backfillTokenSplit(st: RuntimeState) {
    if (st.tokenSplitBackfilled) return;
    if (st.source !== 'global') return;
    // 仅 legacy 标记：累计有值但拆分为 0。新会话（拆分已随请求累加）不触发。
    if (!(st.totalTokens > 0 && st.inputTokens === 0 && st.outputTokens === 0)) {
      st.tokenSplitBackfilled = true;
      return;
    }
    if (!this.db?.getLogsBySessionId || !this.db?.updateSession) {
      st.tokenSplitBackfilled = true;
      return;
    }
    st.tokenSplitBackfilled = true; // 先置位，防并发重复回填
    try {
      // 取全部日志（默认 limit=100 会漏算大 session），传一个大上限以覆盖完整历史
      const logs = await this.db.getLogsBySessionId(st.sessionId, Number.MAX_SAFE_INTEGER);
      let inputTokens = 0;
      let outputTokens = 0;
      for (const log of logs) {
        const u = (log as any).usage;
        if (!u) continue;
        inputTokens += u.inputTokens || u.promptTokens || 0;
        outputTokens += u.outputTokens || u.completionTokens || 0;
      }
      if (inputTokens > 0 || outputTokens > 0) {
        st.inputTokens = inputTokens;
        st.outputTokens = outputTokens;
        // 绝对写入 DB（不走 upsertSession 的累加语义），后续新请求在其上累加
        await this.db.updateSession(st.sessionId, { inputTokens, outputTokens });
        this.emitSession(st);
      }
    } catch (err) {
      st.tokenSplitBackfilled = false; // 失败则允许下次重试
      throw err;
    }
  }

  // ============ 任务结束 OS 通知 ============

  setNotifyEnabled(enabled: boolean) {
    this.notifyEnabled = !!enabled;
    this.persistNotifyEnabled(this.notifyEnabled);
  }
  /** 异步把通知开关写入 AppConfig（read-modify-write，best-effort，不阻塞调用） */
  private async persistNotifyEnabled(enabled: boolean) {
    if (!this.db?.getConfig || !this.db?.updateConfig) return;
    try {
      const cfg = this.db.getConfig();
      if (cfg.agentMapNotifyEnabled === enabled) return;
      cfg.agentMapNotifyEnabled = enabled;
      await this.db.updateConfig(cfg);
    } catch { /* ignore */ }
  }
  /** 兼容旧端点：不再区分前后台，调用为 no-op（开关开启后始终弹） */
  setPageHidden(_hidden: boolean) { /* no-op */ }
  getNotifyEnabled() { return this.notifyEnabled; }

  /** 发一条测试通知（供 UI「测试」按钮验证 OS 是否真弹） */
  notifyTest() {
    notify({ title: '🔔 AICodeSwitch', body: '测试通知：通知功能可用' });
  }

  /**
   * 结束通知调度（基于「结束检测」，而非展示状态迁移）：
   * - onFinalized 检测到一轮结束（inFlight==0 且非 tool_use）时调用；
   * - sweep / reevaluate 检测到停滞/泄漏脱离 active 时调用。
   * 每轮只调度一次（notifiedForTurn 去重）；499（用户取消）不调度。实际弹通知由 scheduleNotify 防抖。
   * 展示状态的「防抖保持 active」由 inferStatus 负责，fireNotify 落实 idle，二者经 NOTIFY_DEBOUNCE_MS 对齐。
   */
  private considerEndNotify(st: RuntimeState, isError: boolean) {
    if (!this.notifyEnabled) return;
    if (st.notifiedForTurn) return;                 // 本轮已调度
    if (st.lastStatusCode === 499) return;          // 用户主动取消，不弹
    if (st.thinkingInFlight > 0) return;            // 仍有思考请求在途，暂不弹结束通知
    st.notifiedForTurn = true;
    this.scheduleNotify(st, isError);
  }

  /** 安排一条防抖结束通知（先取消已挂起的，再重新计时）。 */
  private scheduleNotify(st: RuntimeState, isError: boolean) {
    this.cancelNotifyTimer(st);
    st.notifyTimer = setTimeout(() => {
      st.notifyTimer = null;
      this.fireNotify(st, isError);
    }, NOTIFY_DEBOUNCE_MS);
    // 不阻止进程退出
    if (typeof st.notifyTimer.unref === 'function') st.notifyTimer.unref();
  }

  /** 取消挂起的防抖通知（会话再次活跃时调用）。 */
  private cancelNotifyTimer(st: RuntimeState) {
    if (st.notifyTimer) {
      clearTimeout(st.notifyTimer);
      st.notifyTimer = null;
    }
  }

  /** 真正弹出 OS 通知（防抖窗口结束、未被取消时调用）。过 60s 冷却兜底。同时把「防抖保持的 active」落实为 idle。 */
  private fireNotify(st: RuntimeState, isError: boolean) {
    // 防抖期间用户可能关掉了通知开关 → 不弹
    if (!this.notifyEnabled) return;
    const now = Date.now();
    if (st.lastNotifyAt && now - st.lastNotifyAt < NOTIFY_COOLDOWN_MS) return;
    st.lastNotifyAt = now;
    // 把展示状态从「防抖保持的 active」落实为 idle，与通知同步；仅当确无在途请求（不覆盖后台请求进行中的 active）
    if (st.inFlight === 0 && st.status === 'active') {
      st.status = isError ? 'error' : 'idle';
      st.statusReason = isError ? 'upstream error' : 'turn ended';
      this.emitSession(st);
    }
    const agentName = st.agent === 'codex' ? 'Codex' : 'Claude Code';
    notify({
      title: `${isError ? '⚠️' : '✅'} AICodeSwitch · ${agentName}`,
      body: st.title || st.lastActivitySummary || (isError ? '任务出现异常' : '任务已结束，等待下一步'),
    });
  }

  private recordEvents(sessionId: string, events: ActivityEvent[]) {
    const arr = this.sessionEvents.get(sessionId) || [];
    arr.push(...events);
    if (arr.length > MAX_EVENTS_PER_SESSION) {
      arr.splice(0, arr.length - MAX_EVENTS_PER_SESSION);
    }
    this.sessionEvents.set(sessionId, arr);

    this.globalEvents.push(...events);
    if (this.globalEvents.length > MAX_GLOBAL_EVENTS) {
      this.globalEvents.splice(0, this.globalEvents.length - MAX_GLOBAL_EVENTS);
    }
  }

  // ============ 状态推断（纯函数，基于「在途 + 真实活动时钟 + 轮次语义」） ============

  private inferStatus(args: {
    lastActivityAt: number; lastStatusCode?: number; inFlight: number;
    streamingInFlight: number; thinkingInFlight: number;
    streamFirstChunkAt: number; inFlightSince: number;
    lastTurnEnd?: boolean | null; now: number;
  }): { status: SessionStatus; reason: string; notifyEligible: boolean } {
    // 末次上游 5xx → error（即使时间较近也标 error，下一次成功会刷回 active）
    if (args.lastStatusCode != null && args.lastStatusCode >= 500) {
      return { status: 'error', reason: `upstream ${args.lastStatusCode}`, notifyEligible: true };
    }
    // 在途请求：判定是否「真正存活」（区分同步 / SSE / 思考）。在途期间任何「停滞→idle」都可通知。
    if (args.inFlight > 0) {
      if (args.streamingInFlight > 0) {
        if (!args.streamFirstChunkAt) {
          // 首 Token 前：思考类模型 TTFT 可能较长，按同步超时 5min 等待
          const since = args.inFlightSince || args.lastActivityAt;
          if (args.now - since <= this.syncMaxMs) return { status: 'active', reason: 'awaiting first token', notifyEligible: true };
          return { status: 'idle', reason: 'stream stalled (no first token)', notifyEligible: true };
        }
        // 已开始产出：思考请求用更宽的 THINKING_SILENCE_MS，否则 SSE_SILENCE_MS（30s）
        const limit = args.thinkingInFlight > 0 ? this.thinkingSilenceMs : this.sseSilenceMs;
        // 静默基准用「最近一次活动」（每个下游 chunk 经 heartbeat 刷新），而非首个 chunk 时刻：
        // 否则任何总时长超过 30s 的流式响应都会被误判为停滞，在响应仍正常输出时弹出「任务已结束」通知。
        const since = args.lastActivityAt;
        if (args.now - since <= limit) {
          return { status: 'active', reason: args.thinkingInFlight > 0 ? 'thinking' : 'streaming', notifyEligible: true };
        }
        return { status: 'idle', reason: args.thinkingInFlight > 0 ? 'thinking timeout' : 'stream stalled', notifyEligible: true };
      }
      // 同步请求：5min 内视为仍在处理；超过则视作服务中断、强制结束
      const since = args.inFlightSince || args.lastActivityAt;
      if (args.now - since <= this.syncMaxMs) return { status: 'active', reason: 'in-flight', notifyEligible: true };
      return { status: 'idle', reason: 'sync timeout', notifyEligible: true };
    }
    // 无在途请求：按「上一轮响应语义 + 距最近活动时长」判 idle / completed，并决定是否可通知
    const elapsed = args.now - args.lastActivityAt;
    // 499 = 客户端主动断开（用户放弃停止任务）：视为「已取消」，立即进入 idle
    if (args.lastStatusCode === 499) {
      if (elapsed <= this.idleWindowMs) return { status: 'idle', reason: 'client cancelled', notifyEligible: true };
      return { status: 'completed', reason: 'cancelled earlier', notifyEligible: true };
    }
    // tool_use：客户端正在本地执行工具，随后会再发请求 → 保持「进行中」，且**不可通知**（避免每次工具调用误弹）
    if (args.lastTurnEnd === false) {
      if (elapsed <= this.idleWindowMs) return { status: 'active', reason: 'executing tool locally', notifyEligible: false };
      return { status: 'idle', reason: 'tool exec abandoned', notifyEligible: false };
    }
    // end_turn（true）或无法判定（null，兜底按结束处理）：
    // 先防抖保持 active 满 NOTIFY_DEBOUNCE_MS（避免请求边界处「闪一下空闲」），期满才落实 idle/completed。
    // 防抖期内若发起新主请求，lastActivityAt 会被刷新 → 继续保持 active，不闪、不弹通知。
    if (elapsed <= NOTIFY_DEBOUNCE_MS) return { status: 'active', reason: 'turn ending (debounced)', notifyEligible: true };
    if (elapsed <= this.idleWindowMs) return { status: 'idle', reason: 'turn ended', notifyEligible: true };
    return { status: 'completed', reason: 'inactive', notifyEligible: true };
  }

  // ============ 定时清扫 ============

  private sweep() {
    const now = Date.now();
    let changed = false;
    this.states.forEach(st => {
      const prevStatus = st.status;
      const { status, reason } = this.inferStatus({
        lastActivityAt: st.lastActivityAt,
        lastStatusCode: st.lastStatusCode,
        inFlight: st.inFlight,
        streamingInFlight: st.streamingInFlight,
        thinkingInFlight: st.thinkingInFlight,
        streamFirstChunkAt: st.streamFirstChunkAt,
        inFlightSince: st.inFlightSince,
        lastTurnEnd: st.lastTurnEnd,
        now,
      });
      // 状态迁移，或在途请求已陈旧/泄漏（inFlight>0 却不再存活）→ 清零泄漏的计数器
      const statusChanged = status !== prevStatus;
      const leakedInFlight = st.inFlight > 0 && status !== 'active';
      if (statusChanged || leakedInFlight) {
        if (leakedInFlight) {
          // 修复「永远卡在进行中」：endRequest 未配对到达（早退/异常）导致的在途泄漏，这里兜底清零
          st.inFlight = 0;
          st.streamingInFlight = 0;
          st.thinkingInFlight = 0;
          st.inFlightSince = 0;
          st.streamFirstChunkAt = 0;
        }
        st.status = status;
        st.statusReason = reason;
        changed = true;
        // 停滞/泄漏/异常导致脱离 active → 调度防抖通知（正常结束已在 onFinalized 调度，notifiedForTurn 去重）
        if (status !== 'active') this.considerEndNotify(st, status === 'error');
        this.emitSession(st);
      }
    });
    if (changed) this.broadcastStats();
  }

  // ============ 广播 ============

  private emitSession(st: RuntimeState) {
    this.emit('session-update', this.toMapItem(st));
    this.broadcastStats();
  }

  private broadcastStats() {
    this.emit('stats', this.computeStats());
  }

  // ============ 读取（供 REST / SSE init） ============

  getSnapshot(): { sessions: SessionMapItem[]; events: ActivityEvent[]; stats: AgentMapStats; serverTime: number } {
    return {
      sessions: Array.from(this.states.values()).map(s => this.toMapItem(s)),
      events: this.getRecentGlobalEvents(100),
      stats: this.computeStats(),
      serverTime: Date.now(),
    };
  }

  async getSessionEvents(sessionId: string, since?: number): Promise<ActivityEvent[]> {
    let arr = this.sessionEvents.get(sessionId);
    // 按需重建：缓冲为空、会话存在、且能读日志 → 从 Session Log 现算（重启后点开老节点）
    if ((!arr || arr.length === 0) && this.states.has(sessionId) && this.db?.getLogsBySessionId) {
      const st = this.states.get(sessionId)!;
      if (st.source === 'global') {
        // 按需重建：取最近 24h，既保证老节点点开后能看到活动路径，又避免解析全部历史
        const evs = await this.rebuildSessionEvents(sessionId, st.agent, Date.now() - ONDEMAND_SINCE_MS);
        if (evs.length > 0) {
          this.sessionEvents.set(sessionId, evs);
          arr = evs;
        }
      }
    }
    const base = arr || [];
    if (since == null) return base.slice(-MAX_EVENTS_PER_SESSION);
    return base.filter(e => e.ts > since);
  }

  getRecentGlobalEvents(limit: number): ActivityEvent[] {
    return this.globalEvents.slice(-limit).reverse();
  }

  private toMapItem(st: RuntimeState): SessionMapItem {
    return {
      sessionId: st.sessionId,
      agent: st.agent,
      source: st.source,
      keyId: st.keyId,
      keyName: st.keyName,
      title: st.title,
      status: st.status,
      statusReason: st.statusReason,
      firstRequestAt: st.firstRequestAt,
      lastRequestAt: st.lastRequestAt,
      requestCount: st.requestCount,
      // 展示值 = 已落盘累计 + 在途实时累计，使节点在流式过程中随 token 增长实时上移
      totalTokens: st.totalTokens + st.runningInputTokens + st.runningOutputTokens,
      inputTokens: st.inputTokens + st.runningInputTokens,
      outputTokens: st.outputTokens + st.runningOutputTokens,
      lastToolName: st.lastToolName,
      lastActivitySummary: st.lastActivitySummary,
      lastStatusCode: st.lastStatusCode,
      lastModel: st.lastModel,
      inFlight: st.inFlight,
      projectPath: st.projectPath,
    };
  }

  private computeStats(): AgentMapStats {
    let active = 0, idle = 0, completed = 0, error = 0, inFlight = 0;
    const now = Date.now();
    for (const st of this.states.values()) {
      inFlight += st.inFlight;
      switch (st.status) {
        case 'active': active++; break;
        case 'idle': idle++; break;
        case 'completed': completed++; break;
        case 'error': error++; break;
      }
    }
    const recentCutoff = now - RECENT_WINDOW_FOR_STATS_MS;
    let recentToolCalls = 0;
    let recentTokens = 0;
    for (const e of this.globalEvents) {
      if (e.ts < recentCutoff) continue;
      if (e.kind === 'tool_use') recentToolCalls++;
      if (e.tokensDelta) recentTokens += e.tokensDelta;
    }
    return {
      totalSessions: this.states.size,
      activeSessions: active,
      idleSessions: idle,
      completedSessions: completed,
      errorSessions: error,
      inFlightRequests: inFlight,
      recentToolCalls,
      recentTokens,
    };
  }

  destroy() {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    // 清理所有挂起的防抖通知定时器，避免销毁后仍触发
    this.states.forEach(st => this.cancelNotifyTimer(st));
    this.states.clear();
    this.sessionEvents.clear();
    this.globalEvents = [];
    this.removeAllListeners();
  }
}

// 全局单例（在 dbManager 就绪前 no-op；attach 后激活）
export const agentMapService = new AgentMapService();
