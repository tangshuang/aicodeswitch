/**
 * PermissionJudge —— 裁决 Claude Code 的权限请求
 *
 * 流程：硬规则（allow/deny）→ 否则 LLM 危险度分析 → 策略（low 放行 / high 拒绝+建议 / medium 自动或上抛人类）。
 * LLM 分析经本机代理打一次上游调用（raw HTTP，不走 claude CLI，不触发权限递归）。
 * 上抛人类时登记 pending，同步阻塞等待 UI resolve（10 min 兜底超时→拒绝）。
 */
import { EventEmitter } from 'events';
import { loadLeaderConfig, saveLeaderConfig } from './memory';

export interface PermissionRequest {
  toolName: string;
  input: any;
}

export interface PermissionResult {
  behavior: 'allow' | 'deny';
  updatedInput?: any;
  message?: string;
  risk: 'low' | 'medium' | 'high' | 'rule';
  reason?: string;
}

export interface PermissionConfig {
  enabled: boolean;
  allowPatterns: string[]; // 正则字符串，命中→放行
  denyPatterns: string[]; // 正则字符串，命中→拒绝
  humanGateMedium: boolean; // medium 是否上抛人类（默认 false：自动放行）
  humanGateHigh: boolean; // high 是否上抛人类（默认 false：自动拒绝）
}

export interface PendingPermission {
  id: string;
  toolName: string;
  input: any;
  risk: 'low' | 'medium' | 'high';
  reason?: string;
  createdAt: number;
}

const DEFAULT_DENY = [
  'rm\\s+-rf\\s+/(\\s|$)', // rm -rf /
  'rm\\s+-rf\\s+~',
  ':\\(\\)\\s*\\{.*\\}', // fork bomb
  'mkfs',
  'dd\\s+if=.*of=/dev/',
  'git\\s+push.*--force',
  'git\\s+push.*-f\\b',
  'drop\\s+(table|database)',
  'truncate\\s+table',
  'curl\\s+.*\\|\\s*(sh|bash)',
  'wget\\s+.*\\|\\s*(sh|bash)',
  'chmod\\s+-R\\s+777\\s+/',
];

const DEFAULT_ALLOW = [
  '^ls(\\s|$)',
  '^cat\\s',
  '^grep\\s',
  '^rg\\s',
  '^find\\s',
  '^head\\s',
  '^tail\\s',
  '^wc\\s',
  '^git\\s+(status|diff|log|show|branch)',
  '^npm\\s+(test|run\\s+test|run\\s+build|run\\s+lint|install|run|ls)',
  '^yarn\\s+(test|build|lint|install)',
  '^npx\\s+',
  '^node\\s+-e\\s+',
  '^pwd',
  '^echo\\s',
  '^npm\\s+run\\s',
];

export function loadPermissionConfig(): PermissionConfig {
  const raw = loadLeaderConfig() as any;
  const p = raw.permission;
  return {
    enabled: p?.enabled !== false,
    allowPatterns: p?.allowPatterns ?? DEFAULT_ALLOW,
    denyPatterns: p?.denyPatterns ?? DEFAULT_DENY,
    humanGateMedium: p?.humanGateMedium === true,
    humanGateHigh: p?.humanGateHigh === true,
  };
}

export function savePermissionConfig(patch: Partial<PermissionConfig>): PermissionConfig {
  const cur = loadLeaderConfig() as any;
  const merged: PermissionConfig = { ...loadPermissionConfig(), ...patch };
  saveLeaderConfig({ leaderTool: cur.leaderTool, permission: merged } as any);
  return merged;
}

export class PermissionJudge extends EventEmitter {
  private pending = new Map<string, { resolve: (r: PermissionResult) => void; req: PendingPermission; timer: NodeJS.Timeout }>();

  constructor(private proxyBase: string) {
    super();
  }

  listPending(): PendingPermission[] {
    return Array.from(this.pending.values()).map((p) => p.req);
  }

  resolve(id: string, behavior: 'allow' | 'deny', message?: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    const result: PermissionResult = {
      behavior,
      message,
      risk: entry.req.risk,
      reason: message || (behavior === 'allow' ? '人类放行' : '人类拒绝'),
    };
    this.emit('event', { kind: 'resolved', id, behavior, message });
    entry.resolve(result);
    return true;
  }

  async evaluate(req: PermissionRequest): Promise<PermissionResult> {
    const cfg = loadPermissionConfig();
    const text = this.extractText(req);
    const ctx = { toolName: req.toolName, input: req.input, text };

    // 1) 硬规则
    for (const pat of cfg.denyPatterns) {
      try {
        if (new RegExp(pat, 'i').test(text)) {
          return this.decide(req, 'rule', 'deny', `命中禁止规则：${pat}`);
        }
      } catch { /* ignore bad regex */ }
    }
    for (const pat of cfg.allowPatterns) {
      try {
        if (new RegExp(pat, 'i').test(text)) {
          return this.decide(req, 'rule', 'allow', `命中放行规则：${pat}`);
        }
      } catch { /* ignore */ }
    }
    // 写操作若在 workspace 之外 → 拒绝（基础护栏，workspace 由调用方 env 提供，此处仅做路径绝对性提示）
    if (!text && req.toolName !== 'Bash') {
      // 无文本可判（如纯结构化工具），默认 low 放行
      return this.decide(req, 'rule', 'allow', '只读/结构化工具默认放行');
    }

    // 2) LLM 危险度分析
    let risk: 'low' | 'medium' | 'high' = 'medium';
    let reason = '';
    let alternative = '';
    try {
      const analysis = await this.llmJudge(ctx, cfg);
      risk = analysis.risk;
      reason = analysis.reason || '';
      alternative = analysis.alternative || '';
    } catch (e) {
      reason = `LLM 分析失败：${e instanceof Error ? e.message : String(e)}`;
      risk = 'medium';
    }

    // 3) 策略
    if (risk === 'low') {
      return this.decide(req, risk, 'allow', reason || '低风险');
    }
    if (risk === 'high') {
      if (cfg.humanGateHigh) {
        return this.askHuman(req, risk, reason);
      }
      const msg = alternative ? `高风险，已拒绝。建议：${alternative}` : `高风险，已拒绝。${reason}`;
      return this.decide(req, risk, 'deny', msg);
    }
    // medium
    if (cfg.humanGateMedium) {
      return this.askHuman(req, risk, reason);
    }
    return this.decide(req, risk, 'allow', `中等风险，自动放行。${reason}`);
  }

  private decide(req: PermissionRequest, risk: PermissionResult['risk'], behavior: 'allow' | 'deny', reason: string): PermissionResult {
    const result: PermissionResult = { behavior, risk, reason };
    this.emit('event', { kind: 'decision', toolName: req.toolName, input: req.input, risk, behavior, reason });
    return result;
  }

  private askHuman(req: PermissionRequest, risk: 'medium' | 'high', reason?: string): Promise<PermissionResult> {
    const id = `perm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const pending: PendingPermission = {
      id,
      toolName: req.toolName,
      input: req.input,
      risk,
      reason,
      createdAt: Date.now(),
    };
    this.emit('event', { kind: 'pending', pending });
    return new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.emit('event', { kind: 'resolved', id, behavior: 'deny', message: '人类确认超时，自动拒绝' });
        resolve({ behavior: 'deny', risk, reason: '人类确认超时，自动拒绝' });
      }, 4 * 60 * 1000);
      this.pending.set(id, { resolve, req: pending, timer });
    });
  }

  private extractText(req: PermissionRequest): string {
    const i = req.input || {};
    if (typeof i === 'string') return i;
    if (typeof i.command === 'string') return i.command;
    if (typeof i.file_path === 'string') return `${req.toolName} ${i.file_path}`;
    if (typeof i.path === 'string') return `${req.toolName} ${i.path}`;
    try {
      return JSON.stringify(i);
    } catch {
      return '';
    }
  }

  /** 经本机代理打一次上游 LLM 调用做危险度分析（raw HTTP） */
  private async llmJudge(
    ctx: { toolName: string; input: any; text: string },
    _cfg: PermissionConfig
  ): Promise<{ risk: 'low' | 'medium' | 'high'; reason?: string; alternative?: string }> {
    const prompt = `你是权限安全裁决器。判断下面这个工具调用对一个本地开发环境来说的危险程度。
工具：${ctx.toolName}
参数：${ctx.text}

只输出一行 JSON，字段：risk(low|medium|high)、reason(简短中文)、alternative(若高风险，给出更安全的替代做法，没有则空字符串)。
判定准则：只读/查询/本地构建测试=low；会修改文件/安装依赖/一般写操作=medium；删除、强制推送、网络下载执行、破坏性 shell、写系统目录=high。`;

    const body = {
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = process.env.ATO_TOKEN;
    if (token) headers['Access-Token'] = token;

    const res = await fetch(`${this.proxyBase}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`judge proxy HTTP ${res.status}`);
    }
    const data: any = await res.json();
    const text = Array.isArray(data?.content)
      ? data.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('')
      : '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('judge 未返回 JSON');
    const parsed = JSON.parse(match[0]);
    const risk = parsed.risk === 'low' || parsed.risk === 'high' ? parsed.risk : 'medium';
    return { risk, reason: parsed.reason, alternative: parsed.alternative };
  }
}
