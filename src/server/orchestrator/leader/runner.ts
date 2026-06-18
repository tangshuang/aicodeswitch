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
import { existsSync } from 'fs';
import * as path from 'path';
import { loadPermissionConfig } from './permission';
import { isCliAvailable, resolveCli } from '../cli-resolver';

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
  onDebug?: (entry: { kind: 'event' | 'stdout' | 'stderr'; message: string }) => void;
  /** 捕获 Claude Code 的 session_id（删除会话时用于定位其本地会话文件） */
  onSessionId?: (id: string) => void;
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

/** 健康检查：claude/codex CLI 是否可用（Windows 下自动解析 .cmd shim，绕过 cmd.exe 避免闪窗） */
export type LeaderTool = 'claude-code' | 'codex';

export function isClaudeAvailable(): boolean {
  return isCliAvailable('claude');
}

export function isCodexAvailable(): boolean {
  return isCliAvailable('codex');
}

export function isToolAvailable(tool: LeaderTool): boolean {
  return tool === 'codex' ? isCodexAvailable() : isClaudeAvailable();
}

function extractText(content: any): string {
  if (typeof content === 'string') return content;
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
  let sessionIdEmitted = false;
  let timedOut = false;
  let timer: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let child: ChildProcess | null = null;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let firstStdoutEmitted = false;
  let firstStderrEmitted = false;

  const done = new Promise<string>((resolve) => {
    const startTime = Date.now();
    const finish = (finalText: string) => {
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      cb.onDebug?.({ kind: 'event', message: `[finish] elapsed=${Math.round((Date.now() - startTime) / 1000)}s stdout=${stdoutBytes}B stderr=${stderrBytes}B fullText=${finalText.length}chars` });
      cb.onDone?.(finalText);
      resolve(finalText);
    };

    const permEnabled = loadPermissionConfig().enabled;
    const claudeArgs = ['--print', '--output-format', 'stream-json'];
    if (permEnabled) {
      claudeArgs.push('--permission-mode', 'default', '--permission-prompt-tool', 'mcp__ato-leader__permission_request');
      // 检查 ato-leader MCP server 文件是否存在（缺失会导致 claude 启动时挂起）
      // 注意：实际注册到 ~/.claude.json 的路径由 main.ts:resolveMcpServerCommand 决定，
      // 这里只检查 runner 本目录的文件存在性作为辅助诊断。权威检查见 manager 的 [preflight]。
      const mcpJs = path.join(__dirname, 'mcp-server.js');
      const mcpTs = path.join(__dirname, 'mcp-server.ts');
      const jsOk = existsSync(mcpJs);
      const tsOk = existsSync(mcpTs);
      cb.onDebug?.({ kind: 'event', message: `[mcp-check] runner 本目录: mcp-server.js=${jsOk ? 'EXISTS' : 'missing'} mcp-server.ts=${tsOk ? 'EXISTS' : 'missing'}（实际注册路径见 [preflight]）` });
    }

    const resolved = resolveCli('claude');
    const fullArgs = [...resolved.prependArgs, ...claudeArgs];
    cb.onDebug?.({ kind: 'event', message: `[spawn] cmd=${resolved.command} args=${JSON.stringify(fullArgs)} cwd=${opts.cwd || '(default)'} permissionPromptTool=${permEnabled} promptBytes=${Buffer.byteLength(prompt)}` });
    child = spawn(
      resolved.command,
      fullArgs,
      { cwd: opts.cwd, env: { ...process.env, ...opts.env } as Record<string, string>, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    cb.onDebug?.({ kind: 'event', message: `[spawn] pid=${child.pid ?? '(none)'}` });

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child?.pid) {
            if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
            else process.kill(child.pid, 'SIGKILL');
          }
        } catch { /* ignore */ }
        cb.onDebug?.({ kind: 'stderr', message: `[timeout] ${opts.timeoutMs}ms 超时，强制终止 pid=${child?.pid}` });
        cb.onError?.('主 Agent 运行超时');
      }, opts.timeoutMs);
    }

    // 心跳：每 5 秒 emit 一次存活+IO 指标，便于判断进程是否卡死
    heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const msg = `[heartbeat] elapsed=${elapsed}s pid=${child?.pid ?? '(gone)'} stdout=${stdoutBytes}B stderr=${stderrBytes}B`;
      console.error(`[leader:runner] ${msg}`);
      cb.onDebug?.({ kind: 'event', message: msg });
    }, 5000);

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      cb.onDebug?.({ kind: 'stdout', message: line });
      let evt: any;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        return; // 非 JSON 行忽略
      }
      cb.onDebug?.({ kind: 'event', message: JSON.stringify(evt) });
      // 防御式多路径捕获 session_id（顶层或嵌套在 message 里），单次触发
      if (!sessionIdEmitted) {
        const sid =
          (typeof evt.session_id === 'string' && evt.session_id) ||
          (typeof evt.message?.session_id === 'string' && evt.message.session_id) ||
          (typeof evt.sessionId === 'string' && evt.sessionId) ||
          null;
        if (sid) {
          sessionIdEmitted = true;
          cb.onSessionId?.(sid);
        }
      }
      if (evt.type === 'assistant' && evt.message) {
        const current = extractText(evt.message.content);
        if (current.length >= lastText.length) {
          const delta = current.slice(lastText.length);
          if (delta) {
            fullText += delta;
            lastText = current;
            cb.onText(delta);
          } else if (current.length > fullText.length) {
            // Snapshot grew but no delta — use snapshot as fallback
            fullText = current;
          }
        }
        const tools = collectTools(evt.message.content);
        for (const t of tools) cb.onTool?.(t);
      } else if (evt.type === 'user' && evt.message) {
        const tools = collectTools(evt.message.content);
        for (const t of tools) cb.onTool?.(t);
      } else if (evt.type === 'result') {
        const text = extractText(evt.message?.content);
        if (text && text.length > fullText.length) fullText = text;
      }
    };

    child.stdout?.on('data', (d: Buffer) => {
      stdoutBytes += d.length;
      if (!firstStdoutEmitted) {
        firstStdoutEmitted = true;
        console.error(`[leader:runner] [stdout] first byte (${d.length}B)`);
        cb.onDebug?.({ kind: 'event', message: `[stdout] first byte (${d.length}B)` });
      }
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    });

    let stderrText = '';
    child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString();
      stderrBytes += d.length;
      if (!firstStderrEmitted) {
        firstStderrEmitted = true;
        console.error(`[leader:runner] [stderr] first byte (${d.length}B): ${text.slice(0, 200)}`);
        cb.onDebug?.({ kind: 'event', message: `[stderr] first byte (${d.length}B)` });
      }
      stderrText += text;
      cb.onDebug?.({ kind: 'stderr', message: text });
    });

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      console.error(`[leader:runner] [exit] code=${code} signal=${signal}`);
      cb.onDebug?.({ kind: 'stderr', message: `[exit] code=${code} signal=${signal}` });
    });

    child.on('error', (err: Error) => {
      console.error(`[leader:runner] [process error] ${err.message}`);
      cb.onDebug?.({ kind: 'stderr', message: `[process error] ${err.message}` });
      if (timedOut) return finish(fullText);
      cb.onError?.(`无法启动 claude 进程：${err.message}`);
      finish(fullText);
    });

    child.on('close', (code: number | null) => {
      console.error(`[leader:runner] [close] exit code: ${code} stdout=${stdoutBytes}B stderr=${stderrBytes}B stderrText="${stderrText.slice(0, 200)}"`);
      cb.onDebug?.({ kind: 'stderr', message: `[close] exit code: ${code}` });
      if (buffer.trim()) handleLine(buffer);
      if (timedOut) return finish(fullText);
      if (code !== 0 && !fullText) {
        const diag = stderrText.slice(0, 500) + (code !== null ? ` (exit code: ${code})` : '');
        cb.onError?.(diag || '进程意外退出');
      }
      finish(fullText);
    });

    // stdin 诊断
    const stdin = child.stdin;
    if (stdin) {
      stdin.on('error', (e: Error) => {
        console.error(`[leader:runner] [stdin error] ${e.message}`);
        cb.onDebug?.({ kind: 'stderr', message: `[stdin error] ${e.message}` });
      });
      stdin.on('close', () => {
        console.error(`[leader:runner] [stdin] closed`);
        cb.onDebug?.({ kind: 'event', message: '[stdin] closed' });
      });
      try {
        stdin.write(prompt, (err?: Error | null) => {
          if (err) {
            console.error(`[leader:runner] [stdin write cb] error: ${err.message}`);
            cb.onDebug?.({ kind: 'stderr', message: `[stdin write cb] error: ${err.message}` });
          } else {
            console.error(`[leader:runner] [stdin write cb] OK ${Buffer.byteLength(prompt)}B`);
            cb.onDebug?.({ kind: 'event', message: `[stdin write cb] OK ${Buffer.byteLength(prompt)}B` });
          }
        });
        stdin.end();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[leader:runner] [stdin write throw] ${msg}`);
        cb.onDebug?.({ kind: 'stderr', message: `[stdin write throw] ${msg}` });
      }
    } else {
      console.error(`[leader:runner] [stdin] child.stdin is null — cannot write prompt!`);
      cb.onDebug?.({ kind: 'stderr', message: '[stdin] child.stdin is null — cannot write prompt!' });
    }
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
  let heartbeat: NodeJS.Timeout | null = null;
  let child: ChildProcess | null = null;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let firstStdoutEmitted = false;
  let firstStderrEmitted = false;

  const done = new Promise<string>((resolve) => {
    const startTime = Date.now();
    const finish = (finalText: string) => {
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      cb.onDebug?.({ kind: 'event', message: `[finish] elapsed=${Math.round((Date.now() - startTime) / 1000)}s stdout=${stdoutBytes}B stderr=${stderrBytes}B fullText=${finalText.length}chars` });
      cb.onDone?.(finalText);
      resolve(finalText);
    };

    const resolved = resolveCli('codex');
    const fullArgs = [...resolved.prependArgs, 'exec'];
    cb.onDebug?.({ kind: 'event', message: `[spawn] cmd=${resolved.command} args=${JSON.stringify(fullArgs)} cwd=${opts.cwd || '(default)'} promptBytes=${Buffer.byteLength(prompt)}` });
    child = spawn(
      resolved.command,
      fullArgs,
      { cwd: opts.cwd, env: { ...process.env, ...opts.env } as Record<string, string>, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    cb.onDebug?.({ kind: 'event', message: `[spawn] pid=${child.pid ?? '(none)'}` });

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child?.pid) {
            if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
            else process.kill(child.pid, 'SIGKILL');
          }
        } catch { /* ignore */ }
        cb.onDebug?.({ kind: 'stderr', message: `[timeout] ${opts.timeoutMs}ms 超时，强制终止 pid=${child?.pid}` });
        cb.onError?.('主 Agent 运行超时');
      }, opts.timeoutMs);
    }

    // 心跳
    heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      cb.onDebug?.({ kind: 'event', message: `[heartbeat] elapsed=${elapsed}s pid=${child?.pid ?? '(gone)'} stdout=${stdoutBytes}B stderr=${stderrBytes}B` });
    }, 5000);

    child.stdout?.on('data', (d: Buffer) => {
      stdoutBytes += d.length;
      if (!firstStdoutEmitted) {
        firstStdoutEmitted = true;
        cb.onDebug?.({ kind: 'event', message: `[stdout] first byte (${d.length}B)` });
      }
      const delta = d.toString();
      fullText += delta;
      cb.onText(delta);
      cb.onDebug?.({ kind: 'stdout', message: delta });
    });

    let stderrText = '';
    child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString();
      stderrBytes += d.length;
      if (!firstStderrEmitted) {
        firstStderrEmitted = true;
        cb.onDebug?.({ kind: 'event', message: `[stderr] first byte (${d.length}B)` });
      }
      stderrText += text;
      cb.onDebug?.({ kind: 'stderr', message: text });
    });

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      cb.onDebug?.({ kind: 'stderr', message: `[exit] code=${code} signal=${signal}` });
    });

    child.on('error', (err: Error) => {
      cb.onDebug?.({ kind: 'stderr', message: `[process error] ${err.message}` });
      if (timedOut) return finish(fullText);
      cb.onError?.(`无法启动 codex 进程：${err.message}`);
      finish(fullText);
    });

    child.on('close', (code: number | null) => {
      cb.onDebug?.({ kind: 'stderr', message: `[close] exit code: ${code}` });
      if (timedOut) return finish(fullText);
      if (!fullText && stderrText) cb.onError?.(stderrText.slice(0, 500) + (code !== null ? ` (exit code: ${code})` : ''));
      finish(fullText);
    });

    // stdin 诊断
    const stdin = child.stdin;
    if (stdin) {
      stdin.on('error', (e: Error) => cb.onDebug?.({ kind: 'stderr', message: `[stdin error] ${e.message}` }));
      stdin.on('close', () => cb.onDebug?.({ kind: 'event', message: '[stdin] closed' }));
      try {
        stdin.write(prompt, (err?: Error | null) => {
          if (err) cb.onDebug?.({ kind: 'stderr', message: `[stdin write cb] error: ${err.message}` });
          else cb.onDebug?.({ kind: 'event', message: `[stdin write cb] OK ${Buffer.byteLength(prompt)}B` });
        });
        stdin.end();
      } catch (e) {
        cb.onDebug?.({ kind: 'stderr', message: `[stdin write throw] ${e instanceof Error ? e.message : String(e)}` });
      }
    } else {
      cb.onDebug?.({ kind: 'stderr', message: '[stdin] child.stdin is null — cannot write prompt!' });
    }
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

