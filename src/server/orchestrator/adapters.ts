/**
 * Agent 适配器实现 + 注册表
 *
 * v4 PRD 关键点：问答统一走 stdout 协议（«ATO_QUESTION»），不再依赖 stdin 拦截。
 * 因此 claude-code（stream-json）与 codex（纯文本）共用同一套问题解析逻辑。
 */
import { spawn, spawnSync } from 'child_process';
import path from 'path';
import { resolveCli, isCliAvailable } from './cli-resolver';
import fs from 'fs';
import type {
  AgentAdapter,
  AgentAdapterFeatures,
  AgentRunResult,
  Decision,
  ParsedQuestion,
  SpawnOptions,
  Task,
  TaskResult,
  QuestionLevel,
} from './types';

/** stdout 协议问题标记：«ATO_QUESTION»{json}«/ATO_QUESTION» */
const QUESTION_OPEN = '«ATO_QUESTION»';
const QUESTION_CLOSE = '«/ATO_QUESTION»';

/** 从任意文本（stream-json 拼接或纯文本）中提取 «ATO_QUESTION» 块 */
export function extractQuestionBlocks(text: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  while (true) {
    const start = text.indexOf(QUESTION_OPEN, cursor);
    if (start === -1) break;
    const end = text.indexOf(QUESTION_CLOSE, start + QUESTION_OPEN.length);
    if (end === -1) break;
    blocks.push(text.slice(start + QUESTION_OPEN.length, end).trim());
    cursor = end + QUESTION_CLOSE.length;
  }
  return blocks;
}

/** 解析问题块为结构化 ParsedQuestion */
export function parseQuestionBlocks(text: string): ParsedQuestion[] {
  const out: ParsedQuestion[] = [];
  for (const block of extractQuestionBlocks(text)) {
    let parsed: any = null;
    try {
      parsed = JSON.parse(block);
    } catch {
      // 非 JSON，尝试提取文本
      out.push({
        id: `q-${Date.now()}-${out.length}`,
        level: inferLevel(parsed?.text || block),
        text: block.slice(0, 500),
        options: [],
      });
      continue;
    }
    out.push({
      id: String(parsed.id || `q-${Date.now()}-${out.length}`),
      level: inferLevel(parsed.text, parsed.level),
      text: String(parsed.text || parsed.question || '未命名问题'),
      options: Array.isArray(parsed.options) ? parsed.options.map(String) : [],
    });
  }
  return out;
}

/** 问题分级推断（默认 L1，命中高风险关键词升 L2） */
function inferLevel(text: string | undefined, explicit?: string): QuestionLevel {
  if (explicit === 'L0' || explicit === 'L1' || explicit === 'L2') return explicit;
  const t = (text || '').toLowerCase();
  if (/删除|drop|delete|rm -rf|外部\s*api|支付|生产|线上|production/.test(t)) return 'L2';
  if (/格式|命名|tab|空格|缩进|prefix/.test(t)) return 'L0';
  return 'L1';
}

/**
 * 运行子进程并收集输出，带超时与强杀。
 * stdio: stdin 用 pipe（可写入），stdout/stderr 用 pipe 收集。
 */
function runProcess(
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs?: number; stdinInput?: string }
): Promise<AgentRunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;

    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const finish = (exitCode: number) => {
      if (timer) clearTimeout(timer);
      const combined = stdout + stderr;
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
        // 粗略 token 估算：输入 + 输出字符数 / 4
        estimatedTokens: Math.ceil(((opts.stdinInput?.length || 0) + combined.length) / 4),
      });
    };

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform === 'win32') {
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
          } else {
            process.kill(child.pid!, 'SIGKILL');
          }
        } catch {
          /* ignore */
        }
      }, opts.timeoutMs);
    }

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(code ?? -1));

    // 写入 stdin（上下文）
    try {
      if (opts.stdinInput !== undefined) {
        child.stdin.write(opts.stdinInput);
      }
      child.stdin.end();
    } catch {
      /* ignore */
    }
  });
}

/** 生成 context.md 的公共段落（依赖产出 + 历史决策） */
function buildCommonSections(task: Task, deps: TaskResult[], decisions: Decision[]): string {
  let ctx = '';

  const taskDecisions = decisions.filter((d) => d.taskId === task.id);
  if (taskDecisions.length > 0) {
    ctx += `## Prior Decisions（来自此 task 之前的问答轮次）\n`;
    for (const d of taskDecisions) {
      ctx += `- [${d.questionId} ${d.level}] "${d.text}" → 决策：${d.choice}（决策者：${d.decidedBy}）\n`;
    }
    ctx += `\n`;
  }

  const completedDeps = deps.filter((d) => d.status === 'completed');
  if (completedDeps.length > 0) {
    ctx += `## Dependencies Completed\n`;
    for (const d of completedDeps) {
      ctx += `- **${d.taskId}**: ${d.summary || '(无摘要)'}\n`;
      if (d.artifacts && d.artifacts.length > 0) {
        ctx += `  - Artifacts: ${d.artifacts.join(', ')}\n`;
      }
    }
    ctx += `\n`;
  }

  ctx += `## Your Goal\n${task.expectedOutput || task.description}\n\n`;

  if (task.verificationScript) {
    ctx += `## Verification\n你的产出将被以下脚本验证（exit 0 才算完成）：\n\`\`\`\n${task.verificationScript}\n\`\`\`\n\n`;
  }

  ctx += `## Routing Hint\n如遇难题可在消息开头用 [!] 前缀临时切换到强模型规则，用 [x] 取消。\n\n`;

  ctx += `## Question Protocol\n当你需要外部决策时，输出一行如下标记（JSON 体含 level/id/text/options），然后立即结束本次运行，不要自行猜测继续：\n${QUESTION_OPEN}{"id":"q-<n>","level":"L0|L1|L2","text":"问题","options":["A","B"]}${QUESTION_CLOSE}\n`;

  return ctx;
}

/** 健康检查：跨平台 CLI 可用性（Windows 下自动解析 .cmd shim） */

// ───────────────────────── Claude Code 适配器 ─────────────────────────

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = 'claude-code';
  readonly features: AgentAdapterFeatures = {
    streamJson: true,
    contextFile: true,
    workspaceIsolation: true,
    stdoutProtocol: true,
  };

  async spawn(opts: SpawnOptions): Promise<AgentRunResult> {
    // claude --print 读取 stdin 作为 prompt，输出 stream-json
    const env = { ...process.env, ...opts.env } as Record<string, string>;
    const stdinInput = await fs.promises.readFile(opts.contextFilePath, 'utf-8').catch(() => '');
    // --print + --output-format stream-json 必须搭配 --verbose（否则 claude 直接 exit 1）
    const args = ['--print', '--output-format', 'stream-json', '--verbose'];
    const resolved = resolveCli('claude');
    return runProcess(
      resolved.command,
      [...resolved.prependArgs, ...args],
      { cwd: opts.workspacePath, env, timeoutMs: opts.timeoutMs, stdinInput }
    );
  }

  generateContext(task: Task, deps: TaskResult[], decisions: Decision[]): string {
    return `# Task: ${task.description}\n\n` + buildCommonSections(task, deps, decisions);
  }

  parseQuestions(stdout: string): ParsedQuestion[] {
    return parseQuestionBlocks(stdout);
  }

  async checkHealth(): Promise<boolean> {
    return isCliAvailable('claude');
  }
}

// ───────────────────────── Codex 适配器 ─────────────────────────

export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex';
  readonly features: AgentAdapterFeatures = {
    streamJson: false,
    contextFile: true,
    workspaceIsolation: true,
    stdoutProtocol: true,
  };

  async spawn(opts: SpawnOptions): Promise<AgentRunResult> {
    // codex exec 读取 stdin 作为 prompt（非交互）
    const env = { ...process.env, ...opts.env } as Record<string, string>;
    const stdinInput = await fs.promises.readFile(opts.contextFilePath, 'utf-8').catch(() => '');
    const resolved = resolveCli('codex');
    return runProcess(
      resolved.command,
      [...resolved.prependArgs, 'exec'],
      { cwd: opts.workspacePath, env, timeoutMs: opts.timeoutMs, stdinInput }
    );
  }

  generateContext(task: Task, deps: TaskResult[], decisions: Decision[]): string {
    return `Task: ${task.description}\n\n` + buildCommonSections(task, deps, decisions);
  }

  parseQuestions(stdout: string): ParsedQuestion[] {
    return parseQuestionBlocks(stdout);
  }

  async checkHealth(): Promise<boolean> {
    return isCliAvailable('codex');
  }
}

// ───────────────────────── 适配器注册表 ─────────────────────────

export class AgentAdapterRegistry {
  private adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name);
  }

  /** 取适配器，找不到则回退到 defaultName */
  resolve(name: string | undefined, defaultName: string): AgentAdapter {
    return this.adapters.get(name || '') || this.adapters.get(defaultName) || this.first();
  }

  first(): AgentAdapter {
    return Array.from(this.adapters.values())[0];
  }

  list(): AgentAdapter[] {
    return Array.from(this.adapters.values());
  }

  async checkAll(): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const [name, adapter] of this.adapters) {
      out[name] = await adapter.checkHealth();
    }
    return out;
  }
}

export function createDefaultRegistry(): AgentAdapterRegistry {
  const registry = new AgentAdapterRegistry();
  registry.register(new ClaudeCodeAdapter());
  registry.register(new CodexAdapter());
  return registry;
}

export const orchestratorDataDir = (workspacePath: string) => path.join(workspacePath, '.team');
