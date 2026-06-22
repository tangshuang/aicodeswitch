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
  RequestLog,
  SessionMapItem,
  SessionStatus,
  ToolType,
} from '../../types';
import { deriveLastActivity, extractActivityEvents, detectTurnEnd, type ExtractInput } from './activity-extractor';
import { resolveSessionMeta } from './session-meta';
import { notify } from '../notifier';

type DbManagerLike = {
  getSessions?: (targetType?: ToolType, limit?: number, offset?: number) => Promise<any[]>;
  getLogsBySessionId?: (sessionId: string, limit?: number, since?: number) => Promise<RequestLog[]>;
  // 批量回填多会话近期日志（跨会话合并分片读取），用于启动重建，避免重复解析同一分片
  getRecentLogsBySessions?: (
    sessionIds: string[],
    opts?: { since?: number; perSessionLimit?: number }
  ) => Promise<Map<string, RequestLog[]>>;
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
  lastToolName?: string;
  lastActivitySummary?: string;
  lastStatusCode?: number;
  lastModel?: string;
  status: SessionStatus;
  statusReason?: string;
  inFlight: number;
  projectPath?: string;
  metaResolved?: boolean; // 是否已尝试解析本地会话元信息（避免重复扫盘）
  lastTurnEnd?: boolean | null; // 末轮响应是否表示「一轮结束」（精确信号，见 detectTurnEnd）
  lastPromptSummary?: string; // 最近一次真正写入的 prompt 文本，用于跨轮次去重
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
  body?: any;
  downstreamResponseBody?: any;
  responseBody?: any;
}

const ACTIVE_WINDOW_MS = 60_000;       // 最近 60s 内有活动 → active
const IDLE_WINDOW_MS = 10 * 60_000;    // 10min 内有活动但超过 active 窗口 → idle；超出 → completed
const SWEEP_INTERVAL_MS = 15_000;      // 每 15s 扫描一次状态迁移
const MAX_EVENTS_PER_SESSION = 200;
const MAX_GLOBAL_EVENTS = 500;
const RECENT_WINDOW_FOR_STATS_MS = 60_000;
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
  public readonly activeWindowMs = ACTIVE_WINDOW_MS;
  public readonly idleWindowMs = IDLE_WINDOW_MS;

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /** 由 main.ts 在 dbManager 就绪后调用 */
  attach(db: DbManagerLike) {
    this.db = db;
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
          lastRequestAt,
          lastStatusCode: s.lastStatusCode,
          inFlight: 0,
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
          lastToolName: s.lastToolName,
          lastActivitySummary: s.lastActivitySummary,
          lastStatusCode: s.lastStatusCode,
          lastModel: s.model,
          status,
          statusReason: reason,
          inFlight: 0,
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

  // ============ 在途请求注册表 ============

  startRequest(sessionId: string, agent: ToolType, opts?: { source?: 'global' | 'access-key'; keyId?: string; keyName?: string; title?: string }) {
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
        status: 'active',
        statusReason: 'in-flight',
        inFlight: 0,
      };
      this.states.set(sessionId, st);
    }
    st.inFlight += 1;
    st.lastRequestAt = now;
    // 有在途请求必然 active
    if (st.status !== 'active') {
      st.status = 'active';
      st.statusReason = 'in-flight';
    }
    this.emitSession(st);
  }

  endRequest(sessionId: string) {
    if (!sessionId || sessionId === '-') return;
    const st = this.states.get(sessionId);
    if (!st) return;
    st.inFlight = Math.max(0, st.inFlight - 1);
    // 不立即改 status，由 onFinalized 的重算决定
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
        status: 'active',
        inFlight: 0,
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
    if (ctx.model) st.lastModel = ctx.model;
    if (ctx.statusCode != null) st.lastStatusCode = ctx.statusCode;
    if (summary) st.lastActivitySummary = summary;
    if (toolName) st.lastToolName = toolName;

    // 本轮响应是否表示「一轮结束」（精确信号，替代纯时间窗）
    const turnEnd = detectTurnEnd(ctx.agent, ctx.downstreamResponseBody, ctx.responseBody);
    st.lastTurnEnd = turnEnd;

    // 重算状态（onFinalized 时请求已结束，inFlight 会被 endRequest 减，但可能尚未调用）
    const prevStatus = st.status;
    const { status, reason } = this.inferStatus({
      lastRequestAt: st.lastRequestAt,
      lastStatusCode: st.lastStatusCode,
      inFlight: st.inFlight,
      now,
      turnEnd,
    });
    st.status = status;
    st.statusReason = reason;
    this.maybeNotifyTurnEnd(prevStatus, st);

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

  /** 从本机 Claude/Codex 会话存储读取项目路径与原始标题并回填（access-key 不解析） */
  private async enrichSession(st: RuntimeState) {
    if (st.source === 'access-key' || st.metaResolved) return;
    st.metaResolved = true;
    try {
      const meta = await resolveSessionMeta(st.sessionId, st.agent);
      let changed = false;
      if (meta.projectPath && !st.projectPath) { st.projectPath = meta.projectPath; changed = true; }
      // 原始标题更标准，命中即覆盖日志截取的标题
      if (meta.title) { st.title = meta.title; changed = true; }
      if (changed) this.emitSession(st);
    } catch { /* ignore */ }
  }

  /** 按需解析（供 REST 端点 / 详情 popover）。返回 source 便于前端给出恰当提示 */
  async getSessionMeta(sessionId: string): Promise<{ source: 'global' | 'access-key' | 'unknown'; projectPath?: string; title?: string }> {
    const st = this.states.get(sessionId);
    const source = st ? st.source : 'unknown';
    if (source === 'access-key' || source === 'unknown') {
      return { source, projectPath: st?.projectPath, title: st?.title };
    }
    // global：命中缓存或现解析
    const meta = await resolveSessionMeta(sessionId, st?.agent || 'claude-code');
    if (st) {
      if (meta.projectPath && !st.projectPath) st.projectPath = meta.projectPath;
      if (meta.title) st.title = meta.title;
      st.metaResolved = true;
    }
    return { source, projectPath: meta.projectPath || st?.projectPath, title: meta.title || st?.title };
  }

  // ============ 任务结束 OS 通知 ============

  setNotifyEnabled(enabled: boolean) { this.notifyEnabled = !!enabled; }
  /** 兼容旧端点：不再区分前后台，调用为 no-op（开关开启后始终弹） */
  setPageHidden(_hidden: boolean) { /* no-op */ }
  getNotifyEnabled() { return this.notifyEnabled; }

  /** 发一条测试通知（供 UI「测试」按钮验证 OS 是否真弹） */
  notifyTest() {
    notify({ title: '🔔 AICodeSwitch', body: '测试通知：通知功能可用' });
  }

  /** active → idle 迁移时，只要开关开启就弹 OS 通知（一轮工作结束）。不再看页面是否后台。 */
  private maybeNotifyTurnEnd(prevStatus: SessionStatus, st: RuntimeState) {
    if (!this.notifyEnabled) return;
    if (prevStatus !== 'active' || st.status !== 'idle') return;
    const agentName = st.agent === 'codex' ? 'Codex' : 'Claude Code';
    notify({
      title: `✅ AICodeSwitch · ${agentName}`,
      body: `一轮工作结束：${st.title || st.lastActivitySummary || '任务已暂停，等待下一步'}`,
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

  // ============ 状态推断（纯函数，基于活跃度） ============

  private inferStatus(args: {
    lastRequestAt: number; lastStatusCode?: number; inFlight: number; now: number;
    turnEnd?: boolean | null;
  }): { status: SessionStatus; reason: string } {
    // 在途请求 → active
    if (args.inFlight > 0) return { status: 'active', reason: 'in-flight' };
    // 末次失败 → error（即使时间较近也标 error，下一次成功会刷回 active）
    if (args.lastStatusCode != null && args.lastStatusCode >= 500) {
      return { status: 'error', reason: `upstream ${args.lastStatusCode}` };
    }
    const elapsed = args.now - args.lastRequestAt;
    // 精确信号：本轮响应明确「结束」→ 立即停止脉冲，进入 idle（超时再 completed）
    if (args.turnEnd === true) {
      if (elapsed <= this.idleWindowMs) return { status: 'idle', reason: 'turn ended' };
      return { status: 'completed', reason: 'inactive' };
    }
    // 仍将继续（tool_use）或信号未知 → 回退到活跃时间窗
    if (elapsed <= this.activeWindowMs) {
      return { status: 'active', reason: args.turnEnd === false ? 'tool loop' : 'recent request' };
    }
    if (elapsed <= this.idleWindowMs) return { status: 'idle', reason: 'no recent activity' };
    return { status: 'completed', reason: 'inactive' };
  }

  // ============ 定时清扫 ============

  private sweep() {
    const now = Date.now();
    let changed = false;
    this.states.forEach(st => {
      const prevStatus = st.status;
      const { status, reason } = this.inferStatus({
        lastRequestAt: st.lastRequestAt,
        lastStatusCode: st.lastStatusCode,
        inFlight: st.inFlight,
        now,
        turnEnd: st.lastTurnEnd,
      });
      if (status !== prevStatus) {
        st.status = status;
        st.statusReason = reason;
        changed = true;
        this.maybeNotifyTurnEnd(prevStatus, st);
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
      totalTokens: st.totalTokens,
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
    this.states.clear();
    this.sessionEvents.clear();
    this.globalEvents = [];
    this.removeAllListeners();
  }
}

// 全局单例（在 dbManager 就绪前 no-op；attach 后激活）
export const agentMapService = new AgentMapService();
