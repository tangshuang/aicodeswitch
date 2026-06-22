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
  SessionMapItem,
  SessionStatus,
  ToolType,
} from '../../types';
import { deriveLastActivity, extractActivityEvents, type ExtractInput } from './activity-extractor';
import { resolveSessionMeta } from './session-meta';

type DbManagerLike = {
  getSessions?: (targetType?: ToolType, limit?: number, offset?: number) => Promise<any[]>;
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

export class AgentMapService extends EventEmitter {
  private db: DbManagerLike | null = null;
  private states = new Map<string, RuntimeState>();
  private sessionEvents = new Map<string, ActivityEvent[]>();
  private globalEvents: ActivityEvent[] = [];
  private sweepTimer: NodeJS.Timeout | null = null;

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
    } catch (err) {
      console.error('[AgentMap] seedFromDb error:', err);
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
    // 去重：若本轮首个 prompt 与该会话上一条已记录的 prompt 文本相同，则丢弃该 prompt
    // （防止重发 / 重试等同一条提问在活动流/路径里重复）
    const prev = this.sessionEvents.get(ctx.sessionId);
    const lastRecorded = prev && prev.length ? prev[prev.length - 1] : null;
    const events = (lastRecorded && lastRecorded.kind === 'prompt'
      && rawEvents.length > 0 && rawEvents[0].kind === 'prompt'
      && rawEvents[0].summary === lastRecorded.summary)
      ? rawEvents.slice(1)
      : rawEvents;
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
    st.lastRequestAt = ctx.timestamp;
    st.requestCount += 1;
    if (ctx.tokensDelta) st.totalTokens += ctx.tokensDelta;
    if (ctx.model) st.lastModel = ctx.model;
    if (ctx.statusCode != null) st.lastStatusCode = ctx.statusCode;
    if (summary) st.lastActivitySummary = summary;
    if (toolName) st.lastToolName = toolName;

    // 重算状态（onFinalized 时请求已结束，inFlight 会被 endRequest 减，但可能尚未调用）
    const { status, reason } = this.inferStatus({
      lastRequestAt: st.lastRequestAt,
      lastStatusCode: st.lastStatusCode,
      inFlight: st.inFlight,
      now,
    });
    st.status = status;
    st.statusReason = reason;

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

  private inferStatus(args: { lastRequestAt: number; lastStatusCode?: number; inFlight: number; now: number }): { status: SessionStatus; reason: string } {
    // 在途请求 → active
    if (args.inFlight > 0) return { status: 'active', reason: 'in-flight' };
    // 末次失败 → error（即使时间较近也标 error，下一次成功会刷回 active）
    if (args.lastStatusCode != null && args.lastStatusCode >= 500) {
      return { status: 'error', reason: `upstream ${args.lastStatusCode}` };
    }
    const elapsed = args.now - args.lastRequestAt;
    if (elapsed <= this.activeWindowMs) return { status: 'active', reason: 'recent request' };
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
      });
      if (status !== prevStatus) {
        st.status = status;
        st.statusReason = reason;
        changed = true;
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

  getSessionEvents(sessionId: string, since?: number): ActivityEvent[] {
    const arr = this.sessionEvents.get(sessionId) || [];
    if (since == null) return arr.slice(-MAX_EVENTS_PER_SESSION);
    return arr.filter(e => e.ts > since);
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
