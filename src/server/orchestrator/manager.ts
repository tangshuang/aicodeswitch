/**
 * OrchestratorManager —— ATO 团队生命周期管理
 *
 * 职责：
 * - 创建/启动/停止团队，维护内存中的 TeamRun
 * - 持久化 .team/state.json + logs.jsonl
 * - 问题分级处理：L0 自动 / L1 倒计时自动 / L2 等待人工
 * - 维护 AppConfig.atoActiveTeamCount（配置态软锁）
 */
import fs from 'fs';
import path from 'path';
import { AgentAdapterRegistry, createDefaultRegistry, orchestratorDataDir } from './adapters';
import { TeamScheduler } from './scheduler';
import type {
  CreateTeamRequest,
  LogEntry,
  Task,
  TeamConfig,
  TeamRun,
} from './types';

const DEFAULT_CONFIG: TeamConfig = {
  maxConcurrency: 1,
  taskTimeoutMs: 5 * 60 * 1000,
  retryCount: 2,
  verificationTimeoutMs: 60 * 1000,
  failureStrategy: 'skip',
  atomicCommits: false,
  autoL0: true,
  autoL1TimeoutSeconds: 15,
  forceL2Keywords: ['删除', 'drop', 'delete', '外部API', '支付', '生产'],
};

export interface ManagerDeps {
  /** 读取/更新 AppConfig（用于软锁） */
  getConfig: () => { atoActiveTeamCount?: number };
  updateConfig: (patch: Record<string, unknown>) => void;
  /** 配置态检查（是否已被代理覆盖） */
  isConfigOverwritten: () => boolean;
}

export class OrchestratorManager {
  private teams = new Map<string, TeamRun>();
  private schedulers = new Map<string, TeamScheduler>();
  private l1Timers = new Map<string, NodeJS.Timeout>();
  readonly registry: AgentAdapterRegistry;

  constructor(private deps: ManagerDeps) {
    this.registry = createDefaultRegistry();
  }

  // ───────────────────────── 团队创建/启动 ─────────────────────────

  async createTeam(req: CreateTeamRequest): Promise<TeamRun> {
    const id = `team_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const workspacePath = path.resolve(req.workspacePath || process.cwd());

    const tasks = this.buildTasks(req);
    const results: TeamRun['results'] = {};
    for (const t of tasks) {
      results[t.id] = { taskId: t.id, status: 'pending', retryCount: 0 };
    }

    const team: TeamRun = {
      id,
      prompt: req.prompt,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'queued',
      workspacePath,
      defaultAgent: req.defaultAgent || 'claude-code',
      teamAccessKey: req.teamAccessKey,
      config: { ...DEFAULT_CONFIG, ...req.config },
      tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
      results,
      logs: [],
      pendingQuestions: [],
      decisions: [],
      tokenBudget: { spent: 0 },
    };

    // 为每个任务标记 routeId（Layer 1 task 级路由）
    if (req.routeId) {
      for (const t of tasks) {
        if (!t.routeId) t.routeId = req.routeId;
      }
    }

    fs.mkdirSync(orchestratorDataDir(workspacePath), { recursive: true });
    this.teams.set(id, team);
    this.incrementActiveCount();
    this.persist(team);
    this.log(team, 'leader', { action: 'created', description: `团队已创建（${tasks.length} 个子任务）` });

    // 异步启动调度
    void this.startScheduler(team);
    return team;
  }

  private async startScheduler(team: TeamRun): Promise<void> {
    const scheduler = new TeamScheduler(team, this.registry, {
      log: (entry) => this.appendLog(team, entry),
      persist: () => this.persist(team),
      onStatusChange: (status) => {
        if (status === 'completed' || status === 'failed' || status === 'stopped') {
          this.decrementActiveCount();
        }
      },
      isConfigOverwritten: () => this.deps.isConfigOverwritten(),
    });
    this.schedulers.set(team.id, scheduler);
    try {
      await scheduler.run();
      // run 让出后，若有待处理问题，触发分级处理
      this.maybeAutoAnswer(team);
    } catch (err) {
      team.status = 'failed';
      team.error = err instanceof Error ? err.message : String(err);
      this.log(team, 'leader', { action: 'error', description: `调度异常：${team.error}` }, undefined, undefined, 'error');
      this.decrementActiveCount();
      this.persist(team);
    }
  }

  private buildTasks(req: CreateTeamRequest): Task[] {
    if (req.tasks && req.tasks.length > 0) {
      return req.tasks.map((t, i) => ({
        id: t.id || `sub-${i + 1}`,
        description: t.description,
        dependencies: t.dependencies || [],
        expectedOutput: t.expectedOutput,
        verificationScript: t.verificationScript,
        agentTool: t.agentTool,
        routeId: t.routeId,
      }));
    }
    // 单任务模式
    return [
      {
        id: 'sub-1',
        description: req.prompt,
        dependencies: [],
        expectedOutput: req.prompt,
        verificationScript: req.verificationScript,
      },
    ];
  }

  // ───────────────────────── 查询 ─────────────────────────

  listTeams(): TeamRun[] {
    return Array.from(this.teams.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  getTeam(id: string): TeamRun | undefined {
    return this.teams.get(id);
  }

  getLogs(id: string, sinceTs = 0): LogEntry[] {
    const team = this.teams.get(id);
    if (!team) return [];
    return team.logs.filter((l) => l.ts > sinceTs);
  }

  // ───────────────────────── 控制 ─────────────────────────

  stopTeam(id: string): boolean {
    const team = this.teams.get(id);
    const scheduler = this.schedulers.get(id);
    if (!team) return false;
    scheduler?.stop();
    if (team.status === 'running' || team.status === 'awaiting-question') {
      team.status = 'stopped';
      this.decrementActiveCount();
    }
    this.clearL1Timer(id);
    this.log(team, 'leader', { action: 'stopped', description: '团队已停止' }, undefined, undefined, 'status');
    this.persist(team);
    return true;
  }

  async answerQuestion(teamId: string, questionId: string, choice: string, decidedBy: 'user' | 'leader' = 'user'): Promise<boolean> {
    const team = this.teams.get(teamId);
    if (!team) return false;
    const idx = team.pendingQuestions.findIndex((q) => q.id === questionId);
    if (idx === -1) return false;
    const q = team.pendingQuestions.splice(idx, 1)[0];
    const decision = {
      questionId: q.id,
      taskId: q.taskId,
      level: q.level,
      text: q.text,
      choice,
      decidedBy,
      decidedAt: Date.now(),
    };
    team.decisions.push(decision);
    // 把对应任务从 awaiting-question 恢复为 pending
    const r = team.results[q.taskId];
    if (r && r.status === 'awaiting-question') r.status = 'pending';
    this.log(team, 'leader', { action: 'answer', questionId: q.id, choice, decidedBy }, undefined, q.taskId, 'answer');
    this.clearL1Timer(teamId);
    this.persist(team);

    // 没有待处理问题后，恢复调度
    if (team.pendingQuestions.length === 0 && team.status === 'awaiting-question') {
      const scheduler = this.schedulers.get(teamId);
      if (scheduler) void scheduler.resume().then(() => this.maybeAutoAnswer(team));
    }
    return true;
  }

  /** L0 自动 + L1 倒计时自动 */
  private maybeAutoAnswer(team: TeamRun): void {
    for (const q of [...team.pendingQuestions]) {
      if (q.level === 'L0' && team.config.autoL0) {
        const choice = q.options[0] || 'auto';
        void this.answerQuestion(team.id, q.id, choice, 'leader');
      } else if (q.level === 'L1' && team.config.autoL1TimeoutSeconds > 0 && !this.l1Timers.has(q.id)) {
        const autoAdoptAt = Date.now() + team.config.autoL1TimeoutSeconds * 1000;
        q.autoAdoptAt = autoAdoptAt;
        const timer = setTimeout(() => {
          this.l1Timers.delete(q.id);
          const suggestion = q.options[0] || 'auto';
          void this.answerQuestion(team.id, q.id, suggestion, 'leader');
        }, team.config.autoL1TimeoutSeconds * 1000);
        this.l1Timers.set(q.id, timer);
      }
    }
    this.persist(team);
  }

  private clearL1Timer(teamId: string): void {
    const team = this.teams.get(teamId);
    if (!team) return;
    // 清理属于该团队的 L1 计时器
    for (const q of team.pendingQuestions) {
      const t = this.l1Timers.get(q.id);
      if (t) {
        clearTimeout(t);
        this.l1Timers.delete(q.id);
      }
    }
  }

  // ───────────────────────── 适配器健康检查 ─────────────────────────

  async checkAdapters(): Promise<Record<string, boolean>> {
    return this.registry.checkAll();
  }

  // ───────────────────────── 软锁维护 ─────────────────────────

  private incrementActiveCount(): void {
    const cur = this.deps.getConfig().atoActiveTeamCount || 0;
    this.deps.updateConfig({ atoActiveTeamCount: cur + 1 });
  }

  private decrementActiveCount(): void {
    const cur = this.deps.getConfig().atoActiveTeamCount || 0;
    this.deps.updateConfig({ atoActiveTeamCount: Math.max(0, cur - 1) });
  }

  /** 团队运行中时，restore 配置应被拒绝（软锁） */
  isConfigLocked(): boolean {
    return (this.deps.getConfig().atoActiveTeamCount || 0) > 0;
  }

  // ───────────────────────── 持久化 ─────────────────────────

  shutdownAll(): void {
    for (const [id, scheduler] of this.schedulers) {
      scheduler.stop();
      const team = this.teams.get(id);
      if (team && (team.status === 'running' || team.status === 'awaiting-question')) {
        team.status = 'stopped';
      }
    }
    this.l1Timers.forEach((t) => clearTimeout(t));
    this.l1Timers.clear();
    this.teams.forEach((t) => this.persist(t));
  }

  private appendLog(team: TeamRun, entry: LogEntry): void {
    // 内存中已由 scheduler 推入 team.logs，这里只做持久化追加
    try {
      const logsFile = path.join(orchestratorDataDir(team.workspacePath), 'logs.jsonl');
      fs.appendFileSync(logsFile, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      /* ignore */
    }
  }

  private log(team: TeamRun, agentId: string, content: unknown, agentTool?: string, taskId?: string, type: LogEntry['type'] = 'status'): void {
    const entry: LogEntry = { ts: Date.now(), agentId, agentTool, taskId, type, content };
    team.logs.push(entry);
    this.appendLog(team, entry);
  }

  private persist(team: TeamRun): void {
    try {
      const dir = orchestratorDataDir(team.workspacePath);
      fs.mkdirSync(dir, { recursive: true });
      const { _scheduler, ...serializable } = team;
      void _scheduler;
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(serializable, null, 2), 'utf-8');
    } catch {
      /* ignore */
    }
  }
}
