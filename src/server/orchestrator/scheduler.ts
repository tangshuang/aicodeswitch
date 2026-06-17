/**
 * Ralph Loop 调度器
 *
 * 每轮：选一个就绪任务（依赖已满足）→ spawn 全新子 Agent → 退出后：
 *   - 若留下未决 «ATO_QUESTION»：上抛问题，等待答案后重 spawn（问答分支）
 *   - 否则执行验证脚本：通过则完成（可选原子提交），失败则重试/失败策略
 */
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { AgentAdapterRegistry } from './adapters';
import type {
  AgentAdapter,
  LogEntry,
  Task,
  TaskResult,
  TeamRun,
} from './types';
import { orchestratorDataDir } from './adapters';

export interface SchedulerCallbacks {
  log: (entry: LogEntry) => void;
  persist: () => void;
  /** 通知 manager 团队状态变化（用于 atoActiveTeamCount 维护等） */
  onStatusChange: (status: TeamRun['status']) => void;
  /** 获取配置态（是否已被代理覆盖） */
  isConfigOverwritten: () => boolean;
}

export class TeamScheduler {
  private stopped = false;
  private currentKill: (() => void) | null = null;

  constructor(
    private team: TeamRun,
    private registry: AgentAdapterRegistry,
    private cb: SchedulerCallbacks
  ) {}

  /** 主循环：运行到完成、失败、停止、或遇到未决问题（返回让出控制权） */
  async run(): Promise<void> {
    this.markStatus('running');
    this.log('leader', { action: 'started', description: '开始执行团队任务' });

    while (!this.stopped) {
      const ready = this.selectNextTask();

      if (!ready) {
        if (this.allTasksTerminal()) {
          // 全部结束
          const hasFailed = Object.values(this.team.results).some((r) => r.status === 'failed');
          this.markStatus(hasFailed ? 'failed' : 'completed');
          this.log('leader', {
            action: 'finished',
            description: hasFailed ? '团队任务结束（存在失败）' : '团队任务全部完成',
          });
          return;
        }
        // 存在未完成的任务但没有就绪的（可能在等问答/运行中）→ 让出
        return;
      }

      // spawn 前配置态自检
      if (!this.cb.isConfigOverwritten()) {
        this.log('leader', {
          action: 'warn',
          description: '配置未被代理覆盖，子 Agent 可能无法走代理。建议先激活路由。',
        });
      }

      // Token 预算检查（团队级）
      const budget = this.team.tokenBudget;
      if (budget.total && budget.spent >= budget.total) {
        this.log('leader', { action: 'budget-exhausted', description: 'Token 预算耗尽，停止启动新任务' });
        this.markStatus('failed');
        this.team.error = 'Token 预算耗尽';
        return;
      }

      const exitState = await this.runOneTask(ready);
      this.cb.persist();
      if (exitState === 'awaiting-question') {
        // 让出控制权，等待 manager 在答案到达后再次调用 run()
        this.markStatus('awaiting-question');
        return;
      }
      if (exitState === 'stopped') {
        return;
      }
    }

    if (this.stopped) this.markStatus('stopped');
  }

  /** 停止调度（外部调用） */
  stop(): void {
    this.stopped = true;
    if (this.currentKill) this.currentKill();
  }

  /** 答案注入后恢复运行（manager 调用） */
  async resume(): Promise<void> {
    // run() 会重新选中处于 pending 的任务
    await this.run();
  }

  // ───────────────────────── 单任务执行 ─────────────────────────

  private async runOneTask(task: Task): Promise<'continue' | 'awaiting-question' | 'stopped'> {
    const result = this.ensureResult(task.id);
    result.status = 'running';
    result.startedAt = Date.now();
    this.team.updatedAt = Date.now();

    const adapter = this.resolveAdapter(task);
    this.log(task.id, { action: 'started', description: `开始执行（工具：${adapter.name}${task.routeId ? '，路由：' + task.routeId : ''}）` }, adapter.name, task.id);

    const deps = task.dependencies.map((id) => this.ensureResult(id));
    const decisions = this.team.decisions.filter((d) => d.taskId === task.id);

    // 生成上下文文件
    const teamDir = orchestratorDataDir(this.team.workspacePath);
    const taskDir = path.join(teamDir, 'tasks', task.id);
    fs.mkdirSync(taskDir, { recursive: true });
    const contextPath = path.join(taskDir, 'context.md');
    const contextContent = adapter.generateContext(task, deps, decisions);
    fs.writeFileSync(contextPath, contextContent, 'utf-8');

    // spawn 子 Agent
    const env: Record<string, string> = {};
    // 通过自定义 header 实现 task 归因（claude 会在请求里带上自定义 env? 否）。
    // 这里通过团队 AccessKey 复用配额/统计；header 归因依赖代理侧 x-ato-task-id（见 proxy-server 改动）。
    if (this.team.teamAccessKey) {
      env.ANTHROPIC_AUTH_TOKEN = this.team.teamAccessKey;
    }
    // 让子 Agent 携带 task 标识（代理 finalizeLog 会读取 x-ato-task-id；此处尽力注入）
    env.ATO_TASK_ID = task.id;

    const runResult = await adapter.spawn({
      taskId: task.id,
      teamId: this.team.id,
      contextFilePath: contextPath,
      workspacePath: this.team.workspacePath,
      env,
      timeoutMs: this.team.config.taskTimeoutMs,
    });

    result.tokensEstimate = (result.tokensEstimate || 0) + runResult.estimatedTokens;
    this.team.tokenBudget.spent = this.team.tokenBudget.spent + runResult.estimatedTokens;
    result.lastStdoutTail = runResult.stdout.slice(-2000);

    if (this.stopped) return 'stopped';

    if (runResult.timedOut) {
      result.error = '任务超时';
      return this.handleFailure(task, result, '任务超时');
    }

    // 问答分支：检测未决问题
    const questions = adapter.parseQuestions(runResult.stdout);
    if (questions.length > 0) {
      result.status = 'awaiting-question';
      for (const q of questions) {
        this.team.pendingQuestions.push({
          id: q.id,
          taskId: task.id,
          level: q.level,
          text: q.text,
          options: q.options,
          createdAt: Date.now(),
        });
        this.log(task.id, { action: 'question', id: q.id, level: q.level, text: q.text, options: q.options }, adapter.name, task.id, 'question');
      }
      this.cb.persist();
      return 'awaiting-question';
    }

    // 正常分支：执行验证脚本
    return this.verify(task, result);
  }

  private async verify(task: Task, result: TaskResult): Promise<'continue' | 'stopped'> {
    const script = task.verificationScript;
    if (!script) {
      this.log(task.id, { action: 'warn', description: '未配置验证脚本，默认视为完成（不推荐）' }, undefined, task.id, 'verification');
      return this.handleSuccess(task, result, '(无验证脚本)');
    }

    this.log(task.id, { action: 'verifying', description: `执行验证：${script}` }, undefined, task.id, 'verification');
    const vres = await this.runScript(script, this.team.config.verificationTimeoutMs);
    if (vres.timedOut) {
      return this.handleFailure(task, result, '验证脚本超时');
    }
    if (vres.code === 0) {
      this.log(task.id, { action: 'verified', description: '验证通过 ✅', stdout: (vres.stdout || '').slice(0, 500) }, undefined, task.id, 'verification');
      return this.handleSuccess(task, result, '验证通过');
    }
    this.log(task.id, { action: 'verify-failed', description: `验证失败（exit ${vres.code}）`, stderr: (vres.stderr || '').slice(0, 500) }, undefined, task.id, 'verification');
    return this.handleFailure(task, result, `验证失败（exit ${vres.code}）`);
  }

  private handleSuccess(task: Task, result: TaskResult, summary: string): 'continue' {
    result.status = 'completed';
    result.summary = summary;
    result.completedAt = Date.now();
    this.log(task.id, { action: 'completed', description: `✅ 完成：${summary}` }, undefined, task.id, 'result');
    if (this.team.config.atomicCommits) {
      this.gitCommit(task, true);
    }
    return 'continue';
  }

  private handleFailure(task: Task, result: TaskResult, reason: string): 'continue' | 'stopped' {
    result.error = reason;
    result.retryCount += 1;
    if (result.retryCount > this.team.config.retryCount) {
      result.status = 'failed';
      this.log(task.id, { action: 'failed', description: `❌ 失败：${reason}（已用尽重试）` }, undefined, task.id, 'error');
      if (this.team.config.atomicCommits) this.gitCommit(task, false);
      const strat = this.team.config.failureStrategy;
      if (strat === 'abort') {
        this.stopped = true;
        this.team.error = `任务 ${task.id} 失败，策略 abort`;
        this.markStatus('failed');
      } else if (strat === 'skip') {
        this.skipDownstream(task.id);
      }
      // replan: 留待后续（标记失败，不级联）
      return this.stopped ? 'stopped' : 'continue';
    }
    // 重新排队
    result.status = 'pending';
    this.log(task.id, { action: 'retry', description: `🔄 重试 (${result.retryCount}/${this.team.config.retryCount})：${reason}` }, undefined, task.id, 'status');
    return 'continue';
  }

  private skipDownstream(taskId: string): void {
    for (const t of Object.values(this.team.tasks)) {
      if (t.dependencies.includes(taskId)) {
        const r = this.ensureResult(t.id);
        r.status = 'skipped';
        this.log(t.id, { action: 'skipped', description: `因上游 ${taskId} 失败而跳过` }, undefined, t.id, 'status');
      }
    }
  }

  // ───────────────────────── 工具方法 ─────────────────────────

  private resolveAdapter(task: Task): AgentAdapter {
    return this.registry.resolve(task.agentTool, this.team.defaultAgent);
  }

  private selectNextTask(): Task | null {
    const ids = Object.keys(this.team.tasks);
    for (const id of ids) {
      const r = this.ensureResult(id);
      if (r.status !== 'pending') continue;
      const task = this.team.tasks[id];
      const depsOk = task.dependencies.every((dep) => {
        const dr = this.team.results[dep];
        return dr && dr.status === 'completed';
      });
      if (depsOk) return task;
    }
    return null;
  }

  private allTasksTerminal(): boolean {
    return Object.keys(this.team.tasks).every((id) => {
      const s = this.ensureResult(id).status;
      return s === 'completed' || s === 'failed' || s === 'skipped';
    });
  }

  private ensureResult(taskId: string): TaskResult {
    if (!this.team.results[taskId]) {
      this.team.results[taskId] = { taskId, status: 'pending', retryCount: 0 };
    }
    return this.team.results[taskId];
  }

  private runScript(script: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      exec(script, { cwd: this.team.workspacePath, timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
        const timedOut = !!err && (err as any).killed === true && (err as any).signal === 'SIGTERM';
        resolve({ code: err ? (err as any).code ?? 1 : 0, stdout: stdout || '', stderr: stderr || '', timedOut });
      });
    });
  }

  private gitCommit(_task: Task, success: boolean): void {
    const cwd = this.team.workspacePath;
    try {
      if (success) {
        exec('git add -A && git commit -m "✅ ato: task completed" --allow-empty', { cwd, timeout: 15000 });
      } else {
        // 失败：重置到任务起点（不留脏 commit）。简化为对未提交改动做 stash 风格的 reset
        exec('git reset --hard HEAD', { cwd, timeout: 15000 });
      }
    } catch {
      /* git 不可用或非 git 仓库，忽略 */
    }
  }

  private markStatus(status: TeamRun['status']): void {
    this.team.status = status;
    this.team.updatedAt = Date.now();
    this.cb.onStatusChange(status);
    this.cb.persist();
  }

  private log(agentId: string, content: unknown, agentTool?: string, taskId?: string, type: LogEntry['type'] = 'status'): void {
    const entry: LogEntry = { ts: Date.now(), agentId, agentTool, taskId, type, content };
    this.team.logs.push(entry);
    if (this.team.logs.length > 2000) this.team.logs = this.team.logs.slice(-1500);
    this.cb.log(entry);
  }
}
