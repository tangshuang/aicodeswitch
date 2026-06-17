/**
 * 流式 Claude Code 运行器
 *
 * spawn `claude --print --output-format stream-json`，逐行解析事件，
 * 增量回调 onText/onTool，结束时 onDone(fullText)。
 *
 * 注意：stream-json 事件结构以真实环境为准；这里用「按 text 快照做后缀 diff」
 * 的方式提取增量，兼容快照式与增量式两种事件。
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { loadPermissionConfig } from './permission';

export interface ToolEvent {
  kind: 'tool_use' | 'tool_result';
  name?: string;
  input?: unknown;
  content?: unknown;
}

export interface StreamCallbacks {
  onText: (delta: string) => void;
  onTool?: (e: ToolEvent) => void;
  onDone?: (fullText: string) => void;
  onError?: (err: string) => void;
}

export interface StreamHandle {
  kill: () => void;
  done: Promise<string>;
}

export interface StreamOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** 健康检查：claude CLI 是否可用 */
export type LeaderTool = 'claude-code' | 'codex';

export function isClaudeAvailable(): boolean {
  try {
    const r = spawnSync('claude', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 4000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function isCodexAvailable(): boolean {
  try {
    const r = spawnSync('codex', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 4000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function isToolAvailable(tool: LeaderTool): boolean {
  return tool === 'codex' ? isCodexAvailable() : isClaudeAvailable();
}

function extractText(content: any): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('');
}

function collectTools(content: any): ToolEvent[] {
  if (!Array.isArray(content)) return [];
  const out: ToolEvent[] = [];
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'tool_use') out.push({ kind: 'tool_use', name: b.name, input: b.input });
    if (b.type === 'tool_result') out.push({ kind: 'tool_result', content: b.content });
  }
  return out;
}

export function streamClaude(prompt: string, opts: StreamOptions, cb: StreamCallbacks): StreamHandle {
  let lastText = '';
  let fullText = '';
  let buffer = '';
  let timedOut = false;
  let timer: NodeJS.Timeout | null = null;
  let child: ChildProcess | null = null;

  const done = new Promise<string>((resolve) => {
    const finish = (finalText: string) => {
      if (timer) clearTimeout(timer);
      cb.onDone?.(finalText);
      resolve(finalText);
    };

    const claudeArgs = ['--print', '--output-format', 'stream-json'];
    if (loadPermissionConfig().enabled) {
      claudeArgs.push('--permission-mode', 'default', '--permission-prompt-tool', 'mcp__ato-leader__permission_request');
    }

    child = spawn(
      'claude',
      claudeArgs,
      { cwd: opts.cwd, env: { ...process.env, ...opts.env } as Record<string, string>, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child?.pid) {
            if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
            else process.kill(child.pid, 'SIGKILL');
          }
        } catch { /* ignore */ }
        cb.onError?.('主 Agent 运行超时');
      }, opts.timeoutMs);
    }

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let evt: any;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        return; // 非 JSON 行忽略
      }
      if (evt.type === 'assistant' && evt.message) {
        const current = extractText(evt.message.content);
        if (current.length > lastText.length) {
          const delta = current.slice(lastText.length);
          lastText = current;
          fullText = current;
          cb.onText(delta);
        }
        const tools = collectTools(evt.message.content);
        for (const t of tools) cb.onTool?.(t);
      } else if (evt.type === 'user' && evt.message) {
        const tools = collectTools(evt.message.content);
        for (const t of tools) cb.onTool?.(t);
      } else if (evt.type === 'result') {
        // 结束
      }
    };

    child.stdout?.on('data', (d: Buffer) => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    });

    let stderrText = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderrText += d.toString();
    });

    child.on('error', () => {
      if (timedOut) return finish(fullText);
      cb.onError?.('无法启动 claude 进程');
      finish(fullText);
    });

    child.on('close', () => {
      if (buffer.trim()) handleLine(buffer);
      if (timedOut) return finish(fullText);
      if (!fullText && stderrText) cb.onError?.(stderrText.slice(0, 500));
      finish(fullText);
    });

    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch { /* ignore */ }
  });

  return {
    kill: () => {
      try {
        if (child?.pid) {
          if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
          else process.kill(child.pid, 'SIGTERM');
        }
      } catch { /* ignore */ }
    },
    done,
  };
}

/** Codex 运行器：`codex exec` 读 stdin 作 prompt，stdout 为纯文本流式输出（无 stream-json/工具事件） */
export function streamCodex(prompt: string, opts: StreamOptions, cb: StreamCallbacks): StreamHandle {
  let fullText = '';
  let timedOut = false;
  let timer: NodeJS.Timeout | null = null;
  let child: ChildProcess | null = null;

  const done = new Promise<string>((resolve) => {
    const finish = (finalText: string) => {
      if (timer) clearTimeout(timer);
      cb.onDone?.(finalText);
      resolve(finalText);
    };

    child = spawn(
      'codex',
      ['exec'],
      { cwd: opts.cwd, env: { ...process.env, ...opts.env } as Record<string, string>, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child?.pid) {
            if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
            else process.kill(child.pid, 'SIGKILL');
          }
        } catch { /* ignore */ }
        cb.onError?.('主 Agent 运行超时');
      }, opts.timeoutMs);
    }

    child.stdout?.on('data', (d: Buffer) => {
      const delta = d.toString();
      fullText += delta;
      cb.onText(delta);
    });

    let stderrText = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderrText += d.toString();
    });

    child.on('error', () => {
      if (timedOut) return finish(fullText);
      cb.onError?.('无法启动 codex 进程');
      finish(fullText);
    });

    child.on('close', () => {
      if (timedOut) return finish(fullText);
      if (!fullText && stderrText) cb.onError?.(stderrText.slice(0, 500));
      finish(fullText);
    });

    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch { /* ignore */ }
  });

  return {
    kill: () => {
      try {
        if (child?.pid) {
          if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
          else process.kill(child.pid, 'SIGTERM');
        }
      } catch { /* ignore */ }
    },
    done,
  };
}

/** 按主 Agent 工具类型分派到对应运行器 */
export function streamLeader(tool: LeaderTool, prompt: string, opts: StreamOptions, cb: StreamCallbacks): StreamHandle {
  return tool === 'codex' ? streamCodex(prompt, opts, cb) : streamClaude(prompt, opts, cb);
}

